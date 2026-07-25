/**
 * Classification decides what a mood force-quits, so a false positive here is
 * not cosmetic — it is an app closed, or opened, that the user never named.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classify,
  findByName,
  inCategory,
  nameMatches,
  type CatalogEntry,
} from '../src/main/app-catalog';

const entry = (name: string, categories: string[], process = name): CatalogEntry =>
  ({ name, path: `/Applications/${name}.app`, bundleId: '', process, categories }) as CatalogEntry;

describe('nameMatches', () => {
  test('matches on whole words only', () => {
    assert.equal(nameMatches('Microsoft Word', 'word'), true);
    // The bug this exists to prevent: a password manager filed under writing.
    assert.equal(nameMatches('Passwords', 'word'), false);
  });

  test('is case-insensitive and handles multi-word needles', () => {
    assert.equal(nameMatches('Visual Studio Code', 'visual studio code'), true);
    assert.equal(nameMatches('SLACK', 'slack'), true);
  });

  test('does not match a needle embedded in a longer word', () => {
    assert.equal(nameMatches('Mailbox Simulator', 'mail'), false);
    assert.equal(nameMatches('Mail', 'mail'), true);
  });

  test('regex metacharacters in a needle are literal', () => {
    assert.equal(nameMatches('zoom.us', 'zoom.us'), true);
    assert.equal(nameMatches('zoomxus', 'zoom.us'), false);
  });
});

describe('classify', () => {
  test('files known apps by bundle identifier', () => {
    assert.deepEqual(classify('com.apple.Notes', 'Notes'), ['writing']);
    assert.deepEqual(classify('com.valvesoftware.steam', 'Steam'), ['games']);
    assert.deepEqual(classify('com.hnc.Discord', 'Discord'), ['messaging']);
  });

  test('falls back to the display name when the bundle id is unknown', () => {
    // Cursor ships under com.todesktop.<hash>, so the name is what saves it.
    assert.ok(classify('com.todesktop.230313mzl4w4u92', 'Cursor').includes('dev'));
    assert.ok(classify('', 'Obsidian').includes('writing'));
  });

  test('the real Teams identifier lands in messaging', () => {
    assert.deepEqual(classify('com.microsoft.teams2', 'Microsoft Teams'), ['messaging']);
  });

  test('an unremarkable app matches nothing rather than guessing', () => {
    assert.deepEqual(classify('com.apple.Passwords', 'Passwords'), []);
    assert.deepEqual(classify('com.example.unknown', 'Some Utility'), []);
  });

  test('an app can belong to more than one category', () => {
    const categories = classify('com.microsoft.Excel', 'Microsoft Excel');
    assert.ok(categories.includes('productivity'));
  });
});

describe('inCategory', () => {
  const catalog = [
    entry('Steam', ['games']),
    entry('Discord', ['messaging']),
    entry('Notes', ['writing']),
  ];

  test('returns only members of the category', () => {
    assert.deepEqual(
      inCategory(catalog, 'games').map((e) => e.name),
      ['Steam'],
    );
  });

  test('an empty category is empty, not an error', () => {
    assert.deepEqual(inCategory(catalog, 'browser'), []);
  });
});

describe('findByName', () => {
  const catalog = [entry('Notes', ['writing']), entry('OneNote', ['writing']), entry('Xcode', ['dev'])];

  test('prefers an exact match over a substring one', () => {
    // "Notes" appears inside "OneNote"'s neighbourhood; exact must win.
    assert.equal(findByName(catalog, 'Notes')?.name, 'Notes');
  });

  test('falls back to a partial match', () => {
    assert.equal(findByName(catalog, 'onen')?.name, 'OneNote');
  });

  test('is case- and whitespace-insensitive', () => {
    assert.equal(findByName(catalog, '  xcode ')?.name, 'Xcode');
  });

  test('returns null rather than a wrong guess', () => {
    assert.equal(findByName(catalog, 'Photoshop'), null);
    assert.equal(findByName(catalog, '   '), null);
  });
});
