import { app, BrowserWindow, clipboard, dialog, ipcMain, NativeImage, shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, parse, resolve, sep } from 'node:path';
import { isLang, Key, Lang } from '../shared/i18n';
import type {
  Artefact, CleanOutcome, DeleteItem, DeleteMode, DeleteOutcome, ItemCheck, ScanResult, TargetMeasure, ViewOptions,
} from '../shared/types';
import { ALLOWED_LINKS } from '../shared/about';
import { diskFree, listDisks, readMounts } from './disks';
import { Engine } from './engine';
import { setMainLang, tr } from './i18n';
import { refusal, SafetyContext, warning } from './safety';
import { blockedBy, home, labelOf, resolveTargets, Resolved, runningPrograms, toPublic } from './targets';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ----- Command line ---------------------------------------------------------------
const shotIndex = process.argv.indexOf('--screenshot');
const screenshotFile = shotIndex >= 0 ? process.argv[shotIndex + 1] : undefined;
if (shotIndex >= 0 && !screenshotFile) {
  console.error('--screenshot needs a file name.');
  process.exit(2);
}
if (screenshotFile) app.disableHardwareAcceleration();

// Started from the Finder, a Mac app only sees the bare system PATH: add where Homebrew and Docker live.
if (IS_MAC) {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/Docker.app/Contents/Resources/bin'];
  const have = (process.env.PATH ?? '').split(delimiter);
  process.env.PATH = [...have, ...extra.filter((d) => !have.includes(d))].join(delimiter);
}

// The engine has to be a real file on disk to run, outside any app archive.
const appRoot = app.getAppPath();
const unpacked = appRoot.replace(/app\.asar$/, 'app.asar.unpacked');
const engine = new Engine(join(unpacked, 'engine-bin', IS_WIN ? 'clairiere-engine.exe' : 'clairiere-engine'));
let win: BrowserWindow | null = null;

function emit(event: string, data: unknown) {
  win?.webContents.send('clairiere:event', event, data);
}

// ----- Saved settings -------------------------------------------------------------
interface Settings {
  /** Missing until the person picks one at the first start. */
  language?: Lang;
  overrides: Record<string, boolean>;
  customs: { id: string; path: string }[];
  totalFreed: number;
  lastCleanAt: number | null;
  lastFreed: number;
  autoClean: boolean;
}
const settingsFile = () => join(app.getPath('userData'), 'settings.json');
const defaults: Settings = { overrides: {}, customs: [], totalFreed: 0, lastCleanAt: null, lastFreed: 0, autoClean: false };
let settings: Settings = defaults;
function loadSettings() {
  try {
    settings = { ...defaults, ...JSON.parse(readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = { ...defaults };
  }
  if (!isLang(settings.language)) settings.language = undefined;
  if (settings.language) setMainLang(settings.language);
}
function saveSettings() {
  if (screenshotFile) return;
  mkdirSync(dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// ----- Safety ---------------------------------------------------------------------
const USUAL_NAMES = ['Documents', 'Images', 'Pictures', 'Musique', 'Music', 'Vidéos', 'Videos', 'Movies', 'Bureau', 'Desktop', 'Téléchargements', 'Downloads', 'OneDrive'];

function safety(): SafetyContext {
  const fromSystem = (['documents', 'pictures', 'music', 'videos', 'desktop', 'downloads'] as const).flatMap((n) => {
    try {
      return [app.getPath(n)];
    } catch {
      return [];
    }
  });
  return {
    platform: process.platform,
    home: home(),
    mounts: readMounts().map((m) => m.mount),
    appDirs: [appRoot, unpacked, app.getPath('userData'), ...(app.isPackaged ? [process.resourcesPath, dirname(process.execPath)] : [])],
    personal: [...new Set([...fromSystem, ...USUAL_NAMES.map((n) => join(home(), n))])],
    env: process.env,
  };
}

/** Windows and macOS ignore letter case in names. */
function sameOrInside(path: string, folder: string) {
  const a = IS_WIN || IS_MAC ? path.toLowerCase() : path;
  const b = IS_WIN || IS_MAC ? folder.toLowerCase() : folder;
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

const why = (key: Key | null) => (key ? tr(key) : undefined);

// ----- Scanning -------------------------------------------------------------------
let currentScan: number | null = null;

const ENGINE_ERRORS: Record<string, Key> = { not_a_folder: 'err.notFolder', no_scan: 'err.read', unknown_folder: 'err.read' };

async function scan(path: string): Promise<ScanResult> {
  let root = resolve(path);
  try {
    root = realpathSync(root);
  } catch {
    throw new Error(tr('err.noFolder'));
  }
  if (process.platform === 'linux' && /^\/(proc|sys|dev)(\/|$)/.test(root)) throw new Error(tr('err.virtual'));
  if (currentScan !== null) await engine.cancel(currentScan);
  const res = await engine.request(
    'scan',
    { path: root },
    (ev) => {
      if (ev.ev === 'progress') emit('scan:progress', ev);
    },
    (id) => {
      currentScan = id;
    },
  );
  currentScan = null;
  if (res.cancelled) throw new Error('cancelled');
  if (!res.ok) throw new Error(tr(ENGINE_ERRORS[res.error] ?? 'err.scanFailed'));
  const disks = await listDisks();
  const disk = disks.find((d) => d.mount === root || (IS_WIN && d.mount.toLowerCase() === root.toLowerCase()));
  // Virtual folders are skipped too, but only real disks are worth mentioning.
  const realMounts = new Set(disks.map((d) => d.mount));
  return {
    ...(res as unknown as ScanResult),
    artefacts: ownProjects(res.artefacts),
    skippedMounts: (res.skippedMounts as string[]).filter((m) => realMounts.has(m)),
    diskUsed: disk?.used,
  };
}

/**
 * Only projects in the home folder are offered: anywhere else they likely belong to an installed
 * program. The same goes for the folders where each system keeps applications' own files.
 */
function ownProjects(found: Artefact[] = []): Artefact[] {
  const appData = IS_WIN ? [join(home(), 'AppData')] : IS_MAC ? [join(home(), 'Library')] : [];
  return found.filter((a) => {
    if (a.path === home() || !sameOrInside(a.path, home())) return false;
    if (sameOrInside(a.path, appRoot)) return false;
    return !appData.some((d) => sameOrInside(a.path, d));
  });
}

// ----- Deleting -------------------------------------------------------------------
let currentDelete: number | null = null;

function checkItems(paths: string[]): ItemCheck[] {
  const ctx = safety();
  return paths.map((path) => ({
    path,
    refused: why(refusal(path, ctx)),
    warning: why(warning(path, ctx)),
  }));
}

/** The engine names a reason ("denied", "in_use"…); the person reads a sentence. */
function engineReason(code: unknown): string {
  const known: Record<string, Key> = { denied: 'why.denied', in_use: 'why.inUse', other_disk: 'why.otherDisk', refused: 'why.refused', failed: 'why.failed' };
  return typeof code === 'string' && known[code] ? tr(known[code]) : tr('err.resisted');
}

async function deleteItems(items: DeleteItem[], mode: DeleteMode): Promise<DeleteOutcome> {
  const ctx = safety();
  const outcome: DeleteOutcome = { mode, freed: 0, moved: 0, done: [], failed: [] };
  const allowed: DeleteItem[] = [];
  for (const item of items) {
    const refused = refusal(item.path, ctx);
    if (refused) outcome.failed.push({ path: item.path, reason: tr(refused) });
    else allowed.push(item);
  }
  const forget: DeleteItem[] = [];
  if (mode === 'trash') {
    for (const item of allowed) {
      try {
        await shell.trashItem(item.path);
        outcome.moved += item.size;
        outcome.done.push(item.path);
        forget.push(item);
      } catch {
        outcome.failed.push({ path: item.path, reason: tr('err.trash') });
      }
    }
  } else if (allowed.length) {
    const res = await engine.request(
      'delete',
      { paths: allowed.map((i) => i.path), keepRoot: false },
      (ev) => emit('delete:progress', ev),
      (id) => {
        currentDelete = id;
      },
    );
    currentDelete = null;
    outcome.freed = res.freed ?? 0;
    for (const r of res.results ?? []) {
      const item = allowed.find((i) => i.path === r.path)!;
      if (r.gone) {
        outcome.done.push(r.path);
        forget.push(item);
      } else {
        outcome.failed.push({ path: r.path, reason: engineReason(r.error ?? res.messages?.[0]?.why) });
      }
    }
  }
  if (forget.length) {
    const res = await engine.request('forget', { items: forget });
    if (res.bytes !== undefined) {
      outcome.summary = { bytes: res.bytes, files: res.files, dirs: res.dirs, topFiles: res.topFiles, artefacts: ownProjects(res.artefacts) };
    }
  }
  if (outcome.freed > 0) {
    settings.totalFreed += outcome.freed;
    saveSettings();
  }
  return outcome;
}

// ----- Cleaning -------------------------------------------------------------------
let resolvedCache: Resolved[] = [];

function resolveAll() {
  resolvedCache = resolveTargets(settings.customs, readMounts().map((m) => m.mount));
  return resolvedCache;
}

function isSelected(r: Resolved) {
  return settings.overrides[r.def.id] ?? r.def.on;
}

function cleanTargets() {
  const running = runningPrograms();
  return resolveAll().map((r) => toPublic(r, isSelected(r), running));
}

function runCommand(file: string, args: string[], timeout = 10 * 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((done) => {
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      done({ ok: !error, out: String(stdout), err: String(stderr) });
    });
  });
}

const UNIT: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

function parseHuman(text: string): number {
  const m = /([\d.]+)\s*([KMGT]?B?)/i.exec(text);
  return m ? parseFloat(m[1]) * (UNIT[m[2].toUpperCase() || 'B'] ?? 1) : 0;
}

async function measurePaths(paths: string[]): Promise<number | null> {
  if (!paths.length) return null;
  let bytes = 0;
  let any = false;
  await engine.request('measure', { paths }, (ev) => {
    if (ev.ev === 'measured') {
      bytes += ev.bytes;
      any = any || ev.exists;
    }
  });
  return any ? bytes : null;
}

/** Size a system command would give back, or null when the system won't say. */
async function measureCommand(r: Resolved): Promise<number | null> {
  const id = r.def.id;
  if (r.measure.length) return measurePaths(r.measure);
  if (id === 'apt') return measurePaths(['/var/cache/apt/archives']);
  if (id === 'journal') {
    const res = await runCommand('journalctl', ['--disk-usage'], 5000);
    const m = /take up ([\d.]+\s*[KMGT]?)/.exec(res.out + res.err);
    return m ? parseHuman(m[1]) : null;
  }
  if (id === 'docker') {
    const res = await runCommand('docker', ['system', 'df', '--format', '{{.Type}}\t{{.Reclaimable}}'], 5000);
    if (!res.ok) return null;
    return res.out.split(/\r?\n/).reduce((sum, line) => {
      const [type, value] = line.split('\t');
      return type === 'Images' || type === 'Build Cache' ? sum + parseHuman(value ?? '') : sum;
    }, 0);
  }
  return null;
}

/**
 * Sends each size as soon as it is known, and returns them all at the end: messages sent just
 * before the reply can reach the window after it, when nobody is listening any more.
 */
async function measureTargets(): Promise<TargetMeasure[]> {
  const targets = resolvedCache.length ? resolvedCache : resolveAll();
  const results: TargetMeasure[] = [];
  const report = (m: TargetMeasure) => {
    results.push(m);
    emit('clean:measure', m);
  };
  const owner = new Map<string, string>();
  const totals = new Map<string, { bytes: number; files: number; left: number }>();
  for (const t of targets) {
    if (t.def.steps) continue;
    const all = [...t.paths, ...t.files];
    totals.set(t.def.id, { bytes: 0, files: 0, left: all.length });
    if (!all.length) report({ id: t.def.id, bytes: 0, files: 0 });
    for (const p of all) owner.set(p, t.def.id);
  }
  const commands = targets.filter((t) => t.def.steps).map(async (t) => {
    const bytes = await measureCommand(t);
    report({ id: t.def.id, bytes: bytes ?? 0, files: null, unknown: bytes === null });
  });
  const paths = [...owner.keys()];
  if (paths.length) {
    await engine.request('measure', { paths }, (ev) => {
      if (ev.ev !== 'measured') return;
      const id = owner.get(ev.path)!;
      const total = totals.get(id)!;
      total.bytes += ev.bytes;
      total.files += ev.files;
      total.left -= 1;
      if (total.left === 0) report({ id, bytes: total.bytes, files: total.files });
    });
  }
  await Promise.all(commands);
  return results;
}

let cancelCleanRequested = false;

/** The disk a system command frees space on: the one holding the home folder. */
const commandDisk = () => (IS_WIN ? parse(home()).root : '/');

async function cleanRun(ids: string[]): Promise<CleanOutcome> {
  const started = Date.now();
  cancelCleanRequested = false;
  const targets = resolveAll().filter((t) => ids.includes(t.def.id));
  const running = runningPrograms();
  const ctx = safety();
  const outcome: CleanOutcome = { freed: 0, ms: 0, cancelled: false, results: [] };
  let index = 0;
  for (const t of targets) {
    if (cancelCleanRequested) {
      outcome.cancelled = true;
      break;
    }
    index += 1;
    const label = labelOf(t.def);
    const notify = (freed: number) =>
      emit('clean:progress', { targetId: t.def.id, label, freed: outcome.freed + freed, index, count: targets.length });
    notify(0);
    const blocker = blockedBy(t.def, running);
    if (blocker) {
      outcome.results.push({ id: t.def.id, label, freed: 0, note: tr('note.skipped', { name: blocker }) });
      continue;
    }
    let freed = 0;
    let note: string | undefined;
    if (t.def.steps) {
      const before = await diskFree(commandDisk());
      for (const step of t.def.steps) {
        const r = await runCommand(step.file, step.args);
        if (!r.ok) {
          note = /dismissed|not authorized/i.test(r.err) ? tr('note.password') : tr('note.command');
          break;
        }
      }
      freed = Math.max(0, (await diskFree(commandDisk())) - before);
    } else {
      // Folders are only emptied: the folder itself stays for the program that uses it.
      const safe = t.paths.filter((p) => !refusal(p, ctx, true));
      const safeFiles = t.files.filter((p) => !refusal(p, ctx));
      const onEvent = (ev: Record<string, number | string>) => {
        if (ev.ev === 'deleting') notify(freed + Number(ev.freed));
      };
      const remember = (id: number) => {
        currentDelete = id;
      };
      let errors = 0;
      if (safe.length) {
        const r = await engine.request('delete', { paths: safe, keepRoot: true }, onEvent, remember);
        freed += r.freed ?? 0;
        errors += r.errors ?? 0;
      }
      if (safeFiles.length) {
        const r = await engine.request('delete', { paths: safeFiles, keepRoot: false }, onEvent, remember);
        freed += r.freed ?? 0;
        errors += r.errors ?? 0;
      }
      currentDelete = null;
      if (errors > 0) note = tr('note.notRemoved', { n: errors });
    }
    outcome.freed += freed;
    outcome.results.push({ id: t.def.id, label, freed, note });
    notify(0);
  }
  outcome.ms = Date.now() - started;
  outcome.cancelled = outcome.cancelled || cancelCleanRequested;
  if (outcome.freed > 0 || outcome.results.some((r) => !r.note)) {
    settings.totalFreed += outcome.freed;
    settings.lastCleanAt = Date.now();
    settings.lastFreed = outcome.freed;
    saveSettings();
  }
  return outcome;
}

async function findProjects(): Promise<Artefact[]> {
  const res = await engine.request('scan', { path: home(), keep: false });
  return res.ok ? ownProjects(res.artefacts) : [];
}

// ----- Launcher (Linux: an entry in the applications menu) ------------------------
const desktopFile = () => join(home(), '.local', 'share', 'applications', 'clairiere.desktop');

function installLauncher() {
  if (process.platform !== 'linux') return;
  const file = desktopFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Clairière',
    `Comment=${tr('home.lead')}`,
    `Exec="${join(appRoot, 'clairiere')}"`,
    `Icon=${join(appRoot, 'dist', 'icon.svg')}`,
    'Terminal=false',
    'Categories=System;Utility;',
    '',
  ].join('\n'));
}

function launcherInstalled() {
  // Installed on Windows and macOS, the app always comes with its own shortcut.
  // (app.isPackaged can't tell on Linux: the development copy runs under a renamed Electron too.)
  if (process.platform !== 'linux') return true;
  return basename(process.execPath) === 'clairiere' || existsSync(desktopFile());
}

// ----- Window ---------------------------------------------------------------------
const handlers: Record<string, (...args: never[]) => unknown> = {
  platform: () => process.platform,
  getLanguage: () => settings.language ?? null,
  setLanguage: (lang: string) => {
    if (!isLang(lang)) return;
    settings.language = lang;
    setMainLang(lang);
    saveSettings();
  },
  openDiskAccessSettings: async () => {
    if (IS_MAC) await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  },
  home: () => home(),
  disks: () => listDisks(),
  scan: (path: string) => scan(path),
  cancelScan: async () => {
    if (currentScan !== null) await engine.cancel(currentScan);
  },
  view: async (node: number, options: ViewOptions) => {
    const res = await engine.request('view', { node, ...options });
    if (!res.ok) throw new Error(tr(ENGINE_ERRORS[res.error] ?? 'err.read'));
    return res;
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: tr('dialog.pickFolder'), defaultPath: home() });
    return r.canceled ? null : r.filePaths[0];
  },
  checkItems: (paths: string[]) => checkItems(paths),
  deleteItems: (items: DeleteItem[], mode: DeleteMode) => deleteItems(items, mode),
  open: async (path: string) => {
    await shell.openPath(path);
  },
  reveal: (path: string) => shell.showItemInFolder(path),
  copyPath: (path: string) => clipboard.writeText(path),
  cleanTargets: () => cleanTargets(),
  measureTargets: () => measureTargets(),
  setTargetSelected: (id: string, selected: boolean) => {
    settings.overrides[id] = selected;
    saveSettings();
  },
  cleanRun: (ids: string[]) => cleanRun(ids),
  cancelClean: async () => {
    cancelCleanRequested = true;
    if (currentDelete !== null) await engine.cancel(currentDelete);
  },
  addCustomTarget: (path: string) => {
    const refused = refusal(path, safety());
    if (refused) return tr(refused);
    if (!settings.customs.some((c) => c.path === path)) {
      settings.customs.push({ id: `custom:${Date.now()}`, path });
      saveSettings();
    }
    return null;
  },
  removeCustomTarget: (id: string) => {
    settings.customs = settings.customs.filter((c) => c.id !== id);
    delete settings.overrides[id];
    saveSettings();
  },
  stats: () => ({
    totalFreed: settings.totalFreed, lastCleanAt: settings.lastCleanAt, lastFreed: settings.lastFreed, autoClean: settings.autoClean,
  }),
  setAutoClean: (on: boolean) => {
    settings.autoClean = on;
    saveSettings();
  },
  runAutoClean: async () => {
    if (!settings.autoClean || screenshotFile) return null;
    // Only what rebuilds itself: never the bin, your own folders, or anything asking a password.
    const ids = resolveAll().filter((r) => isSelected(r) && r.def.risk === 'safe' && !r.def.steps).map((r) => r.def.id);
    return cleanRun(ids);
  },
  findProjects: () => findProjects(),
  launcherInstalled: () => launcherInstalled(),
  installLauncher: () => installLauncher(),
  openLink: async (url: string) => {
    if (!ALLOWED_LINKS.includes(url)) throw new Error(tr('err.link'));
    await shell.openExternal(url);
  },
};

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(`clairiere:${name}`, (_, ...args) => (fn as (...a: unknown[]) => unknown)(...args));
}

// A frame normally comes from the display; the timer keeps counting if the system stops asking for them.
const COUNT_FRAMES = `new Promise((done) => {
  let n = 0;
  const step = () => {
    let fired = false;
    const go = () => {
      if (fired) return;
      fired = true;
      clearTimeout(timer);
      if (++n >= 120) done(n);
      else step();
    };
    const timer = setTimeout(go, 100);
    requestAnimationFrame(go);
  };
  step();
})`;

async function takeScreenshot(file: string) {
  const target = resolve(file);
  const fail = setTimeout(() => {
    console.error('Screenshot timed out.');
    app.exit(1);
  }, 60_000);
  try {
    let lastPainted: NativeImage | null = null;
    win!.webContents.on('paint', (_event, _dirty, image) => {
      lastPainted = image;
    });
    win!.webContents.setFrameRate(60);
    await win!.webContents.executeJavaScript(COUNT_FRAMES, true);
    let image = await win!.webContents.capturePage();
    if (image.isEmpty() && lastPainted) image = lastPainted;
    if (image.isEmpty()) throw new Error('The window drew nothing.');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, image.toPNG());
    clearTimeout(fail);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#141613',
    title: 'Clairière',
    icon: join(appRoot, 'dist', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The picture must not depend on the window being visible, focused or on top: an offscreen
      // window is never shown, so a check never steals focus or covers what the person is doing,
      // on Windows, macOS and Linux alike, and it keeps drawing whatever happens on screen.
      offscreen: !!screenshotFile,
      backgroundThrottling: !screenshotFile,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (!screenshotFile) win.once('ready-to-show', () => win?.show());
  if (screenshotFile) win.webContents.once('did-finish-load', () => void takeScreenshot(screenshotFile));
  void win.loadFile(join(appRoot, 'dist', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

if (!screenshotFile && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  void app.whenReady().then(() => {
    loadSettings();
    createWindow();
  });
  app.on('activate', () => {
    if (!win && app.isReady()) createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => engine.stop());
}
