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

/** The fields a user types. Tokens are never among them — the flow owns those. */
interface Field {
  key: "hue_bridge_ip" | "hue_api_key" | "spotify_client_id";
  label: string;
  hint: React.ReactNode;
  placeholder: string;
  secret?: boolean;
}

const FIELDS: Field[] = [
  {
    key: "hue_bridge_ip",
    label: "Hue bridge address",
    hint: "Use Find bridge below, or type the address from the Hue app under Settings › Bridge.",
    placeholder: "192.168.1.50",
  },
  {
    key: "spotify_client_id",
    label: "Spotify client ID",
    hint: (
      <>
        Create an app at developer.spotify.com and add{" "}
        <code className="text-slate-500">{REDIRECT_URI}</code> as a redirect URI. Premium accounts
        only.
      </>
    ),
    placeholder: "32-character client ID",
  },
];

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
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(isSpotifyConnected(config.user_settings));
  const [hueBusy, setHueBusy] = useState<"idle" | "discovering" | "pairing">("idle");
  const [hueBridges, setHueBridges] = useState<HueBridgeCandidate[]>([]);
  const [hueConnected, setHueConnected] = useState(isHueConnected(config.user_settings));

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
      setError(`Could not save: ${String(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  const findBridges = async () => {
    const api = window.monolith;
    if (!api) return;

    setHueBusy("discovering");
    setError(null);
    setNotice(null);
    try {
      const result = await api.discoverHueBridges();
      setHueBridges(result.bridges);

      if (result.bridges.length === 1) {
        // One bridge is the common case; fill it in rather than making them click.
        setDraft((prev) => ({ ...prev, hue_bridge_ip: result.bridges[0]!.ip }));
        setNotice(`Found ${result.bridges[0]!.name || "a bridge"} — now press its link button and pair.`);
      } else if (result.bridges.length > 1) {
        setNotice("Choose which bridge to use.");
      } else {
        setError(result.detail);
      }
    } catch (cause) {
      setError(`Discovery failed: ${String(cause)}`);
    } finally {
      setHueBusy("idle");
    }
  };

  const pairBridge = async () => {
    const api = window.monolith;
    if (!api) return;

    const ip = draft.hue_bridge_ip.trim();
    if (!ip) {
      setError("Find or enter a bridge address first.");
      return;
    }

    setHueBusy("pairing");
    setError(null);
    setNotice("Press the round button on top of your Hue bridge — waiting up to 30 seconds…");
    try {
      const result = await api.pairHueBridge(ip);

      if (result.ok) {
        setHueConnected(true);
        setNotice(result.detail);
        // The bridge minted the key and the main process stored it; pull it back.
        const next = await api.readConfig();
        setDraft((prev) => ({ ...prev, hue_api_key: next.user_settings.hue_api_key }));
        onSaved(next);
      } else {
        setNotice(null);
        setError(result.detail);
      }
    } catch (cause) {
      setNotice(null);
      setError(`Pairing failed: ${String(cause)}`);
    } finally {
      setHueBusy("idle");
    }
  };

  const connectSpotify = async () => {
    const api = window.monolith;
    if (!api) return;

    if (!draft.spotify_client_id.trim()) {
      setError("Add a Spotify client ID first.");
      return;
    }

    setConnecting(true);
    setError(null);
    setNotice("Finish signing in through the browser window…");
    try {
      // The client ID has to be on disk before the main process reads it.
      await api.writeConfig(await merged());
      const result = await api.authorizeSpotify();

      if (result.ok) {
        setConnected(true);
        setNotice(result.detail);
        // The grant was written by the main process; pull it back in.
        onSaved(await api.readConfig());
      } else {
        setNotice(null);
        setError(result.detail);
      }
    } catch (cause) {
      setNotice(null);
      setError(`Could not connect Spotify: ${String(cause)}`);
    } finally {
      setConnecting(false);
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
        <h2 id="credentials-title" className="text-lg font-semibold text-slate-100">
          Connect your room
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Monolith launches apps and clears tabs without these. Add them to also drive your lights
          and music — they are stored locally and never leave this machine.
        </p>

        <div className="mt-6 flex flex-col gap-4">
          {FIELDS.map((field) => (
            <label key={field.key} className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-widest text-slate-500">
                {field.label}
              </span>
              <input
                type={field.secret ? "password" : "text"}
                value={draft[field.key]}
                placeholder={field.placeholder}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))
                }
                className="rounded-lg border border-[#242430] bg-black/60 px-3 py-2 font-mono text-sm text-slate-200 outline-none transition focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/40"
              />
              <span className="text-[11px] leading-relaxed text-slate-600">{field.hint}</span>
            </label>
          ))}
        </div>

        <div className="mt-5 rounded-lg border border-[#1e1e1e] bg-black/40 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium uppercase tracking-widest text-slate-500">
                Hue bridge
              </span>
              <span className={`text-xs ${hueConnected ? "text-emerald-400" : "text-slate-600"}`}>
                {hueConnected ? "Paired — a key is stored for this bridge" : "Not paired"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => void findBridges()}
                disabled={hueBusy !== "idle"}
                className="rounded-full border border-[#2a2a35] px-3 py-2 text-xs font-semibold uppercase tracking-widest text-slate-300 transition hover:border-slate-500 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
              >
                {hueBusy === "discovering" ? "Searching…" : "Find bridge"}
              </button>
              <button
                onClick={() => void pairBridge()}
                disabled={hueBusy !== "idle"}
                className="rounded-full border border-amber-500/40 px-3 py-2 text-xs font-semibold uppercase tracking-widest text-amber-300 transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
              >
                {hueBusy === "pairing" ? "Waiting…" : hueConnected ? "Re-pair" : "Pair"}
              </button>
            </div>
          </div>

          {hueBridges.length > 1 && (
            <ul className="mt-3 flex flex-col gap-1 border-t border-[#1e1e1e] pt-3">
              {hueBridges.map((bridge) => {
                const chosen = bridge.ip === draft.hue_bridge_ip.trim();
                return (
                  <li key={bridge.id}>
                    <button
                      onClick={() => setDraft((prev) => ({ ...prev, hue_bridge_ip: bridge.ip }))}
                      className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition ${
                        chosen ? "bg-amber-500/10 text-amber-200" : "text-slate-400 hover:bg-white/5"
                      }`}
                    >
                      <span>{bridge.name || "Hue bridge"}</span>
                      <span className="font-mono text-[11px] text-slate-500">{bridge.ip}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-[#1e1e1e] bg-black/40 px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium uppercase tracking-widest text-slate-500">
              Spotify account
            </span>
            <span className={`text-xs ${connected ? "text-emerald-400" : "text-slate-600"}`}>
              {connected ? "Connected — tokens renew automatically" : "Not connected"}
            </span>
          </div>
          <button
            onClick={() => void connectSpotify()}
            disabled={connecting}
            className="shrink-0 rounded-full border border-emerald-500/40 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-emerald-300 transition hover:border-emerald-400 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
          >
            {connecting ? "Waiting…" : connected ? "Reconnect" : "Connect"}
          </button>
        </div>

        {notice && <p className="mt-4 text-sm text-slate-400">{notice}</p>}
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-400">
            {error}
          </p>
        )}

        <div className="mt-7 flex items-center justify-end gap-3">
          <button
            onClick={onDismiss}
            className="rounded-full px-4 py-2 text-xs uppercase tracking-widest text-slate-500 transition hover:text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
          >
            Skip for now
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-full bg-indigo-500 px-5 py-2 text-xs font-semibold uppercase tracking-widest text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300"
          >
            {saving ? "Saving…" : "Save credentials"}
          </button>
        </div>
      </div>
    </div>
  );
}
