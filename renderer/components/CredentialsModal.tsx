import React, { useState } from "react";
import type { MonolithConfig, UserSettings } from "../monolith";

/** Values shipped in the template — present, but not real credentials. */
const PLACEHOLDERS = new Set([
  "OAUTH_BEARER_ACCESS_TOKEN_STRING_PROTOTYPE",
  "AUTHORIZED_LOCAL_HUE_DEVELOPER_HASH",
  "",
]);

export function isUnconfigured(settings: UserSettings | undefined): boolean {
  if (!settings) return false;
  return (
    PLACEHOLDERS.has(settings.spotify_auth_token.trim()) ||
    PLACEHOLDERS.has(settings.hue_api_key.trim()) ||
    PLACEHOLDERS.has(settings.hue_bridge_ip.trim())
  );
}

interface Field {
  key: keyof UserSettings;
  label: string;
  hint: string;
  placeholder: string;
}

const FIELDS: Field[] = [
  {
    key: "hue_bridge_ip",
    label: "Hue bridge address",
    hint: "Find it at discovery.meethue.com, or in the Hue app under Settings › Bridge.",
    placeholder: "192.168.1.50",
  },
  {
    key: "hue_api_key",
    label: "Hue developer key",
    hint: "Press the button on the bridge, then POST {\"devicetype\":\"monolith#mac\"} to http://<bridge>/api",
    placeholder: "Generated username string",
  },
  {
    key: "spotify_auth_token",
    label: "Spotify access token",
    hint: "Needs the user-modify-playback-state scope. Premium accounts only.",
    placeholder: "BQD…",
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

  const [draft, setDraft] = useState<UserSettings>({
    spotify_auth_token: clean(config.user_settings.spotify_auth_token),
    hue_bridge_ip: clean(config.user_settings.hue_bridge_ip),
    hue_api_key: clean(config.user_settings.hue_api_key),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const api = window.monolith;
    if (!api) return;

    setSaving(true);
    setError(null);
    try {
      const next = await api.writeConfig({ ...config, user_settings: draft });
      onSaved(next);
    } catch (cause) {
      setError(`Could not save: ${String(cause)}`);
    } finally {
      setSaving(false);
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
                type={field.key === "hue_bridge_ip" ? "text" : "password"}
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
