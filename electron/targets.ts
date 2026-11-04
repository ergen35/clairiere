import { readdirSync, lstatSync, existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { CleanTarget, TargetGroup } from '../shared/types';

export interface CommandStep {
  file: string;
  args: string[];
}

export interface TargetDef {
  id: string;
  group: TargetGroup;
  label: string;
  hint: string;
  risk: 'safe' | 'review';
  on: boolean;
  /** Folders whose content is emptied. Accepts * in a path segment. */
  paths?: string[];
  /** Programs whose cache is in use while they run. */
  procs?: string[];
  procName?: string;
  /** A fixed system command instead of deleting folders. */
  steps?: CommandStep[];
  needsPassword?: boolean;
}

const CHROMIUM_INNER = ['Cache', 'Code Cache', 'GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache'];
const CHROMIUM_ROOT = ['GrShaderCache', 'ShaderCache', 'GraphiteDawnCache'];

function chromium(id: string, label: string, dir: string, procs: string[], flatpak?: string): TargetDef {
  return {
    id, group: 'browsers', label, risk: 'safe', on: true, procs, procName: label,
    hint: 'Pages et images gardées pour aller plus vite. Vos favoris, mots de passe et sessions ne sont pas touchés.',
    paths: [
      `~/.cache/${dir}`,
      ...CHROMIUM_INNER.map((c) => `~/.config/${dir}/*/${c}`),
      ...CHROMIUM_ROOT.map((c) => `~/.config/${dir}/${c}`),
      ...(flatpak ? [`~/.var/app/${flatpak}/cache`] : []),
    ],
  };
}

function electronApp(id: string, label: string, dir: string, procs: string[], extra: string[] = []): TargetDef {
  return {
    id, group: 'apps', label, risk: 'safe', on: true, procs, procName: label,
    hint: 'Fichiers temporaires retéléchargés à la demande. Vos comptes et réglages restent.',
    paths: [...['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Service Worker/CacheStorage'].map((c) => `~/.config/${dir}/${c}`), ...extra],
  };
}

function devCache(id: string, label: string, paths: string[], hint = 'Paquets téléchargés : ils reviennent tout seuls à la prochaine installation.', risk: 'safe' | 'review' = 'safe'): TargetDef {
  return { id, group: 'dev', label, hint, risk, on: risk === 'safe', paths };
}

const SLOW = 'Sans risque, mais long à retélécharger : à vider quand la place manque vraiment.';

export const CATALOG: TargetDef[] = [
  {
    id: 'trash', group: 'quick', label: 'Corbeille', risk: 'review', on: false,
    hint: 'Ce que vous avez déjà jeté. Vider la corbeille rend enfin la place au disque, sans retour possible.',
    paths: ['~/.local/share/Trash/files', '~/.local/share/Trash/info', '~/.local/share/Trash/expunged'],
  },
  {
    id: 'thumbnails', group: 'quick', label: 'Miniatures', risk: 'safe', on: true,
    hint: 'Aperçus de photos et vidéos : ils se recréent quand vous rouvrez un dossier.',
    paths: ['~/.cache/thumbnails', '~/.thumbnails'],
  },

  chromium('chrome', 'Google Chrome', 'google-chrome', ['chrome'], 'com.google.Chrome'),
  chromium('chromium', 'Chromium', 'chromium', ['chromium', 'chrome'], 'org.chromium.Chromium'),
  chromium('brave', 'Brave', 'BraveSoftware/Brave-Browser', ['brave'], 'com.brave.Browser'),
  chromium('edge', 'Microsoft Edge', 'microsoft-edge', ['msedge'], 'com.microsoft.Edge'),
  chromium('vivaldi', 'Vivaldi', 'vivaldi', ['vivaldi-bin'], 'com.vivaldi.Vivaldi'),
  chromium('opera', 'Opera', 'opera', ['opera']),
  {
    id: 'firefox', group: 'browsers', label: 'Firefox', risk: 'safe', on: true, procs: ['firefox', 'firefox-bin'], procName: 'Firefox',
    hint: 'Pages et images gardées pour aller plus vite. Vos favoris, mots de passe et sessions ne sont pas touchés.',
    paths: ['~/.cache/mozilla/firefox', '~/snap/firefox/common/.cache/mozilla/firefox', '~/.var/app/org.mozilla.firefox/cache'],
  },

  electronApp('vscode', 'Visual Studio Code', 'Code', ['code'], ['~/.config/Code/CachedData', '~/.config/Code/CachedExtensionVSIXs', '~/.config/Code/logs']),
  electronApp('cursor', 'Cursor', 'Cursor', ['cursor'], ['~/.config/Cursor/CachedData', '~/.config/Cursor/logs']),
  electronApp('slack', 'Slack', 'Slack', ['slack']),
  electronApp('discord', 'Discord', 'discord', ['Discord', 'discord']),
  electronApp('teams', 'Teams', 'teams-for-linux', ['teams-for-linux']),
  { id: 'spotify', group: 'apps', label: 'Spotify', risk: 'safe', on: true, procs: ['spotify'], procName: 'Spotify', hint: 'Musique gardée pour la réécoute. Les titres téléchargés hors ligne peuvent être à recharger.', paths: ['~/.cache/spotify', '~/snap/spotify/common/.cache/spotify'] },
  { id: 'jetbrains', group: 'apps', label: 'Outils JetBrains', risk: 'safe', on: true, procs: ['idea', 'pycharm', 'webstorm', 'clion', 'goland', 'rider'], procName: 'un outil JetBrains', hint: "Index de vos projets : ils seront recréés à l'ouverture suivante.", paths: ['~/.cache/JetBrains'] },
  { id: 'steamshaders', group: 'apps', label: 'Shaders Steam', risk: 'safe', on: false, procs: ['steam'], procName: 'Steam', hint: 'Recalculés au lancement de vos jeux (premier démarrage un peu plus long).', paths: ['~/.steam/steam/steamapps/shadercache', '~/.local/share/Steam/steamapps/shadercache'] },
  { id: 'mesa', group: 'apps', label: 'Caches graphiques', risk: 'safe', on: true, hint: 'Se reconstruisent en quelques secondes.', paths: ['~/.cache/mesa_shader_cache', '~/.cache/mesa_shader_cache_db', '~/.cache/nvidia', '~/.nv/ComputeCache', '~/.nv/GLCache'] },
  { id: 'flatpakcache', group: 'apps', label: 'Caches des applications Flatpak', risk: 'safe', on: true, hint: 'Fichiers temporaires de chaque application : ils se recréent tout seuls.', paths: ['~/.var/app/*/cache'] },
  { id: 'snapcache', group: 'apps', label: 'Caches des applications Snap', risk: 'safe', on: true, hint: 'Fichiers temporaires de chaque application : ils se recréent tout seuls.', paths: ['~/snap/*/common/.cache', '~/snap/*/current/.cache'] },

  devCache('npm', 'npm', ['~/.npm/_cacache', '~/.npm/_npx', '~/.npm/_logs']),
  devCache('yarn', 'Yarn', ['~/.cache/yarn', '~/.yarn/berry/cache']),
  devCache('pnpm', 'pnpm', ['~/.cache/pnpm', '~/.local/share/pnpm/store'], 'Paquets partagés entre vos projets : ils reviennent à la prochaine installation.'),
  devCache('bun', 'Bun', ['~/.bun/install/cache']),
  devCache('nodegyp', 'node-gyp', ['~/.cache/node-gyp']),
  devCache('pip', 'pip', ['~/.cache/pip']),
  devCache('uv', 'uv', ['~/.cache/uv']),
  devCache('poetry', 'Poetry', ['~/.cache/pypoetry']),
  devCache('cargo', 'Cargo (Rust)', ['~/.cargo/registry/cache', '~/.cargo/registry/src', '~/.cargo/git/checkouts']),
  devCache('gobuild', 'Go (compilation)', ['~/.cache/go-build'], 'Résultats de compilation : recalculés à la prochaine fois.'),
  devCache('gomod', 'Go (modules)', ['~/go/pkg/mod'], SLOW, 'review'),
  devCache('gradle', 'Gradle', ['~/.gradle/caches'], SLOW, 'review'),
  devCache('maven', 'Maven', ['~/.m2/repository'], SLOW, 'review'),
  devCache('composer', 'Composer', ['~/.cache/composer']),
  devCache('playwright', 'Navigateurs de Playwright', ['~/.cache/ms-playwright'], SLOW, 'review'),
  devCache('puppeteer', 'Navigateurs de Puppeteer', ['~/.cache/puppeteer'], SLOW, 'review'),
  devCache('electron', 'Téléchargements Electron', ['~/.cache/electron', '~/.cache/electron-builder']),
  devCache('cypress', 'Cypress', ['~/.cache/Cypress'], SLOW, 'review'),
  devCache('huggingface', 'Modèles Hugging Face', ['~/.cache/huggingface'], SLOW, 'review'),
  devCache('torch', 'Modèles PyTorch', ['~/.cache/torch'], SLOW, 'review'),

  {
    id: 'apt', group: 'system', label: 'Paquets Ubuntu téléchargés', risk: 'safe', on: false, needsPassword: true,
    hint: 'Installateurs déjà utilisés : le système les retélécharge si besoin.',
    steps: [{ file: 'pkexec', args: ['apt-get', 'clean'] }],
  },
  {
    id: 'journal', group: 'system', label: 'Journaux du système', risk: 'safe', on: false, needsPassword: true,
    hint: 'Garde les 7 derniers jours, retire les plus anciens.',
    steps: [{ file: 'pkexec', args: ['journalctl', '--vacuum-time=7d'] }],
  },
  {
    id: 'snapold', group: 'system', label: 'Anciennes versions Snap', risk: 'safe', on: false, needsPassword: true,
    hint: 'Versions précédentes conservées par Snap : seules les versions actives restent.',
    steps: [{ file: 'pkexec', args: ['sh', '-c', `LANG=C snap list --all | awk '/disabled/{print $1, $3}' | while read -r n r; do snap remove "$n" --revision="$r"; done`] }],
  },
  {
    id: 'flatpakunused', group: 'system', label: 'Composants Flatpak inutilisés', risk: 'safe', on: false,
    hint: 'Bibliothèques que plus aucune application n’utilise.',
    steps: [{ file: 'flatpak', args: ['uninstall', '--unused', '-y', '--noninteractive'] }],
  },
  {
    id: 'docker', group: 'system', label: 'Docker : images et cache inutilisés', risk: 'review', on: false,
    hint: 'Retire les images qu’aucun conteneur n’utilise et le cache de construction. Elles seront à retélécharger.',
    steps: [
      { file: 'docker', args: ['image', 'prune', '-af'] },
      { file: 'docker', args: ['builder', 'prune', '-af'] },
    ],
  },
];

/** Folders in the general cache where apps keep more than a cache, or that the session is using. */
const KEEP_IN_CACHE = /^(keyring|evolution|dconf|ibus|sessions|gvfs|tracker|localsearch|gnome-shell|gstreamer|at-spi|clairiere)/i;

export function home(): string {
  return homedir();
}

function expandHome(p: string) {
  return p.startsWith('~/') ? join(home(), p.slice(2)) : p;
}

function isRealPath(p: string) {
  try {
    return !lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function expandGlob(pattern: string): string[] {
  const full = expandHome(pattern);
  if (!full.includes('*')) return isRealPath(full) ? [full] : [];
  let found = ['/'];
  for (const seg of full.split('/').filter(Boolean)) {
    if (seg === '*') {
      found = found.flatMap((dir) => {
        try {
          return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
        } catch {
          return [];
        }
      });
    } else {
      found = found.map((d) => join(d, seg)).filter(isRealPath);
    }
  }
  return found;
}

function commandExists(file: string) {
  return (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, file)));
}

function availableStep(def: TargetDef) {
  if (def.id === 'apt') return commandExists('apt-get') && commandExists('pkexec');
  if (def.id === 'journal') return commandExists('journalctl') && commandExists('pkexec');
  if (def.id === 'snapold') return commandExists('snap') && commandExists('pkexec');
  if (def.id === 'flatpakunused') return commandExists('flatpak');
  if (def.id === 'docker') return commandExists('docker');
  return false;
}

export function runningPrograms(): Set<string> {
  const names = new Set<string>();
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        names.add(readFileSync(`/proc/${entry}/comm`, 'utf8').trim());
      } catch {
        // The process is gone: nothing to note.
      }
    }
  } catch {
    // No /proc: treat everything as closed.
  }
  return names;
}

export function blockedBy(def: TargetDef, running = runningPrograms()): string | undefined {
  return def.procs?.some((p) => running.has(p)) ? def.procName : undefined;
}

export interface Resolved {
  def: TargetDef;
  paths: string[];
  /** Loose files deleted outright. */
  files: string[];
}

/** Everything that exists on this computer right now, with its real paths. */
export function resolveTargets(customs: { id: string; path: string }[], mounts: string[]): Resolved[] {
  const out: Resolved[] = [];
  const claimed = new Set<string>();
  const cacheDir = join(home(), '.cache');
  for (const def of CATALOG) {
    if (def.steps) {
      if (availableStep(def)) out.push({ def, paths: [], files: [] });
      continue;
    }
    let paths = (def.paths ?? []).flatMap(expandGlob);
    if (def.id === 'trash') {
      const uid = userInfo().uid;
      for (const m of mounts) {
        if (m === '/') continue;
        paths.push(...['files', 'info', 'expunged'].map((s) => join(m, `.Trash-${uid}`, s)).filter(existsSync));
      }
    }
    paths = [...new Set(paths)];
    for (const p of paths) {
      if (p.startsWith(cacheDir + '/')) claimed.add(p.slice(cacheDir.length + 1).split('/')[0]);
    }
    if (paths.length) out.push({ def, paths, files: [] });
  }

  // Whatever else sits in the general cache folder.
  try {
    const others = readdirSync(cacheDir, { withFileTypes: true }).filter((e) => !claimed.has(e.name) && !KEEP_IN_CACHE.test(e.name));
    const paths = others.filter((e) => e.isDirectory()).map((e) => join(cacheDir, e.name));
    const files = others.filter((e) => e.isFile()).map((e) => join(cacheDir, e.name));
    if (paths.length || files.length) {
      out.push({
        def: {
          id: 'othercaches', group: 'apps', label: "Autres caches d'applications", risk: 'review', on: false,
          hint: 'Tout le reste du dossier de cache. Sans danger pour vos fichiers, mais une application ouverte peut devoir redémarrer.',
        },
        paths, files,
      });
    }
  } catch {
    // No general cache folder on this account.
  }

  for (const c of customs) {
    out.push({
      def: { id: c.id, group: 'custom', label: c.path.split('/').pop() || c.path, hint: c.path, risk: 'review', on: true },
      paths: existsSync(c.path) ? [c.path] : [],
      files: [],
    });
  }
  return out;
}

export function toPublic(r: Resolved, selected: boolean, running: Set<string>): CleanTarget {
  return {
    id: r.def.id,
    group: r.def.group,
    label: r.def.label,
    hint: r.def.hint,
    risk: r.def.risk,
    needsPassword: !!r.def.needsPassword,
    blockedBy: blockedBy(r.def, running),
    selected,
    bytes: null,
    files: null,
    paths: [...r.paths, ...r.files],
  };
}
