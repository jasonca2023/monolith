/**
 * Monolith — Chrome Extension (Manifest V3) service worker.
 *
 * Holds a localhost WebSocket link to the Electron host and executes the
 * browser-side half of a reality shift:
 *
 *   AGGRESSIVE_PURGE  — snapshot every open, non-pinned tab under the profile's
 *                       id, persist it, drop a clean staging tab, then close the
 *                       whole set. Arms the distraction blockade for deep_work.
 *   HYDRATE_SESSION   — rebuild that profile's snapshot tab-for-tab, clear the
 *                       storage trace, and release the blockade.
 *   RELEASE_BLOCKADE  — unconditional escape hatch for the host or the popup.
 *
 * MV3 workers are evicted aggressively, so nothing here assumes it stays
 * resident: state lives in chrome.storage and in the dynamic rule set, and a
 * chrome.alarms tick revives the worker and re-establishes the socket.
 */

'use strict';

const BRIDGE_URL = 'ws://localhost:8080';
const SESSION_KEY_PREFIX = 'monolith.session.';
const LAST_PROFILE_KEY = 'monolith.session.__last';
const FOCUS_STATE_KEY = 'monolith.focus.session';
const KEEPALIVE_ALARM = 'monolith-keepalive';
const KEEPALIVE_PERIOD_MINUTES = 0.5;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const BLANK_TAB_URL = 'chrome://newtab/';

/** URL schemes chrome.tabs.create is permitted to recreate. */
const RESTORABLE_SCHEME = /^(https?|file|ftp):/i;

/** The profile whose purge arms the hostile-domain blockade. */
const BLOCKADE_PROFILE_ID = 'deep_work';

/** Overridable per signal via payload.blocked_domains. */
const DEFAULT_BLOCKED_DOMAINS = [
  'twitter.com',
  'x.com',
  'reddit.com',
  'youtube.com',
  'instagram.com',
  'tiktok.com',
  'facebook.com',
  'news.ycombinator.com',
  'twitch.tv',
];

/**
 * Dynamic rule ids are owned by this worker exclusively. Keeping them in a
 * reserved band means a reset only ever clears Monolith's own rules.
 */
const RULE_ID_BASE = 9000;
const RULE_ID_CEILING = 9999;

/** Module-scope state is a cache only — never the source of truth. */
let socket = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

/* -------------------------------------------------------------------------- */
/* Logging                                                                     */
/* -------------------------------------------------------------------------- */

function log(message, detail) {
  if (detail === undefined) {
    console.log(`[monolith] ${message}`);
  } else {
    console.log(`[monolith] ${message}`, detail);
  }
}

function logError(message, error) {
  console.error(`[monolith] ${message}`, error instanceof Error ? error.message : error);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* Bridge transport                                                            */
/* -------------------------------------------------------------------------- */

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  let next;
  try {
    next = new WebSocket(BRIDGE_URL);
  } catch (error) {
    logError('failed to construct bridge socket', error);
    scheduleReconnect();
    return;
  }

  socket = next;

  next.addEventListener('open', () => {
    reconnectAttempts = 0;
    log(`bridge connected → ${BRIDGE_URL}`);
    report('EXTENSION_READY', { manifestVersion: chrome.runtime.getManifest().manifest_version });
  });

  next.addEventListener('message', (event) => {
    void handleSignal(event.data);
  });

  next.addEventListener('error', () => {
    // The close event carries the actionable information; this fires first and
    // stays quiet so a host that simply is not running does not spam the log.
    log('bridge socket error (host may be offline)');
  });

  next.addEventListener('close', (event) => {
    log(`bridge closed (code ${event.code})`);
    if (socket === next) socket = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;

  log(`reconnecting to bridge in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/** Sends an acknowledgement back to the Electron host, if it is listening. */
function report(type, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify({ type, payload, issuedAt: new Date().toISOString() }));
    return true;
  } catch (error) {
    logError(`failed to report "${type}"`, error);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Signal routing                                                              */
/* -------------------------------------------------------------------------- */

async function handleSignal(raw) {
  let envelope;
  try {
    envelope = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch (error) {
    logError('discarded malformed frame from bridge', error);
    return;
  }

  // The host sends `type` and `action` as aliases; accept either so a hand-sent
  // frame or a future sender using only one of them still routes.
  const type = envelope && (envelope.type || envelope.action);
  const payload = (envelope && envelope.payload) || {};

  // profileId may ride alongside the payload rather than inside it.
  if (envelope && envelope.profileId && !payload.profileId) {
    payload.profileId = envelope.profileId;
  }

  log(`signal received: ${type}`);

  try {
    switch (type) {
      case 'AGGRESSIVE_PURGE': {
        const result = await aggressivePurge(payload);
        report('PURGE_COMPLETE', result);
        break;
      }
      case 'HYDRATE_SESSION': {
        const result = await hydrateSession(payload);
        report('HYDRATE_COMPLETE', result);
        break;
      }
      case 'RELEASE_BLOCKADE': {
        const cleared = await deactivateBlockade();
        report('BLOCKADE_RELEASED', { cleared });
        break;
      }
      case 'BRIDGE_READY':
        log('host handshake acknowledged');
        break;
      default:
        log(`ignoring unknown signal "${type}"`);
    }
  } catch (error) {
    logError(`signal "${type}" failed`, error);
    report('SIGNAL_FAILED', { signal: type, error: messageOf(error) });
  }
}

function sessionKeyFor(profileId) {
  return `${SESSION_KEY_PREFIX}${profileId || 'default'}`;
}

/* -------------------------------------------------------------------------- */
/* Hostile domain blockade (declarativeNetRequest)                             */
/* -------------------------------------------------------------------------- */

/**
 * Builds one redirect rule per domain. `requestDomains` also covers subdomains,
 * so a single entry catches www., m., and old.reddit.com alike.
 */
function buildBlockadeRules(domains, redirectUrl) {
  return domains.map((domain, index) => ({
    id: RULE_ID_BASE + index,
    priority: 1,
    action: redirectUrl
      ? { type: 'redirect', redirect: { url: redirectUrl } }
      : { type: 'redirect', redirect: { extensionPath: '/blocked.html' } },
    condition: {
      requestDomains: [domain],
      resourceTypes: ['main_frame'],
    },
  }));
}

/** Every id this worker owns, so a reset never touches another rule set. */
function ownedRuleIds() {
  const ids = [];
  for (let id = RULE_ID_BASE; id <= RULE_ID_CEILING; id += 1) ids.push(id);
  return ids;
}

async function activateBlockade(payload) {
  const domains = Array.isArray(payload.blocked_domains) && payload.blocked_domains.length > 0
    ? payload.blocked_domains.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : DEFAULT_BLOCKED_DOMAINS;

  const capped = domains.slice(0, RULE_ID_CEILING - RULE_ID_BASE + 1);
  const redirectUrl = typeof payload.redirect_url === 'string' ? payload.redirect_url : '';

  // Record the session before the rules land so the countdown page always has
  // something to render, even on the very first blocked navigation.
  await chrome.storage.local.set({
    [FOCUS_STATE_KEY]: {
      profileId: payload.profileId || BLOCKADE_PROFILE_ID,
      profileName: payload.profileName || 'Deep Work',
      startedAt: Date.now(),
      endsAt: typeof payload.duration_minutes === 'number'
        ? Date.now() + payload.duration_minutes * 60_000
        : null,
      domains: capped,
    },
  });

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ownedRuleIds(),
    addRules: buildBlockadeRules(capped, redirectUrl),
  });

  log(`blockade armed across ${capped.length} domain(s)`);

  // A distracting tab already open would otherwise survive the purge untouched.
  await evictOpenDistractions(capped, redirectUrl);

  return { armed: true, domains: capped, redirectUrl: redirectUrl || 'chrome-extension://blocked.html' };
}

async function deactivateBlockade() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ownedRuleIds(),
    addRules: [],
  });
  await chrome.storage.local.remove(FOCUS_STATE_KEY);
  log('blockade released');
  return true;
}

/**
 * DNR only intercepts navigations, so a pinned tab already sitting on a blocked
 * domain has to be pushed to the countdown page explicitly.
 */
async function evictOpenDistractions(domains, redirectUrl) {
  let evicted = 0;
  const target = redirectUrl || chrome.runtime.getURL('blocked.html');

  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      const url = tab.pendingUrl || tab.url || '';
      if (!url || typeof tab.id !== 'number') continue;
      if (!matchesBlockedDomain(url, domains)) continue;

      try {
        await chrome.tabs.update(tab.id, { url: target });
        evicted += 1;
      } catch (error) {
        logError(`could not evict tab ${tab.id}`, error);
      }
    }
  } catch (error) {
    logError('could not scan tabs for open distractions', error);
  }

  if (evicted > 0) log(`evicted ${evicted} already-open distraction tab(s)`);
  return evicted;
}

function matchesBlockedDomain(url, domains) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((domain) => {
    const needle = String(domain).toLowerCase();
    return host === needle || host.endsWith(`.${needle}`);
  });
}

/* -------------------------------------------------------------------------- */
/* Tab discovery                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A service worker has no "current window" of its own, so the documented
 * currentWindow query can legitimately come back empty. Fall back to the last
 * focused normal window before giving up.
 */
async function queryPurgeableTabs() {
  const current = await chrome.tabs.query({ currentWindow: true, pinned: false });
  if (current.length > 0) return current;

  try {
    const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (focused && typeof focused.id === 'number') {
      return await chrome.tabs.query({ windowId: focused.id, pinned: false });
    }
  } catch (error) {
    logError('could not resolve a focused window', error);
  }

  return [];
}

function serializeTab(tab) {
  return {
    url: tab.pendingUrl || tab.url || '',
    title: tab.title || '',
    index: typeof tab.index === 'number' ? tab.index : 0,
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    windowId: tab.windowId,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    favIconUrl: tab.favIconUrl || '',
    muted: Boolean(tab.mutedInfo && tab.mutedInfo.muted),
  };
}

/* -------------------------------------------------------------------------- */
/* AGGRESSIVE_PURGE                                                            */
/* -------------------------------------------------------------------------- */

async function aggressivePurge(payload) {
  const startedAt = Date.now();
  const profileId = payload.profileId || 'default';
  const tabs = await queryPurgeableTabs();

  // Any mood can arm the blockade — the host says so per shift. The legacy
  // deep_work check stays as a fallback for hosts that send neither field.
  const wantsBlockade =
    typeof payload.block_distractions === 'boolean'
      ? payload.block_distractions
      : Array.isArray(payload.blocked_domains) && payload.blocked_domains.length > 0
        ? true
        : profileId === BLOCKADE_PROFILE_ID;

  // The blockade is a property of the profile, not of the tab count — arm it
  // even when there was nothing to close.
  const blockade = wantsBlockade
    ? await activateBlockade(payload)
    : { armed: false, cleared: await deactivateBlockade() };

  if (tabs.length === 0) {
    log('purge requested but no unpinned tabs are open');
    return { profileId, purged: 0, cached: 0, failed: 0, blockade, durationMs: Date.now() - startedAt };
  }

  const snapshot = {
    version: 1,
    profileId,
    profileName: payload.profileName || '',
    capturedAt: new Date().toISOString(),
    windowId: tabs[0].windowId,
    tabs: tabs.map(serializeTab),
  };

  // Persist before destroying anything — a failed write must never cost tabs.
  await chrome.storage.local.set({
    [sessionKeyFor(profileId)]: snapshot,
    [LAST_PROFILE_KEY]: profileId,
  });
  log(`cached ${snapshot.tabs.length} tab(s) under "${sessionKeyFor(profileId)}"`);

  const blankTabId = await openBlankTab(snapshot.windowId);

  const doomed = tabs
    .map((tab) => tab.id)
    .filter((id) => typeof id === 'number' && id !== blankTabId && id !== chrome.tabs.TAB_ID_NONE);

  const purged = await terminateTabs(doomed);

  const durationMs = Date.now() - startedAt;
  log(`purge complete — ${purged}/${doomed.length} tab(s) closed in ${durationMs}ms`);

  return {
    profileId,
    purged,
    cached: snapshot.tabs.length,
    failed: doomed.length - purged,
    capturedAt: snapshot.capturedAt,
    blockade,
    durationMs,
  };
}

/**
 * chrome.tabs.create rejects most chrome:// URLs; the new tab page is the
 * exception on current Chrome, and a bare create yields it everywhere else.
 */
async function openBlankTab(windowId) {
  const base = typeof windowId === 'number' ? { windowId } : {};

  try {
    const tab = await chrome.tabs.create({ ...base, url: BLANK_TAB_URL, active: true });
    return tab.id;
  } catch {
    log('chrome://newtab/ was rejected, opening a default blank tab instead');
    try {
      const tab = await chrome.tabs.create({ ...base, active: true });
      return tab.id;
    } catch (fallbackError) {
      logError('could not open a blank tab', fallbackError);
      return null;
    }
  }
}

/**
 * One batched remove wipes the whole set in a single trip. If any single tab is
 * already gone the batch rejects, so fall back to per-tab removal rather than
 * leaving the window half-purged.
 */
async function terminateTabs(tabIds) {
  if (tabIds.length === 0) return 0;

  try {
    await chrome.tabs.remove(tabIds);
    return tabIds.length;
  } catch (error) {
    logError('batch termination failed, falling back to per-tab removal', error);
  }

  const outcomes = await Promise.allSettled(tabIds.map((id) => chrome.tabs.remove(id)));
  return outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
}

/* -------------------------------------------------------------------------- */
/* HYDRATE_SESSION                                                             */
/* -------------------------------------------------------------------------- */

async function hydrateSession(payload) {
  const startedAt = Date.now();

  // Leaving deep work always lifts the blockade, even if there is nothing to
  // restore — otherwise a user could be locked out by an empty snapshot.
  await deactivateBlockade();

  const profileId = await resolveHydrationProfile(payload);
  const key = sessionKeyFor(profileId);
  const stored = await chrome.storage.local.get(key);
  const snapshot = stored[key];

  if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) {
    log(`hydrate requested but no cached session exists for "${profileId}"`);
    return { profileId, restored: 0, skipped: 0, durationMs: Date.now() - startedAt };
  }

  const targetWindowId = await resolveHydrationWindow(snapshot.windowId);
  const ordered = [...snapshot.tabs].sort((a, b) => a.index - b.index);

  let restored = 0;
  let skipped = 0;

  for (const entry of ordered) {
    if (!entry.url || !RESTORABLE_SCHEME.test(entry.url)) {
      skipped += 1;
      continue;
    }

    try {
      await chrome.tabs.create({
        url: entry.url,
        windowId: targetWindowId,
        active: false,
        pinned: Boolean(entry.pinned),
        // Preserve original ordering; Chrome clamps an out-of-range index.
        ...(typeof entry.index === 'number' ? { index: entry.index } : {}),
      });
      restored += 1;
    } catch (error) {
      skipped += 1;
      logError(`could not restore ${entry.url}`, error);
    }
  }

  // The volatile layer is single-use: a restored session is not restorable twice.
  await chrome.storage.local.remove([key, LAST_PROFILE_KEY]);

  const durationMs = Date.now() - startedAt;
  log(`hydrate complete — ${restored} restored, ${skipped} skipped in ${durationMs}ms`);

  return { profileId, restored, skipped, capturedAt: snapshot.capturedAt, durationMs };
}

/** An explicit id wins; otherwise fall back to whichever profile purged last. */
async function resolveHydrationProfile(payload) {
  if (payload && typeof payload.profileId === 'string' && payload.profileId.length > 0) {
    return payload.profileId;
  }
  const stored = await chrome.storage.local.get(LAST_PROFILE_KEY);
  return stored[LAST_PROFILE_KEY] || 'default';
}

/** Prefers the window the snapshot came from; falls back to whatever is focused. */
async function resolveHydrationWindow(preferredId) {
  if (typeof preferredId === 'number') {
    try {
      const existing = await chrome.windows.get(preferredId);
      if (existing && typeof existing.id === 'number') return existing.id;
    } catch {
      log(`original window ${preferredId} is gone, hydrating into the focused window`);
    }
  }

  try {
    const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (focused && typeof focused.id === 'number') return focused.id;
  } catch (error) {
    logError('no window available for hydration', error);
  }

  const created = await chrome.windows.create({});
  return created.id;
}

/* -------------------------------------------------------------------------- */
/* Worker lifecycle                                                            */
/* -------------------------------------------------------------------------- */

function bootstrap() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
  connect();
}

chrome.runtime.onInstalled.addListener(() => {
  log('extension installed');
  // Dynamic rules survive reloads; a fresh install must never inherit a blockade.
  void deactivateBlockade();
  bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  log('browser started');
  // A browser restart ends the focus session, so the blockade must not outlive
  // it — otherwise a crash mid-deep-work would lock the user out permanently.
  void deactivateBlockade();
  bootstrap();
});

// The alarm both revives an evicted worker and repairs a dropped socket.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    reconnectAttempts = 0;
    connect();
  }
});

// Lets the popup or the countdown page drive a shift without the desktop host.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  handleSignal(JSON.stringify(message))
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: messageOf(error) }));

  return true; // keep the message channel open for the async response
});

// Top-level connect covers the cold start that follows an eviction.
bootstrap();
