/**
 * Monolith — physical and sonic actuators.
 *
 * Turns the `physical_orchestration` and `sonic_layering` blocks of a profile
 * into real network calls: a Philips Hue group command on the LAN and a
 * Spotify Web API playback command.
 *
 * Both are best-effort. Neither can fail a reality shift — an unreachable
 * bridge or an expired token comes back as a described result, never a throw.
 */

import type {
  ActuationResult,
  ActuationStatus,
  PhysicalOrchestration,
  SonicLayering,
  UserSettings,
} from '../shared/types';

const HUE_TIMEOUT_MS = 4000;
const SPOTIFY_TIMEOUT_MS = 6000;
const SPOTIFY_API = 'https://api.spotify.com/v1';

/** Values shipped in the template — present, but not real credentials. */
const PLACEHOLDERS = new Set([
  'OAUTH_BEARER_ACCESS_TOKEN_STRING_PROTOTYPE',
  'AUTHORIZED_LOCAL_HUE_DEVELOPER_HASH',
  '',
]);

export type { ActuationResult, ActuationStatus } from '../shared/types';

export function isPlaceholder(value: string | undefined): boolean {
  return value === undefined || PLACEHOLDERS.has(value.trim());
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
    return error.message;
  }
  return String(error);
}

/**
 * A Hue bridge lives on the LAN. Restricting the target to private ranges stops
 * a hand-edited config from pointing the app at an arbitrary internet host.
 */
export function isPrivateIpv4(candidate: string): boolean {
  // An explicit port is allowed; a Hue bridge answers on 80, but a proxied or
  // emulated bridge may not.
  const [host, port, ...rest] = candidate.trim().split(':');
  if (rest.length > 0) return false;
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return false;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return false;

  const parts = (host ?? '').split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return -1;
    return Number(part);
  });
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;

  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Hue                                                                         */
/* -------------------------------------------------------------------------- */

/** Config carries 0–100; the Hue API wants 1–254. */
export function toHueBrightness(percent: number): number {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 100));
  return Math.max(1, Math.round((clamped / 100) * 254));
}

export async function applyLighting(
  directive: PhysicalOrchestration,
  settings: UserSettings,
  transitionMs = 500,
): Promise<ActuationResult> {
  const startedAt = Date.now();
  const done = (status: ActuationStatus, detail: string): ActuationResult => ({
    status,
    detail,
    durationMs: Date.now() - startedAt,
  });

  if (!directive.lights_enabled) {
    return done('disabled', 'lights_enabled is false for this profile');
  }
  if (isPlaceholder(settings.hue_api_key) || isPlaceholder(settings.hue_bridge_ip)) {
    return done('not_configured', 'set hue_bridge_ip and hue_api_key in monolith_config.json');
  }
  if (!isPrivateIpv4(settings.hue_bridge_ip)) {
    return done('failed', `hue_bridge_ip "${settings.hue_bridge_ip}" is not a private LAN address`);
  }

  // Group 0 is the built-in "all lights" group on every bridge.
  const url = `http://${settings.hue_bridge_ip}/api/${encodeURIComponent(settings.hue_api_key)}/groups/0/action`;
  const body = {
    on: true,
    bri: toHueBrightness(directive.brightness),
    xy: directive.hue_xy_payload,
    transitiontime: Math.max(0, Math.round(transitionMs / 100)),
  };

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HUE_TIMEOUT_MS),
    });

    if (!response.ok) {
      return done('failed', `bridge returned HTTP ${response.status}`);
    }

    // The bridge answers 200 with a per-command array; errors hide inside it.
    const payload = (await response.json()) as Array<Record<string, unknown>>;
    const firstError = Array.isArray(payload)
      ? payload.find((entry) => entry && typeof entry === 'object' && 'error' in entry)
      : undefined;

    if (firstError) {
      const description = (firstError.error as { description?: string } | undefined)?.description;
      return done('failed', `bridge rejected the command: ${description ?? 'unknown error'}`);
    }

    return done(
      'applied',
      `${directive.hex_color} at ${directive.brightness}% on ${settings.hue_bridge_ip}`,
    );
  } catch (error) {
    return done('failed', `bridge unreachable: ${describe(error)}`);
  }
}

/** D65 white — the "Neutral State" the room returns to on disengage. */
const NEUTRAL_WHITE: [number, number] = [0.3127, 0.329];

/**
 * Restores standard white ambient illumination. Shares the transport with
 * applyLighting so a disengage reports failures the same way an engage does.
 */
export async function restoreLighting(settings: UserSettings): Promise<ActuationResult> {
  return applyLighting(
    {
      lights_enabled: true,
      hex_color: '#FFFFFF',
      brightness: 100,
      hue_xy_payload: NEUTRAL_WHITE,
    },
    settings,
  );
}

/* -------------------------------------------------------------------------- */
/* Spotify                                                                     */
/* -------------------------------------------------------------------------- */

async function spotifyRequest(
  token: string,
  path: string,
  init: { method: string; body?: string },
): Promise<{ ok: boolean; status: number; detail: string }> {
  const response = await fetch(`${SPOTIFY_API}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: init.body,
    signal: AbortSignal.timeout(SPOTIFY_TIMEOUT_MS),
  });

  if (response.ok) return { ok: true, status: response.status, detail: '' };

  // Spotify returns a JSON error envelope on failure; fall back to the status.
  let detail = `HTTP ${response.status}`;
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    if (payload.error?.message) detail = payload.error.message;
  } catch {
    // Body was empty or not JSON — the status line is all we have.
  }
  return { ok: false, status: response.status, detail };
}

/**
 * Supplies access tokens and renews them. Implemented in main.ts against the
 * config store; injected here so this module neither reads nor writes config,
 * and so the 401-retry path can be tested without a network.
 */
export interface SpotifyTokenSource {
  /** A usable token, or null when Spotify has never been connected. */
  getAccessToken(): Promise<string | null>;
  /** Forces a renewal after a rejection. Null when the grant is unrecoverable. */
  refresh(): Promise<string | null>;
}

/**
 * Hands a `spotify:` URI to the desktop client. Injected rather than imported
 * so this module stays free of platform shelling and stays testable.
 * Resolves false when the handoff could not be made.
 */
export type SpotifyHandoff = (playlistUri: string) => Promise<boolean>;

export async function applyAudio(
  directive: SonicLayering,
  auth: SpotifyTokenSource,
  handoff?: SpotifyHandoff,
): Promise<ActuationResult> {
  const startedAt = Date.now();
  const done = (status: ActuationStatus, detail: string): ActuationResult => ({
    status,
    detail,
    durationMs: Date.now() - startedAt,
  });

  if (!directive.spotify_enabled) {
    return done('disabled', 'spotify_enabled is false for this profile');
  }
  if (!directive.playlist_uri.trim()) {
    return done('not_configured', 'this profile has no playlist_uri');
  }

  try {
    let token = await auth.getAccessToken();

    // Without a grant there is still a way to start music: handing the URI to
    // the desktop client opens the playlist and plays it. It needs no token, no
    // developer app and no Premium account, which is the difference between a
    // mood that plays music on any machine and one that only plays after a
    // five-minute OAuth setup. The Web API is still preferred when connected —
    // only it can report what actually happened.
    if (!token) {
      if (!handoff) {
        return done(
          'not_configured',
          'Spotify is not connected — authorize it from the credentials panel',
        );
      }

      const opened = await handoff(directive.playlist_uri);
      if (!opened) {
        return done('failed', 'could not hand the playlist to the Spotify app');
      }

      const label = directive.target_frequency_profile || directive.playlist_uri;
      return done(
        'applied',
        `opened ${label} in the Spotify app (no API token, so playback is unconfirmed)`,
      );
    }

    const play = () =>
      spotifyRequest(token as string, '/me/player/play', {
        method: 'PUT',
        body: JSON.stringify({ context_uri: directive.playlist_uri }),
      });

    let result = await play();

    // An access token can expire between the pre-flight check and this call,
    // and a token revoked from Spotify's side looks identical. One renewal and
    // one retry covers both without looping.
    if (!result.ok && result.status === 401) {
      const renewed = await auth.refresh();
      if (!renewed) {
        return done('failed', 'Spotify rejected the token and it could not be renewed — reconnect Spotify');
      }
      token = renewed;
      result = await play();
    }

    if (!result.ok) {
      if (result.status === 404) {
        return done('failed', 'no active Spotify device — open Spotify and start playing once');
      }
      if (result.status === 401) {
        return done('failed', 'Spotify rejected the renewed token — reconnect Spotify');
      }
      if (result.status === 403) {
        return done('failed', `Spotify refused playback (Premium required): ${result.detail}`);
      }
      return done('failed', result.detail);
    }

    const label = directive.target_frequency_profile || directive.playlist_uri;
    return done('applied', `${label} playing`);
  } catch (error) {
    return done('failed', `Spotify unreachable: ${describe(error)}`);
  }
}
