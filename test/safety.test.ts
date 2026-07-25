/**
 * The host builds shell command strings out of user-editable config, so these
 * tests are the ones that matter most: everything here is about what must not
 * reach a shell, and what must not be killed.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertKillable,
  assertLaunchable,
  buildKillCommand,
  buildLaunchCommand,
  hasControlCharacters,
  isNotRunningExit,
  quotePosix,
  validateLaunchPath,
} from '../src/main/safety';

const always = async () => true;
const never = async () => false;

describe('quotePosix', () => {
  test('wraps a plain path in single quotes', () => {
    assert.equal(quotePosix('/Applications/Figma.app'), `'/Applications/Figma.app'`);
  });

  test('neutralises an embedded single quote rather than ending the string', () => {
    // The classic break-out: a naive implementation yields '/tmp/'; rm -rf /'
    assert.equal(quotePosix(`/tmp/'; rm -rf /`), `'/tmp/'\\''; rm -rf /'`);
  });

  test('leaves shell metacharacters literal', () => {
    for (const payload of ['/tmp/a;b', '/tmp/a&&b', '/tmp/a|b', '/tmp/a$(whoami)', '/tmp/a`id`']) {
      const quoted = quotePosix(payload);
      assert.equal(quoted.at(0), `'`);
      assert.equal(quoted.at(-1), `'`);
      // No unescaped quote in the middle means the shell sees one argument.
      assert.equal(quoted.slice(1, -1).includes(`'`), false);
    }
  });
});

describe('hasControlCharacters', () => {
  test('rejects a newline, which would otherwise start a second command', () => {
    assert.equal(hasControlCharacters('/tmp/a\nrm -rf /'), true);
  });

  test('rejects NUL and DEL', () => {
    assert.equal(hasControlCharacters('/tmp/a\u0000b'), true);
    assert.equal(hasControlCharacters('/tmp/a\u007fb'), true);
  });

  test('accepts ordinary and non-ASCII paths', () => {
    assert.equal(hasControlCharacters('/Applications/Visual Studio Code.app'), false);
    assert.equal(hasControlCharacters('/Users/j/Ünïcödé/文書.app'), false);
  });
});

describe('validateLaunchPath', () => {
  test('accepts an absolute POSIX path', () => {
    assert.equal(validateLaunchPath('/Applications/iTerm.app', 'darwin'), '/Applications/iTerm.app');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(validateLaunchPath('  /Applications/iTerm.app  ', 'darwin'), '/Applications/iTerm.app');
  });

  test('rejects a relative path', () => {
    assert.throws(() => validateLaunchPath('Applications/iTerm.app', 'darwin'), /must be absolute/);
    assert.throws(() => validateLaunchPath('../../etc/passwd', 'darwin'), /must be absolute/);
  });

  test('rejects non-strings and empty input', () => {
    assert.throws(() => validateLaunchPath(42, 'darwin'), /expected a string path/);
    assert.throws(() => validateLaunchPath(null, 'darwin'), /expected a string path/);
    assert.throws(() => validateLaunchPath('   ', 'darwin'), /path is empty/);
  });

  test('rejects control characters before any quoting happens', () => {
    assert.throws(() => validateLaunchPath('/tmp/a\nb', 'darwin'), /control characters/);
  });

  test('treats a Windows drive path as absolute on any platform', () => {
    assert.equal(
      validateLaunchPath('C:\\Program Files\\Git\\git-bash.exe', 'darwin'),
      'C:\\Program Files\\Git\\git-bash.exe',
    );
  });

  test('rejects cmd.exe-unquotable characters only on win32', () => {
    for (const bad of ['C:\\a"b.exe', 'C:\\a%PATH%b.exe', 'C:\\a!b.exe']) {
      assert.throws(() => validateLaunchPath(bad, 'win32'), /cannot be safely quoted/);
      // The same string is harmless on POSIX, where single quoting handles it.
      assert.doesNotThrow(() => validateLaunchPath(bad, 'darwin'));
    }
  });
});

describe('assertLaunchable', () => {
  test('returns the trimmed path when it exists', async () => {
    assert.equal(await assertLaunchable('/Applications/iTerm.app', 'darwin', always), '/Applications/iTerm.app');
  });

  test('reports a missing path rather than building a command for it', async () => {
    await assert.rejects(
      assertLaunchable('/Applications/Nope.app', 'darwin', never),
      /does not exist on this machine/,
    );
  });

  test('never consults the disk for a structurally invalid path', async () => {
    let consulted = false;
    const spy = async () => {
      consulted = true;
      return true;
    };
    await assert.rejects(assertLaunchable('relative.app', 'darwin', spy));
    assert.equal(consulted, false);
  });
});

describe('buildLaunchCommand', () => {
  test('uses the platform opener', () => {
    assert.equal(buildLaunchCommand('/Applications/iTerm.app', 'darwin'), `open '/Applications/iTerm.app'`);
    assert.equal(buildLaunchCommand('/usr/bin/gedit', 'linux'), `xdg-open '/usr/bin/gedit'`);
    assert.equal(buildLaunchCommand('C:\\app.exe', 'win32'), `start "" "C:\\app.exe"`);
  });

  test('quotes a path containing spaces as one argument', () => {
    assert.equal(
      buildLaunchCommand('/Applications/Visual Studio Code.app', 'darwin'),
      `open '/Applications/Visual Studio Code.app'`,
    );
  });
});

describe('assertKillable', () => {
  test('accepts an ordinary process name', () => {
    assert.equal(assertKillable('Slack'), 'Slack');
    assert.equal(assertKillable('  Discord  '), 'Discord');
    assert.equal(assertKillable('Adobe_Update-Service.exe'), 'Adobe_Update-Service.exe');
  });

  test('refuses protected processes regardless of case', () => {
    for (const name of ['launchd', 'WindowServer', 'explorer.exe', 'Electron', 'LAUNCHD']) {
      assert.throws(() => assertKillable(name), /protected/, `${name} should be protected`);
    }
  });

  test('refuses shell metacharacters in a process name', () => {
    for (const bad of ['Slack; rm -rf /', 'Slack$(id)', 'Slack`id`', 'Slack|cat', 'Slack&', "Slack'"]) {
      assert.throws(() => assertKillable(bad), /unsupported characters/);
    }
  });

  test('refuses non-strings and empty input', () => {
    assert.throws(() => assertKillable(undefined), /expected a string process name/);
    assert.throws(() => assertKillable('  '), /process name is empty/);
  });
});

describe('buildKillCommand', () => {
  test('uses whole-name matching on POSIX so prefixes are not caught', () => {
    assert.equal(buildKillCommand('Steam', 'darwin'), `pkill -i -x -- 'Steam'`);
  });

  test('appends .exe on win32 only when missing', () => {
    assert.equal(buildKillCommand('Slack', 'win32'), `taskkill /F /IM "Slack.exe"`);
    assert.equal(buildKillCommand('Slack.exe', 'win32'), `taskkill /F /IM "Slack.exe"`);
    assert.equal(buildKillCommand('Slack.EXE', 'win32'), `taskkill /F /IM "Slack.EXE"`);
  });
});

describe('isNotRunningExit', () => {
  test('maps the "nothing matched" exit code per platform', () => {
    assert.equal(isNotRunningExit({ code: 1 }, 'darwin'), true);
    assert.equal(isNotRunningExit({ code: 128 }, 'win32'), true);
    assert.equal(isNotRunningExit({ code: 1 }, 'win32'), true);
  });

  test('a real failure is not mistaken for "not running"', () => {
    assert.equal(isNotRunningExit({ code: 2 }, 'darwin'), false);
    assert.equal(isNotRunningExit({ code: 128 }, 'darwin'), false);
    assert.equal(isNotRunningExit(new Error('boom'), 'darwin'), false);
    assert.equal(isNotRunningExit(null, 'darwin'), false);
  });
});
