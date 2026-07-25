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

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

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

/** Process names may only contain these characters before reaching a shell. */
const SAFE_PROCESS_NAME = /^[A-Za-z0-9 ._-]+$/;

/** cmd.exe offers no literal-quoting construct, so these are refused outright. */
const WINDOWS_FORBIDDEN = /["%!]/;

/**
 * Terminating any of these takes the desktop session or the host app with it.
 * A profile that names one is rejected rather than obeyed.
 */
const PROTECTED_PROCESSES = new Set([
  'kernel_task',
  'launchd',
  'windowserver',
  'loginwindow',
  'systemd',
  'init',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'explorer.exe',
  'electron',
  'monolith',
  'monolith.exe',
]);

/* -------------------------------------------------------------------------- */
/* Configuration schema                                                        */
/* -------------------------------------------------------------------------- */

export interface UserSettings {
  spotify_auth_token: string;
  hue_bridge_ip: string;
  hue_api_key: string;
}

export interface DigitalPurge {
  close_browser_tabs: boolean;
  launch_applications: string[];
  kill_background_processes: string[];
}

export interface PhysicalOrchestration {
  lights_enabled: boolean;
  hex_color: string;
  brightness: number;
  hue_xy_payload: [number, number];
}

export interface SonicLayering {
  spotify_enabled: boolean;
  playlist_uri: string;
  target_frequency_profile: string;
}

export interface Profile {
  id: string;
  name: string;
  digital_purge: DigitalPurge;
  physical_orchestration: PhysicalOrchestration;
  sonic_layering: SonicLayering;
}

export interface MonolithConfig {
  user_settings: UserSettings;
  profiles: Profile[];
}

/* -------------------------------------------------------------------------- */
/* IPC result types                                                            */
/* -------------------------------------------------------------------------- */

export type LaunchStatus = 'launched' | 'failed';
export type KillStatus = 'terminated' | 'not_running' | 'rejected' | 'failed';
export type BrowserSignal = 'AGGRESSIVE_PURGE' | 'HYDRATE_SESSION';

export interface LaunchResult {
  target: string;
  status: LaunchStatus;
  durationMs: number;
  command?: string;
  error?: string;
}

export interface KillResult {
  target: string;
  status: KillStatus;
  durationMs: number;
  command?: string;
  error?: string;
}

export interface BrowserDispatchResult {
  signal: BrowserSignal | 'NONE';
  ok: boolean;
  receivers: number;
  error?: string;
}

export interface RealityShiftReport {
  ok: boolean;
  profileId: string;
  profileName: string;
  platform: NodeJS.Platform;
  applications: {
    requested: number;
    launched: number;
    failed: number;
    results: LaunchResult[];
  };
  processes: {
    requested: number;
    terminated: number;
    notRunning: number;
    failed: number;
    results: KillResult[];
  };
  browser: BrowserDispatchResult;
  physical_orchestration: PhysicalOrchestration | null;
  sonic_layering: SonicLayering | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  errors: string[];
}

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

/** No regex: keeps control-character detection independent of source encoding. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Configuration store                                                         */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONFIG: MonolithConfig = {
  user_settings: {
    spotify_auth_token: '',
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

/** Fills every field so a hand-edited config can never crash the shell. */
function normalizeConfig(input: unknown): MonolithConfig {
  const source = (isRecord(input) ? input : {}) as Partial<MonolithConfig>;
  const settings = (isRecord(source.user_settings) ? source.user_settings : {}) as Partial<UserSettings>;

  return {
    user_settings: {
      spotify_auth_token: String(settings.spotify_auth_token ?? ''),
      hue_bridge_ip: String(settings.hue_bridge_ip ?? ''),
      hue_api_key: String(settings.hue_api_key ?? ''),
    },
    profiles: Array.isArray(source.profiles) ? source.profiles.map(normalizeProfile) : [],
  };
}

function normalizeProfile(input: unknown, index: number): Profile {
  const source = (isRecord(input) ? input : {}) as Partial<Profile>;
  const purge = (isRecord(source.digital_purge) ? source.digital_purge : {}) as Partial<DigitalPurge>;
  const physical = (isRecord(source.physical_orchestration)
    ? source.physical_orchestration
    : {}) as Partial<PhysicalOrchestration>;
  const sonic = (isRecord(source.sonic_layering) ? source.sonic_layering : {}) as Partial<SonicLayering>;

  return {
    id: String(source.id ?? `profile_${index}`),
    name: String(source.name ?? `Profile ${index + 1}`),
    digital_purge: {
      close_browser_tabs: Boolean(purge.close_browser_tabs ?? false),
      launch_applications: toStringArray(purge.launch_applications),
      kill_background_processes: toStringArray(purge.kill_background_processes),
    },
    physical_orchestration: {
      lights_enabled: Boolean(physical.lights_enabled ?? false),
      hex_color: String(physical.hex_color ?? '#FFFFFF'),
      brightness: clamp(Number(physical.brightness ?? 100), 0, 100),
      hue_xy_payload: toXyPair(physical.hue_xy_payload),
    },
    sonic_layering: {
      spotify_enabled: Boolean(sonic.spotify_enabled ?? false),
      playlist_uri: String(sonic.playlist_uri ?? ''),
      target_frequency_profile: String(sonic.target_frequency_profile ?? ''),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

/** CIE 1931 xy coordinates are always a two-element pair inside the gamut. */
function toXyPair(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length < 2) return [0.3127, 0.329];
  return [clamp(Number(value[0]), 0, 1), clamp(Number(value[1]), 0, 1)];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/* -------------------------------------------------------------------------- */
/* Shell quoting                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Wraps a value in POSIX single quotes. Everything inside single quotes is
 * literal to the shell, so the only escape needed is for the quote itself.
 */
function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Safe only because unsafe characters are rejected before this is called. */
function quoteWindows(value: string): string {
  return `"${value}"`;
}

/* -------------------------------------------------------------------------- */
/* Application launcher                                                        */
/* -------------------------------------------------------------------------- */

/** Throws with a human-readable reason if `target` must not reach a shell. */
async function assertLaunchable(target: unknown): Promise<string> {
  if (typeof target !== 'string') {
    throw new Error(`expected a string path, received ${typeof target}`);
  }

  const trimmed = target.trim();
  if (trimmed.length === 0) {
    throw new Error('path is empty');
  }
  if (hasControlCharacters(trimmed)) {
    throw new Error('path contains control characters');
  }
  if (!path.isAbsolute(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error('path must be absolute');
  }
  if (process.platform === 'win32' && WINDOWS_FORBIDDEN.test(trimmed)) {
    throw new Error('path contains characters that cannot be safely quoted for cmd.exe');
  }

  // Fail fast with a useful message instead of a silent shell error later. A
  // cross-platform profile always carries paths for the other OS; those land
  // here and degrade to a single skipped entry.
  await fs.access(trimmed).catch(() => {
    throw new Error('path does not exist on this machine');
  });

  return trimmed;
}

function buildLaunchCommand(target: string): string {
  switch (process.platform) {
    case 'darwin':
      return `open ${quotePosix(target)}`;
    case 'win32':
      return `start "" ${quoteWindows(target)}`;
    default:
      return `xdg-open ${quotePosix(target)}`;
  }
}

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

/* -------------------------------------------------------------------------- */
/* Background process terminator                                               */
/* -------------------------------------------------------------------------- */

function assertKillable(name: unknown): string {
  if (typeof name !== 'string') {
    throw new Error(`expected a string process name, received ${typeof name}`);
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('process name is empty');
  }
  if (!SAFE_PROCESS_NAME.test(trimmed)) {
    throw new Error('process name contains unsupported characters');
  }
  if (PROTECTED_PROCESSES.has(trimmed.toLowerCase())) {
    throw new Error('process is protected and will not be terminated');
  }

  return trimmed;
}

function buildKillCommand(name: string): string {
  if (process.platform === 'win32') {
    const image = /\.exe$/i.test(name) ? name : `${name}.exe`;
    return `taskkill /F /IM ${quoteWindows(image)}`;
  }
  // -i: case-insensitive, -x: whole-name match, so "Steam" never matches
  // "steamwebhelper-adjacent" processes by prefix.
  return `pkill -i -x -- ${quotePosix(name)}`;
}

/**
 * "Nothing matched" is the expected outcome for an app that simply is not
 * running, and both platforms signal it through the exit code rather than an
 * error stream: pkill exits 1, taskkill exits 128.
 */
function isNotRunningExit(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (process.platform === 'win32') return code === 128 || code === 1;
  return code === 1;
}

async function killProcess(rawName: unknown): Promise<KillResult> {
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
    log('info', 'kill', `terminated "${name}"`);
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
  payload?: unknown;
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
    const envelope: BridgeEnvelope = {
      type: message.type,
      payload: message.payload,
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

  const { launch_applications, kill_background_processes, close_browser_tabs } = profile.digital_purge;

  log(
    'info',
    'shift',
    `executing "${profile.name}" — ${launch_applications.length} app(s), ` +
      `${kill_background_processes.length} process(es), browser purge ${close_browser_tabs}`,
  );

  // Dedupe so a profile listing the same target twice does not act twice.
  const apps = Array.from(new Set(launch_applications.map((entry) => entry.trim())));
  const kills = Array.from(new Set(kill_background_processes.map((entry) => entry.trim())));

  const [launchOutcomes, killOutcomes] = await Promise.all([
    Promise.allSettled(apps.map((target) => launchApplication(target))),
    Promise.allSettled(kills.map((target) => killProcess(target))),
  ]);

  const launchResults: LaunchResult[] = launchOutcomes.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : { target: String(apps[index]), status: 'failed', durationMs: 0, error: describeError(outcome.reason) },
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
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
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
