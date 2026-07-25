/**
 * The reason this feature exists: a Spotify access token dies after an hour, so
 * a 401 must renew and retry rather than surface as a failed mood. These drive
 * applyAudio against a stubbed fetch and a fake token source.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { applyAudio, type SpotifyTokenSource } from '../src/main/actuators';
import type { SonicLayering } from '../src/shared/types';

const directive: SonicLayering = {
  spotify_enabled: true,
  playlist_uri: 'spotify:playlist:abc',
  target_frequency_profile: 'Binaural Focus Waves',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replays the given statuses in order, recording the bearer token used. */
function stubFetch(statuses: number[]): { tokens: string[]; calls: () => number } {
  const tokens: string[] = [];
  let index = 0;

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    tokens.push(String(headers.authorization).replace('Bearer ', ''));
    const status = statuses[Math.min(index, statuses.length - 1)] ?? 200;
    index += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ error: { message: `stub ${status}` } }),
    };
  }) as unknown as typeof fetch;

  return { tokens, calls: () => index };
}

/** A source holding one token that becomes another after a refresh. */
function tokenSource(first: string | null, renewed: string | null = null): SpotifyTokenSource & {
  refreshes: number;
} {
  return {
    refreshes: 0,
    async getAccessToken() {
      return first;
    },
    async refresh() {
      this.refreshes += 1;
      return renewed;
    },
  };
}

describe('applyAudio', () => {
  test('plays with the current token when it is accepted', async () => {
    const fetchStub = stubFetch([204]);
    const auth = tokenSource('good-token');

    const result = await applyAudio(directive, auth);

    assert.equal(result.status, 'applied');
    assert.match(result.detail, /Binaural Focus Waves playing/);
    assert.deepEqual(fetchStub.tokens, ['good-token']);
    assert.equal(auth.refreshes, 0, 'a working token must not trigger a refresh');
  });

  test('renews once and retries when Spotify rejects the token', async () => {
    const fetchStub = stubFetch([401, 204]);
    const auth = tokenSource('stale-token', 'fresh-token');

    const result = await applyAudio(directive, auth);

    assert.equal(result.status, 'applied');
    assert.equal(auth.refreshes, 1);
    // The retry must actually use the new token, not repeat the stale one.
    assert.deepEqual(fetchStub.tokens, ['stale-token', 'fresh-token']);
  });

  test('gives up after one retry rather than looping on a persistent 401', async () => {
    const fetchStub = stubFetch([401, 401]);
    const auth = tokenSource('stale-token', 'also-bad');

    const result = await applyAudio(directive, auth);

    assert.equal(result.status, 'failed');
    assert.match(result.detail, /reconnect Spotify/);
    assert.equal(auth.refreshes, 1);
    assert.equal(fetchStub.calls(), 2);
  });

  test('reports an unrecoverable grant without retrying', async () => {
    const fetchStub = stubFetch([401]);
    const auth = tokenSource('stale-token', null);

    const result = await applyAudio(directive, auth);

    assert.equal(result.status, 'failed');
    assert.match(result.detail, /could not be renewed/);
    assert.equal(fetchStub.calls(), 1);
  });

  test('an inactive device is reported as such, not as an auth problem', async () => {
    stubFetch([404]);
    const result = await applyAudio(directive, tokenSource('good-token'));

    assert.equal(result.status, 'failed');
    assert.match(result.detail, /no active Spotify device/);
  });

  test('a free account is told Premium is required', async () => {
    stubFetch([403]);
    const result = await applyAudio(directive, tokenSource('good-token'));

    assert.equal(result.status, 'failed');
    assert.match(result.detail, /Premium required/);
  });

  test('never connected reads as not_configured, not as a failure', async () => {
    const result = await applyAudio(directive, tokenSource(null));

    assert.equal(result.status, 'not_configured');
    assert.match(result.detail, /not connected/);
  });

  test('a disabled directive short-circuits before any network call', async () => {
    const fetchStub = stubFetch([204]);
    const result = await applyAudio({ ...directive, spotify_enabled: false }, tokenSource('good'));

    assert.equal(result.status, 'disabled');
    assert.equal(fetchStub.calls(), 0);
  });

  test('a profile with no playlist is not a failure either', async () => {
    const result = await applyAudio({ ...directive, playlist_uri: '  ' }, tokenSource('good'));
    assert.equal(result.status, 'not_configured');
  });

  test('a network error is described rather than thrown', async () => {
    globalThis.fetch = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    const result = await applyAudio(directive, tokenSource('good-token'));
    assert.equal(result.status, 'failed');
    assert.match(result.detail, /Spotify unreachable/);
  });
});
