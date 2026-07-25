/**
 * The whole feature is "fire once, at the right minute, for the right mood" —
 * so the tests are about the two ways that goes wrong: firing repeatedly
 * because the poll interval is shorter than a minute, and staying silent (or
 * double-firing) because the scheduler's idea of "is this engaged" drifted
 * from what actually happened via a manual engage/disengage.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MoodScheduler, matches, type ScheduledProfile } from '../src/main/scheduler';

const enabledSchedule = (over: Partial<ScheduledProfile['schedule']> = {}) => ({
  enabled: true,
  engage_time: '09:00',
  disengage_time: '17:00',
  days: [] as number[],
  ...over,
});

describe('matches', () => {
  test('a disabled schedule never matches, even at the exact minute', () => {
    const schedule = enabledSchedule({ enabled: false });
    assert.equal(matches(schedule, new Date(2026, 0, 5, 9, 0), 'engage_time'), false);
  });

  test('matches the exact minute for the named field', () => {
    const schedule = enabledSchedule();
    assert.equal(matches(schedule, new Date(2026, 0, 5, 9, 0), 'engage_time'), true);
    assert.equal(matches(schedule, new Date(2026, 0, 5, 17, 0), 'disengage_time'), true);
  });

  test('a minute off in either direction does not match', () => {
    const schedule = enabledSchedule();
    assert.equal(matches(schedule, new Date(2026, 0, 5, 8, 59), 'engage_time'), false);
    assert.equal(matches(schedule, new Date(2026, 0, 5, 9, 1), 'engage_time'), false);
  });

  test('empty days means every day', () => {
    const schedule = enabledSchedule({ days: [] });
    // 2026-01-04 is a Sunday, 2026-01-05 is a Monday.
    assert.equal(matches(schedule, new Date(2026, 0, 4, 9, 0), 'engage_time'), true);
    assert.equal(matches(schedule, new Date(2026, 0, 5, 9, 0), 'engage_time'), true);
  });

  test('a named day list excludes every other day', () => {
    const schedule = enabledSchedule({ days: [1, 3, 5] }); // Mon/Wed/Fri
    assert.equal(matches(schedule, new Date(2026, 0, 5, 9, 0), 'engage_time'), true); // Monday
    assert.equal(matches(schedule, new Date(2026, 0, 6, 9, 0), 'engage_time'), false); // Tuesday
  });
});

/** A profile whose schedule fires every day at the given times. */
function profile(id: string, engage_time: string, disengage_time: string): ScheduledProfile {
  return { id, name: id, schedule: enabledSchedule({ engage_time, disengage_time }) };
}

describe('MoodScheduler', () => {
  test('fires onEngage exactly once for a matching minute, even across several polls', async () => {
    const engaged = new Set<string>();
    let engageCalls = 0;
    const scheduler = new MoodScheduler(
      async () => [profile('deep_work', '09:00', '17:00')],
      async (p) => {
        engageCalls += 1;
        engaged.add(p.id);
      },
      async () => {},
      (id) => engaged.has(id),
      20_000,
      () => new Date(2026, 0, 5, 9, 0),
    );

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    assert.equal(engageCalls, 1);
  });

  test('a mood already engaged is left alone rather than re-fired', async () => {
    let engageCalls = 0;
    const scheduler = new MoodScheduler(
      async () => [profile('deep_work', '09:00', '17:00')],
      async () => {
        engageCalls += 1;
      },
      async () => {},
      () => true, // already engaged by some other trigger
      20_000,
      () => new Date(2026, 0, 5, 9, 0),
    );

    await scheduler.tick();
    assert.equal(engageCalls, 0);
  });

  test('disengage only fires for the mood that is actually running', async () => {
    let disengageCalls = 0;
    const scheduler = new MoodScheduler(
      async () => [profile('deep_work', '09:00', '17:00')],
      async () => {},
      async () => {
        disengageCalls += 1;
      },
      () => false, // nothing engaged — a manual disengage already happened
      20_000,
      () => new Date(2026, 0, 5, 17, 0),
    );

    await scheduler.tick();
    assert.equal(disengageCalls, 0);
  });

  test('two profiles sharing an engage time both fire in the same tick', async () => {
    const firedFor: string[] = [];
    const scheduler = new MoodScheduler(
      async () => [profile('deep_work', '09:00', '17:00'), profile('brain_dump', '09:00', '12:00')],
      async (p) => {
        firedFor.push(p.id);
      },
      async () => {},
      () => false,
      20_000,
      () => new Date(2026, 0, 5, 9, 0),
    );

    await scheduler.tick();
    assert.deepEqual(firedFor.sort(), ['brain_dump', 'deep_work']);
  });

  test('the dedup set clears once the clock minute actually changes', async () => {
    let clock = new Date(2026, 0, 5, 9, 0);
    let engageCalls = 0;
    const scheduler = new MoodScheduler(
      async () => [profile('deep_work', '09:00', '17:00')],
      async () => {
        engageCalls += 1;
      },
      async () => {},
      () => false,
      20_000,
      () => clock,
    );

    await scheduler.tick(); // fires
    await scheduler.tick(); // same minute — suppressed
    clock = new Date(2026, 0, 6, 9, 0); // next day, same clock time
    await scheduler.tick(); // a new minute-key — fires again

    assert.equal(engageCalls, 2);
  });

  test('start() and stop() drive the injected scheduler, not a real timer', () => {
    let scheduledCallback: (() => void) | null = null;
    let cancelledHandle: number | null = null;
    const scheduler = new MoodScheduler(
      async () => [],
      async () => {},
      async () => {},
      () => false,
      5000,
      () => new Date(),
      (callback) => {
        scheduledCallback = callback;
        return 42;
      },
      (handle) => {
        cancelledHandle = handle;
      },
    );

    scheduler.start();
    assert.equal(scheduler.active, true);
    assert.notEqual(scheduledCallback, null);

    scheduler.stop();
    assert.equal(scheduler.active, false);
    assert.equal(cancelledHandle, 42);
  });
});
