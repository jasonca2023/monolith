/**
 * Monolith — Hue bridge discovery and pairing.
 *
 * Setting up lights used to mean finding the bridge's IP by hand and minting a
 * developer key with a curl command out of the docs. Both are mechanical, so
 * the app does them: discover the bridge, then press the button.
 *
 * The parsing is split out from the network calls because the bridge's replies
 * are the awkward part — it answers `200 OK` with an array whose entries may be
 * errors, and "you haven't pressed the button yet" is one of those errors
 * rather than a status code.
 */

import { hostname } from 'node:os';
import { isPrivateIpv4 } from './actuators';
import type { HueBridgeCandidate } from '../shared/types';

/** Hue's official N-UPnP endpoint: matches bridges by the caller's public IP. */
const DISCOVERY_ENDPOINT = 'https://discovery.meethue.com';

const DISCOVERY_TIMEOUT_MS = 6000;
const BRIDGE_TIMEOUT_MS = 4000;

/** The bridge's own name for us. Hue requires the `app#device` shape. */
export function deviceType(): string {
  // The bridge rejects names over 40 characters, and a hostname can be long.
  return `monolith#${hostname().replace(/[^A-Za-z0-9-]/g, '').slice(0, 19) || 'desktop'}`;
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The endpoint returns `[{ id, internalipaddress, port }]`. Anything that is
 * not a private address is dropped rather than trusted — the response is
 * remote input, and it ends up in a URL we call.
 */
export function parseDiscoveryResponse(payload: unknown): HueBridgeCandidate[] {
  if (!Array.isArray(payload)) return [];

  const seen = new Set<string>();
  const bridges: HueBridgeCandidate[] = [];

  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const ip = typeof record.internalipaddress === 'string' ? record.internalipaddress.trim() : '';
    if (!ip || !isPrivateIpv4(ip) || seen.has(ip)) continue;

    seen.add(ip);
    bridges.push({
      id: typeof record.id === 'string' ? record.id : ip,
      ip,
      name: '',
      model: '',
    });
  }

  return bridges;
}

/**
 * Confirms a candidate really is a Hue bridge and names it. `/api/config` is
 * the one unauthenticated endpoint a bridge exposes, so it doubles as a probe
 * for a hand-typed address.
 */
export async function describeBridge(ip: string): Promise<{ name: string; model: string } | null> {
  if (!isPrivateIpv4(ip)) return null;

  try {
    const response = await fetch(`http://${ip}/api/config`, {
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as { name?: unknown; modelid?: unknown };
    // Every bridge reports a modelid; a random device on the LAN will not.
    if (typeof payload.modelid !== 'string') return null;

    return {
      name: typeof payload.name === 'string' ? payload.name : 'Hue bridge',
      model: payload.modelid,
    };
  } catch {
    return null;
  }
}

/** Discovers bridges, then labels each one by asking it directly. */
export async function discoverBridges(): Promise<HueBridgeCandidate[]> {
  const response = await fetch(DISCOVERY_ENDPOINT, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`discovery service returned HTTP ${response.status}`);
  }

  const candidates = parseDiscoveryResponse(await response.json());

  return Promise.all(
    candidates.map(async (candidate) => {
      const described = await describeBridge(candidate.ip);
      return described ? { ...candidate, ...described } : candidate;
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Pairing                                                                     */
/* -------------------------------------------------------------------------- */

export type PairOutcome =
  | { status: 'linked'; username: string }
  | { status: 'button-not-pressed' }
  | { status: 'error'; detail: string };

/**
 * A bridge answers `200` with a one-element array either way; error type 101 is
 * the "press the button" prompt, which is a normal step rather than a failure.
 */
export function parsePairResponse(payload: unknown): PairOutcome {
  if (!Array.isArray(payload) || payload.length === 0) {
    return { status: 'error', detail: 'bridge returned an unexpected response' };
  }

  const entry = payload[0] as Record<string, unknown>;

  const success = entry?.success as { username?: unknown } | undefined;
  if (success && typeof success.username === 'string') {
    return { status: 'linked', username: success.username };
  }

  const error = entry?.error as { type?: unknown; description?: unknown } | undefined;
  if (error) {
    if (error.type === 101) return { status: 'button-not-pressed' };
    return {
      status: 'error',
      detail: typeof error.description === 'string' ? error.description : 'bridge rejected the request',
    };
  }

  return { status: 'error', detail: 'bridge returned an unexpected response' };
}

/** One pairing attempt. Repeated by `pairWithBridge` while the user reaches the button. */
export async function requestPairing(ip: string): Promise<PairOutcome> {
  if (!isPrivateIpv4(ip)) {
    return { status: 'error', detail: `"${ip}" is not a private LAN address` };
  }

  try {
    const response = await fetch(`http://${ip}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ devicetype: deviceType() }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { status: 'error', detail: `bridge returned HTTP ${response.status}` };
    }
    return parsePairResponse(await response.json());
  } catch {
    return { status: 'error', detail: `no Hue bridge answered at ${ip}` };
  }
}

export interface PairOptions {
  /** Roughly 30 seconds at the default interval — the bridge's own link window. */
  attempts?: number;
  intervalMs?: number;
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls until the user presses the link button. Returns the minted username,
 * which is the value that goes into `hue_api_key`.
 */
export async function pairWithBridge(
  ip: string,
  { attempts = 30, intervalMs = 1000, wait = sleep }: PairOptions = {},
): Promise<PairOutcome> {
  let last: PairOutcome = { status: 'button-not-pressed' };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await requestPairing(ip);
    // Both a success and a hard error are final; only the prompt is worth retrying.
    if (last.status !== 'button-not-pressed') return last;
    if (attempt < attempts - 1) await wait(intervalMs);
  }

  return last;
}
