import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Profile,
  BridgeEvent,
  MonolithConfig,
  RealityShiftReport,
} from "../monolith";
import CredentialsModal, { isUnconfigured } from "./CredentialsModal";
import ProfileEditor, { emptyProfile } from "./ProfileEditor";
import { rgba, shade } from "../lib/color";

const WS_PORT = 8080;
/** Neutral State — the room glows white until a mood is engaged. */
const NEUTRAL_HEX = "#FFFFFF";

interface CrisisStat {
  id: string;
  headline: string;
  body: string;
  source: string;
}

const CRISIS_STATS: CrisisStat[] = [
  {
    id: "cognitive-drain",
    headline: "COGNITIVE DRAIN EFFICIENCY DETECTED",
    body: "Up to 40% of productive time is lost daily to task shifting and setup friction rituals.",
    source: "American Psychological Association",
  },
  {
    id: "system-overload",
    headline: "SYSTEM OVERLOAD WARNING",
    body: "Knowledge workers lose an average of 2 hours per day to workspace distractions, draining $650 Billion annually from the US Economy.",
    source: "Speakwise Index",
  },
  {
    id: "recovery-threshold",
    headline: "DISRUPTION RECOVERY THRESHOLD",
    body: "It takes an average of 23 minutes and 15 seconds to fully refocus after a single digital workplace disruption.",
    source: "Dr. Gloria Mark, UC Irvine",
  },
  {
    id: "clutter-factor",
    headline: "DIGITAL CLUTTER FACTOR",
    body: "Modern workers toggle between browser tabs and applications up to 1,200 times per day, wasting 3.6 hours per week in context switching.",
    source: "Asana & Harvard Business Review data",
  },
  {
    id: "fragmentation-coefficient",
    headline: "FRAGMENTATION COEFFICIENT",
    body: "The average uninterrupted focus session on an un-orchestrated desktop workspace lasts an abysmal 13 minutes and 7 seconds.",
    source: "ActivTrak State of the Workplace study",
  },
];

type LogTone = "success" | "network" | "iot" | "sonic" | "warn" | "error";

interface LogLine {
  id: string;
  time: string;
  tone: LogTone;
  text: string;
}

const LOG_TONE_CLASS: Record<LogTone, string> = {
  success: "text-emerald-400",
  network: "text-cyan-400",
  iot: "text-fuchsia-400",
  sonic: "text-violet-300",
  warn: "text-amber-400",
  error: "text-red-400",
};

function timestamp(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8) + "." + String(now.getMilliseconds()).padStart(3, "0");
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? filePath;
  return last.replace(/\.(app|exe|desktop|lnk)$/i, "");
}

/** One line describing what a mood will actually do, for the card face. */
function summarize(profile: Profile): string {
  const purge = profile.digital_purge;
  const bits: string[] = [];
  if (purge.launch_applications.length > 0) bits.push(`${purge.launch_applications.length} apps`);
  if (purge.kill_background_processes.length > 0) {
    bits.push(`quits ${purge.kill_background_processes.length}`);
  }
  if (purge.close_browser_tabs) bits.push("clears tabs");
  if (purge.block_distractions) bits.push("blocks sites");
  if (profile.sonic_layering.spotify_enabled) bits.push("music");
  return bits.length > 0 ? bits.join(" · ") : "Nothing configured yet";
}

export default function CommandDeck(): React.JSX.Element {
  const [config, setConfig] = useState<MonolithConfig | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** null is the Neutral State: nothing engaged, room white, OS untouched. */
  const [engagedId, setEngagedId] = useState<string | null>(null);
  const [shellReady, setShellReady] = useState<boolean | null>(null);
  const [extensionOnline, setExtensionOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waveId, setWaveId] = useState(0);
  const [isWaving, setIsWaving] = useState(false);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [showCredentials, setShowCredentials] = useState(false);
  const [credentialsDismissed, setCredentialsDismissed] = useState(false);
  const [editing, setEditing] = useState<{ profile: Profile; isNew: boolean } | null>(null);
  const logCounter = useRef(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const profiles = useMemo(() => config?.profiles ?? [], [config]);
  const active = useMemo(
    () => profiles.find((profile) => profile.id === activeId) ?? profiles[0] ?? null,
    [profiles, activeId],
  );
  const focusMode = engagedId !== null;

  // Accents come from the mood's own colour, so a user-made mood looks native
  // without asking anyone to pick more than a swatch.
  const accent = active?.physical_orchestration.hex_color ?? "#6366F1";
  const accentSoft = rgba(accent, 0.35);
  const accentDim = rgba(accent, 0.12);

  const appendLog = useCallback((entries: { tone: LogTone; text: string }[]) => {
    setLogLines((prev) => {
      const next = entries.map((entry) => {
        logCounter.current += 1;
        return { ...entry, id: `log-${logCounter.current}`, time: timestamp() };
      });
      return [...prev, ...next].slice(-60);
    });
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Boot                                                                    */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const api = window.monolith;
    if (!api) {
      setShellReady(false);
      appendLog([
        {
          tone: "error",
          text: "[SHELL] Electron bridge not detected. Open this UI through the Monolith app — a browser tab cannot launch applications.",
        },
      ]);
      return;
    }

    setShellReady(true);
    let cancelled = false;

    void (async () => {
      try {
        const [loaded, info] = await Promise.all([api.readConfig(), api.systemInfo()]);
        if (cancelled) return;
        setConfig(loaded);
        setActiveId((current) => current ?? loaded.profiles[0]?.id ?? null);
        if (isUnconfigured(loaded.user_settings)) setShowCredentials(true);
        appendLog([
          {
            tone: "success",
            text: `[SHELL] Host online — ${info.platform}/${info.arch}, Electron ${info.electron}. ${loaded.profiles.length} moods loaded.`,
          },
          {
            tone: "network",
            text: `[WS:${WS_PORT}] Bridge listening on ${info.bridgeUrl}. Awaiting extension handshake.`,
          },
        ]);
      } catch (error) {
        if (cancelled) return;
        appendLog([{ tone: "error", text: `[SHELL] Config read failed: ${String(error)}` }]);
      }
    })();

    const unsubscribe = api.onBridgeEvent((event: BridgeEvent) => {
      const payload = event.payload ?? {};
      switch (event.type) {
        case "EXTENSION_READY":
          setExtensionOnline(true);
          appendLog([{ tone: "success", text: `[EXT] Service worker connected on port ${WS_PORT}.` }]);
          break;
        case "PURGE_COMPLETE": {
          setExtensionOnline(true);
          const blockade = payload.blockade as { armed?: boolean; domains?: string[] } | undefined;
          appendLog([
            {
              tone: "network",
              text: `[EXT] Purge complete — ${payload.cached ?? 0} tabs cached, ${payload.purged ?? 0} closed in ${payload.durationMs ?? 0}ms.`,
            },
            ...(blockade?.armed
              ? [
                  {
                    tone: "warn" as LogTone,
                    text: `[EXT] Blockade armed across ${blockade.domains?.length ?? 0} sites.`,
                  },
                ]
              : []),
          ]);
          break;
        }
        case "HYDRATE_COMPLETE":
          setExtensionOnline(true);
          appendLog([
            {
              tone: "network",
              text: `[EXT] Session restored — ${payload.restored ?? 0} tabs rebuilt, ${payload.skipped ?? 0} skipped. Blockade released.`,
            },
          ]);
          break;
        case "BLOCKADE_RELEASED":
          appendLog([{ tone: "success", text: "[EXT] Blockade released." }]);
          break;
        case "SIGNAL_FAILED":
          appendLog([
            {
              tone: "error",
              text: `[EXT] ${payload.signal ?? "signal"} failed: ${payload.error ?? "unknown"}`,
            },
          ]);
          break;
        default:
          break;
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [appendLog]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logLines]);

  /* ---------------------------------------------------------------------- */
  /* Execution                                                               */
  /* ---------------------------------------------------------------------- */

  const reportToLog = useCallback((report: RealityShiftReport): { tone: LogTone; text: string }[] => {
    const lines: { tone: LogTone; text: string }[] = [];
    const apps = report.applications;

    if (apps.requested > 0) {
      lines.push({
        tone: apps.failed === 0 ? "success" : "warn",
        text: `[IPC] ${report.profileName} — ${apps.launched}/${apps.requested} apps launched in ${report.durationMs}ms.`,
      });
      for (const result of apps.results) {
        if (result.status === "failed") {
          lines.push({ tone: "error", text: `[IPC] ${basename(result.target)} skipped: ${result.error}` });
        }
      }
    }

    const procs = report.processes;
    if (procs.requested > 0) {
      lines.push({
        tone: procs.failed === 0 ? "success" : "warn",
        text: `[PROC] ${procs.terminated} quit, ${procs.notRunning} already closed, ${procs.failed} refused.`,
      });
      for (const result of procs.results) {
        if (result.status === "rejected" || result.status === "failed") {
          lines.push({ tone: "warn", text: `[PROC] ${result.target}: ${result.error}` });
        }
      }
    }

    lines.push(
      report.browser.ok
        ? {
            tone: "network",
            text: `[WS:${WS_PORT}] ${report.browser.signal} delivered to ${report.browser.receivers} service worker${
              report.browser.receivers === 1 ? "" : "s"
            }.`,
          }
        : {
            tone: "warn",
            text: `[WS:${WS_PORT}] ${report.browser.signal} undelivered — ${report.browser.error}.`,
          },
    );

    const physical = report.physical_result;
    lines.push({
      tone: physical.status === "failed" ? "error" : "iot",
      text: `[IoT] Lighting ${physical.status.replace("_", " ")} — ${physical.detail}`,
    });

    const sonic = report.sonic_result;
    lines.push({
      tone: sonic.status === "failed" ? "error" : "sonic",
      text: `[SONIC] Playback ${sonic.status.replace("_", " ")} — ${sonic.detail}`,
    });

    const focus = report.focus_result;
    lines.push({
      tone: focus.status === "applied" ? "success" : "warn",
      text: `[OS] Focus filter ${focus.status} — ${focus.detail}`,
    });

    return lines;
  }, []);

  const startWave = useCallback(() => {
    setIsWaving(true);
    setWaveId((n) => n + 1);
    window.setTimeout(() => setIsWaving(false), 650);
  }, []);

  const handleEngage = useCallback(async () => {
    const api = window.monolith;
    if (!api || busy || !active) return;

    setBusy(true);
    startWave();
    appendLog([{ tone: "network", text: `[IPC] execute-reality-shift → "${active.id}"` }]);

    try {
      const report = await api.executeRealityShift(active.id);
      appendLog(reportToLog(report));
      setEngagedId(active.id);
    } catch (error) {
      appendLog([{ tone: "error", text: `[IPC] Shift failed: ${String(error)}` }]);
    } finally {
      setBusy(false);
    }
  }, [active, appendLog, busy, reportToLog, startWave]);

  /** Restores the Neutral State: OS filters off, lights white, tabs rebuilt. */
  const handleDisengage = useCallback(async () => {
    const api = window.monolith;
    const target = engagedId ?? active?.id ?? "default";
    if (!api || busy) {
      setEngagedId(null);
      return;
    }

    setBusy(true);
    startWave();
    appendLog([{ tone: "network", text: `[IPC] execute-disengage → "${target}"` }]);

    try {
      const report = await api.executeDisengage(target);
      appendLog([
        {
          tone: report.focus_result.status === "applied" ? "success" : "warn",
          text: `[OS] Focus filter ${report.focus_result.status} — ${report.focus_result.detail}`,
        },
        {
          tone: report.physical_result.status === "failed" ? "error" : "iot",
          text: `[IoT] Neutral white ${report.physical_result.status.replace("_", " ")} — ${report.physical_result.detail}`,
        },
        report.browser.ok
          ? {
              tone: "network" as LogTone,
              text: `[WS:${WS_PORT}] HYDRATE_SESSION delivered to ${report.browser.receivers} service worker${
                report.browser.receivers === 1 ? "" : "s"
              }.`,
            }
          : {
              tone: "warn" as LogTone,
              text: `[WS:${WS_PORT}] HYDRATE_SESSION undelivered — ${report.browser.error}.`,
            },
      ]);
    } catch (error) {
      appendLog([{ tone: "error", text: `[IPC] Disengage failed: ${String(error)}` }]);
    } finally {
      setEngagedId(null);
      setBusy(false);
    }
  }, [active, appendLog, busy, engagedId, startWave]);

  /** The Nexus is a single toggle: engage on first press, disengage on the next. */
  const handleNexusTrigger = useCallback(() => {
    void (engagedId ? handleDisengage() : handleEngage());
  }, [engagedId, handleDisengage, handleEngage]);

  const handleSelect = (profile: Profile) => {
    if (profile.id === activeId) return;
    setActiveId(profile.id);
    appendLog([{ tone: "success", text: `[DECK] ${profile.name} staged — ${summarize(profile)}.` }]);
  };

  /* ---------------------------------------------------------------------- */
  /* Mood persistence                                                        */
  /* ---------------------------------------------------------------------- */

  const persist = useCallback(
    async (nextProfiles: Profile[], note: string) => {
      const api = window.monolith;
      if (!api || !config) return;
      try {
        const saved = await api.writeConfig({ ...config, profiles: nextProfiles });
        setConfig(saved);
        appendLog([{ tone: "success", text: `[DECK] ${note}` }]);
      } catch (error) {
        appendLog([{ tone: "error", text: `[DECK] Could not save moods: ${String(error)}` }]);
      }
    },
    [appendLog, config],
  );

  const handleSaveProfile = (next: Profile) => {
    const isNew = editing?.isNew ?? false;
    const nextProfiles = isNew
      ? [...profiles, next]
      : profiles.map((profile) => (profile.id === editing?.profile.id ? next : profile));

    setEditing(null);
    setActiveId(next.id);
    void persist(nextProfiles, isNew ? `${next.name} created.` : `${next.name} updated.`);
  };

  const handleDeleteProfile = () => {
    const target = editing?.profile;
    if (!target) return;

    const nextProfiles = profiles.filter((profile) => profile.id !== target.id);
    setEditing(null);
    if (activeId === target.id) setActiveId(nextProfiles[0]?.id ?? null);
    void persist(nextProfiles, `${target.name} deleted.`);
  };

  /* ---------------------------------------------------------------------- */
  /* Derived display                                                         */
  /* ---------------------------------------------------------------------- */

  const baseHex = focusMode ? active?.physical_orchestration.hex_color ?? accent : NEUTRAL_HEX;
  const lights = [
    { label: "Key Light", hex: shade(baseHex, 0.75) },
    { label: "Monitor Bias", hex: baseHex },
    { label: "Ambient Strip", hex: shade(baseHex, 0.35) },
  ];
  const binaries = (active?.digital_purge.launch_applications ?? []).map(basename);
  const bridgeIp = config?.user_settings.hue_bridge_ip || "bridge unset";
  const sonicProfile = active?.sonic_layering.target_frequency_profile || "—";

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-black text-slate-100">
      <style>{`
        @keyframes nexus-pulse {
          0%, 100% { box-shadow: 0 0 0 0 var(--nexus-glow), 0 0 40px 8px var(--nexus-glow-soft); }
          50% { box-shadow: 0 0 0 14px transparent, 0 0 70px 18px var(--nexus-glow-soft); }
        }
        @keyframes canvas-breathe { 0%, 100% { opacity: 0.5; } 50% { opacity: 0.85; } }
        @keyframes clip-wave {
          0% { clip-path: circle(0% at 50% 50%); opacity: 0.95; }
          55% { clip-path: circle(70% at 50% 50%); opacity: 0.65; }
          100% { clip-path: circle(150% at 50% 50%); opacity: 0; }
        }
        @keyframes cursor-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
        .nexus-pulse { animation: nexus-pulse 2.6s ease-in-out infinite; }
        .canvas-breathe { animation: canvas-breathe 6s ease-in-out infinite; }
        .clip-wave { animation: clip-wave 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards; will-change: clip-path, opacity; }
        .terminal-cursor { animation: cursor-blink 1s step-end infinite; }
        .command-deck-scroll::-webkit-scrollbar { width: 6px; }
        .command-deck-scroll::-webkit-scrollbar-thumb { background: #1e1e1e; border-radius: 3px; }
      `}</style>

      <div
        className="canvas-breathe pointer-events-none fixed inset-0 z-0 transition-colors duration-700"
        style={{ background: `radial-gradient(circle at 50% 35%, ${accentDim}, transparent 65%)` }}
      />

      {isWaving && (
        <div
          key={waveId}
          className="clip-wave pointer-events-none fixed inset-0 z-50"
          style={{
            background: `radial-gradient(circle at 50% 50%, ${accent} 0%, ${accentSoft} 45%, transparent 75%)`,
          }}
        />
      )}

      {showCredentials && config && (
        <CredentialsModal
          config={config}
          onSaved={(next) => {
            setConfig(next);
            setShowCredentials(false);
            appendLog([{ tone: "success", text: "[SHELL] Credentials saved." }]);
          }}
          onDismiss={() => {
            setShowCredentials(false);
            setCredentialsDismissed(true);
            appendLog([
              {
                tone: "warn",
                text: "[SHELL] Running without credentials — apps and tabs only, no lights or music.",
              },
            ]);
          }}
        />
      )}

      {editing && (
        <ProfileEditor
          profile={editing.profile}
          isNew={editing.isNew}
          onSave={handleSaveProfile}
          onDelete={editing.isNew ? undefined : handleDeleteProfile}
          onCancel={() => setEditing(null)}
        />
      )}

      <TitleBar
        onExitFocus={focusMode ? () => void handleDisengage() : undefined}
        shellReady={shellReady}
        extensionOnline={extensionOnline}
        needsCredentials={credentialsDismissed && isUnconfigured(config?.user_settings)}
        onOpenCredentials={() => setShowCredentials(true)}
      />

      <div className="relative z-10 flex flex-1 flex-col overflow-hidden">
        {focusMode ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
            <NexusButton
              accent={accent}
              accentSoft={accentSoft}
              label={busy ? "Working" : "Disengage"}
              disabled={!shellReady || busy}
              busy={busy}
              onClick={handleNexusTrigger}
              large
            />
            <p className="text-sm uppercase tracking-[0.4em]" style={{ color: accent }}>
              {active?.name ?? "Engaged"}
            </p>
          </div>
        ) : (
          <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden p-4 sm:p-6 lg:grid-cols-[1fr_320px] lg:gap-6">
            <div className="flex flex-col gap-6 overflow-y-auto pr-1 lg:pr-2">
              <div className="flex flex-col items-center gap-4 pt-8">
                <NexusButton
                  accent={accent}
                  accentSoft={accentSoft}
                  label={busy ? "Working" : "Engage"}
                  disabled={!shellReady || busy || !active}
                  busy={busy}
                  onClick={handleNexusTrigger}
                />
                <p className="text-xs uppercase tracking-widest text-slate-500">
                  {busy
                    ? "Executing…"
                    : active
                      ? `Neutral state — ${active.name} staged`
                      : "No moods yet — create one below"}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {profiles.map((profile) => (
                  <ProfileCard
                    key={profile.id}
                    profile={profile}
                    isActive={profile.id === active?.id}
                    onSelect={() => handleSelect(profile)}
                    onEdit={() => setEditing({ profile, isNew: false })}
                  />
                ))}
                <button
                  onClick={() => setEditing({ profile: emptyProfile(), isNew: true })}
                  className="flex min-h-[84px] flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-[#242430] p-3 text-slate-600 transition hover:border-slate-500 hover:text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                >
                  <span className="text-xl leading-none">+</span>
                  <span className="text-[11px] uppercase tracking-widest">New mood</span>
                </button>
              </div>

              <RoomSimulator
                accentSoft={accentSoft}
                lights={lights}
                binaries={binaries}
                bridgeIp={bridgeIp}
                sonicProfile={sonicProfile}
                brightness={active?.physical_orchestration.brightness ?? 0}
                engaged={focusMode}
              />
            </div>

            <StatsTerminal />
          </div>
        )}

        {!focusMode && (
          <div className="z-10 border-t border-slate-800 bg-[#0a0a0a] px-4 py-3 sm:px-6">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-500">
                Monolith Deployment Log
              </span>
              <span
                className={`flex items-center gap-1.5 text-[11px] ${
                  extensionOnline ? "text-emerald-500" : "text-slate-500"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    extensionOnline ? "bg-emerald-500" : "bg-slate-600"
                  }`}
                />
                {extensionOnline ? "EXTENSION LIVE" : "HOST ONLY"}
              </span>
            </div>
            <div className="command-deck-scroll h-28 overflow-y-auto rounded-lg border border-slate-800 bg-black/60 p-3 font-mono text-[11px] leading-relaxed sm:h-32 sm:text-xs">
              {logLines.map((line) => (
                <div key={line.id} className="flex gap-2">
                  <span className="shrink-0 text-slate-600">{line.time}</span>
                  <span className={LOG_TONE_CLASS[line.tone]}>{line.text}</span>
                </div>
              ))}
              <div className="flex gap-2 text-slate-500">
                <span>&gt;</span>
                <span className="terminal-cursor">_</span>
              </div>
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The shell runs frameless, so this strip is the only way to move the window
 * and the only close button that exists.
 */
function TitleBar({
  onExitFocus,
  shellReady,
  extensionOnline,
  needsCredentials,
  onOpenCredentials,
}: {
  onExitFocus?: () => void;
  shellReady: boolean | null;
  extensionOnline: boolean;
  needsCredentials: boolean;
  onOpenCredentials: () => void;
}): React.JSX.Element {
  const api = window.monolith;

  return (
    <header className="app-drag relative z-40 flex h-11 shrink-0 items-center justify-between px-4 sm:px-6">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.35em] text-slate-600">
          MONOLITH
        </span>
        {shellReady === false && (
          <span className="rounded-full border border-red-500/40 px-2 py-0.5 text-[10px] uppercase tracking-widest text-red-400">
            Shell offline
          </span>
        )}
        {shellReady === true && !extensionOnline && (
          <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-widest text-slate-500">
            No extension
          </span>
        )}
      </div>

      <div className="app-no-drag flex items-center gap-2">
        {needsCredentials && (
          <button
            onClick={onOpenCredentials}
            className="rounded-full border border-indigo-500/40 px-3 py-1 text-[10px] uppercase tracking-widest text-indigo-300 transition hover:border-indigo-400 hover:text-indigo-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300"
          >
            Connect lights &amp; music
          </button>
        )}
        {onExitFocus && (
          <button
            onClick={onExitFocus}
            className="rounded-full border border-slate-700 bg-slate-950/80 px-4 py-1.5 text-xs uppercase tracking-widest text-slate-400 backdrop-blur transition hover:border-slate-500 hover:text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
          >
            Exit focus &amp; restore tabs
          </button>
        )}
        {api && (
          <div className="flex items-center gap-1">
            <WindowButton label="Minimize" onClick={() => void api.window.minimize()}>
              &#8722;
            </WindowButton>
            <WindowButton label="Toggle maximize" onClick={() => void api.window.toggleMaximize()}>
              &#9633;
            </WindowButton>
            <WindowButton label="Close" onClick={() => void api.window.close()} danger>
              &#10005;
            </WindowButton>
          </div>
        )}
      </div>
    </header>
  );
}

function WindowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded text-[11px] text-slate-600 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 ${
        danger ? "hover:bg-red-500/20 hover:text-red-300" : "hover:bg-slate-800 hover:text-slate-300"
      }`}
    >
      {children}
    </button>
  );
}

function NexusButton({
  accent,
  accentSoft,
  label,
  disabled,
  busy,
  onClick,
  large,
}: {
  accent: string;
  accentSoft: string;
  label: string;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
  large?: boolean;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy}
      className={`nexus-pulse group relative flex items-center justify-center rounded-full border-2 bg-gradient-to-b from-[#1e1e1e] to-black transition-transform duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${
        large ? "h-56 w-56 sm:h-72 sm:w-72" : "h-40 w-40 sm:h-52 sm:w-52"
      }`}
      style={
        {
          borderColor: accent,
          outlineColor: accent,
          "--nexus-glow": accent,
          "--nexus-glow-soft": accentSoft,
        } as React.CSSProperties
      }
    >
      <span
        className={`text-center font-bold uppercase tracking-[0.35em] transition-colors duration-500 ${
          large ? "text-lg sm:text-xl" : "text-sm sm:text-base"
        }`}
        style={{ color: accent }}
      >
        {label}
      </span>
    </button>
  );
}

function ProfileCard({
  profile,
  isActive,
  onSelect,
  onEdit,
}: {
  profile: Profile;
  isActive: boolean;
  onSelect: () => void;
  onEdit: () => void;
}): React.JSX.Element {
  const hex = profile.physical_orchestration.hex_color;

  return (
    <div
      className={`group relative flex min-h-[84px] flex-col justify-between gap-1 rounded-xl border bg-[#121212] p-3 transition-all duration-300 sm:p-4 ${
        isActive ? "" : "border-[#1e1e1e] hover:border-slate-600"
      }`}
      style={isActive ? { borderColor: hex, boxShadow: `0 0 25px ${rgba(hex, 0.35)}` } : undefined}
    >
      <button
        onClick={onSelect}
        aria-pressed={isActive}
        className="flex flex-col items-start gap-1 pr-8 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
      >
        <span className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: hex, boxShadow: `0 0 8px ${rgba(hex, 0.7)}` }}
          />
          <span
            className="text-sm font-semibold sm:text-base"
            style={{ color: isActive ? hex : undefined }}
          >
            {profile.name}
          </span>
        </span>
        <span className="text-[11px] leading-snug text-slate-500">{summarize(profile)}</span>
      </button>

      <button
        onClick={onEdit}
        aria-label={`Edit ${profile.name}`}
        title={`Edit ${profile.name}`}
        className="absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-slate-700 opacity-0 transition hover:text-slate-300 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 group-hover:opacity-100"
      >
        Edit
      </button>
    </div>
  );
}

function RoomSimulator({
  accentSoft,
  lights,
  binaries,
  bridgeIp,
  sonicProfile,
  brightness,
  engaged,
}: {
  accentSoft: string;
  lights: { label: string; hex: string }[];
  binaries: string[];
  bridgeIp: string;
  sonicProfile: string;
  brightness: number;
  engaged: boolean;
}): React.JSX.Element {
  return (
    <section className="rounded-2xl border border-[#1e1e1e] bg-[#121212]/60 p-4 sm:p-6">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-xs uppercase tracking-[0.3em] text-slate-500">
          Virtual Space Environment Simulator
        </h2>
        <span className="text-[10px] uppercase tracking-widest text-slate-600">
          {engaged ? "Engaged" : "Neutral"}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <svg
          viewBox="0 0 320 200"
          className="w-full rounded-lg"
          role="img"
          aria-label="Room lighting preview"
        >
          <defs>
            <radialGradient id="ambientGlow" cx="50%" cy="20%" r="80%">
              <stop offset="0%" stopColor={accentSoft} />
              <stop offset="100%" stopColor="transparent" />
            </radialGradient>
          </defs>
          <rect width="320" height="200" fill="#050505" />
          <rect width="320" height="200" fill="url(#ambientGlow)" style={{ transition: "fill 500ms ease" }} />
          <rect x="40" y="140" width="240" height="10" rx="2" fill="#1e293b" />
          <rect x="50" y="150" width="8" height="30" fill="#111827" />
          <rect x="262" y="150" width="8" height="30" fill="#111827" />
          <rect x="120" y="80" width="80" height="50" rx="3" fill="#0f172a" />
          <rect
            x="126"
            y="86"
            width="68"
            height="38"
            rx="2"
            fill={lights[1].hex}
            style={{ transition: "fill 500ms ease", opacity: 0.85 }}
          />
          <rect x="152" y="130" width="16" height="10" fill="#1e293b" />
          <rect
            x="20"
            y="20"
            width="280"
            height="6"
            rx="3"
            fill={lights[2].hex}
            style={{ transition: "fill 500ms ease" }}
          />
          {Array.from({ length: 7 }).map((_, i) => (
            <rect
              key={i}
              x={20 + i * 40}
              y="30"
              width="20"
              height="4"
              rx="2"
              fill={lights[2].hex}
              style={{ transition: "fill 500ms ease", opacity: 0.5 }}
            />
          ))}
          <circle cx="255" cy="70" r="10" fill={lights[0].hex} style={{ transition: "fill 500ms ease" }} />
          <line x1="255" y1="80" x2="255" y2="140" stroke="#1e293b" strokeWidth="3" />
        </svg>

        <div className="flex flex-col justify-center gap-3">
          {lights.map((zone) => (
            <div key={zone.label} className="flex items-center justify-between gap-3">
              <span className="text-xs text-slate-400 sm:text-sm">{zone.label}</span>
              <div className="flex items-center gap-2">
                <span
                  className="h-4 w-4 rounded-full border border-[#1e1e1e] transition-colors duration-500"
                  style={{ backgroundColor: zone.hex, boxShadow: `0 0 10px ${zone.hex}` }}
                />
                <code className="text-[11px] text-slate-500">{zone.hex}</code>
              </div>
            </div>
          ))}
          <div className="mt-2 rounded-lg border border-[#1e1e1e] bg-black/40 px-3 py-2 text-[11px] text-slate-500">
            Hue bridge {bridgeIp} · {brightness}% · {sonicProfile}
          </div>
          <div className="flex flex-wrap gap-2">
            {binaries.length > 0 ? (
              binaries.map((bin) => (
                <span
                  key={bin}
                  className="rounded-full border border-[#1e1e1e] px-2 py-0.5 text-[11px] text-slate-300"
                >
                  {bin}
                </span>
              ))
            ) : (
              <span className="text-[11px] text-slate-600">No apps set for this mood.</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function StatsTerminal(): React.JSX.Element {
  return (
    <aside className="flex flex-col overflow-hidden rounded-2xl border border-[#1e1e1e] bg-[#0a0a0a]">
      <div className="flex items-center gap-2 border-b border-[#1e1e1e] px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
        <span className="ml-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-500">
          Context Crisis Telemetry
        </span>
      </div>
      <div className="command-deck-scroll flex-1 overflow-y-auto px-4 py-4 font-mono text-[11px] leading-relaxed">
        {CRISIS_STATS.map((stat) => (
          <div key={stat.id} className="mb-4 border-l-2 border-red-500/40 pl-3">
            <p className="font-semibold uppercase tracking-wide text-red-400">{stat.headline}:</p>
            <p className="mt-1 text-slate-300">{stat.body}</p>
            <p className="mt-1 text-slate-600">(Source: {stat.source})</p>
          </div>
        ))}
      </div>
    </aside>
  );
}
