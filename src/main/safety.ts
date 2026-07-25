/**
 * Monolith — target validation and shell quoting.
 *
 * Everything a profile names eventually becomes part of a command string, so
 * this module is the boundary that decides what is allowed to get there. It is
 * deliberately free of Electron and of module-level side effects: it is the
 * part of the host that most needs tests, and tests must be able to import it.
 *
 * Platform is a parameter rather than a read of `process.platform` so the
 * Windows quoting rules can be exercised from a POSIX machine and vice versa.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Platform } from '../shared/types';

/** Process names may only contain these characters before reaching a shell. */
export const SAFE_PROCESS_NAME = /^[A-Za-z0-9 ._-]+$/;

/** cmd.exe offers no literal-quoting construct, so these are refused outright. */
export const WINDOWS_FORBIDDEN = /["%!]/;

/**
 * Terminating any of these takes the desktop session or the host app with it.
 * A profile that names one is rejected rather than obeyed.
 */
export const PROTECTED_PROCESSES = new Set([
  'kernel_task',
  'launchd',
  'windowserver',
  'loginwindow',
  'systemd',
  'init',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'explorer.exe',
  'electron',
  'monolith',
  'monolith.exe',
]);

/**
 * No regex: keeps control-character detection independent of source encoding.
 * A newline in a path would otherwise end the command and start a new one,
 * which is the whole reason this check exists.
 */
export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Shell quoting                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Wraps a value in POSIX single quotes. Everything inside single quotes is
 * literal to the shell, so the only escape needed is for the quote itself:
 * close the quote, emit an escaped quote, reopen.
 */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Safe only because unsafe characters are rejected before this is called. */
export function quoteWindows(value: string): string {
  return `"${value}"`;
}

/* -------------------------------------------------------------------------- */
/* Launch targets                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every check that does not touch the disk. Throws with a human-readable
 * reason, which the caller turns into a skipped entry in the report.
 */
export function validateLaunchPath(target: unknown, platform: Platform): string {
  if (typeof target !== 'string') {
    throw new Error(`expected a string path, received ${typeof target}`);
  }

  const trimmed = target.trim();
  if (trimmed.length === 0) {
    throw new Error('path is empty');
  }
  if (hasControlCharacters(trimmed)) {
    throw new Error('path contains control characters');
  }
  // A Windows path is absolute to us even when this process is POSIX, so that a
  // cross-platform profile fails on "does not exist" rather than on shape.
  if (!path.isAbsolute(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error('path must be absolute');
  }
  if (platform === 'win32' && WINDOWS_FORBIDDEN.test(trimmed)) {
    throw new Error('path contains characters that cannot be safely quoted for cmd.exe');
  }

  return trimmed;
}

/** Injectable so the not-found branch can be tested without touching the disk. */
export type ExistsCheck = (target: string) => Promise<boolean>;

const defaultExists: ExistsCheck = (target) =>
  fs.access(target).then(
    () => true,
    () => false,
  );

/** Throws with a human-readable reason if `target` must not reach a shell. */
export async function assertLaunchable(
  target: unknown,
  platform: Platform = process.platform,
  exists: ExistsCheck = defaultExists,
): Promise<string> {
  const trimmed = validateLaunchPath(target, platform);

  // Fail fast with a useful message instead of a silent shell error later. A
  // cross-platform profile always carries paths for the other OS; those land
  // here and degrade to a single skipped entry.
  if (!(await exists(trimmed))) {
    throw new Error('path does not exist on this machine');
  }

  return trimmed;
}

export function buildLaunchCommand(target: string, platform: Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return `open ${quotePosix(target)}`;
    case 'win32':
      return `start "" ${quoteWindows(target)}`;
    default:
      return `xdg-open ${quotePosix(target)}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Kill targets                                                                */
/* -------------------------------------------------------------------------- */

export function assertKillable(name: unknown): string {
  if (typeof name !== 'string') {
    throw new Error(`expected a string process name, received ${typeof name}`);
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('process name is empty');
  }
  if (!SAFE_PROCESS_NAME.test(trimmed)) {
    throw new Error('process name contains unsupported characters');
  }
  if (PROTECTED_PROCESSES.has(trimmed.toLowerCase())) {
    throw new Error('process is protected and will not be terminated');
  }

  return trimmed;
}

/**
 * `force` escalates to SIGKILL on POSIX. Windows has no gentler option to
 * escalate from — `taskkill /F` is already unconditional — so the flag changes
 * nothing there.
 */
export function buildKillCommand(
  name: string,
  platform: Platform = process.platform,
  force = false,
): string {
  if (platform === 'win32') {
    const image = /\.exe$/i.test(name) ? name : `${name}.exe`;
    return `taskkill /F /IM ${quoteWindows(image)}`;
  }
  // -i: case-insensitive, -x: whole-name match, so "Steam" never matches
  // "steamwebhelper-adjacent" processes by prefix.
  return `pkill ${force ? '-9 ' : ''}-i -x -- ${quotePosix(name)}`;
}

/**
 * "Nothing matched" is the expected outcome for an app that simply is not
 * running, and both platforms signal it through the exit code rather than an
 * error stream: pkill exits 1, taskkill exits 128.
 */
export function isNotRunningExit(error: unknown, platform: Platform = process.platform): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (platform === 'win32') return code === 128 || code === 1;
  return code === 1;
}
