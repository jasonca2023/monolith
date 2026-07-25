/**
 * The auth session — never the password — lives in this file-backed store,
 * so the one thing worth pinning is that it round-trips correctly and
 * survives the process restarting with a cold cache.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createFileStorage } from '../src/main/cloud';

describe('createFileStorage', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'monolith-auth-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a key that was never set reads back as null, not an error', async () => {
    const storage = createFileStorage(path.join(dir, 'a.json'));
    assert.equal(await storage.getItem('sb-session'), null);
  });

  test('setItem then getItem round-trips the value', async () => {
    const storage = createFileStorage(path.join(dir, 'b.json'));
    await storage.setItem('sb-session', '{"access_token":"abc"}');
    assert.equal(await storage.getItem('sb-session'), '{"access_token":"abc"}');
  });

  test('a fresh instance reads what a previous one wrote — the whole point of persisting it', async () => {
    const file = path.join(dir, 'c.json');
    await createFileStorage(file).setItem('sb-session', 'token-1');

    const reopened = createFileStorage(file);
    assert.equal(await reopened.getItem('sb-session'), 'token-1');
  });

  test('removeItem clears only the named key', async () => {
    const storage = createFileStorage(path.join(dir, 'd.json'));
    await storage.setItem('sb-session', 'keep-me');
    await storage.setItem('other-key', 'also-keep');
    await storage.removeItem('sb-session');

    assert.equal(await storage.getItem('sb-session'), null);
    assert.equal(await storage.getItem('other-key'), 'also-keep');
  });

  test('signing out (removeItem) is itself durable across a fresh instance', async () => {
    const file = path.join(dir, 'e.json');
    const storage = createFileStorage(file);
    await storage.setItem('sb-session', 'token');
    await storage.removeItem('sb-session');

    assert.equal(await createFileStorage(file).getItem('sb-session'), null);
  });
});
