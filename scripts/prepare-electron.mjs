// Linux only. Ubuntu forbids the sandbox helper Electron starts with unless it is installed as
// root, and Electron then refuses to start at all. Clairière only ever loads its own local files
// (the content policy and the blocked navigation make sure of it), so it runs without that
// helper, however it is started: the Electron program is wrapped once, after every build.
// Windows and macOS need nothing of the kind.
import { chmodSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'linux') {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'electron', 'dist');
  const program = join(dist, 'electron');
  const real = join(dist, 'electron.bin');

  if (!existsSync(real)) renameSync(program, real);
  writeFileSync(
    program,
    '#!/bin/sh\nexec "$(dirname "$(readlink -f "$0")")/electron.bin" --no-sandbox "$@"\n',
  );
  chmodSync(program, 0o755);
}
