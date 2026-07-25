/**
 * PKCE is only worth anything if the verifier is unpredictable and the
 * challenge really is its SHA-256, so those are pinned against the RFC 7636
 * test vector rather than against our own implementation.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  EXPIRY_SKEW_MS,
  REDIRECT_URI,
  SCOPES,
  base64url,
  buildAuthorizeUrl,
  challengeFor,
  createVerifier,
  isExpired,
  statesMatch,
} from '../src/main/spotify-auth';

describe('base64url', () => {
  test('strips padding and swaps the URL-unsafe characters', () => {
    // 0xfb 0xff encodes to "+/8=" in standard base64.
    assert.equal(base64url(Buffer.from([0xfb, 0xff])), '-_8');
    assert.equal(base64url(Buffer.from('')), '');
  });

  test('output is URL-safe', () => {
    for (let i = 0; i < 50; i += 1) {
      assert.match(base64url(Buffer.from(createVerifier())), /^[A-Za-z0-9\-_]*$/);
    }
  });
});

describe('createVerifier', () => {
  test('satisfies the RFC 7636 length and charset rules', () => {
    const verifier = createVerifier();
    assert.ok(verifier.length >= 43 && verifier.length <= 128, `length was ${verifier.length}`);
    assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
  });

  test('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createVerifier()));
    assert.equal(seen.size, 200);
  });
});

describe('challengeFor', () => {
  test('matches the RFC 7636 appendix B vector', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    assert.equal(challengeFor(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('is the base64url of the SHA-256 digest, not of the verifier', () => {
    const verifier = createVerifier();
    const expected = base64url(createHash('sha256').update(verifier).digest());
    assert.equal(challengeFor(verifier), expected);
    assert.notEqual(challengeFor(verifier), base64url(Buffer.from(verifier)));
  });
});

describe('buildAuthorizeUrl', () => {
  const url = new URL(buildAuthorizeUrl('client-123', 'challenge-abc', 'state-xyz'));

  test('targets Spotify with the S256 method', () => {
    assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('response_type'), 'code');
  });

  test('carries the client, challenge, state and redirect', () => {
    assert.equal(url.searchParams.get('client_id'), 'client-123');
    assert.equal(url.searchParams.get('code_challenge'), 'challenge-abc');
    assert.equal(url.searchParams.get('state'), 'state-xyz');
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  });

  test('requests exactly the playback scopes', () => {
    assert.deepEqual(url.searchParams.get('scope')?.split(' '), SCOPES);
  });

  test('never carries a client secret', () => {
    assert.equal(url.searchParams.has('client_secret'), false);
  });
});

describe('REDIRECT_URI', () => {
  test('uses the literal loopback IP, which is what Spotify allows over http', () => {
    // "localhost" is rejected by Spotify's HTTPS rule; 127.0.0.1 is exempt.
    assert.match(REDIRECT_URI, /^http:\/\/127\.0\.0\.1:\d+\//);
    assert.equal(REDIRECT_URI.includes('localhost'), false);
  });
});

describe('statesMatch', () => {
  test('accepts an identical state', () => {
    assert.equal(statesMatch('abc123', 'abc123'), true);
  });

  test('rejects a different or truncated state', () => {
    assert.equal(statesMatch('abc123', 'abc124'), false);
    assert.equal(statesMatch('abc123', 'abc12'), false);
    assert.equal(statesMatch('abc123', ''), false);
  });
});

describe('isExpired', () => {
  const now = 1_000_000_000_000;

  test('an unset expiry counts as expired, forcing a refresh', () => {
    assert.equal(isExpired(0, now), true);
    assert.equal(isExpired(Number.NaN, now), true);
  });

  test('renews early rather than racing the clock', () => {
    // Inside the skew window: still valid by Spotify's clock, refreshed by ours.
    assert.equal(isExpired(now + EXPIRY_SKEW_MS - 1_000, now), true);
    assert.equal(isExpired(now + EXPIRY_SKEW_MS + 1_000, now), false);
  });

  test('a comfortably future expiry is usable', () => {
    assert.equal(isExpired(now + 3_600_000, now), false);
  });
});
