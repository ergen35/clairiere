import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import type { Key } from '../shared/i18n';
import type { CleanTarget, TargetGroup } from '../shared/types';
import { tr } from './i18n';

export interface CommandStep {
  file: string;
  args: string[];
}

export interface TargetDef {
  id: string;
  group: TargetGroup;
  /** A brand name shown as is ("Google Chrome"), or a phrase to translate. */
  label: string | { key: Key };
  hint: Key | { text: string };
  risk: 'safe' | 'review';
  on: boolean;
  /** Folders whose content is emptied. Accepts * in a path segment; ~ is the home folder,
   *  %LOCAL% and %ROAMING% the Windows application data folders. */
  paths?: string[];
  /** Programs whose cache is in use while they run (lower case, without .exe). */
  procs?: string[];
  procName?: string | { key: Key };
  /** A fixed system command instead of deleting folders. */
  steps?: CommandStep[];
  /** What to measure, for a command whose size can be read from folders. */
  measure?: string[];
  needsPassword?: boolean;
}

const OS = process.platform;
const IS_WIN = OS === 'win32';
const IS_MAC = OS === 'darwin';

export function home(): string {
  return homedir();
}

function local() {
  return process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
}
function roaming() {
  return process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
}

/** Where each system keeps per-user application data. */
const APPDATA = IS_MAC ? '~/Library/Application Support' : IS_WIN ? '%ROAMING%' : '~/.config';

const CHROMIUM_INNER = ['Cache', 'Code Cache', 'GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache'];
const CHROMIUM_ROOT = ['GrShaderCache', 'ShaderCache', 'GraphiteDawnCache'];

/** Where a Chromium browser keeps its profiles, and its separate cache folder when it has one. */
interface ChromiumPlaces {
  linux: [string, string?];
  darwin: [string, string?];
  win32: [string, string?];
}

function chromium(id: string, label: string, places: ChromiumPlaces, procs: string[], flatpak?: string): TargetDef {
  const [profiles, cache] = places[OS as keyof ChromiumPlaces] ?? places.linux;
  return {
    id, group: 'browsers', label, risk: 'safe', on: true, procs, procName: label, hint: 'h.browser',
    paths: [
      ...(cache ? [cache] : []),
      ...CHROMIUM_INNER.map((c) => `${profiles}/*/${c}`),
      ...CHROMIUM_ROOT.map((c) => `${profiles}/${c}`),
      ...(flatpak && OS === 'linux' ? [`~/.var/app/${flatpak}/cache`] : []),
    ],
  };
}

function electronApp(id: string, label: string, dir: string, procs: string[], extra: string[] = []): TargetDef {
  return {
    id, group: 'apps', label, risk: 'safe', on: true, procs, procName: label, hint: 'h.electron',
    paths: [...['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'Service Worker/CacheStorage'].map((c) => `${APPDATA}/${dir}/${c}`), ...extra.map((e) => `${APPDATA}/${dir}/${e}`)],
  };
}

function devCache(id: string, label: string | { key: Key }, paths: string[], hint: Key = 'h.download', risk: 'safe' | 'review' = 'safe'): TargetDef {
  return { id, group: 'dev', label, hint, risk, on: risk === 'safe', paths };
}

/** The same tool keeps its cache in a different place on each system. */
const pick = (linux: string[], darwin: string[], win32: string[]) => (IS_WIN ? win32 : IS_MAC ? darwin : linux);

const JETBRAINS = ['idea', 'pycharm', 'webstorm', 'clion', 'goland', 'rider', 'phpstorm', 'rubymine', 'datagrip'];

function catalog(): TargetDef[] {
  const browsers: TargetDef[] = [
    chromium('chrome', 'Google Chrome', {
      linux: ['~/.config/google-chrome', '~/.cache/google-chrome'],
      darwin: ['~/Library/Application Support/Google/Chrome', '~/Library/Caches/Google/Chrome'],
      win32: ['%LOCAL%/Google/Chrome/User Data'],
    }, ['chrome', 'google chrome'], 'com.google.Chrome'),
    chromium('chromium', 'Chromium', {
      linux: ['~/.config/chromium', '~/.cache/chromium'],
      darwin: ['~/Library/Application Support/Chromium', '~/Library/Caches/Chromium'],
      win32: ['%LOCAL%/Chromium/User Data'],
    }, ['chromium', 'chromium-browser'], 'org.chromium.Chromium'),
    chromium('brave', 'Brave', {
      linux: ['~/.config/BraveSoftware/Brave-Browser', '~/.cache/BraveSoftware/Brave-Browser'],
      darwin: ['~/Library/Application Support/BraveSoftware/Brave-Browser', '~/Library/Caches/BraveSoftware/Brave-Browser'],
      win32: ['%LOCAL%/BraveSoftware/Brave-Browser/User Data'],
    }, ['brave', 'brave browser'], 'com.brave.Browser'),
    chromium('edge', 'Microsoft Edge', {
      linux: ['~/.config/microsoft-edge', '~/.cache/microsoft-edge'],
      darwin: ['~/Library/Application Support/Microsoft Edge', '~/Library/Caches/Microsoft Edge'],
      win32: ['%LOCAL%/Microsoft/Edge/User Data'],
    }, ['msedge', 'microsoft edge'], 'com.microsoft.Edge'),
    chromium('vivaldi', 'Vivaldi', {
      linux: ['~/.config/vivaldi', '~/.cache/vivaldi'],
      darwin: ['~/Library/Application Support/Vivaldi', '~/Library/Caches/Vivaldi'],
      win32: ['%LOCAL%/Vivaldi/User Data'],
    }, ['vivaldi-bin', 'vivaldi'], 'com.vivaldi.Vivaldi'),
    chromium('opera', 'Opera', {
      linux: ['~/.config/opera', '~/.cache/opera'],
      darwin: ['~/Library/Application Support/com.operasoftware.Opera', '~/Library/Caches/com.operasoftware.Opera'],
      win32: ['%ROAMING%/Opera Software/Opera Stable', '%LOCAL%/Opera Software/Opera Stable'],
    }, ['opera']),
    {
      id: 'firefox', group: 'browsers', label: 'Firefox', risk: 'safe', on: true, procs: ['firefox', 'firefox-bin'], procName: 'Firefox', hint: 'h.browser',
      paths: pick(
        ['~/.cache/mozilla/firefox', '~/snap/firefox/common/.cache/mozilla/firefox', '~/.var/app/org.mozilla.firefox/cache'],
        ['~/Library/Caches/Firefox'],
        ['%LOCAL%/Mozilla/Firefox/Profiles/*/cache2', '%LOCAL%/Mozilla/Firefox/Profiles/*/startupCache'],
      ),
    },
  ];

  const apps: TargetDef[] = [
    electronApp('vscode', 'Visual Studio Code', 'Code', ['code'], ['CachedData', 'CachedExtensionVSIXs', 'logs']),
    electronApp('cursor', 'Cursor', 'Cursor', ['cursor'], ['CachedData', 'logs']),
    electronApp('slack', 'Slack', 'Slack', ['slack']),
    electronApp('discord', 'Discord', 'discord', ['discord']),
    ...(OS === 'linux' ? [electronApp('teams', 'Teams', 'teams-for-linux', ['teams-for-linux'])] : []),
    {
      id: 'spotify', group: 'apps', label: 'Spotify', risk: 'safe', on: true, procs: ['spotify'], procName: 'Spotify', hint: 'h.spotify',
      paths: pick(['~/.cache/spotify', '~/snap/spotify/common/.cache/spotify'], ['~/Library/Caches/com.spotify.client'], ['%LOCAL%/Spotify/Data', '%LOCAL%/Spotify/Storage']),
    },
    {
      id: 'jetbrains', group: 'apps', label: { key: 't.jetbrains' }, risk: 'safe', on: true, procName: { key: 'proc.jetbrains' }, hint: 'h.jetbrains',
      procs: [...JETBRAINS, ...JETBRAINS.map((n) => `${n}64`)],
      // On Windows the folder also holds settings: only each product's caches and indexes.
      paths: pick(['~/.cache/JetBrains'], ['~/Library/Caches/JetBrains'], ['%LOCAL%/JetBrains/*/caches', '%LOCAL%/JetBrains/*/index', '%LOCAL%/JetBrains/*/log']),
    },
    {
      id: 'steamshaders', group: 'apps', label: { key: 't.steamshaders' }, risk: 'safe', on: false, procs: ['steam', 'steam_osx'], procName: 'Steam', hint: 'h.steamshaders',
      paths: pick(['~/.steam/steam/steamapps/shadercache', '~/.local/share/Steam/steamapps/shadercache'], ['~/Library/Application Support/Steam/steamapps/shadercache'], []),
    },
    {
      id: 'mesa', group: 'apps', label: { key: 't.graphics' }, risk: 'safe', on: true, hint: 'h.graphics',
      paths: pick(
        ['~/.cache/mesa_shader_cache', '~/.cache/mesa_shader_cache_db', '~/.cache/nvidia', '~/.nv/ComputeCache', '~/.nv/GLCache'],
        [],
        ['%LOCAL%/D3DSCache', '%LOCAL%/NVIDIA/DXCache', '%LOCAL%/NVIDIA/GLCache', '%LOCAL%/AMD/DxCache', '%LOCAL%/AMD/DxcCache', '%LOCAL%/AMD/GLCache', '%LOCAL%/Intel/ShaderCache'],
      ),
    },
  ];
  if (OS === 'linux') {
    apps.push(
      { id: 'flatpakcache', group: 'apps', label: { key: 't.flatpakcache' }, risk: 'safe', on: true, hint: 'h.appcache', paths: ['~/.var/app/*/cache'] },
      { id: 'snapcache', group: 'apps', label: { key: 't.snapcache' }, risk: 'safe', on: true, hint: 'h.appcache', paths: ['~/snap/*/common/.cache', '~/snap/*/current/.cache'] },
    );
  }
  if (IS_WIN) {
    apps.push(
      { id: 'inetcache', group: 'apps', label: { key: 't.inetcache' }, risk: 'safe', on: true, hint: 'h.inetcache', paths: ['%LOCAL%/Microsoft/Windows/INetCache'] },
      { id: 'crash', group: 'apps', label: { key: 't.crash' }, risk: 'safe', on: true, hint: 'h.crash', paths: ['%LOCAL%/CrashDumps', '%LOCAL%/Microsoft/Windows/WER/ReportArchive', '%LOCAL%/Microsoft/Windows/WER/ReportQueue'] },
    );
  }
  if (IS_MAC) {
    apps.push(
      { id: 'logs', group: 'apps', label: { key: 't.logs' }, risk: 'safe', on: false, hint: 'h.logs', paths: ['~/Library/Logs'] },
      { id: 'crash', group: 'apps', label: { key: 't.crash' }, risk: 'safe', on: true, hint: 'h.crash', paths: ['~/Library/Logs/DiagnosticReports'] },
    );
  }

  const dev: TargetDef[] = [
    devCache('npm', 'npm', pick(['~/.npm/_cacache', '~/.npm/_npx', '~/.npm/_logs'], ['~/.npm/_cacache', '~/.npm/_npx', '~/.npm/_logs'], ['%LOCAL%/npm-cache/_cacache', '%LOCAL%/npm-cache/_npx', '%LOCAL%/npm-cache/_logs'])),
    devCache('yarn', 'Yarn', [...pick(['~/.cache/yarn'], ['~/Library/Caches/Yarn'], ['%LOCAL%/Yarn/Cache']), '~/.yarn/berry/cache']),
    devCache('pnpm', 'pnpm', pick(['~/.cache/pnpm', '~/.local/share/pnpm/store'], ['~/Library/Caches/pnpm', '~/Library/pnpm/store'], ['%LOCAL%/pnpm-cache', '%LOCAL%/pnpm/store']), 'h.shared'),
    devCache('bun', 'Bun', ['~/.bun/install/cache']),
    devCache('nodegyp', 'node-gyp', pick(['~/.cache/node-gyp'], ['~/Library/Caches/node-gyp'], ['%LOCAL%/node-gyp/Cache'])),
    devCache('pip', 'pip', pick(['~/.cache/pip'], ['~/Library/Caches/pip'], ['%LOCAL%/pip/Cache'])),
    devCache('uv', 'uv', pick(['~/.cache/uv'], ['~/.cache/uv', '~/Library/Caches/uv'], ['%LOCAL%/uv/cache'])),
    devCache('poetry', 'Poetry', pick(['~/.cache/pypoetry'], ['~/Library/Caches/pypoetry'], ['%LOCAL%/pypoetry/Cache'])),
    devCache('cargo', 'Cargo (Rust)', ['~/.cargo/registry/cache', '~/.cargo/registry/src', '~/.cargo/git/checkouts']),
    devCache('gobuild', { key: 't.gobuild' }, pick(['~/.cache/go-build'], ['~/Library/Caches/go-build'], ['%LOCAL%/go-build']), 'h.build'),
    devCache('gomod', { key: 't.gomod' }, ['~/go/pkg/mod'], 'h.slow', 'review'),
    devCache('gradle', 'Gradle', ['~/.gradle/caches'], 'h.slow', 'review'),
    devCache('maven', 'Maven', ['~/.m2/repository'], 'h.slow', 'review'),
    devCache('nuget', { key: 't.nuget' }, [...pick(['~/.local/share/NuGet/v3-cache'], ['~/.local/share/NuGet/v3-cache'], ['%LOCAL%/NuGet/v3-cache']), '~/.nuget/packages'], 'h.slow', 'review'),
    devCache('composer', 'Composer', pick(['~/.cache/composer'], ['~/Library/Caches/composer'], ['%LOCAL%/Composer'])),
    devCache('playwright', { key: 't.playwright' }, pick(['~/.cache/ms-playwright'], ['~/Library/Caches/ms-playwright'], ['%LOCAL%/ms-playwright']), 'h.slow', 'review'),
    devCache('puppeteer', { key: 't.puppeteer' }, ['~/.cache/puppeteer'], 'h.slow', 'review'),
    devCache('electron', { key: 't.electron' }, pick(['~/.cache/electron', '~/.cache/electron-builder'], ['~/Library/Caches/electron', '~/Library/Caches/electron-builder'], ['%LOCAL%/electron/Cache', '%LOCAL%/electron-builder/Cache'])),
    devCache('cypress', 'Cypress', pick(['~/.cache/Cypress'], ['~/Library/Caches/Cypress'], ['%LOCAL%/Cypress/Cache']), 'h.slow', 'review'),
    devCache('huggingface', { key: 't.huggingface' }, ['~/.cache/huggingface'], 'h.slow', 'review'),
    devCache('torch', { key: 't.torch' }, ['~/.cache/torch'], 'h.slow', 'review'),
  ];
  if (IS_MAC) {
    dev.push(
      devCache('xcode', { key: 't.xcode' }, ['~/Library/Developer/Xcode/DerivedData'], 'h.xcode'),
      devCache('simcaches', { key: 't.simcaches' }, ['~/Library/Developer/CoreSimulator/Caches'], 'h.build'),
      devCache('devicesupport', { key: 't.devicesupport' }, ['~/Library/Developer/Xcode/iOS DeviceSupport'], 'h.devicesupport', 'review'),
      devCache('cocoapods', { key: 't.cocoapods' }, ['~/Library/Caches/CocoaPods']),
    );
  }

  const quick: TargetDef[] = [];
  if (IS_WIN) {
    quick.push(
      {
        id: 'trash', group: 'quick', label: { key: 't.trash' }, risk: 'review', on: false, hint: 'h.trash',
        steps: [{ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue'] }],
      },
      { id: 'temp', group: 'quick', label: { key: 't.temp' }, risk: 'safe', on: true, hint: 'h.temp', paths: ['%LOCAL%/Temp'] },
    );
  } else if (IS_MAC) {
    quick.push({
      id: 'trash', group: 'quick', label: { key: 't.trash' }, risk: 'review', on: false, hint: 'h.trash',
      measure: ['~/.Trash'],
      steps: [{ file: 'osascript', args: ['-e', 'tell application "Finder" to empty trash'] }],
    });
  } else {
    quick.push(
      {
        id: 'trash', group: 'quick', label: { key: 't.trash' }, risk: 'review', on: false, hint: 'h.trash',
        paths: ['~/.local/share/Trash/files', '~/.local/share/Trash/info', '~/.local/share/Trash/expunged'],
      },
      { id: 'thumbnails', group: 'quick', label: { key: 't.thumbnails' }, risk: 'safe', on: true, hint: 'h.thumbnails', paths: ['~/.cache/thumbnails', '~/.thumbnails'] },
    );
  }

  const system: TargetDef[] = [];
  if (OS === 'linux') {
    system.push(
      {
        id: 'apt', group: 'system', label: { key: 't.apt' }, risk: 'safe', on: false, needsPassword: true, hint: 'h.apt',
        steps: [{ file: 'pkexec', args: ['apt-get', 'clean'] }],
      },
      {
        id: 'journal', group: 'system', label: { key: 't.journal' }, risk: 'safe', on: false, needsPassword: true, hint: 'h.journal',
        steps: [{ file: 'pkexec', args: ['journalctl', '--vacuum-time=7d'] }],
      },
      {
        id: 'snapold', group: 'system', label: { key: 't.snapold' }, risk: 'safe', on: false, needsPassword: true, hint: 'h.snapold',
        steps: [{ file: 'pkexec', args: ['sh', '-c', `LANG=C snap list --all | awk '/disabled/{print $1, $3}' | while read -r n r; do snap remove "$n" --revision="$r"; done`] }],
      },
      {
        id: 'flatpakunused', group: 'system', label: { key: 't.flatpakunused' }, risk: 'safe', on: false, hint: 'h.flatpakunused',
        steps: [{ file: 'flatpak', args: ['uninstall', '--unused', '-y', '--noninteractive'] }],
      },
    );
  }
  if (IS_MAC) {
    system.push(
      {
        id: 'brew', group: 'system', label: { key: 't.brew' }, risk: 'safe', on: false, hint: 'h.brew',
        measure: ['~/Library/Caches/Homebrew'],
        steps: [{ file: 'brew', args: ['cleanup', '-s', '--prune=all'] }],
      },
      {
        id: 'simunavailable', group: 'system', label: { key: 't.simunavailable' }, risk: 'safe', on: false, hint: 'h.simunavailable',
        steps: [{ file: 'xcrun', args: ['simctl', 'delete', 'unavailable'] }],
      },
    );
  }
  system.push({
    id: 'docker', group: 'system', label: { key: 't.docker' }, risk: 'review', on: false, hint: 'h.docker',
    steps: [
      { file: 'docker', args: ['image', 'prune', '-af'] },
      { file: 'docker', args: ['builder', 'prune', '-af'] },
    ],
  });

  return [...quick, ...browsers, ...apps, ...dev, ...system];
}

export const CATALOG: TargetDef[] = catalog();

/** Folders in the general cache where apps keep more than a cache, or that the session is using. */
const KEEP_IN_CACHE = IS_MAC
  ? /^(com\.apple\.|cloudkit|familycircle|com\.crashlytics|clairiere|homebrew$|clairière)/i
  : /^(keyring|evolution|dconf|ibus|sessions|gvfs|tracker|localsearch|gnome-shell|gstreamer|at-spi|clairiere)/i;

function expand(p: string): string {
  const full = p.startsWith('~/')
    ? path.join(home(), p.slice(2))
    : p.startsWith('%LOCAL%/')
      ? path.join(local(), p.slice(8))
      : p.startsWith('%ROAMING%/')
        ? path.join(roaming(), p.slice(10))
        : p;
  return path.normalize(full);
}

function isRealPath(p: string) {
  try {
    return !lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function expandGlob(pattern: string): string[] {
  const full = expand(pattern);
  if (!full.includes('*')) return isRealPath(full) ? [full] : [];
  const root = path.parse(full).root;
  let found = [root];
  for (const seg of full.slice(root.length).split(path.sep).filter(Boolean)) {
    if (seg === '*') {
      found = found.flatMap((dir) => {
        try {
          return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
        } catch {
          return [];
        }
      });
    } else {
      found = found.map((d) => path.join(d, seg)).filter(isRealPath);
    }
  }
  return found;
}

export function commandExists(file: string): boolean {
  const exts = IS_WIN ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && exts.some((e) => existsSync(path.join(dir, file + e))));
}

function availableStep(def: TargetDef) {
  switch (def.id) {
    case 'apt': return commandExists('apt-get') && commandExists('pkexec');
    case 'journal': return commandExists('journalctl') && commandExists('pkexec');
    case 'snapold': return commandExists('snap') && commandExists('pkexec');
    case 'flatpakunused': return commandExists('flatpak');
    case 'docker': return commandExists('docker');
    case 'brew': return commandExists('brew');
    case 'simunavailable': return existsSync('/Applications/Xcode.app') && commandExists('xcrun');
    case 'trash': return true;
    default: return false;
  }
}

let runningCache: { at: number; names: Set<string> } | null = null;

/** Names of the programs running now, in lower case and without ".exe". */
export function runningPrograms(): Set<string> {
  if (runningCache && Date.now() - runningCache.at < 2000) return runningCache.names;
  const names = new Set<string>();
  try {
    if (IS_WIN) {
      const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split(/\r?\n/)) {
        const m = /^"([^"]+)"/.exec(line);
        if (m) names.add(m[1].toLowerCase().replace(/\.exe$/, ''));
      }
    } else if (IS_MAC) {
      const out = execFileSync('ps', ['-axco', 'comm='], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split('\n')) if (line.trim()) names.add(line.trim().toLowerCase());
    } else {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          names.add(readFileSync(`/proc/${entry}/comm`, 'utf8').trim().toLowerCase());
        } catch {
          // The process is gone: nothing to note.
        }
      }
    }
  } catch {
    // Nothing readable: treat everything as closed.
  }
  runningCache = { at: Date.now(), names };
  return names;
}

const text = (v: string | { key: Key }) => (typeof v === 'string' ? v : tr(v.key));

export function labelOf(def: TargetDef): string {
  return text(def.label);
}

export function blockedBy(def: TargetDef, running = runningPrograms()): string | undefined {
  return def.procs?.some((p) => running.has(p)) && def.procName ? text(def.procName) : undefined;
}

export interface Resolved {
  def: TargetDef;
  paths: string[];
  /** Loose files deleted outright. */
  files: string[];
  /** Only measured, for a target cleaned by a command. */
  measure: string[];
}

/** Everything that exists on this computer right now, with its real paths. */
export function resolveTargets(customs: { id: string; path: string }[], mounts: string[]): Resolved[] {
  const out: Resolved[] = [];
  const claimed = new Set<string>();
  const cacheDir = IS_WIN ? local() : IS_MAC ? path.join(home(), 'Library', 'Caches') : path.join(home(), '.cache');
  for (const def of CATALOG) {
    if (def.steps) {
      if (!availableStep(def)) continue;
      const measure = (def.measure ?? []).flatMap(expandGlob);
      if (IS_WIN && def.id === 'trash') measure.push(...windowsBins(mounts));
      out.push({ def, paths: [], files: [], measure });
      continue;
    }
    let paths = (def.paths ?? []).flatMap(expandGlob);
    if (def.id === 'trash' && OS === 'linux') {
      const uid = userInfo().uid;
      for (const m of mounts) {
        if (m === '/') continue;
        paths.push(...['files', 'info', 'expunged'].map((s) => path.join(m, `.Trash-${uid}`, s)).filter(existsSync));
      }
    }
    paths = [...new Set(paths)];
    for (const p of paths) {
      if (p.startsWith(cacheDir + path.sep)) claimed.add(p.slice(cacheDir.length + 1).split(path.sep)[0].toLowerCase());
    }
    if (paths.length) out.push({ def, paths, files: [], measure: [] });
  }

  // Whatever else sits in the general cache folder (Windows has none: every app picks its own).
  if (!IS_WIN) {
    try {
      const others = readdirSync(cacheDir, { withFileTypes: true }).filter((e) => !claimed.has(e.name.toLowerCase()) && !KEEP_IN_CACHE.test(e.name));
      const paths = others.filter((e) => e.isDirectory()).map((e) => path.join(cacheDir, e.name));
      const files = others.filter((e) => e.isFile()).map((e) => path.join(cacheDir, e.name));
      if (paths.length || files.length) {
        out.push({
          def: { id: 'othercaches', group: 'apps', label: { key: 't.othercaches' }, risk: 'review', on: false, hint: 'h.othercaches' },
          paths, files, measure: [],
        });
      }
    } catch {
      // No general cache folder on this account.
    }
  }

  for (const c of customs) {
    out.push({
      def: { id: c.id, group: 'custom', label: path.basename(c.path) || c.path, hint: { text: c.path }, risk: 'review', on: true },
      paths: existsSync(c.path) ? [c.path] : [],
      files: [],
      measure: [],
    });
  }
  return out;
}

let sid: string | null | undefined;

/** This account's part of the Recycle Bin on every disk (C:\$Recycle.Bin\S-1-5-…). */
function windowsBins(mounts: string[]): string[] {
  if (sid === undefined) {
    try {
      const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      sid = /"(S-1-[\d-]+)"/.exec(out)?.[1] ?? null;
    } catch {
      sid = null;
    }
  }
  if (!sid) return [];
  const mine = sid;
  return mounts.map((m) => path.join(m, '$Recycle.Bin', mine)).filter(existsSync);
}

export function toPublic(r: Resolved, selected: boolean, running: Set<string>): CleanTarget {
  return {
    id: r.def.id,
    group: r.def.group,
    label: labelOf(r.def),
    hint: typeof r.def.hint === 'string' ? tr(r.def.hint) : r.def.hint.text,
    risk: r.def.risk,
    needsPassword: !!r.def.needsPassword,
    blockedBy: blockedBy(r.def, running),
    selected,
    bytes: null,
    files: null,
    paths: [...r.paths, ...r.files],
  };
}
