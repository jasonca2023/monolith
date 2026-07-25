/**
 * Monolith — session history and personal stats.
 *
 * The "Why this matters" panel cites outside research; this is the same
 * argument made with the user's own numbers instead of someone else's study.
 * A session is recorded once, when a mood ends — there is no "in progress"
 * record on disk, so a crash mid-session loses that one session rather than
 * leaving a corrupt partial entry behind.
 */

export interface SessionRecord {
  profileId: string;
  profileName: string;
  /** ISO instant. Always re-parsed through Date, never string-sliced, so
   *  local-day bucketing below is correct regardless of the machine's
   *  timezone at read time. */
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Times an app on this mood's block list was closed after being reopened. */
  appsBlocked: number;
}

export interface SessionStats {
  totalSessions: number;
  totalFocusMinutes: number;
  totalBlocks: number;
  todayMinutes: number;
  streakDays: number;
}

/** Local calendar day, not UTC — a streak is judged by the user's own clock. */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function summarizeSessions(sessions: SessionRecord[], now: Date = new Date()): SessionStats {
  const totalSessions = sessions.length;
  const totalFocusMinutes = Math.round(sessions.reduce((sum, s) => sum + s.durationMs, 0) / 60_000);
  const totalBlocks = sessions.reduce((sum, s) => sum + s.appsBlocked, 0);

  const todayKey = localDayKey(now);
  const todayMinutes = Math.round(
    sessions
      .filter((s) => localDayKey(new Date(s.startedAt)) === todayKey)
      .reduce((sum, s) => sum + s.durationMs, 0) / 60_000,
  );

  const days = new Set(sessions.map((s) => localDayKey(new Date(s.startedAt))));
  const cursor = new Date(now);
  // A day with no session yet doesn't break yesterday's streak until the day
  // actually ends — so a 9pm check still shows yesterday's streak as current.
  if (!days.has(localDayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streakDays = 0;
  while (days.has(localDayKey(cursor))) {
    streakDays += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return { totalSessions, totalFocusMinutes, totalBlocks, todayMinutes, streakDays };
}

/** Keeps the history file from growing without bound. */
export function trimSessions(sessions: SessionRecord[], limit = 500): SessionRecord[] {
  return sessions.length > limit ? sessions.slice(sessions.length - limit) : sessions;
}
