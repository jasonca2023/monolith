/**
 * Monolith — config normalization.
 *
 * The config on disk is user-editable and survives app upgrades, so it is
 * treated as untrusted input: every field is filled, coerced and clamped on
 * read. A missing section, a string where a number belongs, or a profile from
 * an older schema all normalize instead of throwing, which is what lets the
 * shell boot against a hand-edited or out-of-date file.
 *
 * Kept free of Electron so it can be tested directly.
 */

import type {
  AppCategory,
  DigitalPurge,
  MonolithConfig,
  PhysicalOrchestration,
  Profile,
  Schedule,
  SonicLayering,
  UserSettings,
} from '../shared/types';

/** D65 white — the fallback when a profile carries no usable chromaticity. */
const NEUTRAL_XY: [number, number] = [0.3127, 0.329];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

const CATEGORIES = new Set<AppCategory>([
  'games',
  'messaging',
  'writing',
  'productivity',
  'dev',
  'browser',
  'media',
]);

/**
 * Drops anything that is not a category we know how to resolve. An unknown
 * string here would silently match no apps, which reads as "the mood did
 * nothing" rather than "the config has a typo".
 */
export function toCategories(value: unknown): AppCategory[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<AppCategory>();
  for (const entry of value) {
    if (typeof entry === 'string' && CATEGORIES.has(entry as AppCategory)) {
      seen.add(entry as AppCategory);
    }
  }
  return [...seen];
}

/** CIE 1931 xy coordinates are always a two-element pair inside the gamut. */
export function toXyPair(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length < 2) return [...NEUTRAL_XY];
  return [clamp(Number(value[0]), 0, 1), clamp(Number(value[1]), 0, 1)];
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normalizeTime(value: unknown, fallback: string): string {
  return typeof value === 'string' && TIME_PATTERN.test(value) ? value : fallback;
}

/** A config predating scheduling has no `schedule` block at all; disabled is the safe default. */
export function normalizeSchedule(input: unknown): Schedule {
  const source = (isRecord(input) ? input : {}) as Partial<Schedule>;
  const days = Array.isArray(source.days)
    ? [...new Set(source.days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    : [];

  return {
    enabled: Boolean(source.enabled ?? false),
    engage_time: normalizeTime(source.engage_time, '09:00'),
    disengage_time: normalizeTime(source.disengage_time, '17:00'),
    days,
  };
}

/** Fills every field so a hand-edited config can never crash the shell. */
export function normalizeConfig(input: unknown): MonolithConfig {
  const source = (isRecord(input) ? input : {}) as Partial<MonolithConfig>;
  const settings = (isRecord(source.user_settings) ? source.user_settings : {}) as Partial<UserSettings>;

  return {
    user_settings: {
      spotify_auth_token: String(settings.spotify_auth_token ?? ''),
      spotify_client_id: String(settings.spotify_client_id ?? ''),
      spotify_refresh_token: String(settings.spotify_refresh_token ?? ''),
      // A config predating the OAuth flow has no expiry; 0 reads as "expired",
      // so the stale hand-pasted token is refreshed rather than trusted.
      spotify_token_expires_at: Math.max(0, Number(settings.spotify_token_expires_at ?? 0) || 0),
      hue_bridge_ip: String(settings.hue_bridge_ip ?? ''),
      hue_api_key: String(settings.hue_api_key ?? ''),
    },
    profiles: Array.isArray(source.profiles) ? source.profiles.map(normalizeProfile) : [],
  };
}

export function normalizeProfile(input: unknown, index: number): Profile {
  const source = (isRecord(input) ? input : {}) as Partial<Profile>;
  const purge = (isRecord(source.digital_purge) ? source.digital_purge : {}) as Partial<DigitalPurge>;
  const physical = (isRecord(source.physical_orchestration)
    ? source.physical_orchestration
    : {}) as Partial<PhysicalOrchestration>;
  const sonic = (isRecord(source.sonic_layering) ? source.sonic_layering : {}) as Partial<SonicLayering>;

  return {
    id: String(source.id ?? `profile_${index}`),
    name: String(source.name ?? `Profile ${index + 1}`),
    builtin: Boolean(source.builtin ?? false),
    digital_purge: {
      close_browser_tabs: Boolean(purge.close_browser_tabs ?? false),
      launch_applications: toStringArray(purge.launch_applications),
      kill_background_processes: toStringArray(purge.kill_background_processes),
      launch_app_names: toStringArray(purge.launch_app_names),
      launch_categories: toCategories(purge.launch_categories),
      // 0 means "every installed app in the category"; the default of 2 keeps a
      // mood asking for writing apps from opening eight of them.
      launch_category_limit: clamp(Number(purge.launch_category_limit ?? 2), 0, 20),
      launch_urls: toStringArray(purge.launch_urls),
      kill_categories: toCategories(purge.kill_categories),
      force_quit: Boolean(purge.force_quit ?? false),
      block_distractions: Boolean(purge.block_distractions ?? false),
      blocked_domains: toStringArray(purge.blocked_domains),
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
    schedule: normalizeSchedule(source.schedule),
  };
}
