import React, { useEffect, useMemo, useRef, useState } from "react";

type ProfileKey = "deepWork" | "brainDump" | "highEnergy" | "lateNight";

interface LightZone {
  label: string;
  hex: string;
}

interface Profile {
  key: ProfileKey;
  label: string;
  sublabel: string;
  accent: string;
  accentSoft: string;
  accentDim: string;
  ring: string;
  textGlow: string;
  lights: LightZone[];
  binaries: string[];
  iotScene: string;
  iotColorLabel: string;
  iotIp: string;
  appPath: string;
  tabsWiped: number;
  sonicProfile: string;
}

const WS_PORT = 8080;

const PROFILES: Record<ProfileKey, Profile> = {
  deepWork: {
    key: "deepWork",
    label: "Deep Work",
    sublabel: "Lockdown Focus",
    accent: "#6366f1",
    accentSoft: "rgba(99,102,241,0.35)",
    accentDim: "rgba(99,102,241,0.12)",
    ring: "border-indigo-400",
    textGlow: "text-indigo-300",
    lights: [
      { label: "Key Light", hex: "#4338ca" },
      { label: "Monitor Bias", hex: "#6366f1" },
      { label: "Ambient Strip", hex: "#312e81" },
    ],
    binaries: ["VS Code", "iTerm2", "Slack (DND)", "Focus Timer"],
    iotScene: "Hue Scene: Monolith / Lockdown",
    iotColorLabel: "Focus Indigo",
    iotIp: "192.168.1.50",
    appPath: "/Applications/Visual Studio Code.app",
    tabsWiped: 14,
    sonicProfile: "Binaural Focus Waves",
  },
  brainDump: {
    key: "brainDump",
    label: "Brain Dump",
    sublabel: "Creative Canvas",
    accent: "#f59e0b",
    accentSoft: "rgba(245,158,11,0.35)",
    accentDim: "rgba(245,158,11,0.12)",
    ring: "border-amber-400",
    textGlow: "text-amber-300",
    lights: [
      { label: "Key Light", hex: "#d97706" },
      { label: "Monitor Bias", hex: "#f59e0b" },
      { label: "Ambient Strip", hex: "#78350f" },
    ],
    binaries: ["Figma", "Notion", "Obsidian", "Spotify"],
    iotScene: "Hue Scene: Monolith / Wildfire",
    iotColorLabel: "Warm Amber",
    iotIp: "192.168.1.51",
    appPath: "/Applications/Notion.app",
    tabsWiped: 6,
    sonicProfile: "Lo-Fi Ideation Loop",
  },
  highEnergy: {
    key: "highEnergy",
    label: "High Energy",
    sublabel: "Operational Speed",
    accent: "#dc2626",
    accentSoft: "rgba(220,38,38,0.35)",
    accentDim: "rgba(220,38,38,0.12)",
    ring: "border-red-500",
    textGlow: "text-red-400",
    lights: [
      { label: "Key Light", hex: "#b91c1c" },
      { label: "Monitor Bias", hex: "#ef4444" },
      { label: "Ambient Strip", hex: "#450a0a" },
    ],
    binaries: ["iTerm2", "Datadog", "Zoom", "Linear"],
    iotScene: "Hue Scene: Monolith / Redline",
    iotColorLabel: "Intimidating Crimson",
    iotIp: "192.168.1.52",
    appPath: "/Applications/iTerm.app",
    tabsWiped: 22,
    sonicProfile: "High-Tempo Drive Stack",
  },
  lateNight: {
    key: "lateNight",
    label: "Late Night Chill",
    sublabel: "Decompression",
    accent: "#a855f7",
    accentSoft: "rgba(168,85,247,0.35)",
    accentDim: "rgba(168,85,247,0.12)",
    ring: "border-purple-400",
    textGlow: "text-purple-300",
    lights: [
      { label: "Key Light", hex: "#9333ea" },
      { label: "Monitor Bias", hex: "#c026d3" },
      { label: "Ambient Strip", hex: "#3b0764" },
    ],
    binaries: ["Apple TV", "Podcasts", "Sonos Controller"],
    iotScene: "Hue Scene: Monolith / Afterglow",
    iotColorLabel: "Deep Sunset Violet",
    iotIp: "192.168.1.53",
    appPath: "/Applications/Podcasts.app",
    tabsWiped: 9,
    sonicProfile: "Ambient Decompression Drone",
  },
};

const PROFILE_ORDER: ProfileKey[] = [
  "deepWork",
  "brainDump",
  "highEnergy",
  "lateNight",
];

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

type LogTone = "success" | "network" | "iot" | "sonic";

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
};

function buildLogLines(profile: Profile): Omit<LogLine, "id" | "time">[] {
  return [
    {
      tone: "success",
      text: `[MONOLITH IPC DEPLOYMENT SUCCESSFUL] Executing Node.js Child Process system command: ${profile.appPath} launched cleanly.`,
    },
    {
      tone: "network",
      text: `[BROWSING CONTAINMENT CONTRACT INITIATED] Active WebSocket transmission sent over port ${WS_PORT}: Wiping ${profile.tabsWiped} chaotic tabs, caching parameters, and dropping active session layout straight to clean slate canvas.`,
    },
    {
      tone: "iot",
      text: `[IoT MESH NETWORK BROADCASTING] Pinging mDNS IP array (${profile.iotIp}). Adjusting smart-lighting xy matrix to ${profile.iotColorLabel}. Target Hue transition time set to 500ms.`,
    },
    {
      tone: "sonic",
      text: `[SONIC LAYER INTERCEPTION TRIGGERED] Intercepting running Spotify Web API bearer token array. Forcing contextual frequency stream profile injection: ${profile.sonicProfile} active.`,
    },
  ];
}

function timestamp(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8) + "." + String(now.getMilliseconds()).padStart(3, "0");
}

export default function CommandDeck(): React.JSX.Element {
  const [activeKey, setActiveKey] = useState<ProfileKey>("deepWork");
  const [focusMode, setFocusMode] = useState(false);
  const [waveId, setWaveId] = useState(0);
  const [isWaving, setIsWaving] = useState(false);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const logCounter = useRef(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const active = useMemo(() => PROFILES[activeKey], [activeKey]);

  const appendLogLines = (profile: Profile) => {
    const entries = buildLogLines(profile).map((entry) => {
      logCounter.current += 1;
      return {
        ...entry,
        id: `${profile.key}-${logCounter.current}`,
        time: timestamp(),
      };
    });
    setLogLines((prev) => [...prev, ...entries].slice(-40));
  };

  useEffect(() => {
    appendLogLines(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logLines]);

  const handleSelectProfile = (key: ProfileKey) => {
    if (key === activeKey) return;
    setActiveKey(key);
  };

  const handleNexusTrigger = () => {
    setIsWaving(true);
    setWaveId((n) => n + 1);
    setFocusMode((prev) => !prev);
    window.setTimeout(() => setIsWaving(false), 650);
  };

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-black text-slate-100">
      <style>{`
        @keyframes nexus-pulse {
          0%, 100% { box-shadow: 0 0 0 0 var(--nexus-glow), 0 0 40px 8px var(--nexus-glow-soft); }
          50% { box-shadow: 0 0 0 14px transparent, 0 0 70px 18px var(--nexus-glow-soft); }
        }
        @keyframes canvas-breathe {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 0.85; }
        }
        @keyframes clip-wave {
          0% { clip-path: circle(0% at 50% 50%); opacity: 0.95; }
          55% { clip-path: circle(70% at 50% 50%); opacity: 0.65; }
          100% { clip-path: circle(150% at 50% 50%); opacity: 0; }
        }
        @keyframes cursor-blink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
        .nexus-pulse {
          animation: nexus-pulse 2.6s ease-in-out infinite;
        }
        .canvas-breathe {
          animation: canvas-breathe 6s ease-in-out infinite;
        }
        .clip-wave {
          animation: clip-wave 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          will-change: clip-path, opacity;
        }
        .terminal-cursor {
          animation: cursor-blink 1s step-end infinite;
        }
        .command-deck-scroll::-webkit-scrollbar {
          width: 6px;
        }
        .command-deck-scroll::-webkit-scrollbar-thumb {
          background: #1e1e1e;
          border-radius: 3px;
        }
      `}</style>

      {/* Ambient low-frequency background canvas pulse */}
      <div
        className="canvas-breathe pointer-events-none fixed inset-0 z-0 transition-colors duration-700"
        style={{
          background: `radial-gradient(circle at 50% 35%, ${active.accentDim}, transparent 65%)`,
        }}
      />

      {/* Full-screen clip-path wave transition */}
      {isWaving && (
        <div
          key={waveId}
          className="clip-wave pointer-events-none fixed inset-0 z-50"
          style={{
            background: `radial-gradient(circle at 50% 50%, ${active.accent} 0%, ${active.accentSoft} 45%, transparent 75%)`,
          }}
        />
      )}

      {/* Minimal corner wordmark — no title bar, no window chrome */}
      <div className="pointer-events-none fixed left-4 top-3 z-40 text-[11px] font-semibold uppercase tracking-[0.35em] text-slate-600 sm:left-6">
        MONOLITH
      </div>

      {focusMode && (
        <button
          onClick={() => setFocusMode(false)}
          className="fixed right-4 top-4 z-40 rounded-full border border-slate-700 bg-slate-950/80 px-4 py-2 text-xs uppercase tracking-widest text-slate-400 backdrop-blur transition hover:border-slate-500 hover:text-slate-200 sm:right-6"
        >
          Exit Focus
        </button>
      )}

      <div className="relative z-10 flex flex-1 flex-col overflow-hidden">
        {focusMode ? (
          /* Lockdown focus view — everything but the Nexus and active profile is stripped away */
          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
            <NexusButton active={active} focusMode={focusMode} onClick={handleNexusTrigger} large />
            <p className={`text-sm uppercase tracking-[0.4em] ${active.textGlow}`}>
              {active.label} &mdash; {active.sublabel}
            </p>
          </div>
        ) : (
          <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden p-4 sm:p-6 lg:grid-cols-[1fr_320px] lg:gap-6">
            {/* Main stage */}
            <div className="flex flex-col gap-6 overflow-y-auto pr-1 lg:pr-2">
              <div className="flex flex-col items-center gap-4 pt-8">
                <NexusButton active={active} focusMode={focusMode} onClick={handleNexusTrigger} />
                <p className="text-xs uppercase tracking-widest text-slate-500">
                  Nexus Trigger &mdash; {active.label}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {PROFILE_ORDER.map((key) => (
                  <ProfileCard
                    key={key}
                    profile={PROFILES[key]}
                    isActive={key === activeKey}
                    onSelect={() => handleSelectProfile(key)}
                  />
                ))}
              </div>

              <RoomSimulator active={active} />
            </div>

            {/* Context Crisis Statistics Terminal */}
            <StatsTerminal />
          </div>
        )}

        {/* Real-time IPC log terminal */}
        {!focusMode && (
          <div className="z-10 border-t border-slate-800 bg-[#0a0a0a] px-4 py-3 sm:px-6">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-500">
                Monolith Deployment Log
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-emerald-500">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                LIVE
              </span>
            </div>
            <div className="command-deck-scroll h-28 overflow-y-auto rounded-lg border border-slate-800 bg-black/60 p-3 font-mono text-[11px] leading-relaxed sm:h-32 sm:text-xs">
              {logLines.map((line) => (
                <div key={line.id} className="flex gap-2">
                  <span className="text-slate-600">{line.time}</span>
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

function NexusButton({
  active,
  focusMode,
  onClick,
  large,
}: {
  active: Profile;
  focusMode: boolean;
  onClick: () => void;
  large?: boolean;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`nexus-pulse group relative flex items-center justify-center rounded-full border-2 bg-gradient-to-b from-[#1e1e1e] to-black transition-transform duration-300 active:scale-95 ${
        large ? "h-56 w-56 sm:h-72 sm:w-72" : "h-40 w-40 sm:h-52 sm:w-52"
      }`}
      style={
        {
          borderColor: active.accent,
          "--nexus-glow": active.accent,
          "--nexus-glow-soft": active.accentSoft,
        } as React.CSSProperties
      }
    >
      <span
        className={`text-center font-bold uppercase tracking-[0.35em] transition-colors duration-500 ${
          large ? "text-lg sm:text-xl" : "text-sm sm:text-base"
        }`}
        style={{ color: active.accent }}
      >
        {focusMode ? "Engaged" : "Engage"}
      </span>
    </button>
  );
}

function ProfileCard({
  profile,
  isActive,
  onSelect,
}: {
  profile: Profile;
  isActive: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      onClick={onSelect}
      className={`flex flex-col items-start gap-1 rounded-xl border bg-[#121212] p-3 text-left transition-all duration-300 sm:p-4 ${
        isActive
          ? `${profile.ring} shadow-[0_0_25px_var(--tw-shadow-color)]`
          : "border-[#1e1e1e] hover:border-slate-600"
      }`}
      style={
        isActive
          ? ({ "--tw-shadow-color": profile.accentSoft } as React.CSSProperties)
          : undefined
      }
    >
      <span
        className={`text-sm font-semibold sm:text-base ${
          isActive ? profile.textGlow : "text-slate-200"
        }`}
      >
        {profile.label}
      </span>
      <span className="text-[11px] text-slate-500 sm:text-xs">{profile.sublabel}</span>
    </button>
  );
}

function RoomSimulator({ active }: { active: Profile }): React.JSX.Element {
  return (
    <section className="rounded-2xl border border-[#1e1e1e] bg-[#121212]/60 p-4 sm:p-6">
      <h2 className="mb-4 text-xs uppercase tracking-[0.3em] text-slate-500">
        Virtual Space Environment Simulator
      </h2>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <svg viewBox="0 0 320 200" className="w-full rounded-lg">
          <defs>
            <radialGradient id="ambientGlow" cx="50%" cy="20%" r="80%">
              <stop offset="0%" stopColor={active.accentSoft} />
              <stop offset="100%" stopColor="transparent" />
            </radialGradient>
          </defs>
          <rect width="320" height="200" fill="#050505" />
          <rect width="320" height="200" fill="url(#ambientGlow)" style={{ transition: "fill 500ms ease" }} />
          {/* desk */}
          <rect x="40" y="140" width="240" height="10" rx="2" fill="#1e293b" />
          <rect x="50" y="150" width="8" height="30" fill="#111827" />
          <rect x="262" y="150" width="8" height="30" fill="#111827" />
          {/* monitor */}
          <rect x="120" y="80" width="80" height="50" rx="3" fill="#0f172a" />
          <rect
            x="126"
            y="86"
            width="68"
            height="38"
            rx="2"
            fill={active.lights[1].hex}
            style={{ transition: "fill 500ms ease", opacity: 0.85 }}
          />
          <rect x="152" y="130" width="16" height="10" fill="#1e293b" />
          {/* ambient wall lighting grid */}
          <rect
            x="20"
            y="20"
            width="280"
            height="6"
            rx="3"
            fill={active.lights[2].hex}
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
              fill={active.lights[2].hex}
              style={{ transition: "fill 500ms ease", opacity: 0.5 }}
            />
          ))}
          {/* key light lamp */}
          <circle
            cx="255"
            cy="70"
            r="10"
            fill={active.lights[0].hex}
            style={{ transition: "fill 500ms ease" }}
          />
          <line x1="255" y1="80" x2="255" y2="140" stroke="#1e293b" strokeWidth="3" />
        </svg>

        <div className="flex flex-col justify-center gap-3">
          {active.lights.map((zone) => (
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
            {active.iotScene}
          </div>
          <div className="flex flex-wrap gap-2">
            {active.binaries.map((bin) => (
              <span
                key={bin}
                className="rounded-full border border-[#1e1e1e] px-2 py-0.5 text-[11px] text-slate-300"
              >
                {bin}
              </span>
            ))}
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
            <p className="font-semibold uppercase tracking-wide text-red-400">
              {stat.headline}:
            </p>
            <p className="mt-1 text-slate-300">{stat.body}</p>
            <p className="mt-1 text-slate-600">(Source: {stat.source})</p>
          </div>
        ))}
      </div>
    </aside>
  );
}
