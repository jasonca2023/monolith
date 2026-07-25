# Monolith — Backend

Environmental and workspace orchestration engine. This branch holds the desktop
host and the browser agent; the renderer UI lives on `frontend`.

```
src/main/main.ts         Electron main process — frameless shell, launcher, terminator, WS bridge
src/main/preload.ts      contextBridge surface exposed to the renderer as window.monolith
extension/background.js  Chrome MV3 service worker — purge / hydrate / blockade executor
extension/blocked.html   ASCII countdown page served on a blocked navigation
extension/blocked.js     Countdown renderer (MV3 forbids inline script)
extension/manifest.json  Manifest (tabs, storage, alarms, declarativeNetRequest)
monolith_config.json     Credential + profile schema (template; live copy lives in userData)
```

## Run it

```bash
npm install          # downloads the Electron binary
npm start            # compiles TS to dist/ and boots the shell
npm run dev          # same, pointed at a renderer dev server on :5173
```

The window is **frameless** (`frame: false`, `titleBarStyle: 'hidden'`) so the
renderer paints its own dark chrome. It must supply a `-webkit-app-region: drag`
region and call `window.monolith.window.*` for minimize / maximize / close —
there are no native controls to fall back on.

The renderer is resolved in this order: `MONOLITH_RENDERER_URL` →
`dist/renderer/index.html` → a built-in fallback page, so the host boots and the
bridge serves whether or not the frontend branch is built.

Load the extension via `chrome://extensions` → Developer mode → **Load unpacked**
→ select `extension/`. It connects to `ws://localhost:8080` on install, on
browser startup, and on a 30-second alarm that also revives the worker after
Chrome evicts it.

## IPC contract

| Channel | Argument | Returns |
| --- | --- | --- |
| `execute-reality-shift` | profile object, profile id, or `string[]` of paths | `RealityShiftReport` |
| `dispatch-browser-signal` | `'AGGRESSIVE_PURGE' \| 'HYDRATE_SESSION'`, payload | `{ signal, ok, receivers }` |
| `config:read` / `config:write` | — / `MonolithConfig` | normalized `MonolithConfig` |
| `system:info` | — | platform, versions, bridge URL |
| `window:minimize` / `window:toggle-maximize` / `window:close` | — | — / `boolean` / — |

`bridge:event` is pushed to the renderer whenever the extension acknowledges a
signal (`PURGE_COMPLETE`, `HYDRATE_COMPLETE`, `BLOCKADE_RELEASED`,
`SIGNAL_FAILED`).

**No IPC handler ever rejects.** A bad path, a missing extension, an unknown
profile id or a corrupt config all come back as a structured report, so the
renderer never has to guard a throw and one dead app never aborts a shift.

### What a shift does

`execute-reality-shift` reads `digital_purge` and, concurrently:

1. Launches every entry in `launch_applications` through the platform opener —
   `open` (darwin), `start "" …` (win32), `xdg-open` (linux) — in detached child
   processes.
2. Terminates every entry in `kill_background_processes` via `pkill -i -x`
   (POSIX) or `taskkill /F /IM` (Windows).
3. Broadcasts `AGGRESSIVE_PURGE` when `close_browser_tabs` is `true`, or
   `HYDRATE_SESSION` when it is `false`, tagged with the profile id.

`physical_orchestration` and `sonic_layering` are parsed, normalized and echoed
back in the report, but **nothing actuates them yet** — the Hue and Spotify HTTP
calls are the next backend commit.

### Execution safety

Targets are validated before any command string is built: absolute paths only,
no control characters, must exist on disk; on Windows, characters that cannot be
safely quoted for `cmd.exe` (`"`, `%`, `!`) are rejected. POSIX targets are
single-quoted with `'` → `'\''` escaping, so a path containing quotes or
semicolons reaches the opener as one literal argv entry rather than shell syntax.

Process names are restricted to `[A-Za-z0-9 ._-]`, and a protected set
(`launchd`, `WindowServer`, `explorer.exe`, `electron`, …) is refused outright so
a mistyped profile cannot take down the session or the host app. `pkill` exiting
1 and `taskkill` exiting 128 mean "not running" — reported as `not_running`, not
as a failure.

Cross-platform profiles carry paths for every OS by design; the ones for the
other platform fail `fs.access` and land as skipped entries.

## Browser agent

**`AGGRESSIVE_PURGE`** snapshots unpinned tabs, **awaits the storage write before
closing anything** (a failed write costs zero tabs), opens `chrome://newtab/`,
then batch-removes the set with a per-tab fallback. Snapshots are keyed per
profile (`monolith.session.<profileId>`), so deep-work and high-energy sessions
never overwrite each other.

**`HYDRATE_SESSION`** restores that profile's snapshot in original tab order and
clears the key, making a snapshot single-use. Tabs whose scheme is not
`http(s)`, `file` or `ftp` are captured but skipped on restore, since
`chrome.tabs.create` refuses `chrome://` and `devtools://` URLs.

### The blockade

A purge for the `deep_work` profile arms dynamic `declarativeNetRequest` rules
that redirect `main_frame` navigations for twitter.com, x.com, reddit.com,
youtube.com, instagram.com, tiktok.com, facebook.com, news.ycombinator.com and
twitch.tv to the ASCII countdown page. Override per signal with
`blocked_domains` and `redirect_url` (e.g. `http://localhost:3000`);
`duration_minutes` switches the page from counting up to counting down.

DNR only intercepts navigations, so already-open distraction tabs are pushed to
the countdown page explicitly after the rules land.

The blockade is released on `HYDRATE_SESSION`, on an explicit `RELEASE_BLOCKADE`
signal, and on `chrome.runtime.onStartup` / `onInstalled`. That last one matters:
dynamic rules persist across restarts, so without it a crash mid-deep-work would
lock the user out of those domains permanently with no way back.

Rule ids are confined to the 9000–9999 band, so a reset only ever clears
Monolith's own rules. `host_permissions: ["<all_urls>"]` is required because DNR
redirect actions need host access to the request being redirected; a pure
`block` action would not, but it renders Chrome's error page instead of the
countdown.

## Config

`monolith_config.json` at the repo root is the template. On first run it is
copied to `app.getPath('userData')`, and every write goes there via
write-then-rename. Every field is normalized on read — missing sections are
filled, `brightness` is clamped to 0–100, `hue_xy_payload` to a two-element pair
inside 0–1 — so a hand-edited file can never crash the shell.

The shipped template carries placeholder credentials. Real
`spotify_auth_token` / `hue_api_key` values belong in the userData copy, which
sits outside the repo — do not commit filled values back into the template.
