/**
 * Monolith — installed application discovery.
 *
 * Moods used to name applications by absolute path, which meant a config was
 * only ever correct on the machine that wrote it: every path pointing at
 * software the user does not have became a skipped entry, and a mood could look
 * configured while doing nothing at all.
 *
 * This module reads what is actually installed and classifies it, so a mood can
 * say "quit every game" or "open two writing apps" and have that mean something
 * on any machine.
 *
 * Two fields matter and they are not the same string:
 *   - CFBundleIdentifier is stable across versions and localisations, so it is
 *     what classification keys off.
 *   - CFBundleExecutable is the actual process name, and the only thing `pkill
 *     -x` will match. Microsoft Teams ships as "MSTeams"; killing "Microsoft
 *     Teams" silently matches nothing.
 */

import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(exec);

const PLIST_TIMEOUT_MS = 4000;

/** Non-recursive: an .app is a directory, and nesting is rare enough to skip. */
const SEARCH_ROOTS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  path.join(homedir(), 'Applications'),
];

export type AppCategory =
  | 'games'
  | 'messaging'
  | 'writing'
  | 'productivity'
  | 'dev'
  | 'browser'
  | 'media';

export const ALL_CATEGORIES: AppCategory[] = [
  'games',
  'messaging',
  'writing',
  'productivity',
  'dev',
  'browser',
  'media',
];

export interface CatalogEntry {
  /** Display name, e.g. "Visual Studio Code". */
  name: string;
  path: string;
  bundleId: string;
  /** CFBundleExecutable — the name `pkill -x` matches. */
  process: string;
  categories: AppCategory[];
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

interface Rule {
  category: AppCategory;
  /** Matched against the lowercased bundle identifier, as a prefix. */
  bundlePrefixes?: string[];
  /** Matched against the lowercased display name, as a substring. */
  nameContains?: string[];
}

/**
 * Curated rather than heuristic. Guessing from an app's own metadata is
 * unreliable — LSApplicationCategoryType is frequently absent or wrong — and a
 * mood that force-quits the wrong thing is worse than one that quits nothing.
 */
const RULES: Rule[] = [
  {
    category: 'games',
    bundlePrefixes: [
      'com.valvesoftware.steam',
      'com.epicgames',
      'com.riotgames',
      'com.blizzard',
      'net.battle',
      'com.mojang',
      'com.roblox',
      'com.ea.',
      'com.ubisoft',
      'com.gog.galaxy',
      'io.itch',
      'org.prismlauncher',
      'com.unity',
      'com.innersloth',
      'com.faceit',
    ],
    nameContains: [
      'steam',
      'epic games',
      'battle.net',
      'minecraft',
      'roblox',
      'league of legends',
      'valorant',
      'origin',
      'gog galaxy',
      'itch',
      'among us',
      'game launcher',
      'chess',
      'games',
    ],
  },
  {
    category: 'messaging',
    bundlePrefixes: [
      'com.tinyspeck.slackmacgap',
      'com.hnc.discord',
      'com.apple.mobilesms',
      'com.apple.facetime',
      'com.microsoft.teams',
      'us.zoom',
      'com.skype',
      'net.whatsapp',
      'ru.keepcoder.telegram',
      'org.telegram',
      'com.facebook.archon',
      'org.whispersystems.signal-desktop',
      'com.signal',
      'com.readdle.spark',
      'com.microsoft.outlook',
      'com.apple.mail',
    ],
    nameContains: [
      'slack',
      'discord',
      'messages',
      'facetime',
      'teams',
      'zoom',
      'skype',
      'whatsapp',
      'telegram',
      'messenger',
      'signal',
      'outlook',
      'mail',
    ],
  },
  {
    category: 'writing',
    bundlePrefixes: [
      'com.apple.notes',
      'com.apple.freeform',
      'com.apple.textedit',
      'com.apple.iwork.pages',
      'com.apple.stickies',
      'com.microsoft.word',
      'com.microsoft.onenote',
      'notion.id',
      'md.obsidian',
      'net.shinyfrog.bear',
      'com.ulyssesapp',
      'pro.writer.mac',
      'com.literatureandlatte.scrivener',
      'com.coppice.craft',
    ],
    nameContains: [
      'notes',
      'freeform',
      'textedit',
      'pages',
      'stickies',
      'word',
      'onenote',
      'notion',
      'obsidian',
      'bear',
      'ulysses',
      'ia writer',
      'scrivener',
      'craft',
      'drafts',
    ],
  },
  {
    category: 'productivity',
    bundlePrefixes: [
      'com.apple.reminders',
      'com.apple.ical',
      'com.culturedcode.thingsmac',
      'com.omnigroup.omnifocus',
      'com.todoist',
      'com.linear',
      'com.microsoft.excel',
      'com.microsoft.powerpoint',
      'com.apple.iwork.numbers',
      'com.apple.iwork.keynote',
    ],
    nameContains: ['reminders', 'calendar', 'things', 'omnifocus', 'todoist', 'linear'],
  },
  {
    category: 'dev',
    bundlePrefixes: [
      'com.microsoft.vscode',
      'com.todesktop', // Cursor and other ToDesktop-packaged editors
      'com.apple.dt.xcode',
      'com.googlecode.iterm2',
      'com.apple.terminal',
      'com.sublimetext',
      'com.jetbrains',
      'com.torusknot.sourcetreenotmas',
      'com.github.geekscape',
      'com.postmanlabs',
      'com.docker.docker',
      'com.figma.desktop',
    ],
    nameContains: [
      'visual studio code',
      'cursor',
      'xcode',
      'iterm',
      'terminal',
      'sublime',
      'intellij',
      'pycharm',
      'webstorm',
      'sourcetree',
      'github desktop',
      'postman',
      'docker',
      'antigravity',
      'zed',
      'warp',
    ],
  },
  {
    category: 'browser',
    bundlePrefixes: [
      'com.apple.safari',
      'com.google.chrome',
      'org.mozilla.firefox',
      'company.thebrowser.browser',
      'com.microsoft.edgemac',
      'com.brave.browser',
      'com.operasoftware.opera',
    ],
    nameContains: ['safari', 'chrome', 'firefox', 'arc', 'edge', 'brave', 'opera', 'vivaldi'],
  },
  {
    category: 'media',
    bundlePrefixes: [
      'com.spotify.client',
      'com.apple.music',
      'com.apple.podcasts',
      'com.apple.tv',
      'org.videolan.vlc',
      'com.colliderli.iina',
    ],
    nameContains: ['spotify', 'music', 'podcasts', 'vlc', 'iina'],
  },
];

/**
 * Whole-word match against a display name.
 *
 * A plain substring test is wrong here in a way that matters: "Passwords"
 * contains "word", so naive matching files a password manager as a writing app
 * and a mood then opens it. Anchoring to word boundaries keeps "Microsoft Word"
 * while dropping "Passwords".
 */
export function nameMatches(name: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(name);
}

/** Every category an app matches; an app can be both writing and productivity. */
export function classify(bundleId: string, name: string): AppCategory[] {
  const id = bundleId.toLowerCase();

  const matched = RULES.filter(
    (rule) =>
      (rule.bundlePrefixes ?? []).some((prefix) => id.startsWith(prefix)) ||
      (rule.nameContains ?? []).some((needle) => nameMatches(name, needle)),
  ).map((rule) => rule.category);

  return Array.from(new Set(matched));
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads the two fields worth having out of an app bundle. `plutil` handles both
 * the binary and XML plist encodings; reading the file directly would not.
 */
export async function readBundle(appPath: string): Promise<CatalogEntry | null> {
  const name = path.basename(appPath).replace(/\.app$/i, '');

  try {
    const { stdout } = await execFileAsync(
      `plutil -convert json -o - ${JSON.stringify(path.join(appPath, 'Contents', 'Info.plist'))}`,
      { timeout: PLIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );

    const info = JSON.parse(stdout) as { CFBundleIdentifier?: unknown; CFBundleExecutable?: unknown };
    const bundleId = typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : '';
    const executable = typeof info.CFBundleExecutable === 'string' ? info.CFBundleExecutable : name;

    return { name, path: appPath, bundleId, process: executable, categories: classify(bundleId, name) };
  } catch {
    // An unreadable bundle is still worth listing by name — it can be launched,
    // just not classified as confidently.
    return { name, path: appPath, bundleId: '', process: name, categories: classify('', name) };
  }
}

async function listAppsIn(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name.endsWith('.app'))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

let cache: CatalogEntry[] | null = null;

/**
 * Scans every search root in parallel. Cached, because a shift asks for this on
 * every engage and the answer only changes when software is installed.
 */
export async function discoverApps(force = false): Promise<CatalogEntry[]> {
  if (cache && !force) return cache;

  const roots = await Promise.all(SEARCH_ROOTS.map(listAppsIn));
  const paths = Array.from(new Set(roots.flat()));
  const entries = await Promise.all(paths.map(readBundle));

  cache = entries
    .filter((entry): entry is CatalogEntry => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return cache;
}

/** Everything installed that falls in `category`. */
export function inCategory(catalog: CatalogEntry[], category: AppCategory): CatalogEntry[] {
  return catalog.filter((entry) => entry.categories.includes(category));
}

/**
 * Finds one app by fuzzy name, preferring an exact match. Lets a mood ask for
 * "Notes" without caring whether it lives in /Applications or /System.
 */
export function findByName(catalog: CatalogEntry[], query: string): CatalogEntry | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;

  return (
    catalog.find((entry) => entry.name.toLowerCase() === needle) ??
    catalog.find((entry) => entry.name.toLowerCase().includes(needle)) ??
    null
  );
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolvedTargets {
  apps: string[];
  urls: string[];
  processes: string[];
  /** Names a mood asked for that nothing installed satisfies. */
  unresolved: string[];
}

/**
 * Turns a mood's declared intent into concrete targets for this machine:
 * explicit paths pass through, names and categories are looked up.
 *
 * Kill targets resolve to CFBundleExecutable rather than the display name. The
 * two differ often enough to matter — Teams runs as "MSTeams" — and `pkill -x`
 * only ever matches the executable.
 *
 * Pure: the catalog is passed in, so the whole resolution is testable without
 * touching the filesystem.
 */
export function resolveTargets(
  purge: {
    launch_applications: string[];
    launch_app_names: string[];
    launch_categories: AppCategory[];
    launch_category_limit: number;
    launch_urls: string[];
    kill_background_processes: string[];
    kill_categories: AppCategory[];
  },
  catalog: CatalogEntry[],
): ResolvedTargets {
  const apps = new Set(purge.launch_applications.map((entry) => entry.trim()).filter(Boolean));
  const processes = new Set(
    purge.kill_background_processes.map((entry) => entry.trim()).filter(Boolean),
  );
  const unresolved: string[] = [];

  for (const wanted of purge.launch_app_names) {
    const found = findByName(catalog, wanted);
    if (found) apps.add(found.path);
    else unresolved.push(wanted);
  }

  for (const category of purge.launch_categories) {
    const members = inCategory(catalog, category);
    // A limit of 0 means "everything installed"; anything else caps the set so
    // asking for writing apps does not open eight of them.
    const limit = purge.launch_category_limit > 0 ? purge.launch_category_limit : members.length;
    if (members.length === 0) unresolved.push(category);
    for (const entry of members.slice(0, limit)) apps.add(entry.path);
  }

  for (const category of purge.kill_categories) {
    const members = inCategory(catalog, category);
    if (members.length === 0) unresolved.push(category);
    for (const entry of members) processes.add(entry.process);
  }

  return {
    apps: [...apps],
    urls: purge.launch_urls.map((entry) => entry.trim()).filter(Boolean),
    processes: [...processes],
    unresolved,
  };
}
