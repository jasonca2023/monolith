/**
 * The Hue bridge address comes out of a user-editable config and is pasted
 * straight into a URL, so the private-range check is the guard that stops a
 * hand-edited file from pointing the app at an arbitrary internet host.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isPlaceholder, isPrivateIpv4, toHueBrightness } from '../src/main/actuators';

describe('isPrivateIpv4', () => {
  test('accepts the RFC1918 ranges and loopback', () => {
    for (const address of ['10.0.0.1', '192.168.1.50', '172.16.0.1', '172.31.255.254', '127.0.0.1']) {
      assert.equal(isPrivateIpv4(address), true, `${address} should be allowed`);
    }
  });

  test('rejects public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '203.0.113.5', '172.15.0.1', '172.32.0.1']) {
      assert.equal(isPrivateIpv4(address), false, `${address} should be refused`);
    }
  });

  test('rejects hostnames, which could resolve anywhere', () => {
    for (const address of ['evil.example.com', 'localhost', '192.168.1.50.evil.com', '']) {
      assert.equal(isPrivateIpv4(address), false, `${address} should be refused`);
    }
  });

  test('rejects malformed octets', () => {
    for (const address of ['192.168.1', '192.168.1.256', '192.168.1.1.1', '192.168.01.0x1', '-1.0.0.1']) {
      assert.equal(isPrivateIpv4(address), false, `${address} should be refused`);
    }
  });

  test('allows one explicit port but not a second colon', () => {
    assert.equal(isPrivateIpv4('192.168.1.50:8080'), true);
    assert.equal(isPrivateIpv4('192.168.1.50:80:90'), false);
    assert.equal(isPrivateIpv4('192.168.1.50:abc'), false);
    assert.equal(isPrivateIpv4('192.168.1.50:0'), false);
    assert.equal(isPrivateIpv4('192.168.1.50:70000'), false);
  });

  test('tolerates surrounding whitespace from a pasted value', () => {
    assert.equal(isPrivateIpv4('  192.168.1.50  '), true);
  });
});

describe('toHueBrightness', () => {
  test('maps 0–100 onto the bridge range of 1–254', () => {
    assert.equal(toHueBrightness(100), 254);
    assert.equal(toHueBrightness(50), 127);
    // The bridge has no zero: "off" is a separate command, so the floor is 1.
    assert.equal(toHueBrightness(0), 1);
  });

  test('clamps out-of-range and non-finite input', () => {
    assert.equal(toHueBrightness(500), 254);
    assert.equal(toHueBrightness(-20), 1);
    assert.equal(toHueBrightness(Number.NaN), 254);
  });
});

describe('isPlaceholder', () => {
  test('recognises the shipped template values', () => {
    assert.equal(isPlaceholder('OAUTH_BEARER_ACCESS_TOKEN_STRING_PROTOTYPE'), true);
    assert.equal(isPlaceholder('AUTHORIZED_LOCAL_HUE_DEVELOPER_HASH'), true);
    assert.equal(isPlaceholder(''), true);
    assert.equal(isPlaceholder('   '), true);
    assert.equal(isPlaceholder(undefined), true);
  });

  test('a real credential is not a placeholder', () => {
    assert.equal(isPlaceholder('BQC4YvV0-real-token'), false);
  });
});
