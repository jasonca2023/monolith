/**
 * Monolith — Electron main process controller.
 *
 * Owns four things:
 *   1. The frameless application shell (custom dark chrome, no native title bar).
 *   2. The reality-shift executor — launches native applications and terminates
 *      background noise in detached, non-blocking child processes.
 *   3. The orchestration bridge — a WebSocket server on :8080 that pipes signals
 *      to the companion Chrome extension with sub-second latency.
 *   4. The configuration store for monolith_config.json.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  applyAudio,
  applyLighting,
  isPlaceholder,
  restoreLighting,
  type SpotifyHandoff,
  type SpotifyTokenSource,
} from './actuators';
import { setSystemFocus } from './focus-mode';
import { discoverApps, resolveTargets } from './app-catalog';
import { discoverBridges, pairWithBridge } from './hue-setup';
import { authorize, isExpired, refreshTokens, type SpotifyTokens } from './spotify-auth';
import { isRecord, normalizeConfig, normalizeProfile } from './normalize';
import {
  assertKillable,
  assertLaunchable,
  buildKillCommand,
  buildLaunchCommand,
  hasControlCharacters,
  isNotRunningExit,
  quotePosix,
  quoteWindows,
} from './safety';
import type {
  ActuationResult,
  BrowserDispatchResult,
  BrowserSignal,
  DigitalPurge,
  DisengageReport,
  FocusResult,
  HueDiscoveryResult,
  HuePairResult,
  KillResult,
  LaunchResult,
  MonolithConfig,
  PhysicalOrchestration,
  Profile,
  RealityShiftReport,
  SonicLayering,
  SpotifyAuthResult,
  UserSettings,
} from '../shared/types';

const execAsync = promisify(exec);

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const BRIDGE_PORT = 8080;
const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_HEARTBEAT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 15_000;
const KILL_TIMEOUT_MS = 10_000;
const CONFIG_FILENAME = 'monolith_config.json';

/** How long a SIGTERM gets to land before force_quit escalates to SIGKILL. */
const FORCE_QUIT_GRACE_MS = 1500;

/** Schemes a mood may open. Excludes file: — that is what launch paths are for. */
const ALLOWED_URL_SCHEMES = new Set(['http', 'https', 'spotify', 'figma']);

/* -------------------------------------------------------------------------- */
/* Shared contract                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The config schema and every IPC result type live in src/shared/types.ts so
 * the renderer compiles against the same declarations. Re-exported here for
 * callers that already import them from the main module.
 */
export type * from '../shared/types';

/* -------------------------------------------------------------------------- */
/* Logging                                                                     */
/* -------------------------------------------------------------------------- */

type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  const line = `[monolith:${scope}] ${message}`;
  if (detail === undefined) {
    console[level](line);
  } else {
    console[level](line, detail);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const withCode = error as NodeJS.ErrnoException & { stderr?: string };
    const parts = [error.message.trim()];
    if (withCode.code !== undefined) parts.push(`(code ${withCode.code})`);
    const stderr = withCode.stderr?.trim();
    if (stderr) parts.push(`stderr: ${stderr}`);
    return parts.join(' ');
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/* -------------------------------------------------------------------------- */
/* Configuration store                                                         */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONFIG: MonolithConfig = {
  user_settings: {
    spotify_auth_token: '',
    spotify_client_id: '',
    spotify_refresh_token: '',
    spotify_token_expires_at: 0,
    hue_bridge_ip: '',
    hue_api_key: '',
  },
  profiles: [],
};

class ConfigStore {
  private cache: MonolithConfig | null = null;

  /** The writable copy lives in userData; the repo file is only ever a template. */
  private get userPath(): string {
    return path.join(app.getPath('userData'), CONFIG_FILENAME);
  }

  private get templatePath(): string {
    return path.join(app.getAppPath(), CONFIG_FILENAME);
  }

  async read(force = false): Promise<MonolithConfig> {
    if (this.cache && !force) return this.cache;

    const raw = await this.readFirstAvailable([this.userPath, this.templatePath]);
    if (raw === null) {
      log('warn', 'config', 'no config found on disk, seeding defaults');
      this.cache = DEFAULT_CONFIG;
      await this.write(DEFAULT_CONFIG);
      return this.cache;
    }

    try {
      this.cache = normalizeConfig(JSON.parse(raw));
    } catch (error) {
      log('error', 'config', 'config file is not valid JSON, falling back to defaults', describeError(error));
      this.cache = DEFAULT_CONFIG;
    }
    return this.cache;
  }

  async write(config: unknown): Promise<MonolithConfig> {
    const normalized = normalizeConfig(config);
    const target = this.userPath;
    const scratch = `${target}.tmp`;

    await fs.mkdir(path.dirname(target), { recursive: true });
    // Write-then-rename so a crash mid-write cannot truncate a live config.
    await fs.writeFile(scratch, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await fs.rename(scratch, target);

    this.cache = normalized;
    log('info', 'config', `persisted ${normalized.profiles.length} profile(s) to ${target}`);
    return normalized;
  }

  async findProfile(id: string): Promise<Profile | null> {
    const config = await this.read();
    return config.profiles.find((profile) => profile.id === id) ?? null;
  }

  private async readFirstAvailable(candidates: string[]): Promise<string | null> {
    for (const candidate of candidates) {
      try {
        return await fs.readFile(candidate, 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          log('warn', 'config', `unreadable config at ${candidate}`, describeError(error));
        }
      }
    }
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Application launcher                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Launches one application. Settles as soon as the platform opener hands off —
 * the launched app keeps running detached and a failure never reaches the
 * renderer as a rejection.
 */
async function launchApplication(rawTarget: unknown): Promise<LaunchResult> {
  const startedAt = Date.now();
  const label = typeof rawTarget === 'string' ? rawTarget : String(rawTarget);

  let target: string;
  try {
    target = await assertLaunchable(rawTarget);
  } catch (error) {
    const message = describeError(error);
    log('warn', 'launch', `skipped "${label}": ${message}`);
    return { target: label, status: 'failed', durationMs: Date.now() - startedAt, error: message };
  }

  const command = buildLaunchCommand(target);

  try {
    const child = execAsync(command, {
      timeout: LAUNCH_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    // Detach the opener from our event loop so quitting Monolith never waits on it.
    child.child.unref();

    const { stderr } = await child;
    if (stderr?.trim()) {
      log('warn', 'launch', `"${target}" reported stderr`, stderr.trim());
    }

    log('info', 'launch', `launched "${target}"`);
    return { target, status: 'launched', durationMs: Date.now() - startedAt, command };
  } catch (error) {
    const message = describeError(error);
    log('error', 'launch', `failed to launch "${target}": ${message}`);
    return { target, status: 'failed', durationMs: Date.now() - startedAt, command, error: message };
  }
}

/**
 * Opens a URL through the platform handler. Distinct from launching an app: a
 * mood can open a Figma file or a Spotify playlist, neither of which is a path
 * on disk, and `spotify:` in particular starts playback with no API token.
 */
async function launchUrl(rawUrl: unknown): Promise<LaunchResult> {
  const startedAt = Date.now();
  const label = typeof rawUrl === 'string' ? rawUrl.trim() : String(rawUrl);

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(label)?.[1]?.toLowerCase();
  if (!scheme || !ALLOWED_URL_SCHEMES.has(scheme)) {
    const error = `"${label}" is not an http(s), spotify or figma URL`;
    log('warn', 'launch', `skipped ${error}`);
    return { target: label, status: 'failed', durationMs: Date.now() - startedAt, error };
  }
  if (hasControlCharacters(label)) {
    const error = 'URL contains control characters';
    return { target: label, status: 'failed', durationMs: Date.now() - startedAt, error };
  }

  const command =
    process.platform === 'win32'
      ? `start "" ${quoteWindows(label)}`
      : `${process.platform === 'darwin' ? 'open' : 'xdg-open'} ${quotePosix(label)}`;

  try {
    await execAsync(command, { timeout: LAUNCH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });
    log('info', 'launch', `opened ${label}`);
    return { target: label, status: 'launched', durationMs: Date.now() - startedAt, command };
  } catch (error) {
    const message = describeError(error);
    log('error', 'launch', `failed to open ${label}: ${message}`);
    return { target: label, status: 'failed', durationMs: Date.now() - startedAt, command, error: message };
  }
}

/**
 * The no-credentials route to music: the Spotify client registers the
 * `spotify:` scheme, so opening the URI selects the playlist and plays it.
 * Used only when the Web API has no token — it cannot report what happened.
 */
const openPlaylistInSpotify: SpotifyHandoff = async (playlistUri) => {
  const uri = playlistUri.trim();
  if (!/^spotify:[a-z]+:[A-Za-z0-9]+$/.test(uri)) {
    log('warn', 'sonic', `"${uri}" is not a spotify: URI, so it cannot be handed to the app`);
    return false;
  }

  const result = await launchUrl(uri);
  return result.status === 'launched';
};

/* -------------------------------------------------------------------------- */
/* Background process terminator                                               */
/* -------------------------------------------------------------------------- */

async function killProcess(rawName: unknown, force = false): Promise<KillResult> {
  const startedAt = Date.now();
  const label = typeof rawName === 'string' ? rawName : String(rawName);

  let name: string;
  try {
    name = assertKillable(rawName);
  } catch (error) {
    const message = describeError(error);
    log('warn', 'kill', `refused "${label}": ${message}`);
    return { target: label, status: 'rejected', durationMs: Date.now() - startedAt, error: message };
  }

  const command = buildKillCommand(name);

  try {
    await execAsync(command, { timeout: KILL_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });

    // SIGTERM lets an app save and exit, which is what most should get. A game
    // mid-frame often ignores it, so force_quit escalates — but only after the
    // polite request has been made and given a moment to land.
    if (force) {
      await new Promise((resolve) => setTimeout(resolve, FORCE_QUIT_GRACE_MS));
      await execAsync(buildKillCommand(name, undefined, true), {
        timeout: KILL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }).catch(() => undefined); // Already gone is the expected outcome here.
    }

    log('info', 'kill', `terminated "${name}"${force ? ' (forced)' : ''}`);
    return { target: name, status: 'terminated', durationMs: Date.now() - startedAt, command };
  } catch (error) {
    if (isNotRunningExit(error)) {
      log('info', 'kill', `"${name}" was not running`);
      return { target: name, status: 'not_running', durationMs: Date.now() - startedAt, command };
    }

    const message = describeError(error);
    log('error', 'kill', `failed to terminate "${name}": ${message}`);
    return { target: name, status: 'failed', durationMs: Date.now() - startedAt, command, error: message };
  }
}

/* -------------------------------------------------------------------------- */
/* Orchestration bridge (localhost WebSocket server)                           */
/* -------------------------------------------------------------------------- */

interface BridgeEnvelope {
  type: string;
  /** Wire-format alias for `type`; the extension accepts either. */
  action: string;
  payload?: unknown;
  profileId?: string;
  issuedAt: string;
  id: string;
}

class OrchestrationBridge {
  private server: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly alive = new WeakSet<WebSocket>();
  private sequence = 0;

  start(): void {
    if (this.server) return;

    const server = new WebSocketServer({ host: BRIDGE_HOST, port: BRIDGE_PORT });
    this.server = server;

    server.on('listening', () => {
      log('info', 'bridge', `listening on ws://${BRIDGE_HOST}:${BRIDGE_PORT}`);
    });

    server.on('connection', (socket, request) => {
      this.alive.add(socket);
      log('info', 'bridge', `extension connected from ${request.socket.remoteAddress ?? 'unknown'}`);

      socket.on('pong', () => this.alive.add(socket));
      socket.on('message', (data) => this.handleInbound(data));
      socket.on('error', (error) => log('warn', 'bridge', 'socket error', describeError(error)));
      socket.on('close', (code) => {
        this.alive.delete(socket);
        log('info', 'bridge', `extension disconnected (code ${code})`);
      });

      this.send(socket, { type: 'BRIDGE_READY', payload: { platform: process.platform } });
    });

    // A dead TCP connection looks open forever; ping/pong reaps it.
    this.heartbeat = setInterval(() => {
      for (const socket of server.clients) {
        if (!this.alive.has(socket)) {
          log('warn', 'bridge', 'terminating unresponsive client');
          socket.terminate();
          continue;
        }
        this.alive.delete(socket);
        socket.ping();
      }
    }, BRIDGE_HEARTBEAT_MS);

    server.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        log('error', 'bridge', `port ${BRIDGE_PORT} is already in use — browser orchestration is disabled`);
      } else {
        log('error', 'bridge', 'server error', describeError(error));
      }
      this.stop();
    });
  }

  /** Returns how many extension workers actually received the signal. */
  broadcast(type: string, payload?: unknown): number {
    if (!this.server) {
      log('warn', 'bridge', `dropped "${type}" — bridge is not running`);
      return 0;
    }

    let receivers = 0;
    for (const socket of this.server.clients) {
      if (this.send(socket, { type, payload })) receivers += 1;
    }

    log('info', 'bridge', `broadcast "${type}" to ${receivers} client(s)`);
    return receivers;
  }

  stop(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (!this.server) return;

    for (const socket of this.server.clients) socket.terminate();
    this.server.close(() => log('info', 'bridge', 'bridge closed'));
    this.server = null;
  }

  private send(socket: WebSocket, message: { type: string; payload?: unknown }): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;

    this.sequence += 1;
    const payload = message.payload as { profileId?: string } | undefined;
    const envelope: BridgeEnvelope = {
      type: message.type,
      action: message.type,
      payload: message.payload,
      // Hoisted alongside the payload so the worker can read it either way.
      profileId: payload?.profileId,
      issuedAt: new Date().toISOString(),
      id: `sig_${Date.now().toString(36)}_${this.sequence}`,
    };

    try {
      socket.send(JSON.stringify(envelope));
      return true;
    } catch (error) {
      log('warn', 'bridge', `failed to send "${message.type}"`, describeError(error));
      return false;
    }
  }

  /** Extension acknowledgements are relayed straight to the renderer. */
  private handleInbound(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch (error) {
      log('warn', 'bridge', 'discarded non-JSON frame from extension', describeError(error));
      return;
    }

    const envelope = parsed as Partial<BridgeEnvelope>;
    log('info', 'bridge', `extension reported "${envelope.type ?? 'UNKNOWN'}"`, envelope.payload);

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('bridge:event', parsed);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Reality shift                                                               */
/* -------------------------------------------------------------------------- */

const configStore = new ConfigStore();
const bridge = new OrchestrationBridge();

/* -------------------------------------------------------------------------- */
/* Spotify credentials                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Owns the Spotify grant: hands out access tokens, renews them before they
 * expire, and persists the result so a renewal survives a restart.
 *
 * Renewals are deduplicated through `inFlight` because a reality shift can ask
 * for a token while a previous refresh is still running; two concurrent
 * refreshes would race to write the config and one would win with a stale value.
 */
class SpotifyCredentials implements SpotifyTokenSource {
  private inFlight: Promise<string | null> | null = null;

  async getAccessToken(): Promise<string | null> {
    const settings = (await configStore.read()).user_settings;

    if (!settings.spotify_refresh_token) {
      // No grant yet. A hand-pasted token from an older config still works
      // until it expires, which keeps existing setups running.
      const legacy = settings.spotify_auth_token.trim();
      return legacy && !isPlaceholder(legacy) ? legacy : null;
    }

    if (!isExpired(settings.spotify_token_expires_at)) {
      return settings.spotify_auth_token.trim() || this.refresh();
    }

    return this.refresh();
  }

  async refresh(): Promise<string | null> {
    // Collapse concurrent callers onto one network round trip.
    this.inFlight ??= this.performRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async performRefresh(): Promise<string | null> {
    const config = await configStore.read();
    const { spotify_client_id: clientId, spotify_refresh_token: refreshToken } = config.user_settings;

    if (!clientId || !refreshToken) {
      log('warn', 'sonic', 'no Spotify grant to renew — connect Spotify from the credentials panel');
      return null;
    }

    try {
      const tokens = await refreshTokens(clientId, refreshToken);
      await this.persist(tokens);
      log('info', 'sonic', 'renewed the Spotify access token');
      return tokens.accessToken;
    } catch (error) {
      log('error', 'sonic', `could not renew the Spotify token: ${describeError(error)}`);
      return null;
    }
  }

  /** Writes tokens back through the store so the grant survives a restart. */
  async persist(tokens: SpotifyTokens): Promise<void> {
    const config = await configStore.read();
    await configStore.write({
      ...config,
      user_settings: {
        ...config.user_settings,
        spotify_auth_token: tokens.accessToken,
        spotify_refresh_token: tokens.refreshToken,
        spotify_token_expires_at: tokens.expiresAt,
      },
    });
  }
}

const spotifyCredentials = new SpotifyCredentials();

/**
 * Accepts whatever the renderer has on hand: a full profile object, a profile
 * id to resolve from disk, or a bare array of application paths.
 */
async function resolveProfile(payload: unknown): Promise<Profile> {
  if (typeof payload === 'string') {
    const stored = await configStore.findProfile(payload);
    if (stored) return stored;
    throw new Error(`no profile registered under id "${payload}"`);
  }

  if (Array.isArray(payload)) {
    return normalizeProfile(
      { id: 'ad_hoc', name: 'Ad-hoc Shift', digital_purge: { launch_applications: payload } },
      0,
    );
  }

  if (isRecord(payload)) {
    // A profile id with no body still resolves against the stored config.
    if (!isRecord(payload.digital_purge) && typeof payload.id === 'string') {
      const stored = await configStore.findProfile(payload.id);
      if (stored) return stored;
    }
    return normalizeProfile(payload, 0);
  }

  throw new Error(`expected a profile payload, received ${typeof payload}`);
}

/**
 * Runs the full shift. Applications and process terminations fan out
 * concurrently; a single failure anywhere degrades to one entry in the report
 * and never aborts the rest.
 */
async function executeRealityShift(payload: unknown): Promise<RealityShiftReport> {
  const startedAt = new Date();
  const errors: string[] = [];

  let profile: Profile;
  try {
    profile = await resolveProfile(payload);
  } catch (error) {
    const message = describeError(error);
    log('error', 'shift', message);
    return emptyReport(startedAt, message);
  }

  const { close_browser_tabs, force_quit } = profile.digital_purge;

  // Names and categories become real paths and process names here, against what
  // this machine actually has installed.
  const { apps, urls, processes: kills, unresolved } = resolveTargets(
    profile.digital_purge,
    await discoverApps(),
  );
  for (const missing of unresolved) {
    log('warn', 'shift', `nothing installed satisfies "${missing}"`);
  }

  log(
    'info',
    'shift',
    `executing "${profile.name}" — ${apps.length} app(s), ${urls.length} url(s), ` +
      `${kills.length} process(es), browser purge ${close_browser_tabs}`,
  );

  const settings = (await configStore.read()).user_settings;

  // Lights and audio go out alongside the process work — a slow Hue bridge must
  // not delay the apps the user is waiting on.
  const [launchOutcomes, killOutcomes, physicalResult, sonicResult, focusResult] = await Promise.all([
    Promise.allSettled([
      ...apps.map((target) => launchApplication(target)),
      ...urls.map((target) => launchUrl(target)),
    ]),
    Promise.allSettled(kills.map((target) => killProcess(target, force_quit))),
    applyLighting(profile.physical_orchestration, settings),
    applyAudio(profile.sonic_layering, spotifyCredentials, openPlaylistInSpotify),
    setSystemFocus(true),
  ]);

  log('info', 'iot', `lighting ${physicalResult.status}: ${physicalResult.detail}`);
  log('info', 'sonic', `audio ${sonicResult.status}: ${sonicResult.detail}`);
  log('info', 'focus', `system focus ${focusResult.status}: ${focusResult.detail}`);
  if (physicalResult.status === 'failed') errors.push(`lighting: ${physicalResult.detail}`);
  if (sonicResult.status === 'failed') errors.push(`audio: ${sonicResult.detail}`);
  if (focusResult.status === 'failed') errors.push(`focus: ${focusResult.detail}`);

  const launchTargets = [...apps, ...urls];
  const launchResults: LaunchResult[] = launchOutcomes.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : {
          target: String(launchTargets[index]),
          status: 'failed',
          durationMs: 0,
          error: describeError(outcome.reason),
        },
  );

  const killResults: KillResult[] = killOutcomes.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : { target: String(kills[index]), status: 'failed', durationMs: 0, error: describeError(outcome.reason) },
  );

  for (const result of [...launchResults, ...killResults]) {
    if (result.error) errors.push(`${result.target}: ${result.error}`);
  }

  // close_browser_tabs drives the direction: true banks the session and clears
  // the viewport, false restores whatever a previous purge banked.
  const signal: BrowserSignal = close_browser_tabs ? 'AGGRESSIVE_PURGE' : 'HYDRATE_SESSION';
  const receivers = bridge.broadcast(signal, {
    profileId: profile.id,
    profileName: profile.name,
    // Per-mood blocking: the worker arms its blockade from these, not from a
    // hardcoded profile id.
    block_distractions: profile.digital_purge.block_distractions,
    blocked_domains: profile.digital_purge.blocked_domains,
  });
  const browser: BrowserDispatchResult = {
    signal,
    ok: receivers > 0,
    receivers,
    error: receivers === 0 ? 'no extension service worker is connected' : undefined,
  };
  if (!browser.ok) errors.push(`browser: ${browser.error}`);

  const launched = launchResults.filter((result) => result.status === 'launched').length;
  const terminated = killResults.filter((result) => result.status === 'terminated').length;
  const notRunning = killResults.filter((result) => result.status === 'not_running').length;
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  log(
    'info',
    'shift',
    `"${profile.name}" complete in ${durationMs}ms — ${launched}/${launchResults.length} launched, ` +
      `${terminated} terminated, browser signal reached ${receivers} client(s)`,
  );

  return {
    ok: errors.length === 0,
    profileId: profile.id,
    profileName: profile.name,
    platform: process.platform,
    applications: {
      requested: launchResults.length,
      launched,
      failed: launchResults.length - launched,
      results: launchResults,
    },
    processes: {
      requested: killResults.length,
      terminated,
      notRunning,
      failed: killResults.filter((result) => result.status === 'failed' || result.status === 'rejected').length,
      results: killResults,
    },
    browser,
    physical_orchestration: profile.physical_orchestration,
    sonic_layering: profile.sonic_layering,
    physical_result: physicalResult,
    sonic_result: sonicResult,
    focus_result: focusResult,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    errors,
  };
}

/**
 * The exit sequence: drop OS focus filters, return the room to neutral white,
 * and tell the extension to rebuild the session. Runs in parallel — none of the
 * three depends on another, and a failure in one must not strand the others.
 */
async function executeDisengage(profileId: unknown): Promise<DisengageReport> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const id = typeof profileId === 'string' && profileId.length > 0 ? profileId : 'default';

  log('info', 'shift', `disengaging "${id}" — restoring neutral state`);

  const settings = (await configStore.read()).user_settings;

  const [focusResult, physicalResult] = await Promise.all([
    setSystemFocus(false),
    restoreLighting(settings),
  ]);

  const receivers = bridge.broadcast('HYDRATE_SESSION', { profileId: id });
  const browser: BrowserDispatchResult = {
    signal: 'HYDRATE_SESSION',
    ok: receivers > 0,
    receivers,
    error: receivers === 0 ? 'no extension service worker is connected' : undefined,
  };

  log('info', 'focus', `system focus ${focusResult.status}: ${focusResult.detail}`);
  log('info', 'iot', `lighting restore ${physicalResult.status}: ${physicalResult.detail}`);
  if (focusResult.status === 'failed') errors.push(`focus: ${focusResult.detail}`);
  if (physicalResult.status === 'failed') errors.push(`lighting: ${physicalResult.detail}`);
  if (!browser.ok) errors.push(`browser: ${browser.error}`);

  return {
    ok: errors.length === 0,
    profileId: id,
    focus_result: focusResult,
    physical_result: physicalResult,
    browser,
    durationMs: Date.now() - startedAt,
    errors,
  };
}

function emptyReport(startedAt: Date, error: string): RealityShiftReport {
  const finishedAt = new Date();
  return {
    ok: false,
    profileId: 'unknown',
    profileName: 'unknown',
    platform: process.platform,
    applications: { requested: 0, launched: 0, failed: 0, results: [] },
    processes: { requested: 0, terminated: 0, notRunning: 0, failed: 0, results: [] },
    browser: { signal: 'NONE', ok: false, receivers: 0, error },
    physical_orchestration: null,
    sonic_layering: null,
    physical_result: { status: 'failed', detail: error, durationMs: 0 },
    sonic_result: { status: 'failed', detail: error, durationMs: 0 },
    focus_result: { status: 'failed', detail: error, durationMs: 0 },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    errors: [error],
  };
}

/* -------------------------------------------------------------------------- */
/* Application shell                                                           */
/* -------------------------------------------------------------------------- */

let mainWindow: BrowserWindow | null = null;

const FALLBACK_RENDERER = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><title>Monolith</title>
   <style>
     body{background:#0b0b0f;color:#e6e6ef;font:15px/1.6 -apple-system,Segoe UI,sans-serif;
     display:grid;place-items:center;height:100vh;margin:0}
     header{position:fixed;top:0;left:0;right:0;height:38px;-webkit-app-region:drag}
     code{color:#8ab4ff}
   </style>
   <header></header>
   <div><h1>Monolith backend is live</h1>
   <p>No renderer bundle found. Build the frontend branch into <code>dist/renderer</code>
   or set <code>MONOLITH_RENDERER_URL</code>.</p></div>`,
)}`;

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0f',
    // Native chrome is dropped entirely; the renderer paints its own title bar
    // and drives it through the window:* IPC channels below.
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the user's browser; nothing navigates in-shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(safeProtocol(url))) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:$/.test(safeProtocol(url))) void shell.openExternal(url);
    }
  });

  void loadRenderer(window);
  return window;
}

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  const devServer = process.env.MONOLITH_RENDERER_URL;
  if (devServer) {
    try {
      await window.loadURL(devServer);
      return;
    } catch (error) {
      log('warn', 'shell', `dev renderer at ${devServer} unreachable`, describeError(error));
    }
  }

  const bundled = path.join(__dirname, '..', 'renderer', 'index.html');
  try {
    await fs.access(bundled);
    await window.loadFile(bundled);
  } catch {
    log('warn', 'shell', 'renderer bundle missing, showing fallback shell');
    await window.loadURL(FALLBACK_RENDERER);
  }
}

/* -------------------------------------------------------------------------- */
/* IPC surface                                                                 */
/* -------------------------------------------------------------------------- */

function registerIpcHandlers(): void {
  ipcMain.handle('execute-reality-shift', async (_event, profilePayload: unknown): Promise<RealityShiftReport> => {
    const startedAt = new Date();
    try {
      return await executeRealityShift(profilePayload);
    } catch (error) {
      // Absolute backstop: the renderer always receives a report, never a throw.
      const message = describeError(error);
      log('error', 'shift', 'unhandled failure during reality shift', message);
      return emptyReport(startedAt, message);
    }
  });

  ipcMain.handle('execute-disengage', async (_event, profileId: unknown): Promise<DisengageReport> => {
    const startedAt = Date.now();
    try {
      return await executeDisengage(profileId);
    } catch (error) {
      const detail = describeError(error);
      log('error', 'shift', 'unhandled failure during disengage', detail);
      return {
        ok: false,
        profileId: typeof profileId === 'string' ? profileId : 'default',
        focus_result: { status: 'failed', detail, durationMs: 0 },
        physical_result: { status: 'failed', detail, durationMs: 0 },
        browser: { signal: 'NONE', ok: false, receivers: 0, error: detail },
        durationMs: Date.now() - startedAt,
        errors: [detail],
      };
    }
  });

  ipcMain.handle(
    'dispatch-browser-signal',
    async (_event, signal: unknown, payload?: unknown): Promise<BrowserDispatchResult> => {
      const allowed: BrowserSignal[] = ['AGGRESSIVE_PURGE', 'HYDRATE_SESSION'];
      if (typeof signal !== 'string' || !allowed.includes(signal as BrowserSignal)) {
        const error = `unknown browser signal "${String(signal)}"`;
        log('warn', 'bridge', error);
        return { signal: 'NONE', ok: false, receivers: 0, error };
      }

      const receivers = bridge.broadcast(signal, payload);
      return {
        signal: signal as BrowserSignal,
        ok: receivers > 0,
        receivers,
        error: receivers === 0 ? 'no extension service worker is connected' : undefined,
      };
    },
  );

  ipcMain.handle('config:read', async (): Promise<MonolithConfig> => {
    try {
      return await configStore.read(true);
    } catch (error) {
      log('error', 'config', 'failed to read config', describeError(error));
      return DEFAULT_CONFIG;
    }
  });

  ipcMain.handle('config:write', async (_event, config: unknown): Promise<MonolithConfig> => {
    try {
      return await configStore.write(config);
    } catch (error) {
      log('error', 'config', 'failed to persist config', describeError(error));
      return normalizeConfig(config);
    }
  });

  // Typing an .app path by hand is miserable; the editor opens a real picker.
  ipcMain.handle('dialog:pick-applications', async (event): Promise<string[]> => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: 'Choose applications to launch',
      defaultPath: process.platform === 'darwin' ? '/Applications' : undefined,
      properties: ['openFile', 'multiSelections'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Applications', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
          : undefined,
    };

    try {
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    } catch (error) {
      log('warn', 'shell', 'application picker failed', describeError(error));
      return [];
    }
  });

  /**
   * The consent screen opens in the system browser, not a BrowserWindow: the
   * user can see the real accounts.spotify.com address bar there, and their
   * existing Spotify login is already present.
   */
  ipcMain.handle('spotify:authorize', async (): Promise<SpotifyAuthResult> => {
    const config = await configStore.read();
    const clientId = config.user_settings.spotify_client_id.trim();

    if (!clientId) {
      return { ok: false, detail: 'Add a Spotify client ID first — create an app at developer.spotify.com' };
    }

    try {
      log('info', 'sonic', 'opening the Spotify consent screen');
      const tokens = await authorize(clientId, (url) => shell.openExternal(url));
      await spotifyCredentials.persist(tokens);
      log('info', 'sonic', 'Spotify connected');
      return { ok: true, detail: 'Spotify connected — tokens will renew automatically' };
    } catch (error) {
      const detail = describeError(error);
      log('error', 'sonic', `Spotify authorization failed: ${detail}`);
      return { ok: false, detail };
    }
  });

  ipcMain.handle('hue:discover', async (): Promise<HueDiscoveryResult> => {
    try {
      const bridges = await discoverBridges();
      log('info', 'iot', `discovery found ${bridges.length} bridge(s)`);
      return {
        ok: bridges.length > 0,
        detail: bridges.length > 0 ? `Found ${bridges.length} bridge(s)` : 'No Hue bridge found on this network',
        bridges,
      };
    } catch (error) {
      const detail = describeError(error);
      log('warn', 'iot', `discovery failed: ${detail}`);
      return { ok: false, detail: `Discovery failed: ${detail}`, bridges: [] };
    }
  });

  /**
   * Blocks for the length of the bridge's link window, so the renderer shows a
   * "press the button" prompt while this is pending.
   */
  ipcMain.handle('hue:pair', async (_event, ip: unknown): Promise<HuePairResult> => {
    if (typeof ip !== 'string' || !ip.trim()) {
      return { ok: false, status: 'failed', detail: 'No bridge address given' };
    }

    log('info', 'iot', `pairing with the bridge at ${ip} — waiting for the link button`);
    const outcome = await pairWithBridge(ip.trim());

    if (outcome.status === 'linked') {
      const config = await configStore.read();
      await configStore.write({
        ...config,
        user_settings: {
          ...config.user_settings,
          hue_bridge_ip: ip.trim(),
          hue_api_key: outcome.username,
        },
      });
      log('info', 'iot', 'bridge paired and key stored');
      return { ok: true, status: 'linked', detail: 'Bridge paired — lights are ready' };
    }

    if (outcome.status === 'button-not-pressed') {
      return { ok: false, status: 'pending', detail: 'Timed out — press the button on the bridge, then try again' };
    }

    log('warn', 'iot', `pairing failed: ${outcome.detail}`);
    return { ok: false, status: 'failed', detail: outcome.detail };
  });

  ipcMain.handle('system:info', async () => ({
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    bridgeUrl: `ws://${BRIDGE_HOST}:${BRIDGE_PORT}`,
  }));

  // A frameless window has no native controls, so the renderer owns them.
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle('window:toggle-maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (window.isMaximized()) {
      window.unmaximize();
      return false;
    }
    window.maximize();
    return true;
  });

  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  log('warn', 'shell', 'another Monolith instance owns the bridge port, exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    registerIpcHandlers();
    bridge.start();

    await configStore.read().catch((error) => {
      log('error', 'config', 'initial config load failed', describeError(error));
      return DEFAULT_CONFIG;
    });

    mainWindow = createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => bridge.stop());
}

process.on('uncaughtException', (error) => {
  log('error', 'process', 'uncaught exception', describeError(error));
});

process.on('unhandledRejection', (reason) => {
  log('error', 'process', 'unhandled rejection', describeError(reason));
});
