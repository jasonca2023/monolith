# Monolith

Environmental and workspace orchestration engine. One command turns a named mood
into a real change of state: apps launched, noise killed, tabs purged, lights
recoloured, music started, OS notifications silenced.

```
src/shared/types.ts         The contract — config schema and every IPC type, shared by both sides
src/main/main.ts            Electron main process — frameless shell, launcher, terminator, WS bridge
src/main/safety.ts          Target validation and shell quoting — what may reach a shell
src/main/normalize.ts       Config normalization — fills, coerces and clamps untrusted input
src/main/actuators.ts       Philips Hue and Spotify Web API calls
src/main/spotify-auth.ts    Spotify authorization code + PKCE grant and token refresh
src/main/hue-setup.ts       Hue bridge discovery and link-button pairing
src/main/focus-mode.ts      OS focus / Do Not Disturb control, per platform
src/main/preload.ts         contextBridge surface exposed to the renderer as window.monolith
renderer/                   React command deck — mood cards, profile editor, credentials modal
test/                       node:test suites over the safety, config and network-parsing paths
extension/background.js     Chrome MV3 service worker — purge / hydrate / blockade executor
extension/blocked.html      ASCII countdown page served on a blocked navigation
extension/blocked.js        Countdown renderer (MV3 forbids inline script)
extension/manifest.json     Manifest (tabs, storage, alarms, declarativeNetRequest)
monolith_config.json        Credential + profile schema (template; live copy lives in userData)
```

## Run it

```bash
npm install          # downloads the Electron binary
npm start            # compiles main + renderer, then boots the shell
npm test             # compiles to dist-test/ and runs the node:test suites
npm run typecheck    # all three tsconfigs, no emit

npm run dev:renderer # terminal 1 — Vite on :5173
npm run dev          # terminal 2 — shell pointed at that dev server
```

Types live in `src/shared/types.ts` and are imported by the main process, the
preload bridge and the renderer alike. The renderer used to redeclare the config
schema by hand, so a field added to a profile had to be typed in two places and
could silently disagree; now `renderer/monolith.ts` only re-exports it and adds
the `window.monolith` global.

The window is **frameless** (`frame: false`, `titleBarStyle: 'hidden'`) so the
renderer paints its own dark chrome. It supplies a `-webkit-app-region: drag`
region and calls `window.monolith.window.*` for minimize / maximize / close —
there are no native controls to fall back on.

The renderer is resolved in this order: `MONOLITH_RENDERER_URL` →
`dist/renderer/index.html` → a built-in fallback page, so the host boots and the
bridge serves whether or not the renderer bundle has been built.

Load the extension via `chrome://extensions` → Developer mode → **Load unpacked**
→ select `extension/`. It connects to `ws://localhost:8080` on install, on
browser startup, and on a 30-second alarm that also revives the worker after
Chrome evicts it.

## IPC contract

| Channel | Argument | Returns |
| --- | --- | --- |
| `execute-reality-shift` | profile object, profile id, or `string[]` of paths | `RealityShiftReport` |
| `execute-disengage` | profile id | `DisengageReport` |
| `dispatch-browser-signal` | `'AGGRESSIVE_PURGE' \| 'HYDRATE_SESSION'`, payload | `{ signal, ok, receivers }` |
| `config:read` / `config:write` | — / `MonolithConfig` | normalized `MonolithConfig` |
| `dialog:pick-applications` | — | `string[]` (empty if cancelled) |
| `spotify:authorize` | — | `SpotifyAuthResult` |
| `hue:discover` / `hue:pair` | — / bridge IP | `HueDiscoveryResult` / `HuePairResult` |
| `stats:read` | — | `SessionStats` (cloud if signed in, else local) |
| `auth:sign-up` / `auth:sign-in` | email, password | `AuthResult` |
| `auth:sign-out` / `auth:status` | — | — / `AuthStatus` |
| `schedule:sync` | profile id, `Schedule` | — (silent no-op signed out) |
| `system:info` | — | platform, versions, bridge URL |
| `window:minimize` / `window:toggle-maximize` / `window:close` | — | — / `boolean` / — |

`bridge:event` is pushed to the renderer whenever the extension acknowledges a
signal (`PURGE_COMPLETE`, `HYDRATE_COMPLETE`, `BLOCKADE_RELEASED`,
`SIGNAL_FAILED`), and also for cross-trigger sync: `EXTERNAL_ENGAGE` /
`EXTERNAL_DISENGAGE` (tray, hotkey or schedule acted while the window was
open), `BLOCKADE_KILL` (a blocked app got closed again), `STATS_UPDATED` and
`CONFIG_UPDATED` (a cloud schedule pull changed a profile out from under the
open window).

**No IPC handler ever rejects.** A bad path, a missing extension, an unknown
profile id, an unreachable Hue bridge or a corrupt config all come back as a
structured report, so the renderer never has to guard a throw and one dead
subsystem never aborts a shift.

### What a shift does

`execute-reality-shift` resolves the profile and runs all five tracks
concurrently — a slow Hue bridge must not delay the apps the user is waiting on:

1. Launches every entry in `launch_applications` through the platform opener —
   `open` (darwin), `start "" …` (win32), `xdg-open` (linux) — in detached child
   processes.
2. Terminates every entry in `kill_background_processes` via `pkill -i -x`
   (POSIX) or `taskkill /F /IM` (Windows).
3. Broadcasts `AGGRESSIVE_PURGE` when `close_browser_tabs` is `true`, or
   `HYDRATE_SESSION` when it is `false`, tagged with the profile id and the
   mood's own blocking fields.
4. Pushes `physical_orchestration` to Hue group 0 — the built-in "all lights"
   group — as an `xy` + `bri` command with a 500 ms transition.
5. Starts `sonic_layering.playlist_uri` on the user's active Spotify device and
   sets OS focus.

Each lands in the report as `applied` / `disabled` / `not_configured` / `failed`
with a human-readable detail string, so the deck can say *why* a light did not
change rather than just failing the shift.

### Disengage

`execute-disengage` is the exit sequence, and is likewise fully parallel: OS
focus off, lights back to **neutral white** (D65, `[0.3127, 0.329]`, full
brightness), and `HYDRATE_SESSION` broadcast to rebuild the browser session.
None of the three depends on another, so a failure in one cannot strand the
others — the room always comes back even if the extension is gone.

### Physical and sonic actuation

Both actuators are best-effort and neither can fail a shift.

**Hue** is a LAN device, so `hue_bridge_ip` is validated as a private IPv4
address (optionally with a port) before any request is built — a hand-edited
config cannot point the app at an arbitrary internet host. The bridge answers
`200` even for rejected commands, burying the failure in a per-command array, so
the response body is scanned for an `error` entry rather than trusting the
status line. 4 s timeout.

**Spotify** maps the status codes that actually happen to advice instead of
numbers: `404` → no active device (open Spotify and play something once), `403` →
Premium required. A `401` is not reported at all on the first try: the token is
renewed and the request retried once, then reported only if it fails again.
6 s timeout.

### Connecting Spotify

Spotify access tokens expire after an hour, so Monolith holds the grant rather
than a token. Authorization is **authorization code + PKCE** — a desktop app
cannot keep a client secret, since anything in the bundle is readable, and PKCE
needs none: it proves only that the client redeeming the code is the one that
started the flow.

Create an app at developer.spotify.com, add
`http://127.0.0.1:8888/monolith/callback` as a redirect URI, and paste the client
ID into the credentials panel. **Connect** opens the consent screen in the system
browser — not a `BrowserWindow` — so the real `accounts.spotify.com` address bar
is visible and an existing login is already there. The redirect is caught by a
loopback server that serves exactly one request.

Spotify requires HTTPS redirect URIs with an explicit exemption for loopback, and
the exemption is for the literal IP: `localhost` is rejected, `127.0.0.1` is not.

The refresh token is stored in the userData config and the access token is
renewed a minute before it expires, so a token cannot die mid-request.
Concurrent renewals are collapsed onto one round trip — a shift can ask for a
token while a refresh is already running, and two writers would race the config.

A hand-pasted `spotify_auth_token` from an older config still works until it
expires; the normalizer defaults the new expiry to `0`, which reads as expired
and triggers a refresh as soon as a grant exists.

### Connecting Hue

**Find bridge** queries Hue's N-UPnP discovery service, which matches bridges by
the caller's public IP, then labels each hit by asking it for `/api/config` —
the one endpoint a bridge answers unauthenticated, which doubles as a probe for
a hand-typed address. Any address that is not on a private range is dropped: the
response is remote input that would otherwise end up in a URL we call.

**Pair** posts `{"devicetype":"monolith#<host>"}` to `/api` once a second for
thirty seconds. The bridge answers `200` either way — error type `101` is the
"press the link button" prompt rather than a failure — so pairing polls through
`101`, stops immediately on a success or on any other error, and stores the
minted username as `hue_api_key`.

### OS focus

No platform has a supported public API for toggling Focus, so each degrades
through a chain and reports honestly which rung it landed on:

- **macOS** runs Shortcuts named `Monolith Focus On` / `Monolith Focus Off` if
  they exist — create them with the *Set Focus* action to get real control. The
  old `defaults write com.apple.notificationcenterui` trick is only attempted
  below macOS 11, where it can still work; on anything newer the result is
  `unsupported` with instructions rather than a silent no-op.
- **Windows** writes `ToastEnabled` under `PushNotifications`. Focus Assist
  itself lives in an undocumented CloudStore blob that changes shape between
  builds; suppressing toasts is the documented setting that survives upgrades.
- **Linux** sets `org.gnome.desktop.notifications show-banners` via `gsettings`.

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

All of this lives in `src/main/safety.ts`, free of Electron and of module-level
side effects, because it is the part of the host that most needs tests and tests
have to be able to import it. Platform is a parameter rather than a read of
`process.platform`, so the Windows quoting rules are exercised from macOS and
vice versa.

## Tests

```bash
npm test
```

`node:test`, no framework and no new dependencies. The suites compile to
`dist-test/` first: running the `.ts` files directly through Node's type
stripping is tidier, but that path is ESM and cannot resolve the extensionless
relative imports the CommonJS main build requires.

Coverage is deliberately lopsided toward the code where a bug does real damage —
shell escaping and the quote break-out it prevents, absolute-path validation,
the protected-process refusal list, `pkill`/`taskkill` exit-code mapping, the
config normalizer's never-throw contract (including profiles written before
`block_distractions` and before OAuth existed), the Hue private-range check, PKCE
against the RFC 7636 test vector, and the Spotify renew-and-retry path.

## Moods

Moods are data, not code. The deck renders whatever `profiles` contains, and
card accents, glow and the room simulation all derive from the mood's own
`hex_color`, so a user-made mood looks native rather than falling back to a
default swatch.

The profile editor covers everything a mood does — name, apps to launch (through
a native file picker, since typing `.app` paths by hand is miserable), processes
to quit, tab clearing, site blocking with its own domain list, light colour and
brightness, and playlist. Create, edit and delete all persist through
`config:write`.

Hue does not take hex, so `renderer/lib/color.ts` converts a picked sRGB colour
to CIE xy through the matrix Philips documents and the editor writes
`hue_xy_payload` on save — nobody should have to hand-compute chromaticity.

The four shipped moods (Deep Work, Brain Dump, High Energy, Late Night Chill)
carry `builtin: true`. Nothing enforces it beyond labelling; they are ordinary
profiles and can be edited like any other.

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

Blocking is **per mood**. A purge arms dynamic `declarativeNetRequest` rules when
the payload carries `block_distractions: true` (or a non-empty `blocked_domains`
list), redirecting `main_frame` navigations for those domains to the ASCII
countdown page. Deep Work blocks nine sites; High Energy blocks three. A literal
`deep_work` profile-id check survives only as a fallback for hosts that send
neither field.

`redirect_url` overrides the destination (e.g. `http://localhost:3000`) and
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
inside 0–1, `block_distractions` and `builtin` defaulted — so an older or
hand-edited file still loads and can never crash the shell.

The deck opens the credentials panel on launch until both Spotify and Hue are
connected. Nothing there needs to be typed except the Spotify client ID and, if
discovery cannot reach the bridge, its address: the tokens and the Hue key are
minted by the two flows above and written to the userData copy, which sits
outside the repo. **Do not commit filled credentials back into the template.**

## Account

Everything above works fully signed out — an account exists only to sync two
things: session history and mood schedules, so they survive a reinstall or
follow you to another machine. Email + password, via Supabase (project
`shortify`, repurposed — see `src/main/cloud.ts`). Sign-up requires clicking a
confirmation link before sign-in works; the app tells you this rather than
failing silently.

Session history is written to the `sessions` table on every disengage; the
local `monolith_sessions.json` stays the source of truth when signed out and
an offline cache when signed in. Schedules upsert to the `schedules` table on
every edit from the dashboard's Schedule card, and pull back down — overwriting
the local copy for any mood the cloud has a row for — at sign-in and at every
launch where a session is already persisted. Every table is `auth.uid()`-scoped
RLS, same convention the project's own `profiles` table already used.

The auth session (never the password) persists to `monolith_auth.json` in
userData via a small custom storage adapter — supabase-js expects a
browser-shaped `localStorage`, which the main process doesn't have.
