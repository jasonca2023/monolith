/**
 * Monolith — the contract shared by the main process, the preload bridge and
 * the renderer.
 *
 * Every type crossing the IPC boundary lives here and nowhere else. The
 * renderer used to redeclare the config schema by hand, which meant a field
 * added to a profile had to be typed twice and could silently disagree.
 *
 * This module must stay **types only, with no imports**. The renderer compiles
 * with `types: ["vite/client"]` and no `@types/node`, so anything referencing
 * `NodeJS.*` or an Electron type would not resolve there.
 */

/* -------------------------------------------------------------------------- */
/* Config schema — the shape of monolith_config.json                           */
/* -------------------------------------------------------------------------- */

export interface UserSettings {
  /**
   * The current access token. Spotify expires these after an hour, so this is
   * a cache written by the refresh flow, not something the user maintains.
   */
  spotify_auth_token: string;
  /** From developer.spotify.com. Public by design — PKCE needs no secret. */
  spotify_client_id: string;
  /** The long-lived half of the grant. This is the credential worth keeping. */
  spotify_refresh_token: string;
  /** Epoch ms for `spotify_auth_token`; 0 when unknown, which forces a refresh. */
  spotify_token_expires_at: number;
  hue_bridge_ip: string;
  hue_api_key: string;
}

/** Outcome of the interactive Spotify grant, reported back to the deck. */
export interface SpotifyAuthResult {
  ok: boolean;
  detail: string;
}

/** A bridge found on the LAN, labelled by asking it for its own config. */
export interface HueBridgeCandidate {
  id: string;
  ip: string;
  name: string;
  model: string;
}

export interface HueDiscoveryResult {
  ok: boolean;
  detail: string;
  bridges: HueBridgeCandidate[];
}

/** `pending` means the link-button window elapsed without a press. */
export interface HuePairResult {
  ok: boolean;
  status: 'linked' | 'pending' | 'failed';
  detail: string;
}

/** The user's own numbers, next to the "Why this matters" research citations. */
export interface SessionStats {
  totalSessions: number;
  totalFocusMinutes: number;
  totalBlocks: number;
  todayMinutes: number;
  streakDays: number;
}

/**
 * Categories a mood can name instead of individual apps. Resolved against what
 * is actually installed at shift time, so "quit every game" travels between
 * machines in a way a list of absolute paths never could.
 */
export type AppCategory =
  | 'games'
  | 'messaging'
  | 'writing'
  | 'productivity'
  | 'dev'
  | 'browser'
  | 'media';

export interface DigitalPurge {
  close_browser_tabs: boolean;
  launch_applications: string[];
  kill_background_processes: string[];
  /** Apps to open by name, resolved through discovery — "Notes", not a path. */
  launch_app_names: string[];
  /** Categories to open. Capped by `launch_category_limit`. */
  launch_categories: AppCategory[];
  /** How many apps to open per category. 0 means every one installed. */
  launch_category_limit: number;
  /** URLs opened in the default browser: a Figma file, a Spotify playlist. */
  launch_urls: string[];
  /** Categories to quit. Expanded to real process names via CFBundleExecutable. */
  kill_categories: AppCategory[];
  /** Escalate to SIGKILL for anything still alive after SIGTERM. */
  force_quit: boolean;
  /** Arms the extension's redirect blockade for this mood. */
  block_distractions: boolean;
  /** Domains the blockade covers. Empty falls back to the worker's defaults. */
  blocked_domains: string[];
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

/** A mood can run itself on a timer. Times are "HH:MM" in the user's local time. */
export interface Schedule {
  enabled: boolean;
  engage_time: string;
  disengage_time: string;
  /** 0 (Sunday) – 6 (Saturday). Empty means every day. */
  days: number[];
}

export interface Profile {
  id: string;
  name: string;
  /** Ships with the app. Editable, but restored if the user removes them all. */
  builtin: boolean;
  digital_purge: DigitalPurge;
  physical_orchestration: PhysicalOrchestration;
  sonic_layering: SonicLayering;
  schedule: Schedule;
}

export interface MonolithConfig {
  user_settings: UserSettings;
  profiles: Profile[];
}

/* -------------------------------------------------------------------------- */
/* Actuation outcomes                                                          */
/* -------------------------------------------------------------------------- */

export type ActuationStatus = 'applied' | 'disabled' | 'not_configured' | 'failed';

export interface ActuationResult {
  status: ActuationStatus;
  detail: string;
  durationMs: number;
}

export type FocusStatus = 'applied' | 'unsupported' | 'failed';

export interface FocusResult {
  status: FocusStatus;
  detail: string;
  durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* Shift results                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `NodeJS.Platform`, spelled out because the renderer has no node types.
 * `process.platform` must stay assignable to this, so it is a superset.
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32';

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
  platform: Platform;
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
  /** Outcome of the actual Hue call. */
  physical_result: ActuationResult;
  /** Outcome of the actual Spotify call. */
  sonic_result: ActuationResult;
  /** Outcome of the OS Do Not Disturb / Focus Assist toggle. */
  focus_result: FocusResult;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  errors: string[];
}

export interface DisengageReport {
  ok: boolean;
  profileId: string;
  focus_result: FocusResult;
  physical_result: ActuationResult;
  browser: BrowserDispatchResult;
  durationMs: number;
  errors: string[];
}

/* -------------------------------------------------------------------------- */
/* Bridge surface                                                              */
/* -------------------------------------------------------------------------- */

/** Envelope relayed from the extension service worker over `bridge:event`. */
export interface BridgeEvent {
  type: string;
  payload?: Record<string, unknown>;
  issuedAt?: string;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  electron: string;
  node: string;
  bridgeUrl: string;
}

/**
 * The only surface the renderer gets. Implemented by src/main/preload.ts and
 * consumed through `window.monolith`, so both sides typecheck against one
 * declaration rather than two that happen to look alike.
 */
export interface MonolithApi {
  /** Accepts a full profile object, a profile id, or a bare array of app paths. */
  executeRealityShift(profilePayload: unknown): Promise<RealityShiftReport>;
  /** Exit sequence: OS focus off, lights to neutral white, session rehydrated. */
  executeDisengage(profileId: string): Promise<DisengageReport>;
  dispatchBrowserSignal(
    signal: BrowserSignal,
    payload?: unknown,
  ): Promise<BrowserDispatchResult>;
  readConfig(): Promise<MonolithConfig>;
  writeConfig(config: MonolithConfig): Promise<MonolithConfig>;
  systemInfo(): Promise<SystemInfo>;
  /** Opens a native file picker; returns [] if the user cancels. */
  pickApplications(): Promise<string[]>;
  /** Runs the Spotify consent flow in the system browser and stores the grant. */
  authorizeSpotify(): Promise<SpotifyAuthResult>;
  /** Finds Hue bridges on the local network. */
  discoverHueBridges(): Promise<HueDiscoveryResult>;
  /** Waits for the bridge's link button, then stores the minted key. */
  pairHueBridge(ip: string): Promise<HuePairResult>;
  /** Aggregates the user's own session history — no research citation needed. */
  readStats(): Promise<SessionStats>;
  onBridgeEvent(listener: (event: BridgeEvent) => void): () => void;
  /** The shell is frameless, so the renderer owns the window controls. */
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
  };
}
