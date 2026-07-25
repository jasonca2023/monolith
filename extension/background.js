/**
 * Monolith — Chrome Extension (Manifest V3) service worker.
 *
 * Holds a localhost WebSocket link to the Electron host and executes the two
 * browser-side halves of a reality shift:
 *
 *   AGGRESSIVE_PURGE  — snapshot every open, non-pinned tab, persist it, drop a
 *                       clean new tab, then close the whole set in one call.
 *   HYDRATE_SESSION   — rebuild the snapshot tab-for-tab and clear the cache.
 *
 * MV3 workers are evicted aggressively, so nothing here assumes it stays
 * resident: state lives in chrome.storage, and a chrome.alarms tick revives the
 * worker and re-establishes the socket.
 */

'use strict';

const BRIDGE_URL = 'ws://localhost:8080';
const SESSION_KEY = 'monolith.session.snapshot';
const KEEPALIVE_ALARM = 'monolith-keepalive';
const KEEPALIVE_PERIOD_MINUTES = 0.5;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const BLANK_TAB_URL = 'chrome://newtab/';

/** URL schemes chrome.tabs.create is allowed to recreate. */
const RESTORABLE_SCHEME = /^(https?|file|ftp):/i;

/** Module-scope only — treated as cache, never as the source of truth. */
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
    // intentionally stays quiet so a host that is simply not running is not noisy.
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

  const type = envelope && envelope.type;
  log(`signal received: ${type}`);

  try {
    switch (type) {
      case 'AGGRESSIVE_PURGE': {
        const result = await aggressivePurge();
        report('PURGE_COMPLETE', result);
        break;
      }
      case 'HYDRATE_SESSION': {
        const result = await hydrateSession();
        report('HYDRATE_COMPLETE', result);
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
    report('SIGNAL_FAILED', { signal: type, error: String(error && error.message ? error.message : error) });
  }
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

async function aggressivePurge() {
  const startedAt = Date.now();
  const tabs = await queryPurgeableTabs();

  if (tabs.length === 0) {
    log('purge requested but no unpinned tabs are open');
    return { purged: 0, cached: 0, durationMs: Date.now() - startedAt };
  }

  const snapshot = {
    version: 1,
    capturedAt: new Date().toISOString(),
    windowId: tabs[0].windowId,
    tabs: tabs.map(serializeTab),
  };

  // Persist before destroying anything — a failed write must never cost tabs.
  await chrome.storage.local.set({ [SESSION_KEY]: snapshot });
  log(`cached ${snapshot.tabs.length} tab(s) to local storage`);

  const blankTabId = await openBlankTab(snapshot.windowId);

  const doomed = tabs
    .map((tab) => tab.id)
    .filter((id) => typeof id === 'number' && id !== blankTabId && id !== chrome.tabs.TAB_ID_NONE);

  const purged = await terminateTabs(doomed);

  const durationMs = Date.now() - startedAt;
  log(`purge complete — ${purged}/${doomed.length} tab(s) closed in ${durationMs}ms`);

  return {
    purged,
    cached: snapshot.tabs.length,
    failed: doomed.length - purged,
    capturedAt: snapshot.capturedAt,
    durationMs,
  };
}

/**
 * chrome.tabs.create rejects most chrome:// URLs; the new tab page is the
 * exception on current Chrome, and an empty create yields it everywhere else.
 */
async function openBlankTab(windowId) {
  const base = typeof windowId === 'number' ? { windowId } : {};

  try {
    const tab = await chrome.tabs.create({ ...base, url: BLANK_TAB_URL, active: true });
    return tab.id;
  } catch (error) {
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

  const outcomes = await Promise.allSettled(
    tabIds.map((id) => chrome.tabs.remove(id)),
  );

  return outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
}

/* -------------------------------------------------------------------------- */
/* HYDRATE_SESSION                                                             */
/* -------------------------------------------------------------------------- */

async function hydrateSession() {
  const startedAt = Date.now();
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const snapshot = stored[SESSION_KEY];

  if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) {
    log('hydrate requested but no cached session exists');
    return { restored: 0, skipped: 0, durationMs: Date.now() - startedAt };
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

  // Volatile layer is single-use: a restored session must not be restorable twice.
  await chrome.storage.local.remove(SESSION_KEY);

  const durationMs = Date.now() - startedAt;
  log(`hydrate complete — ${restored} restored, ${skipped} skipped in ${durationMs}ms`);

  return { restored, skipped, capturedAt: snapshot.capturedAt, durationMs };
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
  bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  log('browser started');
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

// Lets the popup or a content script trigger a shift without the desktop host.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  handleSignal(JSON.stringify(message))
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));

  return true; // keep the message channel open for the async response
});

// Top-level connect covers the cold start that follows an eviction.
bootstrap();
