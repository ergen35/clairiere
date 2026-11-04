import { app, BrowserWindow, clipboard, dialog, ipcMain, NativeImage, shell } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  Artefact, CleanOutcome, DeleteItem, DeleteMode, DeleteOutcome, DiskInfo, ItemCheck, ScanResult, TargetMeasure, ViewOptions,
} from '../shared/types';
import { ALLOWED_LINKS } from '../shared/about';
import { Engine } from './engine';
import { refusal, SafetyContext, warning } from './safety';
import { blockedBy, home, resolveTargets, Resolved, runningPrograms, toPublic } from './targets';

// ----- Command line ---------------------------------------------------------------
const shotIndex = process.argv.indexOf('--screenshot');
const screenshotFile = shotIndex >= 0 ? process.argv[shotIndex + 1] : undefined;
if (shotIndex >= 0 && !screenshotFile) {
  console.error('--screenshot needs a file name.');
  process.exit(2);
}
if (screenshotFile) app.disableHardwareAcceleration();

const appRoot = app.getAppPath();
const engine = new Engine(join(appRoot, 'engine-bin', 'clairiere-engine'));
let win: BrowserWindow | null = null;

function emit(event: string, data: unknown) {
  win?.webContents.send('clairiere:event', event, data);
}

// ----- Saved settings -------------------------------------------------------------
interface Settings {
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
}
function saveSettings() {
  if (screenshotFile) return;
  mkdirSync(dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// ----- Disks ----------------------------------------------------------------------
const NETWORK_FS = /^(nfs|nfs4|cifs|smb3|sshfs|fuse\.sshfs|9p)$/;

function unescapeMount(s: string) {
  return s.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function readMounts(): { mount: string; device: string; fstype: string }[] {
  const out = new Map<string, { mount: string; device: string; fstype: string }>();
  let text = '';
  try {
    text = readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return [];
  }
  for (const line of text.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const a = left.split(' ');
    const [fstype, device] = right.split(' ');
    const mount = unescapeMount(a[4]);
    if (!device.startsWith('/dev/') || device.startsWith('/dev/loop') || fstype === 'squashfs' || NETWORK_FS.test(fstype)) continue;
    if (a[3] !== '/' && fstype !== 'btrfs') continue; // A folder bound elsewhere, not a disk.
    const seen = out.get(device);
    if (!seen || mount.length < seen.mount.length) out.set(device, { mount, device, fstype });
  }
  return [...out.values()];
}

interface BlockInfo {
  path: string;
  label: string | null;
  model: string | null;
  children?: BlockInfo[];
}

function blockDevices(): Map<string, { label: string | null; model: string | null }> {
  const out = new Map<string, { label: string | null; model: string | null }>();
  try {
    const raw = execFileSync('lsblk', ['-J', '-o', 'PATH,LABEL,MODEL'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    const walk = (list: BlockInfo[], model: string | null) => {
      for (const b of list) {
        const m = b.model ?? model;
        out.set(b.path, { label: b.label, model: m });
        if (b.children) walk(b.children, m);
      }
    };
    walk(JSON.parse(raw).blockdevices ?? [], null);
  } catch {
    // Friendly names are a nicety: fall back to the mount point.
  }
  return out;
}

async function listDisks(): Promise<DiskInfo[]> {
  const block = blockDevices();
  const disks: DiskInfo[] = [];
  for (const m of readMounts()) {
    try {
      const s = await statfs(m.mount);
      const total = s.blocks * s.bsize;
      if (total === 0) continue;
      const free = s.bavail * s.bsize;
      const used = (s.blocks - s.bfree) * s.bsize;
      const info = block.get(m.device);
      const system = m.mount === '/';
      const tail = m.mount.split('/').pop() || m.mount;
      const label = info?.label || (system ? 'Disque système' : m.mount === '/boot/efi' || m.mount === '/boot' ? 'Démarrage' : tail);
      disks.push({
        id: m.device, device: m.device, mount: m.mount, fstype: m.fstype, label,
        detail: info?.model?.trim() || m.device, total, used, free, system,
      });
    } catch {
      // Disk went away while listing it.
    }
  }
  return disks.sort((a, b) => Number(b.system) - Number(a.system) || b.total - a.total);
}

function safety(): SafetyContext {
  const fromSystem = (['documents', 'pictures', 'music', 'videos', 'desktop', 'downloads'] as const).flatMap((n) => {
    try {
      return [app.getPath(n)];
    } catch {
      return [];
    }
  });
  const usualNames = ['Documents', 'Images', 'Pictures', 'Musique', 'Music', 'Vidéos', 'Videos', 'Bureau', 'Desktop', 'Téléchargements', 'Downloads'];
  return {
    home: home(),
    mounts: readMounts().map((m) => m.mount),
    appDirs: [appRoot, app.getPath('userData')],
    personal: [...new Set([...fromSystem, ...usualNames.map((n) => join(home(), n))])],
  };
}

// ----- Scanning -------------------------------------------------------------------
let currentScan: number | null = null;

async function scan(path: string): Promise<ScanResult> {
  let root = resolve(path);
  try {
    root = realpathSync(root);
  } catch {
    throw new Error("Ce dossier n'existe pas.");
  }
  if (/^\/(proc|sys|dev)(\/|$)/.test(root)) throw new Error('Ce dossier est virtuel : il ne prend aucune place sur le disque.');
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
  if (!res.ok) throw new Error(res.error ?? "L'analyse a échoué.");
  const disks = await listDisks();
  const disk = disks.find((d) => d.mount === root);
  // /proc, /run and the like are skipped too, but only real disks are worth mentioning.
  const realMounts = new Set(disks.map((d) => d.mount));
  return {
    ...(res as unknown as ScanResult),
    artefacts: ownProjects(res.artefacts),
    skippedMounts: (res.skippedMounts as string[]).filter((m) => realMounts.has(m)),
    diskUsed: disk?.used,
  };
}

/** Only projects in the home folder are offered: anywhere else they likely belong to an installed program. */
function ownProjects(found: Artefact[] = []): Artefact[] {
  return found.filter((a) => a.path.startsWith(`${home()}/`) && !a.path.startsWith(`${appRoot}/`));
}

// ----- Deleting -------------------------------------------------------------------
let currentDelete: number | null = null;

function checkItems(paths: string[]): ItemCheck[] {
  const ctx = safety();
  return paths.map((path) => ({
    path,
    refused: refusal(path, ctx) ?? undefined,
    warning: warning(path, ctx) ?? undefined,
  }));
}

async function deleteItems(items: DeleteItem[], mode: DeleteMode): Promise<DeleteOutcome> {
  const ctx = safety();
  const outcome: DeleteOutcome = { mode, freed: 0, moved: 0, done: [], failed: [] };
  const allowed: DeleteItem[] = [];
  for (const item of items) {
    const why = refusal(item.path, ctx);
    if (why) outcome.failed.push({ path: item.path, reason: why });
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
        outcome.failed.push({ path: item.path, reason: "La corbeille n'est pas disponible ici. Essayez la suppression définitive." });
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
        outcome.failed.push({ path: r.path, reason: r.error ?? res.messages?.[0] ?? 'Certains fichiers ont résisté (accès refusé).' });
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
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ ok: !error, out: String(stdout), err: String(stderr) });
    });
  });
}

const UNIT: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

function parseHuman(text: string): number {
  const m = /([\d.]+)\s*([KMGT]?B?)/i.exec(text);
  return m ? parseFloat(m[1]) * (UNIT[m[2].toUpperCase() || 'B'] ?? 1) : 0;
}

/** Size a system command would give back, or null when the system won't say. */
async function measureCommand(id: string): Promise<number | null> {
  if (id === 'apt') {
    let bytes: number | null = null;
    await engine.request('measure', { paths: ['/var/cache/apt/archives'] }, (ev) => {
      if (ev.ev === 'measured') bytes = ev.bytes;
    });
    return bytes;
  }
  if (id === 'journal') {
    const r = await runCommand('journalctl', ['--disk-usage'], 5000);
    const m = /take up ([\d.]+\s*[KMGT]?)/.exec(r.out + r.err);
    return m ? parseHuman(m[1]) : null;
  }
  if (id === 'docker') {
    const r = await runCommand('docker', ['system', 'df', '--format', '{{.Type}}\t{{.Reclaimable}}'], 5000);
    if (!r.ok) return null;
    return r.out.split('\n').reduce((sum, line) => {
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
    const bytes = await measureCommand(t.def.id);
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

async function diskFree(path: string) {
  try {
    const s = await statfs(path);
    return s.bavail * s.bsize;
  } catch {
    return 0;
  }
}

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
    const notify = (freed: number) =>
      emit('clean:progress', { targetId: t.def.id, label: t.def.label, freed: outcome.freed + freed, index, count: targets.length });
    notify(0);
    const blocker = blockedBy(t.def, running);
    if (blocker) {
      outcome.results.push({ id: t.def.id, label: t.def.label, freed: 0, note: `Ignoré : ${blocker} est ouvert.` });
      continue;
    }
    let freed = 0;
    let note: string | undefined;
    if (t.def.steps) {
      const before = await diskFree('/');
      for (const step of t.def.steps) {
        const r = await runCommand(step.file, step.args);
        if (!r.ok) {
          note = /dismissed|not authorized/i.test(r.err) ? 'Mot de passe refusé ou annulé.' : 'La commande a échoué.';
          break;
        }
      }
      freed = Math.max(0, (await diskFree('/')) - before);
    } else {
      const safe = t.paths.filter((p) => !refusal(p, ctx));
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
      if (errors > 0) note = `${errors} élément${errors > 1 ? 's' : ''} n'ont pas pu être retirés.`;
    }
    outcome.freed += freed;
    outcome.results.push({ id: t.def.id, label: t.def.label, freed, note });
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

// ----- Launcher -------------------------------------------------------------------
const desktopFile = () => join(home(), '.local', 'share', 'applications', 'clairiere.desktop');

function installLauncher() {
  const file = desktopFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Clairière',
    'Comment=Analyser les disques et libérer de la place',
    `Exec="${join(appRoot, 'clairiere')}"`,
    `Icon=${join(appRoot, 'dist', 'icon.svg')}`,
    'Terminal=false',
    'Categories=System;Utility;',
    '',
  ].join('\n'));
}

// ----- Window ---------------------------------------------------------------------
const handlers: Record<string, (...args: never[]) => unknown> = {
  home: () => home(),
  disks: () => listDisks(),
  scan: (path: string) => scan(path),
  cancelScan: async () => {
    if (currentScan !== null) await engine.cancel(currentScan);
  },
  view: async (node: number, options: ViewOptions) => {
    const res = await engine.request('view', { node, ...options });
    if (!res.ok) throw new Error(res.error ?? 'Lecture impossible.');
    return res;
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Choisir un dossier', defaultPath: home() });
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
    const why = refusal(path, safety());
    if (why) return why;
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
  // The installed package brings its own entry in the applications menu.
  // (app.isPackaged can't tell: the development copy runs under a renamed Electron too.)
  launcherInstalled: () => basename(process.execPath) === 'clairiere' || existsSync(desktopFile()),
  installLauncher: () => installLauncher(),
  openLink: async (url: string) => {
    if (!ALLOWED_LINKS.includes(url)) throw new Error('Adresse non autorisée.');
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
      // A picture must not depend on the window being visible: another window, a locked screen
      // or a different workspace would otherwise stop the drawing.
      offscreen: !!screenshotFile,
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
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => engine.stop());
}
