/**
 * Monolith — cloud sync (Supabase).
 *
 * Everything else in this app works with no network and no account, by
 * design — this module is the one deliberate exception. Signing in adds
 * exactly two things: session history and mood schedules are also written to
 * Supabase, so they survive a reinstall or follow you to another machine.
 * Nothing else about the app changes, and signed-out behavior is unchanged
 * from before this module existed — every function here degrades to a no-op
 * or a local-only fallback when there is no session.
 *
 * The auth session (never the password) is persisted to a small file in
 * userData via a custom storage adapter, since supabase-js expects a
 * browser-shaped `localStorage` and the main process has none.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionRecord } from './sessions';

const SUPABASE_URL = 'https://elmrrznofcmoughigpfl.supabase.co';
// The anon/publishable key is meant to be embedded in client code — it is not
// a secret. Row Level Security on every table is what actually restricts a
// signed-in user to their own rows; this key alone grants nothing.
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVsbXJyem5vZmNtb3VnaGlncGZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxODYzMzMsImV4cCI6MjA5NTc2MjMzM30.bk3vTKlbqotdD5JepEbDUw32iO2Zcds7X8nDZEdvuEk';

const AUTH_FILENAME = 'monolith_auth.json';

/** A minimal file-backed stand-in for the `localStorage` supabase-js expects. */
export function createFileStorage(authPath: string) {
  let cache: Record<string, string> | null = null;

  const load = async (): Promise<Record<string, string>> => {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fs.readFile(authPath, 'utf8'));
    } catch {
      cache = {};
    }
    return cache!;
  };

  return {
    async getItem(key: string): Promise<string | null> {
      const store = await load();
      return store[key] ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      const store = await load();
      store[key] = value;
      cache = store;
      const scratch = `${authPath}.tmp`;
      await fs.mkdir(path.dirname(authPath), { recursive: true });
      await fs.writeFile(scratch, JSON.stringify(store), 'utf8');
      await fs.rename(scratch, authPath);
    },
    async removeItem(key: string): Promise<void> {
      const store = await load();
      delete store[key];
      cache = store;
      const scratch = `${authPath}.tmp`;
      await fs.writeFile(scratch, JSON.stringify(store), 'utf8');
      await fs.rename(scratch, authPath);
    },
  };
}

let client: SupabaseClient | null = null;

/** Created lazily so tests never construct a real network client on import. */
export function getClient(userDataPath: string): SupabaseClient {
  if (client) return client;
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: createFileStorage(path.join(userDataPath, AUTH_FILENAME)),
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}

export interface AuthResult {
  ok: boolean;
  detail: string;
}

export interface AuthStatus {
  signedIn: boolean;
  email: string | null;
}

/** Supabase's own error text is already written for end users. */
function describeAuthError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

export async function signUp(userDataPath: string, email: string, password: string): Promise<AuthResult> {
  const { error } = await getClient(userDataPath).auth.signUp({ email, password });
  if (error) return { ok: false, detail: describeAuthError(error) };
  return { ok: true, detail: 'Check your email to confirm your account, then sign in.' };
}

export async function signIn(userDataPath: string, email: string, password: string): Promise<AuthResult> {
  const { error } = await getClient(userDataPath).auth.signInWithPassword({ email, password });
  if (error) return { ok: false, detail: describeAuthError(error) };
  return { ok: true, detail: 'Signed in.' };
}

export async function signOut(userDataPath: string): Promise<void> {
  await getClient(userDataPath).auth.signOut();
}

export async function getAuthStatus(userDataPath: string): Promise<AuthStatus> {
  const { data } = await getClient(userDataPath).auth.getSession();
  const email = data.session?.user.email ?? null;
  return { signedIn: email !== null, email };
}

/** The signed-in user's id, or null when signed out — every sync call needs this. */
async function currentUserId(userDataPath: string): Promise<string | null> {
  const { data } = await getClient(userDataPath).auth.getSession();
  return data.session?.user.id ?? null;
}

/**
 * Pushes one finished session to the cloud. A silent no-op when signed out —
 * the local history file is the only record in that case, same as before
 * this module existed.
 */
export async function pushSession(userDataPath: string, record: SessionRecord): Promise<void> {
  const userId = await currentUserId(userDataPath);
  if (!userId) return;

  const { error } = await getClient(userDataPath)
    .from('sessions')
    .insert({
      user_id: userId,
      profile_id: record.profileId,
      profile_name: record.profileName,
      started_at: record.startedAt,
      ended_at: record.endedAt,
      duration_ms: record.durationMs,
      apps_blocked: record.appsBlocked,
    });
  if (error) throw new Error(describeAuthError(error));
}

/** The cloud's view of this user's session history, oldest first. */
export async function fetchCloudSessions(userDataPath: string): Promise<SessionRecord[]> {
  const userId = await currentUserId(userDataPath);
  if (!userId) return [];

  const { data, error } = await getClient(userDataPath)
    .from('sessions')
    .select('profile_id, profile_name, started_at, ended_at, duration_ms, apps_blocked')
    .eq('user_id', userId)
    .order('started_at', { ascending: true });
  if (error) throw new Error(describeAuthError(error));

  return (data ?? []).map((row) => ({
    profileId: row.profile_id,
    profileName: row.profile_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    appsBlocked: row.apps_blocked,
  }));
}

export interface CloudSchedule {
  enabled: boolean;
  engage_time: string;
  disengage_time: string;
  days: number[];
}

/** Upserted, not inserted — a schedule is one row per (user, mood), edited in place. */
export async function upsertSchedule(
  userDataPath: string,
  profileId: string,
  schedule: CloudSchedule,
): Promise<void> {
  const userId = await currentUserId(userDataPath);
  if (!userId) return;

  const { error } = await getClient(userDataPath)
    .from('schedules')
    .upsert(
      {
        user_id: userId,
        profile_id: profileId,
        enabled: schedule.enabled,
        engage_time: schedule.engage_time,
        disengage_time: schedule.disengage_time,
        days: schedule.days,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,profile_id' },
    );
  if (error) throw new Error(describeAuthError(error));
}

/** Every schedule this user has saved, keyed by mood id — fetched once at sign-in. */
export async function fetchCloudSchedules(userDataPath: string): Promise<Record<string, CloudSchedule>> {
  const userId = await currentUserId(userDataPath);
  if (!userId) return {};

  const { data, error } = await getClient(userDataPath)
    .from('schedules')
    .select('profile_id, enabled, engage_time, disengage_time, days')
    .eq('user_id', userId);
  if (error) throw new Error(describeAuthError(error));

  const byProfile: Record<string, CloudSchedule> = {};
  for (const row of data ?? []) {
    byProfile[row.profile_id] = {
      enabled: row.enabled,
      engage_time: row.engage_time,
      disengage_time: row.disengage_time,
      days: row.days ?? [],
    };
  }
  return byProfile;
}
