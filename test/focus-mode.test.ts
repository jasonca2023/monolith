/**
 * A hung `shortcuts run` is the one failure that can make the whole app look
 * frozen, because a shift's report waits for the slowest of its five tracks.
 * exec signals a timeout by killing the child rather than through any distinct
 * error code, so this is the discrimination the advice hangs off.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { shortcutUrl, timedOut } from '../src/main/focus-mode';
import { quotePosix } from '../src/main/safety';

describe('timedOut', () => {
  test('recognises the shape exec produces when it kills a hung child', () => {
    assert.equal(timedOut({ killed: true, signal: 'SIGTERM', code: null }), true);
  });

  test('recognises a kill by signal alone', () => {
    assert.equal(timedOut({ signal: 'SIGTERM' }), true);
    assert.equal(timedOut({ signal: 'SIGKILL' }), true);
  });

  test('a command that ran and failed is not a timeout', () => {
    // The shortcut existed and executed, but errored — different advice entirely.
    assert.equal(timedOut({ killed: false, code: 1, signal: null }), false);
    assert.equal(timedOut(new Error('shortcuts: no such shortcut')), false);
  });

  test('junk never reads as a timeout', () => {
    for (const junk of [null, undefined, 'SIGTERM', 42, {}]) {
      assert.equal(timedOut(junk), false, `${String(junk)} should not be a timeout`);
    }
  });

  test('killed must be exactly true, not merely truthy', () => {
    assert.equal(timedOut({ killed: 'yes' }), false);
    assert.equal(timedOut({ killed: 1 }), false);
  });
});

describe('shortcutUrl', () => {
  test('percent-encodes the spaces in a shortcut name', () => {
    assert.equal(
      shortcutUrl('Monolith Focus On'),
      'shortcuts://run-shortcut?name=Monolith%20Focus%20On',
    );
  });

  test('a name cannot smuggle extra query parameters', () => {
    // & and = must not survive as URL syntax, or a shortcut name could append
    // its own parameters to the request.
    const url = shortcutUrl('Evil&input=pwned');
    assert.equal(url.includes('&input='), false);
    assert.match(url, /name=Evil%26input%3Dpwned$/);
  });

  test('an apostrophe survives encoding, so the shell quoting is load-bearing', () => {
    // encodeURIComponent leaves ' alone — it is in the unreserved set. The URL
    // reaches a shell, so quotePosix is what actually makes this safe, not the
    // encoding. Asserted here so nobody later "simplifies" that wrapper away.
    assert.equal(shortcutUrl("it's").includes("'"), true);
    assert.equal(quotePosix(shortcutUrl("it's")).includes(`'\\''`), true);
  });
});
