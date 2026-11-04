import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

export interface SafetyContext {
  home: string;
  mounts: string[];
  appDirs: string[];
  /** Folders worth a second look before deleting them: Documents, Images and so on. */
  personal: string[];
}

// Nothing in these, ever: the system would stop working.
const SYSTEM_TREES = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/run', '/sbin', '/sys', '/usr'];
// These themselves are off limits, what is inside them is judged normally.
const SYSTEM_ROOTS = ['/', '/home', '/media', '/mnt', '/opt', '/root', '/snap', '/srv', '/tmp', '/var', '/var/cache', '/var/lib', '/var/log'];
const HOME_ROOTS = ['.config', '.local', '.local/share', '.cache', 'snap', '.var', '.var/app'];
const HOME_TREES = ['.ssh', '.gnupg', '.password-store', '.pki', '.mozilla', '.thunderbird', '.local/share/keyrings'];

function within(path: string, tree: string) {
  return path === tree || path.startsWith(tree === '/' ? '/' : tree + '/');
}

/** Resolves links in the parent folders, not in the last name: a link is deleted, not followed. */
export function resolvedPath(path: string): string {
  const clean = normalize(path);
  try {
    return join(realpathSync(dirname(clean)), basename(clean));
  } catch {
    return clean;
  }
}

/** Why this path must not be deleted, or null when it may be. Called for every deletion. */
export function refusal(input: string, ctx: SafetyContext): string | null {
  if (!isAbsolute(input) || input.split('/').includes('..') || input.includes('\0')) {
    return 'Chemin invalide.';
  }
  const path = resolvedPath(input);
  if (SYSTEM_TREES.some((t) => within(path, t))) return 'Dossier du système : le supprimer casserait votre ordinateur.';
  if (SYSTEM_ROOTS.includes(path)) return 'Dossier indispensable au système.';
  if (within(ctx.home, path)) return 'Il contient votre dossier personnel.';
  if (ctx.mounts.some((m) => within(m, path))) return "C'est la racine d'un disque, ou il en contient un.";
  if (HOME_ROOTS.some((r) => path === join(ctx.home, r))) return 'Dossier indispensable à votre session.';
  if (HOME_TREES.some((r) => within(path, join(ctx.home, r)))) return 'Contient vos clés, mots de passe ou profils.';
  if (ctx.appDirs.some((d) => within(path, d) || within(d, path))) return 'Clairière a besoin de ce dossier pour fonctionner.';
  return null;
}

/** A warning shown in the confirmation, for a folder that may be precious. */
export function warning(input: string, ctx: SafetyContext): string | null {
  const path = resolvedPath(input);
  if (ctx.personal.some((p) => within(p, path))) return 'Contient un de vos dossiers personnels (Documents, Images…).';
  if (within(path, join(ctx.home, '.config')) || within(path, join(ctx.home, '.local', 'share'))) {
    return "Des réglages d'applications sont rangés ici : elles pourraient les perdre.";
  }
  return null;
}
