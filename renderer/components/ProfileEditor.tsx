import React, { useState } from "react";
import type { Profile } from "../monolith";
import { hexToXy, rgba } from "../lib/color";

const DEFAULT_BLOCKED = [
  "twitter.com",
  "x.com",
  "reddit.com",
  "youtube.com",
  "instagram.com",
  "tiktok.com",
];

/** A blank mood, ready to fill in. */
export function emptyProfile(): Profile {
  return {
    id: `mood_${Date.now().toString(36)}`,
    name: "",
    builtin: false,
    digital_purge: {
      close_browser_tabs: true,
      launch_applications: [],
      kill_background_processes: [],
      launch_app_names: [],
      launch_categories: [],
      launch_category_limit: 2,
      launch_urls: [],
      kill_categories: [],
      force_quit: false,
      block_distractions: false,
      blocked_domains: [],
    },
    physical_orchestration: {
      lights_enabled: true,
      hex_color: "#6366F1",
      brightness: 60,
      hue_xy_payload: hexToXy("#6366F1"),
    },
    sonic_layering: {
      spotify_enabled: false,
      playlist_uri: "",
      target_frequency_profile: "",
    },
  };
}

const toLines = (values: string[]) => values.join("\n");
const fromLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/**
 * People copy the normal share link from Spotify ("Copy link to playlist"),
 * not the spotify:playlist:… form the API wants — asking them to know the
 * difference is exactly the kind of raw-protocol detail a real app hides.
 */
function normalizeSpotifyLink(value: string): string {
  const trimmed = value.trim();
  const match = /open\.spotify\.com\/(playlist|album|track)\/([A-Za-z0-9]+)/.exec(trimmed);
  return match ? `spotify:${match[1]}:${match[2]}` : trimmed;
}

function Section({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="border-t border-[#1b1b22] pt-5">
      <h3 className="text-sm font-medium text-slate-300">{title}</h3>
      <p className="mb-3 mt-1 text-xs leading-relaxed text-slate-500">{caption}</p>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 cursor-pointer accent-indigo-500"
      />
      {label}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-[#242430] bg-black/60 px-3 py-2 text-sm text-slate-200 outline-none transition focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/40";

export default function ProfileEditor({
  profile,
  isNew,
  onSave,
  onDelete,
  onCancel,
}: {
  profile: Profile;
  isNew: boolean;
  onSave: (next: Profile) => void;
  onDelete?: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Profile>(profile);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const purge = draft.digital_purge;
  const physical = draft.physical_orchestration;
  const sonic = draft.sonic_layering;

  const patchPurge = (patch: Partial<Profile["digital_purge"]>) =>
    setDraft((prev) => ({ ...prev, digital_purge: { ...prev.digital_purge, ...patch } }));
  const patchPhysical = (patch: Partial<Profile["physical_orchestration"]>) =>
    setDraft((prev) => ({
      ...prev,
      physical_orchestration: { ...prev.physical_orchestration, ...patch },
    }));
  const patchSonic = (patch: Partial<Profile["sonic_layering"]>) =>
    setDraft((prev) => ({ ...prev, sonic_layering: { ...prev.sonic_layering, ...patch } }));

  const pickApps = async () => {
    const api = window.monolith;
    if (!api) return;
    const picked = await api.pickApplications();
    if (picked.length === 0) return;
    patchPurge({
      launch_applications: [...new Set([...purge.launch_applications, ...picked])],
    });
  };

  const save = () => {
    const name = draft.name.trim() || "Untitled mood";
    onSave({
      ...draft,
      name,
      // Keep the id stable for existing moods; derive a readable one for new.
      id: isNew ? name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || draft.id : draft.id,
      physical_orchestration: {
        ...draft.physical_orchestration,
        // The user picks a colour; the bridge needs chromaticity coordinates.
        hue_xy_payload: hexToXy(draft.physical_orchestration.hex_color),
      },
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="editor-title"
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/85 p-4 backdrop-blur-sm sm:p-8"
    >
      <div className="app-no-drag my-auto w-full max-w-xl rounded-2xl border border-[#1e1e1e] bg-[#0d0d12] p-6 shadow-2xl sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="editor-title" className="text-lg font-semibold text-slate-100">
              {isNew ? "New mood" : `Edit ${profile.name}`}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Everything here happens the moment you press Engage.
            </p>
          </div>
          <span
            className="mt-1 h-8 w-8 shrink-0 rounded-full border border-[#242430]"
            style={{ backgroundColor: physical.hex_color, boxShadow: `0 0 16px ${rgba(physical.hex_color, 0.5)}` }}
          />
        </div>

        <div className="mt-6 flex flex-col gap-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-slate-500">Name</span>
            <input
              value={draft.name}
              placeholder="Late night writing"
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              className={inputClass}
            />
          </label>

          <Section title="Apps to open" caption="Launched the moment this mood starts.">
            <button
              onClick={() => void pickApps()}
              className="self-start rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-white"
            >
              Add apps…
            </button>
            {purge.launch_applications.length > 0 && (
              <textarea
                rows={2}
                value={toLines(purge.launch_applications)}
                onChange={(event) => patchPurge({ launch_applications: fromLines(event.target.value) })}
                className={`${inputClass} resize-y`}
              />
            )}
          </Section>

          <Section
            title="Apps to close"
            caption="Closed to clear the decks. Type each app's name as it shows up when it's running — some apps go by a different name than their icon (iTerm shows up as “iTerm2”, for example)."
          >
            <textarea
              rows={2}
              value={toLines(purge.kill_background_processes)}
              placeholder="Slack"
              onChange={(event) =>
                patchPurge({ kill_background_processes: fromLines(event.target.value) })
              }
              className={`${inputClass} resize-y`}
            />
            <Toggle
              checked={purge.force_quit}
              onChange={(next) => patchPurge({ force_quit: next })}
              label="Quit right away, even if something's unsaved"
            />
          </Section>

          <Section title="Browser" caption="Needs the Monolith browser extension turned on.">
            <Toggle
              checked={purge.close_browser_tabs}
              onChange={(next) => patchPurge({ close_browser_tabs: next })}
              label="Clear open tabs (they come back when you leave this mood)"
            />
            <Toggle
              checked={purge.block_distractions}
              onChange={(next) => patchPurge({ block_distractions: next })}
              label="Block distracting sites while this mood is on"
            />
            {purge.block_distractions && (
              <>
                <textarea
                  rows={3}
                  value={toLines(purge.blocked_domains)}
                  placeholder={DEFAULT_BLOCKED.join("\n")}
                  onChange={(event) => patchPurge({ blocked_domains: fromLines(event.target.value) })}
                  className={`${inputClass} resize-y`}
                />
                <button
                  onClick={() => patchPurge({ blocked_domains: DEFAULT_BLOCKED })}
                  className="self-start text-xs text-slate-500 underline decoration-slate-700 underline-offset-2 transition hover:text-slate-300"
                >
                  Use the usual suspects
                </button>
              </>
            )}
          </Section>

          <Section title="Lights" caption="Needs a Philips Hue bridge. The colour also drives the room preview.">
            <Toggle
              checked={physical.lights_enabled}
              onChange={(next) => patchPhysical({ lights_enabled: next })}
              label="Set the lights for this mood"
            />
            {physical.lights_enabled && (
              <div className="flex flex-wrap items-center gap-4">
                <input
                  type="color"
                  aria-label="Light colour"
                  value={physical.hex_color}
                  onChange={(event) => patchPhysical({ hex_color: event.target.value.toUpperCase() })}
                  className="h-9 w-16 cursor-pointer rounded border border-[#242430] bg-transparent"
                />
                <label className="flex flex-1 items-center gap-3 text-xs text-slate-500">
                  Brightness
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={physical.brightness}
                    onChange={(event) => patchPhysical({ brightness: Number(event.target.value) })}
                    className="flex-1 accent-indigo-500"
                  />
                  <span className="w-9 text-right text-slate-300">{physical.brightness}%</span>
                </label>
              </div>
            )}
          </Section>

          <Section title="Music" caption="Needs Spotify Premium and the app already open on a device.">
            <Toggle
              checked={sonic.spotify_enabled}
              onChange={(next) => patchSonic({ spotify_enabled: next })}
              label="Start a playlist"
            />
            {sonic.spotify_enabled && (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-slate-500">Playlist link</span>
                  <input
                    value={sonic.playlist_uri}
                    placeholder="Paste a playlist link from Spotify's Share button"
                    onChange={(event) => patchSonic({ playlist_uri: normalizeSpotifyLink(event.target.value) })}
                    className={inputClass}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-slate-500">What to call it</span>
                  <input
                    value={sonic.target_frequency_profile}
                    placeholder="Focus playlist"
                    onChange={(event) => patchSonic({ target_frequency_profile: event.target.value })}
                    className={inputClass}
                  />
                </label>
              </>
            )}
          </Section>
        </div>

        <div className="mt-7 flex items-center justify-between gap-3 border-t border-[#1b1b22] pt-5">
          <div>
            {onDelete &&
              (confirmingDelete ? (
                <button
                  onClick={onDelete}
                  className="rounded-full bg-red-500/15 px-4 py-2 text-sm text-red-300 transition hover:bg-red-500/25"
                >
                  Delete for good
                </button>
              ) : (
                <button
                  onClick={() => setConfirmingDelete(true)}
                  className="rounded-full px-3 py-2 text-sm text-slate-500 transition hover:text-red-400"
                >
                  Delete
                </button>
              ))}
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={onCancel}
              className="text-sm text-slate-500 transition hover:text-slate-300"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="rounded-full bg-indigo-500 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-400"
            >
              {isNew ? "Create mood" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
