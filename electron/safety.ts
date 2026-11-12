import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Key } from '../shared/i18n';

export interface SafetyContext {
  platform: NodeJS.Platform;
  home: string;
  /** Where every disk is mounted ("/", "/media/usb", "C:\\", "D:\\"…). */
  mounts: string[];
  appDirs: string[];
  /** Folders worth a second look before deleting them: Documents, Pictures and so on. */
  personal: string[];
  /** Windows: SystemRoot, ProgramFiles, ProgramData… */
  env: Record<string, string | undefined>;
}

interface Rules {
  /** Nothing in these, ever: the system would stop working. */
  trees: string[];
  /** These themselves are off limits, what is inside them is judged normally. */
  roots: string[];
  /** In the home folder: the folder itself is off limits. */
  homeRoots: string[];
  /** In the home folder: nothing in these, ever. */
  homeTrees: string[];
  /** Home roots the cleaner may still empty (never delete). */
  emptiable: string[];
  /** Where applications keep settings: a warning, not a refusal. */
  settings: string[];
  /** Synced with the cloud. */
  cloud: string[];
}

const LINUX: Rules = {
  trees: ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/run', '/sbin', '/sys', '/usr'],
  roots: ['/', '/home', '/media', '/mnt', '/opt', '/root', '/snap', '/srv', '/tmp', '/var', '/var/cache', '/var/lib', '/var/log'],
  homeRoots: ['.config', '.local', '.local/share', '.cache', 'snap', '.var', '.var/app'],
  homeTrees: ['.ssh', '.gnupg', '.password-store', '.pki', '.mozilla', '.thunderbird', '.local/share/keyrings'],
  emptiable: [],
  settings: ['.config', '.local/share'],
  cloud: [],
};

const MAC: Rules = {
  trees: [
    '/System', '/bin', '/sbin', '/usr', '/etc', '/dev', '/cores', '/private/etc', '/private/var/db', '/private/var/root',
    '/private/var/vm', '/Library/Apple', '/Library/Keychains', '/Library/Extensions', '/Library/Filesystems', '/Library/Security',
    '/Library/SystemExtensions',
  ],
  roots: [
    '/', '/Applications', '/Applications/Utilities', '/Library', '/Library/Application Support', '/Library/Caches', '/Library/Preferences',
    '/Library/LaunchAgents', '/Library/LaunchDaemons', '/Users', '/Users/Shared', '/Volumes', '/Network', '/private', '/private/var',
    '/private/tmp', '/private/var/folders', '/tmp', '/var', '/opt', '/opt/homebrew',
  ],
  homeRoots: [
    'Library', 'Library/Application Support', 'Library/Caches', 'Library/Containers', 'Library/Group Containers', 'Library/Preferences',
    'Library/Logs', 'Library/Developer', 'Library/CloudStorage', 'Library/Mobile Documents', 'Applications', '.Trash',
  ],
  homeTrees: ['.ssh', '.gnupg', '.password-store', 'Library/Keychains', 'Library/Accounts'],
  emptiable: ['Library/Caches', 'Library/Logs'],
  settings: ['Library/Application Support', 'Library/Preferences', 'Library/Containers', 'Library/Group Containers'],
  cloud: ['Library/Mobile Documents', 'Library/CloudStorage'],
};

function windowsRules(ctx: SafetyContext): Rules {
  const w = path.win32;
  const drive = (ctx.env.SystemDrive || 'C:').replace(/\\?$/, '\\');
  const sys = ctx.env.SystemRoot || w.join(drive, 'Windows');
  const programs = [ctx.env.ProgramFiles, ctx.env['ProgramFiles(x86)'], ctx.env.ProgramW6432, w.join(drive, 'Program Files'), w.join(drive, 'Program Files (x86)')];
  const data = ctx.env.ProgramData || w.join(drive, 'ProgramData');
  const perDisk = ctx.mounts.flatMap((m) => ['$Recycle.Bin', 'System Volume Information', 'Recovery', 'Boot', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys'].map((n) => w.join(m, n)));
  return {
    trees: [sys, ...programs.filter((p): p is string => !!p), w.join(data, 'Microsoft'), ...perDisk],
    roots: [data, w.join(drive, 'Users'), w.join(drive, 'Users', 'Public'), w.join(drive, 'Users', 'Default'), w.join(drive, 'PerfLogs')],
    homeRoots: [
      'AppData', 'AppData/Local', 'AppData/Roaming', 'AppData/LocalLow', 'AppData/Local/Microsoft', 'AppData/Roaming/Microsoft',
      'AppData/Local/Microsoft/Windows', 'AppData/Local/Packages', 'AppData/Local/Programs', 'AppData/Local/Temp', 'AppData/Roaming/Microsoft/Windows',
    ],
    homeTrees: [
      '.ssh', '.gnupg', 'NTUSER.DAT', 'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials', 'AppData/Roaming/Microsoft/Protect',
      'AppData/Roaming/Microsoft/Crypto', 'AppData/Roaming/Microsoft/SystemCertificates', 'AppData/Local/Microsoft/Vault',
      'AppData/Local/Microsoft/Windows/UsrClass.dat',
    ],
    emptiable: ['AppData/Local/Temp'],
    settings: ['AppData/Roaming', 'AppData/Local'],
    cloud: ['OneDrive'],
  };
}

function rulesFor(ctx: SafetyContext): Rules {
  if (ctx.platform === 'win32') return windowsRules(ctx);
  if (ctx.platform === 'darwin') return MAC;
  return LINUX;
}

function lib(ctx: SafetyContext) {
  return ctx.platform === 'win32' ? path.win32 : path.posix;
}

/** Windows and macOS disks ignore letter case: "C:\\WINDOWS" is "C:\\Windows". */
function norm(ctx: SafetyContext, p: string): string {
  const P = lib(ctx);
  let n = P.normalize(p);
  const root = P.parse(n).root;
  while (n.length > root.length && n.endsWith(P.sep)) n = n.slice(0, -1);
  return ctx.platform === 'linux' ? n : n.toLowerCase();
}

function within(ctx: SafetyContext, p: string, tree: string): boolean {
  const a = norm(ctx, p);
  const b = norm(ctx, tree);
  const sep = lib(ctx).sep;
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

function same(ctx: SafetyContext, a: string, b: string) {
  return norm(ctx, a) === norm(ctx, b);
}

const inHome = (ctx: SafetyContext, rel: string) => lib(ctx).join(ctx.home, rel);

/** Resolves links in the parent folders, not in the last name: a link is deleted, not followed. */
export function resolvedPath(input: string, ctx: SafetyContext): string {
  const P = lib(ctx);
  const clean = P.normalize(input);
  if (ctx.platform !== process.platform) return clean;
  try {
    return P.join(realpathSync(P.dirname(clean)), P.basename(clean));
  } catch {
    return clean;
  }
}

function invalid(input: string, ctx: SafetyContext): boolean {
  if (input.includes('\0') || input.split(/[\\/]/).includes('..')) return true;
  if (ctx.platform === 'win32') {
    // A drive letter or a network share, never a device path.
    return !/^[A-Za-z]:[\\/]/.test(input) && !/^\\\\[^\\?.]/.test(input);
  }
  return !path.posix.isAbsolute(input);
}

/**
 * Why this path must not be deleted, or null when it may be. Called for every deletion.
 * `emptying`: only what is inside will go, the folder itself stays.
 */
export function refusal(input: string, ctx: SafetyContext, emptying = false): Key | null {
  if (invalid(input, ctx)) return 'safety.invalid';
  const p = resolvedPath(input, ctx);
  const r = rulesFor(ctx);
  if (r.trees.some((t) => within(ctx, p, t))) return 'safety.system';
  if (r.roots.some((t) => same(ctx, p, t))) return 'safety.essential';
  if (within(ctx, ctx.home, p)) return 'safety.home';
  if (ctx.mounts.some((m) => within(ctx, m, p))) return 'safety.disk';
  if (r.homeRoots.some((rel) => same(ctx, p, inHome(ctx, rel)) && !(emptying && r.emptiable.includes(rel)))) return 'safety.session';
  if (r.homeTrees.some((rel) => within(ctx, p, inHome(ctx, rel)))) return 'safety.keys';
  if (ctx.appDirs.some((d) => within(ctx, p, d) || within(ctx, d, p))) return 'safety.app';
  return null;
}

/** A warning shown in the confirmation, for something that may be precious. */
export function warning(input: string, ctx: SafetyContext): Key | null {
  const p = resolvedPath(input, ctx);
  const r = rulesFor(ctx);
  if (ctx.personal.some((x) => within(ctx, x, p))) return 'warn.personal';
  if (r.cloud.some((rel) => within(ctx, p, inHome(ctx, rel)) || (ctx.platform === 'win32' && /^onedrive/i.test(path.win32.relative(ctx.home, p))))) {
    return 'warn.cloud';
  }
  if (ctx.platform === 'darwin' && /\.app$/i.test(p)) return 'warn.application';
  if (r.settings.some((rel) => within(ctx, p, inHome(ctx, rel)))) return 'warn.appSettings';
  return null;
}
