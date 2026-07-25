/**
 * The whole feature is "reopen it and it dies again," so the tests are about
 * the interval state machine: does it actually re-kill, does it stay quiet
 * when there's nothing to kill, and — the one that would be an invisible bug
 * in production — does stop() really stop, even mid-sweep.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ProcessBlockade, type Canceller, type KillFn, type Scheduler } from '../src/main/blockade';

/** Drains pending microtasks — enough ticks to let an async for-loop settle. */
const flush = async (times = 15): Promise<void> => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A scheduler the test drives by hand instead of real timers. */
function fakeScheduler() {
  let pending: (() => void) | null = null;
  let nextHandle = 0;
  const cancelled: number[] = [];
  const delays: number[] = [];

  const schedule: Scheduler = (callback, delayMs) => {
    pending = callback;
    delays.push(delayMs);
    return ++nextHandle;
  };
  const cancel: Canceller = (handle) => {
    cancelled.push(handle);
    pending = null;
  };

  /** Fires the pending tick (if any) and waits for its async work to settle. */
  const tick = async (): Promise<boolean> => {
    const callback = pending;
    pending = null;
    if (!callback) return false;
    callback();
    await flush();
    return true;
  };

  return { schedule, cancel, tick, cancelled, delays, hasPending: () => pending !== null };
}

describe('ProcessBlockade', () => {
  test('does nothing for an empty target list', () => {
    const scheduler = fakeScheduler();
    const kill: KillFn = async () => ({ status: 'terminated' });
    const blockade = new ProcessBlockade(kill, () => {}, 3000, scheduler.schedule, scheduler.cancel);

    blockade.start([], false);

    assert.equal(blockade.active, false);
    assert.equal(scheduler.hasPending(), false);
  });

  test('re-kills every target on each tick and reports the ones that actually terminated', async () => {
    const scheduler = fakeScheduler();
    const calls: Array<{ target: string; force: boolean }> = [];
    const kill: KillFn = async (target, force) => {
      calls.push({ target, force });
      return { status: target === 'Slack' ? 'terminated' : 'not_running' };
    };
    const reKilled: string[] = [];
    const blockade = new ProcessBlockade(kill, (t) => reKilled.push(t), 3000, scheduler.schedule, scheduler.cancel);

    blockade.start(['Slack', 'Discord'], true);
    assert.equal(blockade.active, true);

    await scheduler.tick();

    assert.deepEqual(calls, [
      { target: 'Slack', force: true },
      { target: 'Discord', force: true },
    ]);
    // Only the target that was actually still open gets surfaced.
    assert.deepEqual(reKilled, ['Slack']);
  });

  test('reschedules after a sweep, so the blockade keeps enforcing', async () => {
    const scheduler = fakeScheduler();
    const kill: KillFn = async () => ({ status: 'not_running' });
    const blockade = new ProcessBlockade(kill, () => {}, 3000, scheduler.schedule, scheduler.cancel);

    blockade.start(['Steam'], false);
    await scheduler.tick();

    assert.equal(scheduler.hasPending(), true, 'must queue the next sweep');
    assert.deepEqual(scheduler.delays, [3000, 3000]);
  });

  test('stop() cancels the pending tick and prevents further kills', async () => {
    const scheduler = fakeScheduler();
    let killCount = 0;
    const kill: KillFn = async () => {
      killCount += 1;
      return { status: 'terminated' };
    };
    const blockade = new ProcessBlockade(kill, () => {}, 3000, scheduler.schedule, scheduler.cancel);

    blockade.start(['Slack'], false);
    blockade.stop();

    assert.equal(blockade.active, false);
    assert.equal(scheduler.cancelled.length, 1);
    assert.equal(scheduler.hasPending(), false);
    assert.equal(killCount, 0);
  });

  test('a sweep already in flight aborts if stop() lands mid-loop', async () => {
    const scheduler = fakeScheduler();
    const seen: string[] = [];
    const blockade = new ProcessBlockade(
      async (target) => {
        seen.push(target);
        if (target === 'Slack') blockade.stop(); // stop from inside the sweep
        return { status: 'terminated' };
      },
      () => {},
      3000,
      scheduler.schedule,
      scheduler.cancel,
    );

    blockade.start(['Slack', 'Discord', 'Zoom'], false);
    await scheduler.tick();

    // Discord and Zoom must never be reached once the blockade was stopped.
    assert.deepEqual(seen, ['Slack']);
    assert.equal(scheduler.hasPending(), false);
  });

  test('starting again replaces the previous blockade instead of stacking', () => {
    const scheduler = fakeScheduler();
    const kill: KillFn = async () => ({ status: 'not_running' });
    const blockade = new ProcessBlockade(kill, () => {}, 3000, scheduler.schedule, scheduler.cancel);

    blockade.start(['Slack'], false);
    const firstDelayCount = scheduler.delays.length;
    blockade.start(['Discord'], true);

    // The first timer was cancelled, and exactly one new one was scheduled.
    assert.equal(scheduler.cancelled.length, 1);
    assert.equal(scheduler.delays.length, firstDelayCount + 1);
    assert.equal(blockade.active, true);
  });
});
