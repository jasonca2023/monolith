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

const execAsync = promisify(exec);
const COMMAND_TIMEOUT_MS = 8000;

/** Create these in the Shortcuts app to get real Focus control on modern macOS. */
const SHORTCUT_ON = 'Monolith Focus On';
const SHORTCUT_OFF = 'Monolith Focus Off';

export type FocusStatus = 'applied' | 'unsupported' | 'failed';

export interface FocusResult {
  status: FocusStatus;
  detail: string;
  durationMs: number;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

async function run(command: string): Promise<string> {
  const { stdout } = await execAsync(command, {
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
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

async function setFocusDarwin(enabled: boolean): Promise<Omit<FocusResult, 'durationMs'>> {
  const shortcut = enabled ? SHORTCUT_ON : SHORTCUT_OFF;

  if (await hasShortcut(shortcut)) {
    try {
      await run(`shortcuts run ${JSON.stringify(shortcut)}`);
      return { status: 'applied', detail: `ran shortcut "${shortcut}"` };
    } catch (error) {
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
