// Compiles the fast Rust engine and puts it where the app looks for it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'engine-bin');
const target = join(out, 'clairiere-engine');
mkdirSync(out, { recursive: true });
try {
  execFileSync('cargo', ['build', '--release', '--quiet'], { cwd: join(root, 'engine'), stdio: 'inherit' });
  copyFileSync(join(root, 'engine', 'target', 'release', 'clairiere-engine'), target);
  chmodSync(target, 0o755);
} catch (err) {
  if (!existsSync(target)) throw err;
  console.warn('Rust is unavailable: keeping the engine built earlier.');
}
