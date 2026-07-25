import React, { useState } from "react";
import type { HueBridgeCandidate, MonolithConfig, UserSettings } from "../monolith";

/** Values shipped in the template — present, but not real credentials. */
const PLACEHOLDERS = new Set([
  "OAUTH_BEARER_ACCESS_TOKEN_STRING_PROTOTYPE",
  "AUTHORIZED_LOCAL_HUE_DEVELOPER_HASH",
  "",
]);

/** Must match REDIRECT_URI in src/main/spotify-auth.ts. */
const REDIRECT_URI = "http://127.0.0.1:8888/monolith/callback";

/** Spotify is set up once the grant exists; the access token renews itself. */
export function isSpotifyConnected(settings: UserSettings | undefined): boolean {
  return Boolean(settings?.spotify_refresh_token.trim());
}

/** Hue is set up once a bridge has minted us a key. */
export function isHueConnected(settings: UserSettings | undefined): boolean {
  if (!settings) return false;
  return !PLACEHOLDERS.has(settings.hue_api_key.trim()) && !PLACEHOLDERS.has(settings.hue_bridge_ip.trim());
}

export function isUnconfigured(settings: UserSettings | undefined): boolean {
  if (!settings) return false;
  return !isSpotifyConnected(settings) || !isHueConnected(settings);
}

/** Copies to the clipboard and flashes a confirmation — no raw text to select by hand. */
function CopyChip({ value }: { value: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-[#242430] bg-black/40 px-2 py-1 font-mono text-[11px] text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
    >
      {value}
      <span className="text-slate-600">{copied ? "✓ copied" : "copy"}</span>
    </button>
  );
}

/** A collapsed "for people who need it" panel — never shown open by default once a value exists. */
function Advanced({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onToggle}
        className="text-xs text-slate-500 underline decoration-slate-700 underline-offset-2 transition hover:text-slate-300"
      >
        {open ? "Hide" : label}
      </button>
      {open && <div className="mt-3 flex flex-col gap-3">{children}</div>}
    </div>
  );
}

export default function CredentialsModal({
  config,
  onSaved,
  onDismiss,
}: {
  config: MonolithConfig;
  onSaved: (next: MonolithConfig) => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const clean = (value: string) => (PLACEHOLDERS.has(value.trim()) ? "" : value);

  const [draft, setDraft] = useState({
    hue_bridge_ip: clean(config.user_settings.hue_bridge_ip),
    hue_api_key: clean(config.user_settings.hue_api_key),
    spotify_client_id: clean(config.user_settings.spotify_client_id),
  });
  const [saving, setSaving] = useState(false);
  const [connectingSpotify, setConnectingSpotify] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [spotifyConnected, setSpotifyConnected] = useState(isSpotifyConnected(config.user_settings));
  const [hueBusy, setHueBusy] = useState<"idle" | "working">("idle");
  const [hueBridges, setHueBridges] = useState<HueBridgeCandidate[]>([]);
  const [hueConnected, setHueConnected] = useState(isHueConnected(config.user_settings));
  const [hueAdvancedOpen, setHueAdvancedOpen] = useState(false);
  const [spotifyAdvancedOpen, setSpotifyAdvancedOpen] = useState(!draft.spotify_client_id.trim());

  /** Merges the typed fields over whatever the grant has already written. */
  const merged = async (): Promise<MonolithConfig> => {
    const api = window.monolith;
    if (!api) throw new Error("bridge unavailable");
    const current = await api.readConfig();
    return { ...current, user_settings: { ...current.user_settings, ...draft } };
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await window.monolith!.writeConfig(await merged());
      onSaved(next);
    } catch (cause) {
      setError(`Couldn't save that: ${String(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  /**
   * One button covers the whole flow: search, and when exactly one bridge
   * turns up (the common case), pair with it right away. A raw "type the IP,
   * then press Pair" two-step is dev-tool shaped; most people never have to
   * see either step.
   */
  const connectHue = async () => {
    const api = window.monolith;
    if (!api) return;

    setHueBusy("working");
    setError(null);
    setNotice("Looking for a bridge on your network…");
    setHueBridges([]);

    try {
      const discovered = await api.discoverHueBridges();

      if (discovered.bridges.length === 0) {
        setNotice(null);
        setError("Couldn't find a bridge on this network. You can enter its address below.");
        setHueAdvancedOpen(true);
        return;
      }

      if (discovered.bridges.length > 1) {
        setHueBridges(discovered.bridges);
        setNotice("Found more than one — pick yours below.");
        return;
      }

      await pairWith(discovered.bridges[0]!);
    } catch (cause) {
      setNotice(null);
      setError(`Couldn't reach your network: ${String(cause)}`);
    } finally {
      setHueBusy("idle");
    }
  };

  const pairWith = async (bridge: HueBridgeCandidate) => {
    const api = window.monolith;
    if (!api) return;

    setDraft((prev) => ({ ...prev, hue_bridge_ip: bridge.ip }));
    setHueBusy("working");
    setError(null);
    setNotice(`Press the button on top of ${bridge.name || "your bridge"} — you have about 30 seconds.`);

    try {
      const result = await api.pairHueBridge(bridge.ip);
      if (result.ok) {
        setHueConnected(true);
        setHueBridges([]);
        setNotice("Lights connected.");
        // The bridge minted the key and the main process stored it; pull it back.
        onSaved(await api.readConfig());
      } else {
        setNotice(null);
        setError(result.detail);
      }
    } catch (cause) {
      setNotice(null);
      setError(`Pairing didn't finish: ${String(cause)}`);
    } finally {
      setHueBusy("idle");
    }
  };

  /** The manual fallback for a network discovery can't reach. */
  const pairManually = async () => {
    const ip = draft.hue_bridge_ip.trim();
    if (!ip) {
      setError("Enter your bridge's address first.");
      return;
    }
    await pairWith({ id: ip, ip, name: "", model: "" });
  };

  const connectSpotify = async () => {
    const api = window.monolith;
    if (!api) return;

    if (!draft.spotify_client_id.trim()) {
      setSpotifyAdvancedOpen(true);
      setError("Add your Spotify app ID first.");
      return;
    }

    setConnectingSpotify(true);
    setError(null);
    setNotice("Finish signing in — a browser window just opened…");
    try {
      // The client ID has to be on disk before the main process reads it.
      await api.writeConfig(await merged());
      const result = await api.authorizeSpotify();

      if (result.ok) {
        setSpotifyConnected(true);
        setNotice("Music connected.");
        onSaved(await api.readConfig());
      } else {
        setNotice(null);
        setError(result.detail);
      }
    } catch (cause) {
      setNotice(null);
      setError(`Couldn't connect Spotify: ${String(cause)}`);
    } finally {
      setConnectingSpotify(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="credentials-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="app-no-drag w-full max-w-lg rounded-2xl border border-[#1e1e1e] bg-[#0d0d12] p-6 shadow-2xl sm:p-8">
        <h2 id="credentials-title" className="text-xl font-semibold text-slate-100">
          Connect your room
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Your moods can already open apps and clear tabs. Connect your lights and speaker so they
          can set the scene too — everything here stays on this computer.
        </p>

        {/* Lights */}
        <div className="mt-6 rounded-xl border border-[#1e1e1e] bg-black/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-200">Smart lights</p>
              <p className={`text-xs ${hueConnected ? "text-emerald-400" : "text-slate-500"}`}>
                {hueConnected ? "Connected" : "Not connected"}
              </p>
            </div>
            <button
              onClick={() => void connectHue()}
              disabled={hueBusy !== "idle"}
              className="shrink-0 rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-300"
            >
              {hueBusy === "working" ? "Working…" : hueConnected ? "Reconnect" : "Connect"}
            </button>
          </div>

          {hueBridges.length > 1 && (
            <ul className="mt-3 flex flex-col gap-1 border-t border-[#1e1e1e] pt-3">
              {hueBridges.map((bridge) => (
                <li key={bridge.id}>
                  <button
                    onClick={() => void pairWith(bridge)}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-slate-300 transition hover:bg-white/5"
                  >
                    <span>{bridge.name || "Hue bridge"}</span>
                    <span className="text-xs text-slate-600">Choose</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <Advanced
            open={hueAdvancedOpen}
            onToggle={() => setHueAdvancedOpen((v) => !v)}
            label="Enter the bridge address myself"
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draft.hue_bridge_ip}
                placeholder="192.168.1.50"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setDraft((prev) => ({ ...prev, hue_bridge_ip: event.target.value }))}
                className="flex-1 rounded-lg border border-[#242430] bg-black/60 px-3 py-2 text-sm text-slate-200 outline-none transition focus:border-slate-400 focus:ring-1 focus:ring-slate-400/40"
              />
              <button
                onClick={() => void pairManually()}
                disabled={hueBusy !== "idle"}
                className="shrink-0 rounded-lg border border-[#242430] px-3 py-2 text-sm text-slate-300 transition hover:border-slate-500 disabled:opacity-50"
              >
                Pair
              </button>
            </div>
            <p className="text-xs leading-relaxed text-slate-600">
              Find this in the Hue app under Settings › Bridge.
            </p>
          </Advanced>
        </div>

        {/* Music */}
        <div className="mt-3 rounded-xl border border-[#1e1e1e] bg-black/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-200">Music</p>
              <p className={`text-xs ${spotifyConnected ? "text-emerald-400" : "text-slate-500"}`}>
                {spotifyConnected ? "Connected to Spotify" : "Not connected"}
              </p>
            </div>
            <button
              onClick={() => void connectSpotify()}
              disabled={connectingSpotify}
              className="shrink-0 rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
            >
              {connectingSpotify ? "Working…" : spotifyConnected ? "Reconnect" : "Connect"}
            </button>
          </div>

          <Advanced
            open={spotifyAdvancedOpen}
            onToggle={() => setSpotifyAdvancedOpen((v) => !v)}
            label="Add my Spotify app ID"
          >
            <p className="text-xs leading-relaxed text-slate-500">
              Needs a free developer app from Spotify — one-time setup, about a minute.{" "}
              <a
                href="https://developer.spotify.com/dashboard"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline decoration-emerald-800 underline-offset-2 hover:text-emerald-300"
              >
                Create one ↗
              </a>{" "}
              and set its redirect URL to:
            </p>
            <CopyChip value={REDIRECT_URI} />
            <input
              type="text"
              value={draft.spotify_client_id}
              placeholder="Paste the Client ID from that app"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setDraft((prev) => ({ ...prev, spotify_client_id: event.target.value }))}
              className="rounded-lg border border-[#242430] bg-black/60 px-3 py-2 text-sm text-slate-200 outline-none transition focus:border-slate-400 focus:ring-1 focus:ring-slate-400/40"
            />
            <p className="text-xs text-slate-600">Requires a Spotify Premium account to play music.</p>
          </Advanced>
        </div>

        {notice && <p className="mt-4 text-sm text-slate-400">{notice}</p>}
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-400">
            {error}
          </p>
        )}

        <div className="mt-7 flex items-center justify-end gap-4">
          <button
            onClick={onDismiss}
            className="text-sm text-slate-500 transition hover:text-slate-300"
          >
            Not now
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-full bg-indigo-500 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300"
          >
            {saving ? "Saving…" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
