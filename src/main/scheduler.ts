/**
 * Monolith — mood scheduling.
 *
 * Polls every profile's schedule against wall-clock time and fires the same
 * engage/disengage the Nexus button, the tray and the hotkey all use — there
 * is one path into a mood, not a separate scheduled one that could drift from
 * what a manual engage does.
 *
 * Firing is deduped per (action, profile) within a clock-minute rather than
 * per poll tick: the poll interval is shorter than a minute, so several ticks
 * can land inside the same "09:00" match and only the first should act. The
 * dedup set clears the moment the minute actually changes rather than on its
 * own timer, so two profiles sharing an engage_time both still fire — a
 * single "last fired" value could not represent that.
 */

export interface ScheduleLike {
  enabled: boolean;
  engage_time: string;
  disengage_time: string;
  /** 0 (Sunday) – 6 (Saturday). Empty means every day. */
  days: number[];
}

export interface ScheduledProfile {
  id: string;
  name: string;
  schedule: ScheduleLike;
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** True when `schedule` names `now` as one of its engage/disengage moments. */
export function matches(
  schedule: ScheduleLike,
  now: Date,
  field: 'engage_time' | 'disengage_time',
): boolean {
  if (!schedule.enabled) return false;
  if (schedule.days.length > 0 && !schedule.days.includes(now.getDay())) return false;
  return schedule[field] === hhmm(now);
}

export type Scheduler = (callback: () => void, delayMs: number) => number;
export type Canceller = (handle: number) => void;

const defaultSchedule: Scheduler = (callback, delayMs) => setInterval(callback, delayMs) as unknown as number;
const defaultCancel: Canceller = (handle) => clearInterval(handle as unknown as ReturnType<typeof setInterval>);

export class MoodScheduler {
  private handle: number | null = null;
  private firedThisMinute = new Set<string>();
  private currentMinuteKey = '';

  constructor(
    private readonly getProfiles: () => Promise<ScheduledProfile[]>,
    private readonly onEngage: (profile: ScheduledProfile) => Promise<void>,
    private readonly onDisengage: (profile: ScheduledProfile) => Promise<void>,
    /** Whichever mood is actually engaged right now — the single source of
     *  truth the caller already tracks, so the scheduler never keeps its own
     *  copy that could desync from a manual engage/disengage elsewhere. */
    private readonly isEngaged: (profileId: string) => boolean,
    private readonly pollMs = 20_000,
    private readonly now: () => Date = () => new Date(),
    private readonly schedule: Scheduler = defaultSchedule,
    private readonly cancel: Canceller = defaultCancel,
  ) {}

  get active(): boolean {
    return this.handle !== null;
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.schedule(() => void this.tick(), this.pollMs);
    void this.tick();
  }

  stop(): void {
    if (this.handle !== null) this.cancel(this.handle);
    this.handle = null;
  }

  async tick(): Promise<void> {
    const now = this.now();
    // Date-qualified so the dedup set can't bridge midnight and suppress a
    // legitimate match 24 hours later at the same clock time.
    const minuteKey = `${now.toDateString()} ${hhmm(now)}`;
    if (minuteKey !== this.currentMinuteKey) {
      this.currentMinuteKey = minuteKey;
      this.firedThisMinute.clear();
    }

    const profiles = await this.getProfiles();
    for (const profile of profiles) {
      if (matches(profile.schedule, now, 'engage_time')) await this.fire('engage', profile);
      else if (matches(profile.schedule, now, 'disengage_time')) await this.fire('disengage', profile);
    }
  }

  private async fire(action: 'engage' | 'disengage', profile: ScheduledProfile): Promise<void> {
    const key = `${action}:${profile.id}`;
    if (this.firedThisMinute.has(key)) return;
    this.firedThisMinute.add(key);

    if (action === 'engage') {
      if (this.isEngaged(profile.id)) return; // already running — nothing to do
      await this.onEngage(profile);
    } else {
      if (!this.isEngaged(profile.id)) return; // this mood isn't the one running
      await this.onDisengage(profile);
    }
  }
}
