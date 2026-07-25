# Monolith — Backend

Environmental and workspace orchestration engine. This branch holds the desktop
host and the browser agent; the renderer UI lives on `frontend`.

```
src/main/main.ts        Electron main process — app shell, launcher, WebSocket bridge
src/main/preload.ts     contextBridge surface exposed to the renderer as window.monolith
extension/background.js Chrome MV3 service worker — purge / hydrate executor
extension/manifest.json Extension manifest (tabs, storage, alarms)
monolith_config.json    Profile + credential schema (template; live copy lives in userData)
```

## Run it

```bash
npm install          # downloads the Electron binary
npm start            # compiles TS to dist/ and boots the shell
npm run dev          # same, pointed at a renderer dev server on :5173
```

The renderer is resolved in this order: `MONOLITH_RENDERER_URL` →
`dist/renderer/index.html` → a built-in fallback page. The host boots and the
bridge serves regardless of whether the frontend branch is built.

Load the extension via `chrome://extensions` → Developer mode → **Load unpacked**
→ select `extension/`. It connects to `ws://localhost:8080` on install, on
browser startup, and on a 30-second alarm that also revives the worker after
Chrome evicts it.

## IPC contract

| Channel | Argument | Returns |
| --- | --- | --- |
| `execute-reality-shift` | `string[]` of absolute app paths | `RealityShiftReport` — per-target `launched`/`failed` with reasons |
| `dispatch-browser-signal` | `'AGGRESSIVE_PURGE' \| 'HYDRATE_SESSION'`, payload | `{ ok, receivers }` |
| `config:read` / `config:write` | — / `MonolithConfig` | normalized `MonolithConfig` |
| `system:info` | — | platform, versions, bridge URL |

`bridge:event` is pushed to the renderer whenever the extension acknowledges a
signal (`PURGE_COMPLETE`, `HYDRATE_COMPLETE`, `SIGNAL_FAILED`).

**No IPC handler ever rejects.** A bad path, a missing extension, or a corrupt
config all come back as a structured report so the renderer never has to guard a
throw, and one dead app in a profile never aborts the rest of the shift.

## Launch pipeline

Each target is launched concurrently through the platform opener —
`open` (darwin), `start "" …` (win32), `xdg-open` (linux) — in a detached,
unawaited child process.

Paths are validated before a command string is built: they must be absolute,
free of control characters, and present on disk; on Windows, characters that
cannot be safely quoted for `cmd.exe` (`"`, `%`, `!`) are rejected outright.
POSIX targets are single-quoted with `'` → `'\''` escaping, so a path containing
quotes or semicolons reaches the opener as one literal argv entry rather than as
shell syntax.

## Session cache

`AGGRESSIVE_PURGE` writes the snapshot to `chrome.storage.local` and **awaits the
write** before closing anything — a failed write costs zero tabs. Pinned tabs are
never touched. `HYDRATE_SESSION` restores in original tab order and then clears
the key, so a snapshot is single-use.

Tabs whose URL is not `http(s)`, `file`, or `ftp` are captured but skipped on
restore, since `chrome.tabs.create` refuses `chrome://` and `devtools://` URLs;
they are counted in the `skipped` total of the completion report.

## Config

`monolith_config.json` at the repo root is a template. On first run it is copied
to `app.getPath('userData')`, and every write goes there via write-then-rename.
Every field is normalized on read — unknown `browser_action` values fall back to
`NONE`, brightness and volume are clamped, missing profiles become `[]` — so a
hand-edited file can never crash the shell.

Credentials (`spotify_auth_token`, `hue_bridge_ip`, `hue_api_key`) ship empty and
are read from the userData copy, which is outside the repo. Do not commit filled
values back into the template.
