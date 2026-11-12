// Compiles the fast Rust engine and puts it where the app looks for it.
// CLAIRIERE_ENGINE_TARGET picks another Rust target (for example x86_64-apple-darwin on an
// Apple Silicon Mac, to build the Intel version of the app).
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'engine-bin');
const target = process.env.CLAIRIERE_ENGINE_TARGET;
const windows = target ? target.includes('windows') : process.platform === 'win32';
const name = windows ? 'clairiere-engine.exe' : 'clairiere-engine';
const built = join(root, 'engine', 'target', ...(target ? [target] : []), 'release', name);
const dest = join(out, name);

mkdirSync(out, { recursive: true });
try {
  execFileSync('cargo', ['build', '--release', '--quiet', ...(target ? ['--target', target] : [])], {
    cwd: join(root, 'engine'),
    stdio: 'inherit',
  });
  copyFileSync(built, dest);
  if (!windows) chmodSync(dest, 0o755);
} catch (err) {
  if (!existsSync(dest)) throw err;
  console.warn('Rust is unavailable: keeping the engine built earlier.');
}
