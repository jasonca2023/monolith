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
