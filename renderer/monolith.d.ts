/** Shape of the preload bridge exposed by src/main/preload.ts. */

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

export interface BackendProfile {
  id: string;
  name: string;
  digital_purge: DigitalPurge;
  physical_orchestration: PhysicalOrchestration;
  sonic_layering: SonicLayering;
}

export interface MonolithConfig {
  user_settings: UserSettings;
  profiles: BackendProfile[];
}

export interface LaunchResult {
  target: string;
  status: 'launched' | 'failed';
  durationMs: number;
  error?: string;
}

export interface KillResult {
  target: string;
  status: 'terminated' | 'not_running' | 'rejected' | 'failed';
  durationMs: number;
  error?: string;
}

export interface BrowserDispatchResult {
  signal: 'AGGRESSIVE_PURGE' | 'HYDRATE_SESSION' | 'NONE';
  ok: boolean;
  receivers: number;
  error?: string;
}

export type ActuationStatus = 'applied' | 'disabled' | 'not_configured' | 'failed';

export interface ActuationResult {
  status: ActuationStatus;
  detail: string;
  durationMs: number;
}

export interface RealityShiftReport {
  ok: boolean;
  profileId: string;
  profileName: string;
  platform: string;
  applications: { requested: number; launched: number; failed: number; results: LaunchResult[] };
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
  physical_result: ActuationResult;
  sonic_result: ActuationResult;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  errors: string[];
}

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

export interface MonolithApi {
  executeRealityShift(profilePayload: unknown): Promise<RealityShiftReport>;
  dispatchBrowserSignal(
    signal: 'AGGRESSIVE_PURGE' | 'HYDRATE_SESSION',
    payload?: unknown,
  ): Promise<BrowserDispatchResult>;
  readConfig(): Promise<MonolithConfig>;
  writeConfig(config: MonolithConfig): Promise<MonolithConfig>;
  systemInfo(): Promise<SystemInfo>;
  onBridgeEvent(listener: (event: BridgeEvent) => void): () => void;
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
  };
}

declare global {
  interface Window {
    /** Absent when the renderer is opened outside the Electron shell. */
    monolith?: MonolithApi;
  }
}
