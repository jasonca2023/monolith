/**
 * Monolith — Spotify authorization (authorization code + PKCE).
 *
 * The config used to hold a hand-pasted bearer token, which Spotify expires
 * after an hour: every mood's music worked once and then failed silently until
 * the user went and fetched a new one. This module owns the grant instead, so
 * a token can be renewed without the user ever seeing it.
 *
 * PKCE rather than the classic code grant because a desktop app cannot keep a
 * client secret — anything shipped in the bundle is readable. PKCE needs no
 * secret, only proof that the client that redeemed the code is the one that
 * started the flow.
 *
 * Electron is injected (`openUrl`) rather than imported so the flow can be
 * driven from a test.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL, URLSearchParams } from 'node:url';

const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';

/**
 * Spotify requires HTTPS redirect URIs, with an explicit exception for loopback
 * addresses. It must be the literal IP — "localhost" is rejected — and it has to
 * match what is registered in the app's dashboard, hence a fixed port.
 */
export const REDIRECT_PORT = 8888;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/monolith/callback`;

/** Enough to start playback on a chosen device and to see what is active. */
export const SCOPES = ['user-read-playback-state', 'user-modify-playback-state'];

/** How long the user gets to finish in the browser before the server gives up. */
const AUTHORIZE_TIMEOUT_MS = 180_000;
const TOKEN_TIMEOUT_MS = 10_000;

export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. Treated as expired slightly early — see EXPIRY_SKEW_MS. */
  expiresAt: number;
}

/**
 * A token that expires while a request is in flight is indistinguishable from
 * a revoked one, so renew a minute early rather than racing the clock.
 */
export const EXPIRY_SKEW_MS = 60_000;

export function isExpired(expiresAt: number, now = Date.now()): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return true;
  return now >= expiresAt - EXPIRY_SKEW_MS;
}

/* -------------------------------------------------------------------------- */
/* PKCE                                                                        */
/* -------------------------------------------------------------------------- */

/** base64url per RFC 7636: base64 with +/ swapped and padding stripped. */
export function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 allows 43–128 characters; 32 random bytes encode to exactly 43. */
export function createVerifier(): string {
  return base64url(randomBytes(32));
}

export function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function buildAuthorizeUrl(clientId: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES.join(' '),
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/** Constant-time compare so the state check cannot be probed byte by byte. */
export function statesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------------- */
/* Token endpoint                                                              */
/* -------------------------------------------------------------------------- */

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload;
}

function toTokens(payload: TokenResponse, fallbackRefresh: string, now = Date.now()): SpotifyTokens {
  if (!payload.access_token) {
    throw new Error('Spotify returned no access token');
  }
  return {
    accessToken: payload.access_token,
    // A refresh response often omits refresh_token, which means "keep using
    // the one you have" rather than "you no longer have one".
    refreshToken: payload.refresh_token ?? fallbackRefresh,
    expiresAt: now + (payload.expires_in ?? 3600) * 1000,
  };
}

export async function exchangeCode(
  clientId: string,
  code: string,
  verifier: string,
): Promise<SpotifyTokens> {
  const payload = await postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  );
  return toTokens(payload, '');
}

export async function refreshTokens(clientId: string, refreshToken: string): Promise<SpotifyTokens> {
  const payload = await postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  );
  return toTokens(payload, refreshToken);
}

/* -------------------------------------------------------------------------- */
/* Loopback callback                                                           */
/* -------------------------------------------------------------------------- */

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="background:#0a0a0a;color:#e5e5e5;font:14px ui-monospace,monospace;` +
  `display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center">` +
  `<h1 style="font-size:16px;letter-spacing:.2em;text-transform:uppercase">${title}</h1>` +
  `<p style="color:#a3a3a3">${body}</p></div>`;

/**
 * Serves exactly one redirect on the loopback interface and resolves with the
 * authorization code. Rejects on timeout, on a denied consent screen, or on a
 * state mismatch — the last of which means the response did not come from the
 * flow we started.
 */
export function waitForCallback(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error: Error | null, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(code as string);
    };

    const handler = (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${REDIRECT_PORT}`);
      if (url.pathname !== '/monolith/callback') {
        response.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') ?? '';

      const fail = (message: string) => {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE('Authorization failed', message));
        finish(new Error(message));
      };

      if (error) return fail(`Spotify returned "${error}"`);
      if (!code) return fail('Spotify returned no authorization code');
      if (!statesMatch(expectedState, state)) return fail('State mismatch — response did not match this request');

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE('Spotify connected', 'You can close this tab and return to Monolith.'));
      finish(null, code);
    };

    const server = createServer(handler);

    server.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        new Error(
          error.code === 'EADDRINUSE'
            ? `port ${REDIRECT_PORT} is already in use, so the Spotify redirect cannot be received`
            : error.message,
        ),
      );
    });

    const timer = setTimeout(
      () => finish(new Error('timed out waiting for the Spotify consent screen')),
      AUTHORIZE_TIMEOUT_MS,
    );
    // Never hold the app open just because a consent screen is pending.
    timer.unref?.();

    server.listen(REDIRECT_PORT, '127.0.0.1');
  });
}

/* -------------------------------------------------------------------------- */
/* Full flow                                                                   */
/* -------------------------------------------------------------------------- */

export type OpenUrl = (url: string) => Promise<void>;

/**
 * Runs the whole grant: open the consent screen, catch the redirect, redeem the
 * code. The caller persists the result.
 */
export async function authorize(clientId: string, openUrl: OpenUrl): Promise<SpotifyTokens> {
  const trimmed = clientId.trim();
  if (!trimmed) {
    throw new Error('set spotify_client_id first — create an app at developer.spotify.com');
  }

  const verifier = createVerifier();
  const state = base64url(randomBytes(16));

  // Start listening before opening the browser, or a fast redirect races us.
  const pending = waitForCallback(state);
  await openUrl(buildAuthorizeUrl(trimmed, challengeFor(verifier), state));

  const code = await pending;
  return exchangeCode(trimmed, code, verifier);
}
