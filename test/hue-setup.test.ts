/**
 * The bridge answers 200 for both "here is your key" and "press the button
 * first", and the discovery service is remote input whose addresses end up in
 * a URL we call. Both are parsed defensively; these pin that.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  deviceType,
  pairWithBridge,
  parseDiscoveryResponse,
  parsePairResponse,
} from '../src/main/hue-setup';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('parseDiscoveryResponse', () => {
  test('keeps private addresses and carries the id', () => {
    const bridges = parseDiscoveryResponse([
      { id: 'abc123', internalipaddress: '192.168.1.50', port: 443 },
      { id: 'def456', internalipaddress: '10.0.0.7' },
    ]);

    assert.equal(bridges.length, 2);
    assert.equal(bridges[0]?.ip, '192.168.1.50');
    assert.equal(bridges[0]?.id, 'abc123');
  });

  test('drops any address that is not on a private range', () => {
    // The response is remote input; a public address here would have us calling out.
    const bridges = parseDiscoveryResponse([
      { id: 'evil', internalipaddress: '8.8.8.8' },
      { id: 'also-evil', internalipaddress: 'attacker.example.com' },
      { id: 'good', internalipaddress: '192.168.1.50' },
    ]);

    assert.deepEqual(
      bridges.map((bridge) => bridge.ip),
      ['192.168.1.50'],
    );
  });

  test('deduplicates repeated addresses', () => {
    const bridges = parseDiscoveryResponse([
      { id: 'a', internalipaddress: '192.168.1.50' },
      { id: 'b', internalipaddress: '192.168.1.50' },
    ]);
    assert.equal(bridges.length, 1);
  });

  test('junk yields an empty list rather than throwing', () => {
    for (const junk of [null, undefined, {}, 'nope', [null], [{}], [{ internalipaddress: 42 }]]) {
      assert.deepEqual(parseDiscoveryResponse(junk), []);
    }
  });

  test('falls back to the address as an id when none is given', () => {
    const [bridge] = parseDiscoveryResponse([{ internalipaddress: '172.16.0.4' }]);
    assert.equal(bridge?.id, '172.16.0.4');
  });
});

describe('parsePairResponse', () => {
  test('reads the minted username out of a success entry', () => {
    const outcome = parsePairResponse([{ success: { username: 'AbCdEf-key' } }]);
    assert.deepEqual(outcome, { status: 'linked', username: 'AbCdEf-key' });
  });

  test('error type 101 is the link-button prompt, not a failure', () => {
    const outcome = parsePairResponse([
      { error: { type: 101, address: '', description: 'link button not pressed' } },
    ]);
    assert.deepEqual(outcome, { status: 'button-not-pressed' });
  });

  test('any other error is surfaced with its description', () => {
    const outcome = parsePairResponse([{ error: { type: 7, description: 'invalid value' } }]);
    assert.equal(outcome.status, 'error');
    assert.match((outcome as { detail: string }).detail, /invalid value/);
  });

  test('junk is an error rather than a throw', () => {
    for (const junk of [null, [], {}, 'nope', [{}]]) {
      assert.equal(parsePairResponse(junk).status, 'error');
    }
  });
});

describe('deviceType', () => {
  test('uses the app#device shape the bridge requires', () => {
    assert.match(deviceType(), /^monolith#[A-Za-z0-9-]+$/);
  });

  test('stays inside the bridge’s 40-character limit', () => {
    assert.ok(deviceType().length <= 40, `was ${deviceType().length}`);
  });
});

describe('pairWithBridge', () => {
  /** Replays outcomes in order as bridge JSON bodies. */
  function stubBridge(bodies: unknown[]): { calls: () => number } {
    let index = 0;
    globalThis.fetch = (async () => {
      const body = bodies[Math.min(index, bodies.length - 1)];
      index += 1;
      return { ok: true, status: 200, json: async () => body };
    }) as unknown as typeof fetch;
    return { calls: () => index };
  }

  const noWait = async () => {};

  test('returns the key as soon as the button is pressed', async () => {
    const bridge = stubBridge([
      [{ error: { type: 101, description: 'link button not pressed' } }],
      [{ error: { type: 101, description: 'link button not pressed' } }],
      [{ success: { username: 'minted-key' } }],
    ]);

    const outcome = await pairWithBridge('192.168.1.50', { attempts: 10, wait: noWait });

    assert.deepEqual(outcome, { status: 'linked', username: 'minted-key' });
    // Stops polling the moment it succeeds.
    assert.equal(bridge.calls(), 3);
  });

  test('gives up after the link window without hanging', async () => {
    const bridge = stubBridge([[{ error: { type: 101, description: 'link button not pressed' } }]]);

    const outcome = await pairWithBridge('192.168.1.50', { attempts: 4, wait: noWait });

    assert.equal(outcome.status, 'button-not-pressed');
    assert.equal(bridge.calls(), 4);
  });

  test('a hard error stops the polling immediately', async () => {
    const bridge = stubBridge([[{ error: { type: 7, description: 'unauthorized user' } }]]);

    const outcome = await pairWithBridge('192.168.1.50', { attempts: 10, wait: noWait });

    assert.equal(outcome.status, 'error');
    assert.equal(bridge.calls(), 1, 'must not keep retrying a non-recoverable error');
  });

  test('refuses a non-private address without any request', async () => {
    const bridge = stubBridge([[{ success: { username: 'nope' } }]]);

    const outcome = await pairWithBridge('8.8.8.8', { attempts: 3, wait: noWait });

    assert.equal(outcome.status, 'error');
    assert.match((outcome as { detail: string }).detail, /not a private LAN address/);
    assert.equal(bridge.calls(), 0);
  });

  test('an unreachable bridge is described, not thrown', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const outcome = await pairWithBridge('192.168.1.50', { attempts: 2, wait: noWait });
    assert.equal(outcome.status, 'error');
    assert.match((outcome as { detail: string }).detail, /No Hue bridge answered|no Hue bridge answered/);
  });
});
