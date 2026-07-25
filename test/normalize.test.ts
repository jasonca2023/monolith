/**
 * The config is user-editable and survives upgrades, so the normalizer is the
 * thing standing between a hand-typed JSON file and a crashed shell. These
 * tests pin the "never throw, always fill" contract.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clamp, normalizeConfig, normalizeProfile, toStringArray, toXyPair } from '../src/main/normalize';

describe('normalizeConfig', () => {
  test('fills a completely empty input', () => {
    const config = normalizeConfig({});
    assert.deepEqual(config.user_settings, {
      spotify_auth_token: '',
      spotify_client_id: '',
      spotify_refresh_token: '',
      spotify_token_expires_at: 0,
      hue_bridge_ip: '',
      hue_api_key: '',
    });
    assert.deepEqual(config.profiles, []);
  });

  test('survives junk instead of an object', () => {
    for (const junk of [null, undefined, 42, 'nope', []]) {
      const config = normalizeConfig(junk);
      assert.equal(config.user_settings.hue_api_key, '');
      assert.deepEqual(config.profiles, []);
    }
  });

  test('drops a non-array profiles field rather than throwing', () => {
    assert.deepEqual(normalizeConfig({ profiles: { a: 1 } }).profiles, []);
  });

  test('a config predating OAuth loads with an expiry of 0, so the token is renewed', () => {
    const legacy = normalizeConfig({
      user_settings: { spotify_auth_token: 'pasted-by-hand', hue_bridge_ip: '10.0.0.5', hue_api_key: 'k' },
    });
    assert.equal(legacy.user_settings.spotify_client_id, '');
    assert.equal(legacy.user_settings.spotify_refresh_token, '');
    assert.equal(legacy.user_settings.spotify_token_expires_at, 0);
    // The hand-pasted token is kept — it still works until it expires.
    assert.equal(legacy.user_settings.spotify_auth_token, 'pasted-by-hand');
  });

  test('a junk expiry never becomes NaN, which would poison the comparison', () => {
    for (const junk of ['soon', {}, null, -5]) {
      const value = normalizeConfig({ user_settings: { spotify_token_expires_at: junk } })
        .user_settings.spotify_token_expires_at;
      assert.equal(Number.isFinite(value), true, `${JSON.stringify(junk)} produced ${value}`);
      assert.ok(value >= 0);
    }
  });

  test('preserves real values', () => {
    const config = normalizeConfig({
      user_settings: { spotify_auth_token: 'tok', hue_bridge_ip: '192.168.1.50', hue_api_key: 'key' },
      profiles: [],
    });
    assert.equal(config.user_settings.spotify_auth_token, 'tok');
    assert.equal(config.user_settings.hue_bridge_ip, '192.168.1.50');
  });
});

describe('normalizeProfile', () => {
  test('an empty profile gets a stable generated identity', () => {
    const profile = normalizeProfile({}, 0);
    assert.equal(profile.id, 'profile_0');
    assert.equal(profile.name, 'Profile 1');
    assert.equal(profile.builtin, false);
  });

  test('a pre-blocking config still loads, defaulting the new fields', () => {
    // Exactly the shape written before block_distractions/builtin existed.
    const legacy = {
      id: 'deep_work',
      name: 'Deep Work',
      digital_purge: {
        close_browser_tabs: true,
        launch_applications: ['/Applications/iTerm.app'],
        kill_background_processes: ['Slack'],
      },
      physical_orchestration: { lights_enabled: true, hex_color: '#0000FF', brightness: 35 },
      sonic_layering: { spotify_enabled: true, playlist_uri: 'spotify:playlist:x' },
    };

    const profile = normalizeProfile(legacy, 0);
    assert.equal(profile.builtin, false);
    assert.equal(profile.digital_purge.block_distractions, false);
    assert.deepEqual(profile.digital_purge.blocked_domains, []);
    // Nothing that was present is lost.
    assert.equal(profile.id, 'deep_work');
    assert.deepEqual(profile.digital_purge.launch_applications, ['/Applications/iTerm.app']);
    assert.equal(profile.physical_orchestration.brightness, 35);
  });

  test('clamps brightness into 0–100', () => {
    assert.equal(normalizeProfile({ physical_orchestration: { brightness: 250 } }, 0).physical_orchestration.brightness, 100);
    assert.equal(normalizeProfile({ physical_orchestration: { brightness: -5 } }, 0).physical_orchestration.brightness, 0);
    assert.equal(normalizeProfile({ physical_orchestration: { brightness: 'x' } }, 0).physical_orchestration.brightness, 0);
  });

  test('strips non-string and blank entries from list fields', () => {
    const profile = normalizeProfile(
      { digital_purge: { launch_applications: ['/a.app', 42, null, '  ', '/b.app'] } },
      0,
    );
    assert.deepEqual(profile.digital_purge.launch_applications, ['/a.app', '/b.app']);
  });

  test('a malformed section falls back instead of throwing', () => {
    const profile = normalizeProfile({ digital_purge: 'not an object', sonic_layering: 7 }, 3);
    assert.deepEqual(profile.digital_purge.launch_applications, []);
    assert.equal(profile.sonic_layering.playlist_uri, '');
    assert.equal(profile.name, 'Profile 4');
  });
});

describe('toXyPair', () => {
  test('falls back to D65 white when absent or too short', () => {
    assert.deepEqual(toXyPair(undefined), [0.3127, 0.329]);
    assert.deepEqual(toXyPair([0.4]), [0.3127, 0.329]);
    assert.deepEqual(toXyPair('nope'), [0.3127, 0.329]);
  });

  test('clamps into the 0–1 gamut and keeps only two components', () => {
    assert.deepEqual(toXyPair([2, -1, 0.5]), [1, 0]);
    assert.deepEqual(toXyPair([0.157, 0.018]), [0.157, 0.018]);
  });

  test('the fallback is a fresh array, so one profile cannot mutate another', () => {
    const first = toXyPair(undefined);
    first[0] = 0.9;
    assert.deepEqual(toXyPair(undefined), [0.3127, 0.329]);
  });
});

describe('clamp', () => {
  test('non-finite input collapses to the minimum', () => {
    assert.equal(clamp(Number.NaN, 0, 100), 0);
    assert.equal(clamp(Number.POSITIVE_INFINITY, 0, 100), 0);
  });
});

describe('toStringArray', () => {
  test('non-arrays become empty', () => {
    assert.deepEqual(toStringArray(null), []);
    assert.deepEqual(toStringArray('abc'), []);
  });
});
