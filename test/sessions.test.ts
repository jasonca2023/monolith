/**
 * summarizeSessions is what turns raw history into the numbers a user sees,
 * and the one thing worth getting precisely right is the streak: it has to
 * be judged by the user's own calendar day, and a day with nothing logged
 * yet must not read as a broken streak before that day is even over.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { summarizeSessions, trimSessions, type SessionRecord } from '../src/main/sessions';

const MINUTE = 60_000;

function session(daysAgo: number, minutes: number, appsBlocked = 0): SessionRecord {
  const started = new Date();
  started.setDate(started.getDate() - daysAgo);
  started.setHours(10, 0, 0, 0);
  const durationMs = minutes * MINUTE;
  return {
    profileId: 'deep_work',
    profileName: 'Deep Work',
    startedAt: started.toISOString(),
    endedAt: new Date(started.getTime() + durationMs).toISOString(),
    durationMs,
    appsBlocked,
  };
}

describe('summarizeSessions', () => {
  test('an empty history is all zeros, not an error', () => {
    const stats = summarizeSessions([]);
    assert.deepEqual(stats, {
      totalSessions: 0,
      totalFocusMinutes: 0,
      totalBlocks: 0,
      todayMinutes: 0,
      streakDays: 0,
    });
  });

  test('totals sum minutes and blocks across every session', () => {
    const stats = summarizeSessions([session(0, 25, 3), session(1, 15, 2)]);
    assert.equal(stats.totalSessions, 2);
    assert.equal(stats.totalFocusMinutes, 40);
    assert.equal(stats.totalBlocks, 5);
  });

  test('today only counts sessions that started today', () => {
    const stats = summarizeSessions([session(0, 20), session(1, 45), session(2, 10)]);
    assert.equal(stats.todayMinutes, 20);
  });

  test('a streak with a session every day counts consecutively', () => {
    const stats = summarizeSessions([session(0, 10), session(1, 10), session(2, 10)]);
    assert.equal(stats.streakDays, 3);
  });

  test('a gap breaks the streak at the gap, not before it', () => {
    // Today and yesterday logged, then a gap at day 2 — streak is 2, not 0.
    const stats = summarizeSessions([session(0, 10), session(1, 10), session(3, 10)]);
    assert.equal(stats.streakDays, 2);
  });

  test('no session yet today still shows yesterday\'s streak as current', () => {
    const stats = summarizeSessions([session(1, 10), session(2, 10)]);
    assert.equal(stats.streakDays, 2);
  });

  test('nothing today or yesterday reads as a broken streak', () => {
    const stats = summarizeSessions([session(3, 10), session(4, 10)]);
    assert.equal(stats.streakDays, 0);
  });

  test('multiple sessions on the same day count once toward the streak', () => {
    const stats = summarizeSessions([session(0, 10), session(0, 15)]);
    assert.equal(stats.streakDays, 1);
    assert.equal(stats.todayMinutes, 25);
  });
});

describe('trimSessions', () => {
  test('leaves a short history untouched', () => {
    const short = [session(0, 5), session(1, 5)];
    assert.equal(trimSessions(short, 500).length, 2);
  });

  test('keeps only the most recent entries once over the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => session(i, 5));
    const trimmed = trimSessions(many, 3);
    assert.equal(trimmed.length, 3);
    // The array is oldest-first, so the tail is the most recent three.
    assert.deepEqual(trimmed, many.slice(7));
  });
});
