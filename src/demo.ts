// Sample data so the interface can be seen in a plain browser, which may not read disks.
import type { Api, Artefact, CleanTarget, DiskInfo, ScanResult, TopFile, TreeNode, ViewResult } from '../shared/types';

const GB = 1e9;
const MB = 1e6;

interface Sample {
  name: string;
  size?: number;
  items?: Sample[];
}

const SAMPLE: Sample = {
  name: 'demo',
  items: [
    { name: 'Vidéos', items: [{ name: 'Vacances 2025', items: [{ name: 'plage.mov', size: 9.4 * GB }, { name: 'montagne.mov', size: 6.1 * GB }, { name: 'ville.mp4', size: 2.2 * GB }] }, { name: 'Tournage', items: [{ name: 'rush-01.mov', size: 7.8 * GB }, { name: 'rush-02.mov', size: 5.2 * GB }] }, { name: 'film-famille.mkv', size: 4.1 * GB }] },
    { name: '.cache', items: [{ name: 'google-chrome', size: 4.8 * GB }, { name: 'pip', size: 1.9 * GB }, { name: 'thumbnails', size: 820 * MB }, { name: 'yarn', size: 1.4 * GB }, { name: 'spotify', size: 1.1 * GB }] },
    { name: 'Projets', items: [{ name: 'site-web', items: [{ name: 'node_modules', size: 2.6 * GB }, { name: 'src', size: 48 * MB }, { name: 'dist', size: 210 * MB }] }, { name: 'application', items: [{ name: 'target', size: 6.2 * GB }, { name: 'src', size: 12 * MB }] }, { name: 'analyse-donnees', items: [{ name: '.venv', size: 1.7 * GB }, { name: 'mesures.csv', size: 3.3 * GB }] }] },
    { name: 'Images', items: [{ name: 'Photos 2024', size: 8.3 * GB }, { name: 'Photos 2025', size: 11.6 * GB }, { name: 'Captures', size: 640 * MB }] },
    { name: 'Téléchargements', items: [{ name: 'ubuntu-26.04.iso', size: 6.3 * GB }, { name: 'archive-projet.zip', size: 2.4 * GB }, { name: 'installateur.deb', size: 310 * MB }, { name: 'facture.pdf', size: 1.2 * MB }] },
    { name: 'Musique', items: [{ name: 'Albums', size: 7.9 * GB }, { name: 'Podcasts', size: 2.1 * GB }] },
    { name: 'Documents', items: [{ name: 'Comptabilité', size: 900 * MB }, { name: 'Présentations', size: 3.1 * GB }, { name: 'notes.txt', size: 40_000 }] },
    { name: '.local', items: [{ name: 'share', size: 5.2 * GB }, { name: 'state', size: 120 * MB }] },
    { name: 'Bureau', size: 1.1 * GB },
    { name: 'Modèles', size: 240 * MB },
  ],
};

interface Live {
  id: number;
  name: string;
  size: number;
  isDir: boolean;
  parent: Live | null;
  items: Live[];
  mtime: number;
  files: number;
}

const ROOT = '/home/demo';
let nextId = 0;
const byId = new Map<number, Live>();

function build(sample: Sample, parent: Live | null, seed: number): Live {
  const isDir = !!sample.items || (sample.size ?? 0) > 500 * MB && !sample.name.includes('.');
  const node: Live = {
    id: nextId++,
    name: sample.name,
    size: sample.size ?? 0,
    isDir,
    parent,
    items: [],
    mtime: Math.floor(Date.now() / 1000) - ((seed * 7919) % 400) * 86400,
    files: isDir ? Math.round((sample.size ?? 0) / 90_000) : 1,
  };
  byId.set(node.id, node);
  (sample.items ?? []).forEach((s, i) => node.items.push(build(s, node, seed + i + 1)));
  if (sample.items) {
    node.size = node.items.reduce((sum, c) => sum + c.size, 0);
    node.files = node.items.reduce((sum, c) => sum + c.files, 0);
  }
  return node;
}

let tree: Live = build(SAMPLE, null, 1);

function pathOf(n: Live): string {
  const parts: string[] = [];
  for (let c: Live | null = n; c && c.parent; c = c.parent) parts.unshift(c.name);
  return [ROOT, ...parts].join('/');
}

function toNode(n: Live, depth: number, min: number): TreeNode {
  if (!n.isDir) return { name: n.name, kind: 'file', size: n.size, mtime: n.mtime };
  const out: TreeNode = {
    id: n.id, name: n.parent ? n.name : ROOT, kind: 'dir', size: n.size, files: n.files,
    dirs: n.items.filter((i) => i.isDir).length, mtime: n.mtime, hasChildren: n.items.length > 0,
  };
  if (depth > 0) {
    const sorted = [...n.items].sort((a, b) => b.size - a.size);
    const kept = sorted.filter((c) => c.size >= min);
    out.children = kept.map((c) => toNode(c, depth - 1, min));
    const dropped = sorted.length - kept.length;
    if (dropped > 0) {
      const rest = sorted.filter((c) => c.size < min).reduce((s, c) => s + c.size, 0);
      out.children.push({ name: '', kind: 'other', count: dropped, size: rest });
    }
  }
  return out;
}

function locate(path: string): Live | null {
  if (!path.startsWith(ROOT)) return null;
  let cur: Live | undefined = tree;
  for (const part of path.slice(ROOT.length).split('/').filter(Boolean)) {
    cur = cur?.items.find((i) => i.name === part);
  }
  return cur ?? null;
}

function allFiles(): TopFile[] {
  const out: TopFile[] = [];
  const walk = (n: Live) => {
    if (!n.isDir) out.push({ path: pathOf(n), size: n.size, mtime: n.mtime, lossy: false });
    n.items.forEach(walk);
  };
  walk(tree);
  return out.sort((a, b) => b.size - a.size);
}

function artefacts(): Artefact[] {
  const known: [string, Artefact['kind']][] = [['Projets/application/target', 'rust'], ['Projets/site-web/node_modules', 'node'], ['Projets/analyse-donnees/.venv', 'python']];
  const out: Artefact[] = [];
  for (const [rel, kind] of known) {
    const n = locate(`${ROOT}/${rel}`);
    if (n) out.push({ id: n.id, path: pathOf(n), kind, bytes: n.size, files: n.files, mtime: n.mtime, lossy: false });
  }
  return out;
}

function summary() {
  return { bytes: tree.size, files: tree.files, dirs: byId.size, topFiles: allFiles(), artefacts: artefacts() };
}

const TOTAL_DISK = 512 * GB;
let freedOnDisk = 0;
const disks = (): DiskInfo[] => [
  {
    id: 'demo-1', device: '/dev/demo1', mount: '/', fstype: 'ext4', label: 'Disque système', detail: 'Disque interne',
    total: TOTAL_DISK, used: 455 * GB - freedOnDisk, free: TOTAL_DISK - (455 * GB - freedOnDisk), system: true,
  },
  {
    id: 'demo-2', device: '/dev/demo2', mount: '/media/sauvegardes', fstype: 'ext4', label: 'Sauvegardes', detail: 'Disque externe',
    total: 2000 * GB, used: 830 * GB, free: 1170 * GB, system: false,
  },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type DemoTarget = CleanTarget & { real: number };

function target(id: string, group: CleanTarget['group'], label: string, hint: string, bytes: number, risk: 'safe' | 'review' = 'safe', extra: Partial<CleanTarget> = {}): DemoTarget {
  return {
    id, group, label, hint, risk, needsPassword: false, selected: risk === 'safe', bytes: null, files: null, paths: [`~/.cache/${id}`], real: bytes, ...extra,
  };
}

let targets: DemoTarget[] = [
  target('trash', 'quick', 'Corbeille', 'Ce que vous avez déjà jeté. Vider la corbeille rend enfin la place au disque, sans retour possible.', 3.4 * GB, 'review'),
  target('thumbnails', 'quick', 'Miniatures', 'Aperçus de photos et vidéos : ils se recréent quand vous rouvrez un dossier.', 820 * MB),
  target('chrome', 'browsers', 'Google Chrome', 'Pages et images gardées pour aller plus vite. Vos favoris, mots de passe et sessions ne sont pas touchés.', 4.8 * GB),
  target('firefox', 'browsers', 'Firefox', 'Pages et images gardées pour aller plus vite. Vos favoris, mots de passe et sessions ne sont pas touchés.', 1.2 * GB, 'safe', { blockedBy: 'Firefox' }),
  target('spotify', 'apps', 'Spotify', 'Musique gardée pour la réécoute. Les titres téléchargés hors ligne peuvent être à recharger.', 1.1 * GB),
  target('othercaches', 'apps', "Autres caches d'applications", 'Tout le reste du dossier de cache. Sans danger pour vos fichiers, mais une application ouverte peut devoir redémarrer.', 2.3 * GB, 'review'),
  target('npm', 'dev', 'npm', 'Paquets téléchargés : ils reviennent tout seuls à la prochaine installation.', 3.1 * GB),
  target('pip', 'dev', 'pip', 'Paquets téléchargés : ils reviennent tout seuls à la prochaine installation.', 1.9 * GB),
  target('apt', 'system', 'Paquets Ubuntu téléchargés', 'Installateurs déjà utilisés : le système les retélécharge si besoin.', 1.4 * GB, 'safe', { needsPassword: true, selected: false }),
  target('docker', 'system', 'Docker : images et cache inutilisés', 'Retire les images qu’aucun conteneur n’utilise et le cache de construction. Elles seront à retélécharger.', 11.2 * GB, 'review'),
];

let stats = { totalFreed: 0, lastCleanAt: null as number | null, lastFreed: 0, autoClean: false };
let customId = 0;

export function demoApi(): Api {
  return {
    isDemo: true,
    home: async () => ROOT,
    disks: async () => disks(),
    scan: async (path, onProgress) => {
      nextId = 0;
      byId.clear();
      tree = build(SAMPLE, null, 1);
      const top = [...tree.items].sort((a, b) => b.size - a.size);
      const started = performance.now();
      const steps = 16;
      for (let i = 1; i <= steps; i += 1) {
        const f = i / steps;
        onProgress({
          files: Math.round(tree.files * f), dirs: Math.round(byId.size * f), bytes: tree.size * f, errors: 0,
          ms: performance.now() - started, current: `${ROOT}/${top[i % top.length].name}`,
          top: top.map((t) => ({ name: t.name, bytes: t.size * f })),
        });
        await wait(35);
      }
      const result: ScanResult = {
        root: path === '/' ? ROOT : ROOT, ...summary(), errors: 0, ms: performance.now() - started, denied: [], skippedMounts: [],
      };
      return result;
    },
    cancelScan: async () => {},
    view: async (nodeId, options): Promise<ViewResult> => {
      const n = byId.get(nodeId) ?? tree;
      const ancestors: { id: number; name: string }[] = [];
      for (let c = n.parent; c; c = c.parent) ancestors.unshift({ id: c.id, name: c.parent ? c.name : ROOT });
      return { path: pathOf(n), pathLossy: false, ancestors, node: toNode(n, options.depth, options.minBytes ?? 0) };
    },
    pickFolder: async () => ROOT,
    checkItems: async (paths) => paths.map((path) => ({ path })),
    deleteItems: async (items, mode) => {
      let freed = 0;
      for (const item of items) {
        const n = locate(item.path);
        if (!n?.parent) continue;
        freed += n.size;
        n.parent.items = n.parent.items.filter((c) => c !== n);
        for (let c: Live | null = n.parent; c; c = c.parent) {
          c.size -= n.size;
          c.files -= n.files;
        }
      }
      if (mode === 'permanent') freedOnDisk += freed;
      return {
        mode, freed: mode === 'permanent' ? freed : 0, moved: mode === 'trash' ? freed : 0,
        done: items.map((i) => i.path), failed: [], summary: summary(),
      };
    },
    open: async () => {},
    reveal: async () => {},
    copyPath: async (path) => {
      await navigator.clipboard?.writeText(path).catch(() => {});
    },
    cleanTargets: async () => targets.map((t) => ({ ...t })),
    measureTargets: async (onMeasure) => {
      for (const t of targets) {
        await wait(25);
        t.bytes = t.real;
        onMeasure({ id: t.id, bytes: t.real, files: Math.round(t.real / 80_000) });
      }
    },
    setTargetSelected: async (id, selected) => {
      targets = targets.map((t) => (t.id === id ? { ...t, selected } : t));
    },
    cleanRun: async (ids, onProgress) => {
      let freed = 0;
      const results = [];
      let index = 0;
      const started = performance.now();
      for (const t of targets.filter((x) => ids.includes(x.id))) {
        index += 1;
        onProgress({ targetId: t.id, label: t.label, freed, index, count: ids.length });
        await wait(120);
        if (t.blockedBy) {
          results.push({ id: t.id, label: t.label, freed: 0, note: `Ignoré : ${t.blockedBy} est ouvert.` });
          continue;
        }
        freed += t.real;
        results.push({ id: t.id, label: t.label, freed: t.real });
        t.real = 0;
      }
      freedOnDisk += freed;
      stats = { ...stats, totalFreed: stats.totalFreed + freed, lastCleanAt: Date.now(), lastFreed: freed };
      return { freed, ms: performance.now() - started, cancelled: false, results };
    },
    cancelClean: async () => {},
    addCustomTarget: async (path) => {
      customId += 1;
      targets.push(target(`custom:${customId}`, 'custom', path.split('/').pop() || path, path, 600 * MB, 'review', { selected: true }));
      return null;
    },
    removeCustomTarget: async (id) => {
      targets = targets.filter((t) => t.id !== id);
    },
    stats: async () => ({ ...stats }),
    setAutoClean: async (on) => {
      stats.autoClean = on;
    },
    runAutoClean: async () => null,
    findProjects: async () => artefacts(),
    launcherInstalled: async () => true,
    installLauncher: async () => {},
    openLink: async (url) => {
      window.open(url, '_blank', 'noopener');
    },
  };
}
