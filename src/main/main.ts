/**
 * Monolith — Electron main process.
 *
 * Owns three things:
 *   1. The application shell (single window, hardened, contextIsolated).
 *   2. The "reality shift" executor — launches local applications through the
 *      platform's own opener in non-blocking background child processes.
 *   3. The orchestration bridge — a localhost WebSocket server on :8080 that
 *      pushes signals to the Monolith Chrome extension service worker.
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
const CONFIG_FILENAME = 'monolith_config.json';

/** Control characters and quote metacharacters we refuse to hand to a shell. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_FORBIDDEN = /["%!]/;

/* -------------------------------------------------------------------------- */
/* Configuration types                                                         */
/* -------------------------------------------------------------------------- */

export interface UserSettings {
  spotify_auth_token: string;
  hue_bridge_ip: string;
  hue_api_key: string;
}

export interface LightingDirective {
  hex_color: string;
  brightness: number;
  transition_ms: number;
}

export interface AudioDirective {
  playlist_uri: string;
  shuffle: boolean;
  volume_percent: number;
}

export type BrowserAction = 'AGGRESSIVE_PURGE' | 'HYDRATE_SESSION' | 'NONE';

export interface Profile {
  id: string;
  label: string;
  description: string;
  applications: {
    darwin: string[];
    win32: string[];
    linux: string[];
  };
  lighting: LightingDirective;
  audio: AudioDirective;
  browser_action: BrowserAction;
}

export interface MonolithConfig {
  version: number;
  user_settings: UserSettings;
  profiles: Profile[];
}

/* -------------------------------------------------------------------------- */
/* IPC result types                                                            */
/* -------------------------------------------------------------------------- */

export type LaunchStatus = 'launched' | 'failed';

export interface LaunchResult {
  target: string;
  status: LaunchStatus;
  durationMs: number;
  command?: string;
  error?: string;
}

export interface RealityShiftReport {
  ok: boolean;
  platform: NodeJS.Platform;
  requested: number;
  launched: number;
  failed: number;
  results: LaunchResult[];
  startedAt: string;
  finishedAt: string;
}

export interface BridgeDispatchReport {
  ok: boolean;
  signal: string;
  receivers: number;
  error?: string;
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

/** Normalizes anything thrown into a printable string. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const withCode = error as NodeJS.ErrnoException & { stderr?: string };
    const parts = [error.message.trim()];
    if (withCode.code) parts.push(`(code ${withCode.code})`);
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
  version: 1,
  user_settings: {
    spotify_auth_token: '',
    hue_bridge_ip: '',
    hue_api_key: '',
  },
  profiles: [],
};

class ConfigStore {
  private cache: MonolithConfig | null = null;

  /** Writable copy lives in userData; the repo copy is only ever a template. */
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

  async write(config: MonolithConfig): Promise<MonolithConfig> {
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

/** Fills in missing fields so a hand-edited config can never crash the shell. */
function normalizeConfig(input: unknown): MonolithConfig {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Partial<MonolithConfig>;
  const settings = (source.user_settings ?? {}) as Partial<UserSettings>;

  return {
    version: typeof source.version === 'number' ? source.version : 1,
    user_settings: {
      spotify_auth_token: String(settings.spotify_auth_token ?? ''),
      hue_bridge_ip: String(settings.hue_bridge_ip ?? ''),
      hue_api_key: String(settings.hue_api_key ?? ''),
    },
    profiles: Array.isArray(source.profiles) ? source.profiles.map(normalizeProfile) : [],
  };
}

function normalizeProfile(input: unknown, index: number): Profile {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Partial<Profile>;
  const apps = (source.applications ?? {}) as Partial<Profile['applications']>;
  const lighting = (source.lighting ?? {}) as Partial<LightingDirective>;
  const audio = (source.audio ?? {}) as Partial<AudioDirective>;
  const action = source.browser_action;

  return {
    id: String(source.id ?? `profile_${index}`),
    label: String(source.label ?? `Profile ${index + 1}`),
    description: String(source.description ?? ''),
    applications: {
      darwin: toStringArray(apps.darwin),
      win32: toStringArray(apps.win32),
      linux: toStringArray(apps.linux),
    },
    lighting: {
      hex_color: String(lighting.hex_color ?? '#FFFFFF'),
      brightness: clamp(Number(lighting.brightness ?? 100), 1, 100),
      transition_ms: clamp(Number(lighting.transition_ms ?? 800), 0, 60_000),
    },
    audio: {
      playlist_uri: String(audio.playlist_uri ?? ''),
      shuffle: Boolean(audio.shuffle ?? false),
      volume_percent: clamp(Number(audio.volume_percent ?? 60), 0, 100),
    },
    browser_action:
      action === 'AGGRESSIVE_PURGE' || action === 'HYDRATE_SESSION' ? action : 'NONE',
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/* -------------------------------------------------------------------------- */
/* Launch pipeline                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Wraps a path in POSIX single quotes. Everything inside single quotes is
 * literal to the shell, so the only escape needed is for the quote itself.
 */
function quotePosix(target: string): string {
  return `'${target.replace(/'/g, `'\\''`)}'`;
}

/**
 * cmd.exe has no literal-quoting construct, so unsafe characters are rejected
 * by `assertLaunchable` before we ever build the command string.
 */
function quoteWindows(target: string): string {
  return `"${target}"`;
}

/** Throws with a human-readable reason if `target` must not reach a shell. */
async function assertLaunchable(target: unknown): Promise<string> {
  if (typeof target !== 'string') {
    throw new Error(`expected a string path, received ${typeof target}`);
  }

  const trimmed = target.trim();
  if (trimmed.length === 0) {
    throw new Error('path is empty');
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new Error('path contains control characters');
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error('path must be absolute');
  }
  if (process.platform === 'win32' && WINDOWS_FORBIDDEN.test(trimmed)) {
    throw new Error('path contains characters that cannot be safely quoted for cmd.exe');
  }

  // Fail fast with a useful message instead of a silent shell error later.
  await fs.access(trimmed).catch(() => {
    throw new Error('path does not exist or is not readable');
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
 * Launches one application. The returned promise settles as soon as the
 * platform opener hands off — the launched app keeps running detached, and a
 * failure here never propagates far enough to stall the renderer.
 */
async function launchApplication(rawTarget: unknown): Promise<LaunchResult> {
  const startedAt = Date.now();
  const label = typeof rawTarget === 'string' ? rawTarget : String(rawTarget);

  let target: string;
  try {
    target = await assertLaunchable(rawTarget);
  } catch (error) {
    const message = describeError(error);
    log('warn', 'launch', `rejected "${label}": ${message}`);
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
    return {
      target,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      command,
      error: message,
    };
  }
}

/**
 * Fans every requested path out concurrently. One bad path degrades to a single
 * `failed` entry in the report; the rest of the shift still completes.
 */
async function executeRealityShift(paths: unknown): Promise<RealityShiftReport> {
  const startedAt = new Date();
  const requested = Array.isArray(paths) ? paths : [];

  if (!Array.isArray(paths)) {
    log('warn', 'shift', `expected an array of paths, received ${typeof paths}`);
  }

  // Dedupe so a profile listing the same app twice does not double-launch it.
  const unique = Array.from(
    new Set(requested.map((entry) => (typeof entry === 'string' ? entry.trim() : entry))),
  );

  log('info', 'shift', `executing reality shift across ${unique.length} target(s) on ${process.platform}`);

  const settled = await Promise.allSettled(unique.map((target) => launchApplication(target)));

  const results: LaunchResult[] = settled.map((outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    return {
      target: String(unique[index]),
      status: 'failed',
      durationMs: 0,
      error: describeError(outcome.reason),
    };
  });

  const launched = results.filter((result) => result.status === 'launched').length;
  const finishedAt = new Date();

  log(
    'info',
    'shift',
    `reality shift complete — ${launched} launched, ${results.length - launched} failed in ${
      finishedAt.getTime() - startedAt.getTime()
    }ms`,
  );

  return {
    ok: results.length > 0 && launched === results.length,
    platform: process.platform,
    requested: unique.length,
    launched,
    failed: results.length - launched,
    results,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
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
/* Application shell                                                           */
/* -------------------------------------------------------------------------- */

const configStore = new ConfigStore();
const bridge = new OrchestrationBridge();
let mainWindow: BrowserWindow | null = null;

const FALLBACK_RENDERER = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><title>Monolith</title>
   <style>body{background:#0b0b0f;color:#e6e6ef;font:15px/1.6 -apple-system,Segoe UI,sans-serif;
   display:grid;place-items:center;height:100vh;margin:0}code{color:#8ab4ff}</style>
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
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
  ipcMain.handle('execute-reality-shift', async (_event, paths: unknown): Promise<RealityShiftReport> => {
    try {
      return await executeRealityShift(paths);
    } catch (error) {
      // Absolute backstop: the renderer always gets a report, never a rejection.
      const message = describeError(error);
      log('error', 'shift', 'unhandled failure during reality shift', message);
      const now = new Date().toISOString();
      return {
        ok: false,
        platform: process.platform,
        requested: Array.isArray(paths) ? paths.length : 0,
        launched: 0,
        failed: Array.isArray(paths) ? paths.length : 0,
        results: [],
        startedAt: now,
        finishedAt: now,
      };
    }
  });

  ipcMain.handle(
    'dispatch-browser-signal',
    async (_event, signal: unknown, payload?: unknown): Promise<BridgeDispatchReport> => {
      const allowed: BrowserAction[] = ['AGGRESSIVE_PURGE', 'HYDRATE_SESSION'];
      if (typeof signal !== 'string' || !allowed.includes(signal as BrowserAction)) {
        const error = `unknown browser signal "${String(signal)}"`;
        log('warn', 'bridge', error);
        return { ok: false, signal: String(signal), receivers: 0, error };
      }

      const receivers = bridge.broadcast(signal, payload);
      return {
        ok: receivers > 0,
        signal,
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
      return await configStore.write(config as MonolithConfig);
    } catch (error) {
      log('error', 'config', 'failed to persist config', describeError(error));
      return normalizeConfig(config);
    }
  });

  ipcMain.handle('system:info', async () => ({
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    bridgeUrl: `ws://${BRIDGE_HOST}:${BRIDGE_PORT}`,
  }));
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
