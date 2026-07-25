/**
 * Monolith — process blockade.
 *
 * A mood's "apps to close" list used to be a one-shot: quit once at engage,
 * and nothing stops the user from reopening it five seconds later for the
 * rest of the session. This re-issues the same kill against the same targets
 * on an interval for as long as the mood stays engaged, so "closes on engage"
 * becomes "stays closed until you disengage" — the native-app equivalent of
 * the browser extension's site blockade.
 *
 * No separate "is it running" probe is needed: pkill/taskkill already report
 * `not_running` harmlessly when a target isn't there (src/main/safety.ts), so
 * the enforcer just re-issues the same kill call on a timer and only surfaces
 * the ticks that actually terminated something.
 *
 * The scheduler is injected — real setTimeout by default — so the interval
 * logic is testable without real wall-clock waits, the same convention as the
 * Hue pairing poll in hue-setup.ts.
 */

export interface KillOutcome {
  status: string;
}

export type KillFn = (target: string, force: boolean) => Promise<KillOutcome>;
export type Scheduler = (callback: () => void, delayMs: number) => number;
export type Canceller = (handle: number) => void;

const defaultSchedule: Scheduler = (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number;
const defaultCancel: Canceller = (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);

export class ProcessBlockade {
  private targets: string[] = [];
  private force = false;
  private handle: number | null = null;
  private running = false;

  constructor(
    private readonly kill: KillFn,
    private readonly onReKill: (target: string) => void,
    private readonly intervalMs = 3000,
    private readonly schedule: Scheduler = defaultSchedule,
    private readonly cancel: Canceller = defaultCancel,
  ) {}

  get active(): boolean {
    return this.running;
  }

  /**
   * Replaces whatever blockade was active. A mood switch (or re-engaging the
   * same mood) never stacks enforcers — only one can run at a time, matching
   * the single-focus-mode UI.
   */
  start(targets: string[], force: boolean): void {
    this.stop();
    if (targets.length === 0) return;
    this.targets = [...targets];
    this.force = force;
    this.running = true;
    this.queueNext();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) this.cancel(this.handle);
    this.handle = null;
    this.targets = [];
  }

  private queueNext(): void {
    this.handle = this.schedule(() => void this.sweep(), this.intervalMs);
  }

  private async sweep(): Promise<void> {
    for (const target of this.targets) {
      // Checked before and after each await: stop() can land mid-sweep, and a
      // stopped blockade must neither keep killing nor reschedule itself.
      if (!this.running) return;
      const outcome = await this.kill(target, this.force);
      if (this.running && outcome.status === 'terminated') this.onReKill(target);
    }
    if (this.running) this.queueNext();
  }
}
