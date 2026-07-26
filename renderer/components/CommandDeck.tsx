import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AuthStatus,
  BridgeEvent,
  MonolithConfig,
  Profile,
  RealityShiftReport,
  Schedule,
  SessionStats,
} from "../monolith";
import AccountModal from "./AccountModal";
import CredentialsModal, { isUnconfigured } from "./CredentialsModal";
import ProfileEditor, { emptyProfile } from "./ProfileEditor";
import { mix, rgba, shade } from "../lib/color";

/** Neutral State — the room glows white until a mood is engaged. */
const NEUTRAL_HEX = "#FFFFFF";
/** Neutral gray a live accent is blended toward for the pre-engage idle look. */
const MUTE_TOWARD = "#3f3f46";
const MUTE_FACTOR = 0.55;

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
  const killCount = purge.kill_background_processes.length;
  const categoryCount = purge.kill_categories.length;
  if (killCount > 0) {
    bits.push(`blocks ${killCount}`);
  } else if (categoryCount > 0) {
    // Categories resolve to a different app count per machine, so we count
    // the categories themselves rather than showing a vague "blocks apps".
    bits.push(`blocks ${categoryCount} ${categoryCount === 1 ? "category" : "categories"}`);
  }
  if (purge.close_browser_tabs) bits.push("clears tabs");
  if (purge.block_distractions) bits.push("blocks sites");
  if (profile.sonic_layering.spotify_enabled) bits.push("music");
  return bits.length > 0 ? bits.join(" · ") : "Nothing configured yet";
}

const DAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "9am–5pm" instead of "09:00–17:00" — read as a schedule, not a config value. */
function formatHour(hhmm: string): string {
  const [hourStr, minute] = hhmm.split(":");
  const hour = Number(hourStr);
  const period = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return minute === "00" ? `${twelve}${period}` : `${twelve}:${minute}${period}`;
}

/** One line for a scheduled mood's card — absent entirely when scheduling is off. */
function scheduleSummary(schedule: Profile["schedule"]): string | null {
  if (!schedule.enabled) return null;
  const range = `${formatHour(schedule.engage_time)}–${formatHour(schedule.disengage_time)}`;
  const days = schedule.days.length > 0 ? ` · ${schedule.days.map((d) => DAY_ABBR[d]).join("")}` : "";
  return `${range}${days}`;
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
  const [showActivity, setShowActivity] = useState(false);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [showAccount, setShowAccount] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [showCredentials, setShowCredentials] = useState(false);
  const [credentialsDismissed, setCredentialsDismissed] = useState(false);
  const [editing, setEditing] = useState<{ profile: Profile; isNew: boolean } | null>(null);
  const [waveDirection, setWaveDirection] = useState<"expand" | "collapse">("expand");
  const [waveOrigin, setWaveOrigin] = useState({ x: 0, y: 0 });
  const logCounter = useRef(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const waveTimeoutRef = useRef<number | undefined>(undefined);
  const dashboardNexusRef = useRef<HTMLButtonElement | null>(null);
  const dashboardNexusOrigin = useRef({ x: 0, y: 0 });

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
  // Idle state reads subdued — the mood only blazes at full saturation once engaged.
  const accentMuted = mix(accent, MUTE_TOWARD, MUTE_FACTOR);
  const accentMutedSoft = rgba(accentMuted, 0.18);
  const accentMutedDim = rgba(accentMuted, 0.06);

  useLayoutEffect(() => {
    if (focusMode || !dashboardNexusRef.current) return;
    const rect = dashboardNexusRef.current.getBoundingClientRect();
    dashboardNexusOrigin.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, [focusMode]);

  useEffect(() => () => window.clearTimeout(waveTimeoutRef.current), []);

  const appendLog = useCallback((entries: { tone: LogTone; text: string }[]) => {
    setLogLines((prev) => {
      const next = entries.map((entry) => {
        logCounter.current += 1;
        return { ...entry, id: `log-${logCounter.current}`, time: timestamp() };
      });
      return [...prev, ...next].slice(-60);
    });
  }, []);

  /** The user's own numbers, next to the research citations. */
  const refreshStats = useCallback(async () => {
    const loaded = await window.monolith?.readStats();
    if (loaded) setStats(loaded);
  }, []);

  const refreshAuthStatus = useCallback(async () => {
    const status = await window.monolith?.getAuthStatus();
    if (status) setAuthStatus(status);
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
          text: "Couldn't reach the Monolith app. Open this window from the Monolith app, not a browser tab.",
        },
      ]);
      return;
    }

    setShellReady(true);
    let cancelled = false;

    void (async () => {
      try {
        const loaded = await api.readConfig();
        if (cancelled) return;
        setConfig(loaded);
        setActiveId((current) => current ?? loaded.profiles[0]?.id ?? null);
        if (isUnconfigured(loaded.user_settings)) setShowCredentials(true);
        appendLog([
          {
            tone: "success",
            text: `Ready — ${loaded.profiles.length} mood${loaded.profiles.length === 1 ? "" : "s"} loaded.`,
          },
          { tone: "network", text: "Waiting for the browser to connect." },
        ]);
        void refreshStats();
        void refreshAuthStatus();
      } catch (error) {
        if (cancelled) return;
        appendLog([{ tone: "error", text: `Couldn't load your moods: ${String(error)}` }]);
      }
    })();

    const unsubscribe = api.onBridgeEvent((event: BridgeEvent) => {
      const payload = event.payload ?? {};
      switch (event.type) {
        case "EXTENSION_READY":
          setExtensionOnline(true);
          appendLog([{ tone: "success", text: "Browser connected." }]);
          break;
        case "PURGE_COMPLETE": {
          setExtensionOnline(true);
          const blockade = payload.blockade as { armed?: boolean; domains?: string[] } | undefined;
          const purged = Number(payload.purged ?? 0);
          appendLog([
            { tone: "network", text: `Cleared ${purged} tab${purged === 1 ? "" : "s"}.` },
            ...(blockade?.armed
              ? [
                  {
                    tone: "warn" as LogTone,
                    text: `Blocking ${blockade.domains?.length ?? 0} distracting site${
                      blockade.domains?.length === 1 ? "" : "s"
                    } for now.`,
                  },
                ]
              : []),
          ]);
          break;
        }
        case "HYDRATE_COMPLETE": {
          setExtensionOnline(true);
          const restored = Number(payload.restored ?? 0);
          appendLog([
            { tone: "network", text: `Restored ${restored} tab${restored === 1 ? "" : "s"}.` },
          ]);
          break;
        }
        case "BLOCKADE_RELEASED":
          appendLog([{ tone: "success", text: "Site blocking turned off." }]);
          break;
        case "BLOCKADE_KILL": {
          const target = typeof payload.target === "string" ? payload.target : "an app";
          appendLog([{ tone: "warn", text: `${target} was reopened — closed it again.` }]);
          break;
        }
        case "SIGNAL_FAILED":
          appendLog([
            { tone: "error", text: `Couldn't reach the browser: ${payload.error ?? "unknown error"}` },
          ]);
          break;
        case "EXTERNAL_ENGAGE": {
          const profileId = typeof payload.profileId === "string" ? payload.profileId : null;
          const profileName = typeof payload.profileName === "string" ? payload.profileName : "A mood";
          const trigger = typeof payload.trigger === "string" ? payload.trigger : "from the menu bar";
          if (profileId) {
            setActiveId(profileId);
            setEngagedId(profileId);
            startWave("expand");
          }
          appendLog([{ tone: "success", text: `${profileName} engaged ${trigger}.` }]);
          break;
        }
        case "EXTERNAL_DISENGAGE": {
          const trigger = typeof payload.trigger === "string" ? payload.trigger : "from the menu bar";
          setEngagedId(null);
          startWave("collapse");
          appendLog([{ tone: "success", text: `Disengaged ${trigger}.` }]);
          break;
        }
        case "STATS_UPDATED":
          void refreshStats();
          break;
        case "CONFIG_UPDATED":
          // A schedule pulled from the cloud at sign-in changed profiles out
          // from under the renderer — re-read rather than trying to patch it.
          void api.readConfig().then((loaded) => setConfig(loaded));
          break;
        default:
          break;
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [appendLog, refreshStats, refreshAuthStatus]);

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
        text: `Opened ${apps.launched} of ${apps.requested} apps for ${report.profileName}.`,
      });
      for (const result of apps.results) {
        if (result.status === "failed") {
          lines.push({ tone: "error", text: `Couldn't open ${basename(result.target)}: ${result.error}` });
        }
      }
    }

    const procs = report.processes;
    if (procs.terminated > 0) {
      lines.push({
        tone: procs.failed === 0 ? "success" : "warn",
        text: `Closed ${procs.terminated} app${procs.terminated === 1 ? "" : "s"}.`,
      });
    }
    for (const result of procs.results) {
      if (result.status === "rejected" || result.status === "failed") {
        lines.push({ tone: "warn", text: `Couldn't close ${result.target}: ${result.error}` });
      }
    }

    lines.push(
      report.browser.ok
        ? { tone: "network", text: report.browser.signal === "AGGRESSIVE_PURGE" ? "Cleared your tabs." : "Restored your tabs." }
        : { tone: "warn", text: `Browser not connected — tabs weren't touched.` },
    );

    const physical = report.physical_result;
    if (physical.status !== "disabled") {
      lines.push({
        tone: physical.status === "failed" ? "error" : "iot",
        text:
          physical.status === "applied"
            ? "Lights set."
            : physical.status === "not_configured"
              ? "Lights aren't connected yet."
              : `Couldn't reach your lights: ${physical.detail}`,
      });
    }

    const sonic = report.sonic_result;
    if (sonic.status !== "disabled") {
      lines.push({
        tone: sonic.status === "failed" ? "error" : "sonic",
        text:
          sonic.status === "applied"
            ? sonic.detail
            : sonic.status === "not_configured"
              ? "Music isn't connected yet."
              : `Couldn't start music: ${sonic.detail}`,
      });
    }

    const focus = report.focus_result;
    lines.push({
      tone: focus.status === "applied" ? "success" : "warn",
      text: focus.status === "applied" ? "Do Not Disturb turned on." : focus.detail,
    });

    return lines;
  }, []);

  /** Expands the wave out of the dashboard Nexus button on engage; on
   * disengage it collapses back into that same (now unmounted) position,
   * using the spot last measured before focus mode took over. */
  const startWave = useCallback((direction: "expand" | "collapse") => {
    if (direction === "expand") {
      const rect = dashboardNexusRef.current?.getBoundingClientRect();
      if (rect) {
        dashboardNexusOrigin.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    setWaveOrigin(dashboardNexusOrigin.current);
    setWaveDirection(direction);
    setIsWaving(true);
    setWaveId((n) => n + 1);
    window.clearTimeout(waveTimeoutRef.current);
    waveTimeoutRef.current = window.setTimeout(() => setIsWaving(false), 1100);
  }, []);

  const handleEngage = useCallback(async () => {
    const api = window.monolith;
    if (!api || busy || !active) return;

    setBusy(true);
    startWave("expand");
    appendLog([{ tone: "network", text: `Starting ${active.name}…` }]);

    try {
      const report = await api.executeRealityShift(active.id);
      appendLog(reportToLog(report));
      setEngagedId(active.id);
    } catch (error) {
      appendLog([{ tone: "error", text: `Couldn't start ${active.name}: ${String(error)}` }]);
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
    startWave("collapse");
    appendLog([{ tone: "network", text: "Returning to neutral…" }]);

    try {
      const report = await api.executeDisengage(target);
      appendLog([
        {
          tone: report.focus_result.status === "applied" ? "success" : "warn",
          text: report.focus_result.status === "applied" ? "Do Not Disturb turned off." : report.focus_result.detail,
        },
        {
          tone: report.physical_result.status === "failed" ? "error" : "iot",
          text:
            report.physical_result.status === "failed"
              ? `Couldn't reset your lights: ${report.physical_result.detail}`
              : "Lights back to neutral white.",
        },
        report.browser.ok
          ? { tone: "network" as LogTone, text: "Restored your tabs." }
          : { tone: "warn" as LogTone, text: "Browser not connected — tabs weren't touched." },
      ]);
    } catch (error) {
      appendLog([{ tone: "error", text: `Couldn't return to neutral: ${String(error)}` }]);
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
    appendLog([{ tone: "success", text: `${profile.name} staged — ${summarize(profile)}.` }]);
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
        appendLog([{ tone: "success", text: note }]);
      } catch (error) {
        appendLog([{ tone: "error", text: `Couldn't save your moods: ${String(error)}` }]);
      }
    },
    [appendLog, config],
  );

  /**
   * Edits the staged mood's schedule in place from the dashboard, not from
   * inside the mood editor — a schedule is something you glance at and nudge
   * often, not a one-time setup field. Quiet on its own (no log line) unless
   * a note is passed, since a time-input tweak shouldn't spam the activity
   * log the way creating or deleting a mood does.
   */
  const updateActiveSchedule = useCallback(
    async (patch: Partial<Profile["schedule"]>, note?: string) => {
      const api = window.monolith;
      if (!api || !config || !active) return;
      const nextProfiles = profiles.map((profile) =>
        profile.id === active.id ? { ...profile, schedule: { ...profile.schedule, ...patch } } : profile,
      );
      try {
        const saved = await api.writeConfig({ ...config, profiles: nextProfiles });
        setConfig(saved);
        if (note) appendLog([{ tone: "success", text: note }]);
        // A silent no-op in main when signed out — this call never needs to
        // know whether there's an account, only that the schedule changed.
        const updated = saved.profiles.find((p) => p.id === active.id);
        if (updated) void api.syncSchedule(active.id, updated.schedule);
      } catch (error) {
        appendLog([{ tone: "error", text: `Couldn't save the schedule: ${String(error)}` }]);
      }
    },
    [active, appendLog, config, profiles],
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

  /** Shared by the mood editor's Delete and the card's own inline delete. */
  const deleteProfile = (target: Profile) => {
    const nextProfiles = profiles.filter((profile) => profile.id !== target.id);
    if (activeId === target.id) setActiveId(nextProfiles[0]?.id ?? null);
    if (engagedId === target.id) setEngagedId(null);
    void persist(nextProfiles, `${target.name} deleted.`);
  };

  const handleDeleteProfile = () => {
    const target = editing?.profile;
    if (!target) return;
    setEditing(null);
    deleteProfile(target);
  };

  /* ---------------------------------------------------------------------- */
  /* Drag-to-reorder                                                         */
  /* ---------------------------------------------------------------------- */

  const handleDragStart = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
    setDragIndex(index);
    event.dataTransfer.effectAllowed = "move";
    // Firefox won't start a drag without data being set on it.
    event.dataTransfer.setData("text/plain", String(index));
  };

  const handleDragOver = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
    if (dragIndex === null) return;
    event.preventDefault();
    if (dragOverIndex !== index) setDragOverIndex(index);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDrop = (index: number) => (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (dragIndex !== null && dragIndex !== index) {
      const reordered = [...profiles];
      const [moved] = reordered.splice(dragIndex, 1);
      if (moved) {
        reordered.splice(index, 0, moved);
        void persist(reordered, `${moved.name} moved to position ${index + 1}.`);
      }
    }
    setDragIndex(null);
    setDragOverIndex(null);
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
  const bridgeIp = config?.user_settings.hue_bridge_ip?.trim() || "";
  const sonicProfile = active?.sonic_layering.target_frequency_profile || "—";

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-[#050608] text-slate-100">
      <style>{`
        @keyframes nexus-pulse {
          0%, 100% { box-shadow: 0 0 0 0 var(--nexus-glow), 0 0 40px 8px var(--nexus-glow-soft); }
          50% { box-shadow: 0 0 0 14px transparent, 0 0 70px 18px var(--nexus-glow-soft); }
        }
        @keyframes canvas-breathe { 0%, 100% { opacity: 0.5; } 50% { opacity: 0.85; } }
        @keyframes clip-wave-expand {
          0% { clip-path: circle(0% at var(--wave-x) var(--wave-y)); opacity: 0.95; }
          55% { clip-path: circle(70% at var(--wave-x) var(--wave-y)); opacity: 0.65; }
          100% { clip-path: circle(150% at var(--wave-x) var(--wave-y)); opacity: 0; }
        }
        @keyframes clip-wave-collapse {
          0% { clip-path: circle(150% at var(--wave-x) var(--wave-y)); opacity: 0; }
          45% { clip-path: circle(60% at var(--wave-x) var(--wave-y)); opacity: 0.6; }
          100% { clip-path: circle(0% at var(--wave-x) var(--wave-y)); opacity: 0.95; }
        }
        @keyframes cursor-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
        .nexus-pulse { animation: nexus-pulse 2.6s ease-in-out infinite; }
        .canvas-breathe { animation: canvas-breathe 6s ease-in-out infinite; }
        .clip-wave-expand { animation: clip-wave-expand 1s cubic-bezier(0.16, 1, 0.3, 1) forwards; will-change: clip-path, opacity; }
        .clip-wave-collapse { animation: clip-wave-collapse 1s cubic-bezier(0.65, 0, 0.35, 1) forwards; will-change: clip-path, opacity; }
        .terminal-cursor { animation: cursor-blink 1s step-end infinite; }
        .command-deck-scroll::-webkit-scrollbar { width: 6px; }
        .command-deck-scroll::-webkit-scrollbar-thumb { background: #1e1e1e; border-radius: 3px; }
      `}</style>

      <div
        className="canvas-breathe pointer-events-none fixed inset-0 z-0 transition-colors duration-700"
        style={{
          background: `radial-gradient(circle at 50% 35%, ${
            focusMode ? accentDim : accentMutedDim
          }, transparent 65%)`,
        }}
      />

      {isWaving && (
        <div
          key={waveId}
          className={`pointer-events-none fixed inset-0 z-50 ${
            waveDirection === "expand" ? "clip-wave-expand" : "clip-wave-collapse"
          }`}
          style={
            {
              "--wave-x": `${waveOrigin.x}px`,
              "--wave-y": `${waveOrigin.y}px`,
              background: `radial-gradient(circle at ${waveOrigin.x}px ${waveOrigin.y}px, ${accent} 0%, ${accentSoft} 45%, transparent 75%)`,
            } as React.CSSProperties
          }
        />
      )}

      {showCredentials && config && (
        <CredentialsModal
          config={config}
          onSaved={(next) => {
            setConfig(next);
            setShowCredentials(false);
            appendLog([{ tone: "success", text: "Room connected." }]);
          }}
          onDismiss={() => {
            setShowCredentials(false);
            setCredentialsDismissed(true);
            appendLog([
              { tone: "warn", text: "Apps and tabs are ready — lights and music aren't connected yet." },
            ]);
          }}
        />
      )}

      {showAccount && (
        <AccountModal
          onSignedIn={(email) => {
            setShowAccount(false);
            setAuthStatus({ signedIn: true, email });
            appendLog([{ tone: "success", text: `Signed in as ${email}.` }]);
            void refreshStats();
          }}
          onDismiss={() => setShowAccount(false)}
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
        needsCredentials={credentialsDismissed && isUnconfigured(config?.user_settings)}
        onOpenCredentials={() => setShowCredentials(true)}
        authStatus={authStatus}
        onOpenAccount={() => setShowAccount(true)}
        onSignOut={() => {
          void window.monolith?.signOut().then(() => {
            setAuthStatus({ signedIn: false, email: null });
            appendLog([{ tone: "success", text: "Signed out." }]);
            void refreshStats();
          });
        }}
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
            <p className="font-display text-base tracking-wide" style={{ color: accent }}>
              {active?.name ?? "Engaged"}
            </p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-4 sm:p-6">
            <div className="flex flex-col items-center gap-4 pt-8">
              <NexusButton
                ref={dashboardNexusRef}
                accent={accentMuted}
                accentSoft={accentMutedSoft}
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

            <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {profiles.map((profile, index) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  isActive={profile.id === active?.id}
                  isDragging={dragIndex === index}
                  isDropTarget={dragOverIndex === index && dragIndex !== null && dragIndex !== index}
                  onSelect={() => handleSelect(profile)}
                  onEdit={() => setEditing({ profile, isNew: false })}
                  onDelete={() => deleteProfile(profile)}
                  onDragStart={handleDragStart(index)}
                  onDragOver={handleDragOver(index)}
                  onDragEnd={handleDragEnd}
                  onDrop={handleDrop(index)}
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

            {active && (
              <div className="mx-auto w-full max-w-6xl">
                <ScheduleCard
                  profileName={active.name}
                  schedule={active.schedule}
                  onChange={updateActiveSchedule}
                />
              </div>
            )}

            <div className="mx-auto grid w-full max-w-6xl items-stretch gap-4 pb-2 lg:grid-cols-2">
              <RoomSimulator
                accentSoft={accentMutedSoft}
                lights={lights}
                binaries={binaries}
                bridgeIp={bridgeIp}
                sonicProfile={sonicProfile}
                brightness={active?.physical_orchestration.brightness ?? 0}
                engaged={focusMode}
              />
              <StatsTerminal stats={stats} />
            </div>
          </div>
        )}

        {!focusMode && (
          <div className="z-10 border-t border-slate-800 bg-[#0a0a0f] px-4 py-2.5 sm:px-6">
            <div className="flex items-center justify-between">
              <button
                onClick={() => setShowActivity((visible) => !visible)}
                className="text-xs text-slate-500 transition hover:text-slate-300"
                aria-expanded={showActivity}
              >
                {showActivity ? "Hide activity" : "Show activity"}
              </button>
              <span
                className={`flex items-center gap-1.5 text-xs ${
                  extensionOnline ? "text-emerald-500" : "text-slate-500"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    extensionOnline ? "bg-emerald-500" : "bg-slate-600"
                  }`}
                />
                {extensionOnline ? "Browser connected" : "Browser not connected"}
              </span>
            </div>
            {/* Always rendered — a 0fr/1fr grid-template-rows transition is
                what lets this slide open/closed, since height can't be
                animated to "auto" any other way in CSS. The inner
                overflow-hidden is what actually clips the content at 0fr. */}
            <div
              className={`grid transition-[grid-template-rows,opacity,margin-top] duration-300 ease-out ${
                showActivity ? "mt-2 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="overflow-hidden">
                <div className="command-deck-scroll h-28 overflow-y-auto rounded-lg border border-slate-800 bg-black/60 p-3 text-xs leading-relaxed sm:h-32">
                  {logLines.map((line) => (
                    <div key={line.id} className="flex gap-2">
                      <span className="shrink-0 font-mono text-[11px] text-slate-600">{line.time}</span>
                      <span className={LOG_TONE_CLASS[line.tone]}>{line.text}</span>
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </div>
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
  needsCredentials,
  onOpenCredentials,
  authStatus,
  onOpenAccount,
  onSignOut,
}: {
  onExitFocus?: () => void;
  shellReady: boolean | null;
  needsCredentials: boolean;
  onOpenCredentials: () => void;
  authStatus: AuthStatus | null;
  onOpenAccount: () => void;
  onSignOut: () => void;
}): React.JSX.Element {
  const api = window.monolith;

  return (
    <header className="app-drag relative z-40 flex h-11 shrink-0 items-center justify-between pr-4 sm:pr-6">
      {/* pl-20 clears the native traffic-light buttons (trafficLightPosition
          x:16 in main.ts) — the wordmark used to sit directly under them. */}
      <div className="flex items-center gap-3 pl-20">
        <span className="mt-0.5 font-display text-sm font-semibold tracking-wide text-slate-300">
          Monolith
        </span>
        {shellReady === false && (
          <span className="rounded-full border border-red-500/40 px-2 py-0.5 text-[10px] uppercase tracking-widest text-red-400">
            Can't connect
          </span>
        )}
      </div>

      <div className="app-no-drag flex items-center gap-2">
        {needsCredentials && (
          <button
            onClick={onOpenCredentials}
            className="rounded-full border border-indigo-500/40 px-3 py-1 text-xs font-medium text-indigo-300 transition hover:border-indigo-400 hover:text-indigo-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300"
          >
            Connect your room
          </button>
        )}
        {onExitFocus && (
          <button
            onClick={onExitFocus}
            className="rounded-full border border-slate-700 bg-slate-950/80 px-4 py-1.5 text-sm text-slate-300 backdrop-blur transition hover:border-slate-500 hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
          >
            Leave focus mode
          </button>
        )}
        {authStatus?.signedIn ? (
          <button
            onClick={onSignOut}
            title="Sign out"
            className="rounded-full border border-[#242430] px-3 py-1 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
          >
            {authStatus.email}
          </button>
        ) : (
          <button
            onClick={onOpenAccount}
            className="rounded-full border border-[#242430] px-3 py-1 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
          >
            Sign in
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

const NexusButton = React.forwardRef<
  HTMLButtonElement,
  {
    accent: string;
    accentSoft: string;
    label: string;
    disabled: boolean;
    busy: boolean;
    onClick: () => void;
    large?: boolean;
  }
>(function NexusButton({ accent, accentSoft, label, disabled, busy, onClick, large }, ref) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy}
      className={`nexus-pulse group relative flex items-center justify-center rounded-full border-2 bg-gradient-to-b from-[#1e1e1e] to-[#050608] transition-[border-color,transform] duration-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${
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
        className={`font-display text-center font-semibold tracking-wide transition-colors duration-500 ${
          large ? "text-xl sm:text-2xl" : "text-base sm:text-lg"
        }`}
        style={{ color: accent }}
      >
        {label}
      </span>
    </button>
  );
});

function ProfileCard({
  profile,
  isActive,
  isDragging,
  isDropTarget,
  onSelect,
  onEdit,
  onDelete,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  profile: Profile;
  isActive: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
}): React.JSX.Element {
  const hex = profile.physical_orchestration.hex_color;
  const mutedHex = mix(hex, MUTE_TOWARD, MUTE_FACTOR);
  const scheduleLine = scheduleSummary(profile.schedule);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimeoutRef = useRef<number | undefined>(undefined);

  const handleDeleteClick = () => {
    if (confirmingDelete) {
      window.clearTimeout(confirmTimeoutRef.current);
      onDelete();
      return;
    }
    setConfirmingDelete(true);
    confirmTimeoutRef.current = window.setTimeout(() => setConfirmingDelete(false), 3000);
  };

  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      className={`group flex min-h-[84px] cursor-pointer flex-col justify-between gap-1 rounded-xl border p-3 transition-colors duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 sm:p-4 ${
        isDragging ? "opacity-40" : ""
      } ${
        isDropTarget
          ? "border-dashed border-slate-400"
          : isActive
            ? ""
            : "border-[#1e1e1e] bg-[#121218] hover:border-slate-600"
      }`}
      // Active state reads as a lighter surface, not a glow — elevation by
      // lightness rather than a coloured halo on a dark card.
      style={
        !isDropTarget && isActive
          ? { borderColor: mutedHex, backgroundColor: rgba(mutedHex, 0.08) }
          : undefined
      }
    >
      <div className="flex items-start gap-1.5">
        <div
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClick={(event) => event.stopPropagation()}
          role="button"
          tabIndex={-1}
          aria-label={`Drag to reorder ${profile.name}`}
          title="Drag to reorder"
          className="mt-0.5 flex h-5 w-5 shrink-0 cursor-grab items-center justify-center rounded text-slate-600 opacity-40 transition hover:text-slate-300 active:cursor-grabbing group-hover:opacity-100"
        >
          <svg viewBox="0 0 10 16" className="h-3 w-3" fill="currentColor">
            <circle cx="2" cy="2" r="1.4" />
            <circle cx="8" cy="2" r="1.4" />
            <circle cx="2" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="2" cy="14" r="1.4" />
            <circle cx="8" cy="14" r="1.4" />
          </svg>
        </div>

        <div className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
          <span className="flex w-full min-w-0 items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full transition-colors duration-500"
              style={{ backgroundColor: mutedHex }}
            />
            <span
              className="min-w-0 flex-1 truncate font-display text-sm font-semibold sm:text-base transition-colors duration-500"
              style={{ color: isActive ? mutedHex : undefined }}
              title={profile.name}
            >
              {profile.name}
            </span>
          </span>
          <span className="line-clamp-1 w-full text-[11px] leading-snug text-slate-500">{summarize(profile)}</span>
          {/* Always reserved, even when unscheduled, so cards in the same row stay a consistent height. */}
          <span className={`line-clamp-1 w-full text-[11px] leading-snug text-slate-600 ${scheduleLine ? "" : "invisible"}`}>
            {scheduleLine ?? "placeholder"}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
            aria-label={`Edit ${profile.name}`}
            title={`Edit ${profile.name}`}
            className="flex h-6 w-6 items-center justify-center rounded-full text-slate-500 opacity-60 transition hover:bg-white/5 hover:text-slate-200 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 group-hover:opacity-100"
          >
            <svg
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              <path d="M11 2l3 3-8 8H3v-3l8-8z" />
            </svg>
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              handleDeleteClick();
            }}
            onBlur={() => setConfirmingDelete(false)}
            aria-label={confirmingDelete ? `Confirm delete ${profile.name}` : `Delete ${profile.name}`}
            title={confirmingDelete ? "Click again to delete for good" : `Delete ${profile.name}`}
            className={`flex h-6 w-6 items-center justify-center rounded-full transition focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400 ${
              confirmingDelete
                ? "bg-red-500/20 text-red-300 opacity-100"
                : "text-slate-500 opacity-60 hover:bg-red-500/10 hover:text-red-300 hover:opacity-100 group-hover:opacity-100"
            }`}
          >
            <svg
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 4h10" />
              <path d="M6.5 4V2.5h3V4" />
              <path d="M4.5 4l.5 9a1 1 0 001 1h4a1 1 0 001-1l.5-9" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/** One number and its label — a cell in the personal-stats row. */
function StatCell({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="font-display text-xl font-semibold text-slate-100">{value}</span>
      <span className="text-[11px] text-slate-500">{label}</span>
    </div>
  );
}

/**
 * The research citations argue in the abstract; this makes the same case
 * with the user's own numbers, so it isn't just someone else's study.
 */
function StatsTerminal({ stats }: { stats: SessionStats | null }): React.JSX.Element {
  return (
    <section className="flex h-full flex-col rounded-2xl border border-[#1e1e1e] bg-[#121218]/60 p-4 sm:p-6">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-slate-300">Stats</h2>
        <span className="text-xs text-slate-600">
          {stats && stats.totalSessions > 0 ? `${stats.totalSessions} logged` : "No sessions yet"}
        </span>
      </div>
      <div className="grid flex-1 grid-cols-2 place-content-center gap-6 sm:grid-cols-4">
        <StatCell value={`${stats?.todayMinutes ?? 0}m`} label="today" />
        <StatCell value={String(stats?.streakDays ?? 0)} label="day streak" />
        <StatCell value={String(stats?.totalSessions ?? 0)} label="sessions" />
        <StatCell value={String(stats?.totalBlocks ?? 0)} label="blocked" />
      </div>
    </section>
  );
}

/**
 * Lives on the dashboard, not inside the mood editor — a schedule is
 * something to glance at and nudge often, and it always acts on whichever
 * mood is currently staged in the grid above.
 */
function ScheduleCard({
  profileName,
  schedule,
  onChange,
}: {
  profileName: string;
  schedule: Schedule;
  onChange: (patch: Partial<Schedule>, note?: string) => void;
}): React.JSX.Element {
  const toggleDay = (day: number) =>
    onChange({
      days: schedule.days.includes(day) ? schedule.days.filter((d) => d !== day) : [...schedule.days, day].sort(),
    });

  const addSchedule = () => onChange({ enabled: true }, `${profileName} now engages and disengages on a schedule.`);
  const removeSchedule = () => onChange({ enabled: false }, `${profileName} schedule removed.`);

  return (
    <section className="rounded-2xl border border-[#1e1e1e] bg-[#121218]/60 p-4 sm:p-6">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-slate-300">Schedule</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-600">{profileName}</span>
          {schedule.enabled ? (
            <button
              type="button"
              onClick={removeSchedule}
              aria-label={`Remove ${profileName} schedule`}
              title="Remove schedule"
              className="flex h-6 w-6 items-center justify-center rounded-full text-slate-500 opacity-70 transition hover:bg-red-500/10 hover:text-red-300 hover:opacity-100"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 4.5h10M6.5 4.5v-1a1 1 0 011-1h1a1 1 0 011 1v1M6.5 7.5v4M9.5 7.5v4M4.5 4.5l.6 8a1 1 0 001 .9h3.8a1 1 0 001-.9l.6-8" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={addSchedule}
              aria-label={`Add schedule for ${profileName}`}
              title="Add schedule"
              className="flex h-6 w-6 items-center justify-center rounded-full border border-[#242430] text-slate-400 transition hover:border-indigo-400 hover:text-indigo-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {schedule.enabled ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-slate-500">
              Engage
              <input
                type="time"
                value={schedule.engage_time}
                onChange={(event) => onChange({ engage_time: event.target.value })}
                className="rounded-lg border border-[#242430] bg-black/60 px-2 py-1.5 text-sm text-slate-200 outline-none transition focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/40"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-500">
              Disengage
              <input
                type="time"
                value={schedule.disengage_time}
                onChange={(event) => onChange({ disengage_time: event.target.value })}
                className="rounded-lg border border-[#242430] bg-black/60 px-2 py-1.5 text-sm text-slate-200 outline-none transition focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/40"
              />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {schedule.days.length === 0 ? "Every day" : "Repeats on"}
            </span>
            <div className="flex gap-1.5">
              {DAY_LETTERS.map((label, day) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  aria-pressed={schedule.days.includes(day)}
                  title={DAY_NAMES[day]}
                  className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300 ${
                    schedule.days.includes(day)
                      ? "border-indigo-400 bg-indigo-500/20 text-indigo-200"
                      : "border-[#242430] text-slate-500 hover:border-slate-500 hover:text-slate-300"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-600">
          No schedule set. Use the plus button to have {profileName} engage and disengage automatically.
        </p>
      )}
    </section>
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
    <section className="rounded-2xl border border-[#1e1e1e] bg-[#121218]/60 p-4 sm:p-6">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-slate-300">Room preview</h2>
        <span className="text-xs text-slate-600">{engaged ? "Engaged" : "Neutral"}</span>
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
          <rect width="320" height="200" fill="#05050a" />
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
                  style={{ backgroundColor: zone.hex }}
                />
                <code className="text-[11px] text-slate-500">{zone.hex}</code>
              </div>
            </div>
          ))}
          <div className="mt-2 rounded-lg border border-[#1e1e1e] bg-black/40 px-3 py-2 text-xs text-slate-500">
            {bridgeIp ? `Lights connected · ${brightness}% · ${sonicProfile}` : "Lights not connected yet"}
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
