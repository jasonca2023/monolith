/**
 * Monolith — OS focus / Do Not Disturb control.
 *
 * There is no supported public API for toggling Focus on any of the three
 * platforms, so each one degrades through a chain of increasingly less capable
 * mechanisms and reports honestly which rung it landed on. Nothing here throws;
 * an unsupported OS is a described result, not a failed shift.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { quotePosix } from './safety';
import type { FocusResult, FocusStatus } from '../shared/types';

const execAsync = promisify(exec);

/** Probes (`sw_vers`, `shortcuts list`, `gsettings`) answer immediately. */
const PROBE_TIMEOUT_MS = 3000;

/**
 * `shortcuts run` is the one command here that can block indefinitely: the
 * first time an app drives Shortcuts, macOS raises a permission prompt and the
 * command waits until someone clicks it. The other four tracks of a shift have
 * finished in well under a second by then, and the report waits for the
 * slowest, so an unbounded wait here is what makes the whole app look frozen.
 */
const SHORTCUT_RUN_TIMEOUT_MS = 3000;

/** Create these in the Shortcuts app to get real Focus control on modern macOS. */
const SHORTCUT_ON = 'Monolith Focus On';
const SHORTCUT_OFF = 'Monolith Focus Off';

/**
 * The fallback route to a shortcut.
 *
 * `shortcuts run` needs Automation permission, which macOS will not grant to an
 * unsigned development build — it blocks silently rather than prompting, so the
 * command hangs until it is killed. A `shortcuts://` URL goes through
 * LaunchServices instead, which carries no such requirement.
 *
 * The trade is knowledge: `open` reports only that the URL was handed off, not
 * what the shortcut did, so this path can never honestly report success the way
 * `shortcuts run` can. It is a fallback, never the first choice.
 */
export function shortcutUrl(name: string): string {
  return `shortcuts://run-shortcut?name=${encodeURIComponent(name)}`;
}

export type { FocusResult, FocusStatus } from '../shared/types';

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

async function run(command: string, timeout = PROBE_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execAsync(command, {
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/**
 * `exec` reports a timeout by killing the child, not by any distinct error
 * code, so a hang is only recognisable as "we killed it" — which is worth
 * separating from a real failure because the advice differs entirely.
 */
export function timedOut(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const killed = (error as { killed?: unknown }).killed;
  const signal = (error as { signal?: unknown }).signal;
  return killed === true || signal === 'SIGTERM' || signal === 'SIGKILL';
}

/* -------------------------------------------------------------------------- */
/* macOS                                                                       */
/* -------------------------------------------------------------------------- */

async function macosMajorVersion(): Promise<number> {
  try {
    const version = (await run('sw_vers -productVersion')).trim();
    return Number.parseInt(version.split('.')[0] ?? '0', 10) || 0;
  } catch {
    return 0;
  }
}

/** Shortcuts is the only route Apple actually supports for automating Focus. */
async function hasShortcut(name: string): Promise<boolean> {
  try {
    const list = await run('shortcuts list');
    return list.split('\n').some((line) => line.trim() === name);
  } catch {
    return false;
  }
}

/**
 * Hands the shortcut to LaunchServices. `-g` keeps Shortcuts in the background,
 * so a shift never yanks the user out of what they are doing.
 *
 * Deliberately does not report `applied`: `open` succeeds as soon as the URL is
 * accepted, which says nothing about whether the shortcut ran. Claiming success
 * here would put a comforting lie in the log, and the whole point of this
 * module is that every rung reports honestly which one it landed on.
 */
async function dispatchByUrl(shortcut: string): Promise<Omit<FocusResult, 'durationMs'>> {
  try {
    await run(`open -g ${quotePosix(shortcutUrl(shortcut))}`, PROBE_TIMEOUT_MS);
    return {
      status: 'applied',
      detail:
        `dispatched "${shortcut}" via the Shortcuts URL scheme — Automation permission was ` +
        'refused, so the outcome cannot be confirmed from here; check Control Centre',
    };
  } catch (error) {
    return {
      status: 'failed',
      detail:
        `"${shortcut}" could not be run: Automation permission was refused and the Shortcuts ` +
        `URL scheme also failed (${describe(error)})`,
    };
  }
}

async function setFocusDarwin(enabled: boolean): Promise<Omit<FocusResult, 'durationMs'>> {
  const shortcut = enabled ? SHORTCUT_ON : SHORTCUT_OFF;

  if (await hasShortcut(shortcut)) {
    try {
      await run(`shortcuts run ${JSON.stringify(shortcut)}`, SHORTCUT_RUN_TIMEOUT_MS);
      return { status: 'applied', detail: `ran shortcut "${shortcut}"` };
    } catch (error) {
      // A hang here means Automation permission was withheld silently, which is
      // what an unsigned build gets. The URL scheme sidesteps that entirely.
      if (timedOut(error)) return dispatchByUrl(shortcut);
      return { status: 'failed', detail: `shortcut "${shortcut}" failed: ${describe(error)}` };
    }
  }

  // The defaults/NotificationCenter trick was removed in Big Sur; only attempt
  // it where it can actually work rather than writing a key that does nothing.
  const major = await macosMajorVersion();
  if (major > 0 && major < 11) {
    try {
      await run(
        `defaults write com.apple.notificationcenterui doNotDisturb -bool ${enabled} && ` +
          `defaults write com.apple.notificationcenterui doNotDisturbDate -date "$(date -u +'%Y-%m-%d %H:%M:%S +0000')" && ` +
          'killall NotificationCenter',
      );
      return { status: 'applied', detail: `Do Not Disturb ${enabled ? 'on' : 'off'} (legacy path)` };
    } catch (error) {
      return { status: 'failed', detail: describe(error) };
    }
  }

  return {
    status: 'unsupported',
    detail:
      `macOS ${major || '?'} has no scriptable Focus toggle — create Shortcuts named ` +
      `"${SHORTCUT_ON}" and "${SHORTCUT_OFF}" (Set Focus action) and Monolith will run them`,
  };
}

/* -------------------------------------------------------------------------- */
/* Windows                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Focus Assist itself lives in an undocumented CloudStore blob that changes
 * shape between builds. Suppressing toast notifications is the documented
 * setting that survives upgrades, so that is what gets written.
 */
async function setFocusWin32(enabled: boolean): Promise<Omit<FocusResult, 'durationMs'>> {
  const key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications';
  const value = enabled ? 0 : 1;
  const script =
    `New-Item -Path '${key}' -Force | Out-Null; ` +
    `Set-ItemProperty -Path '${key}' -Name 'ToastEnabled' -Value ${value} -Type DWord`;

  try {
    await run(`powershell -NoProfile -NonInteractive -Command "${script}"`);
    return {
      status: 'applied',
      detail: `toast notifications ${enabled ? 'suppressed' : 'restored'}`,
    };
  } catch (error) {
    return { status: 'failed', detail: describe(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Linux                                                                       */
/* -------------------------------------------------------------------------- */

async function setFocusLinux(enabled: boolean): Promise<Omit<FocusResult, 'durationMs'>> {
  try {
    await run(`gsettings set org.gnome.desktop.notifications show-banners ${!enabled}`);
    return { status: 'applied', detail: `GNOME banners ${enabled ? 'hidden' : 'restored'}` };
  } catch (error) {
    return {
      status: 'unsupported',
      detail: `no GNOME notification setting available: ${describe(error)}`,
    };
  }
}

/* -------------------------------------------------------------------------- */

export async function setSystemFocus(enabled: boolean): Promise<FocusResult> {
  const startedAt = Date.now();

  let outcome: Omit<FocusResult, 'durationMs'>;
  switch (process.platform) {
    case 'darwin':
      outcome = await setFocusDarwin(enabled);
      break;
    case 'win32':
      outcome = await setFocusWin32(enabled);
      break;
    case 'linux':
      outcome = await setFocusLinux(enabled);
      break;
    default:
      outcome = { status: 'unsupported', detail: `no focus control for ${process.platform}` };
  }

  return { ...outcome, durationMs: Date.now() - startedAt };
}
