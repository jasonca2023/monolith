/**
 * Shape of monolith_config.json.
 *
 * Kept in its own module so the actuators can share it with the main process
 * without importing main.ts, which owns the app lifecycle side effects.
 */

export interface UserSettings {
  spotify_auth_token: string;
  hue_bridge_ip: string;
  hue_api_key: string;
}

export interface DigitalPurge {
  close_browser_tabs: boolean;
  launch_applications: string[];
  kill_background_processes: string[];
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

export interface Schedule {
  enabled: boolean;
  /** 24h local time, "HH:MM". */
  engage_time: string;
  /** 24h local time, "HH:MM". */
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
