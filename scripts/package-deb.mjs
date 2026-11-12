// Builds the installable Debian/Ubuntu package from what `npm run build` produced.
// Nothing is downloaded: it reuses the Electron already in the project and the system's dpkg-deb.
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const electronDir = join(root, 'node_modules', 'electron', 'dist');
const engine = join(root, 'engine-bin', 'clairiere-engine');
for (const needed of [join(root, 'dist', 'index.html'), join(root, 'dist-electron', 'electron', 'main.js'), engine, join(electronDir, 'electron.bin')]) {
  if (!existsSync(needed)) throw new Error(`Missing ${needed}: run the build first.`);
}

const arch = execFileSync('dpkg', ['--print-architecture'], { encoding: 'utf8' }).trim();
const outDir = join(root, 'release');
const output = join(outDir, `clairiere_${pkg.version}_${arch}.deb`);
const stage = mkdtempSync(join(tmpdir(), 'clairiere-deb-'));

function write(rel, text, mode = 0o644) {
  const p = join(stage, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  chmodSync(p, mode);
}

/** The oldest system the engine runs on, read from the program itself. */
function minimumGlibc() {
  const found = readFileSync(engine).toString('latin1').match(/GLIBC_\d+\.\d+/g) ?? [];
  const versions = found.map((v) => v.slice(6).split('.').map(Number));
  versions.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  return versions[0]?.join('.') ?? '2.34';
}

function normalizeModes(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) normalizeModes(join(path, name));
  } else {
    chmodSync(path, st.mode & 0o111 ? 0o755 : 0o644);
  }
}

function folderKiB(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return Math.ceil(st.size / 1024);
  return readdirSync(path).reduce((sum, name) => sum + folderKiB(join(path, name)), 4);
}

try {
  // The Electron runtime, under the app's own name, without what the app doesn't use.
  const opt = join(stage, 'opt', 'clairiere');
  mkdirSync(opt, { recursive: true });
  for (const name of readdirSync(electronDir)) {
    // `electron` is the development wrapper; chrome-sandbox would need to be installed setuid root.
    if (['electron', 'electron.bin', 'chrome-sandbox', 'locales'].includes(name)) continue;
    cpSync(join(electronDir, name), join(opt, name), { recursive: true, verbatimSymlinks: true });
  }
  copyFileSync(join(electronDir, 'electron.bin'), join(opt, 'clairiere'));
  chmodSync(join(opt, 'clairiere'), 0o755);
  mkdirSync(join(opt, 'locales'));
  for (const locale of ['en-US.pak', 'fr.pak', 'es.pak', 'de.pak', 'zh-CN.pak', 'ko.pak', 'ru.pak']) copyFileSync(join(electronDir, 'locales', locale), join(opt, 'locales', locale));
  rmSync(join(opt, 'resources', 'default_app.asar'), { force: true });

  // The app itself.
  const app = join(opt, 'resources', 'app');
  mkdirSync(app, { recursive: true });
  cpSync(join(root, 'dist'), join(app, 'dist'), { recursive: true });
  cpSync(join(root, 'dist-electron'), join(app, 'dist-electron'), { recursive: true });
  mkdirSync(join(app, 'engine-bin'));
  copyFileSync(engine, join(app, 'engine-bin', 'clairiere-engine'));
  writeFileSync(join(app, 'package.json'), JSON.stringify({
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    description: pkg.description,
    author: pkg.author,
    homepage: pkg.homepage,
    main: pkg.main,
    desktopName: 'clairiere.desktop',
  }, null, 2));

  // Clairière only ever loads its own local files; see scripts/prepare-electron.mjs.
  write('usr/bin/clairiere', '#!/bin/sh\nexec /opt/clairiere/clairiere --no-sandbox "$@"\n', 0o755);
  write('usr/share/applications/clairiere.desktop', [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Clairière',
    'GenericName=Disk usage analyser',
    'GenericName[fr]=Analyse de disque',
    'GenericName[es]=Analizador de discos',
    'GenericName[de]=Speicherplatzanalyse',
    'GenericName[zh_CN]=磁盘分析器',
    'GenericName[ko]=디스크 분석기',
    'GenericName[ru]=Анализатор дисков',
    'Comment=Analyse your disks and free up space',
    'Comment[fr]=Analyser les disques et libérer de la place',
    'Keywords=disk;space;cache;clean;folder;disque;espace;nettoyage;dossier;',
    'Exec=/usr/bin/clairiere',
    'Icon=clairiere',
    'Terminal=false',
    'Categories=System;Filesystem;',
    'StartupNotify=true',
    'StartupWMClass=Clairière',
    '',
  ].join('\n'));
  mkdirSync(join(stage, 'usr/share/icons/hicolor/256x256/apps'), { recursive: true });
  mkdirSync(join(stage, 'usr/share/icons/hicolor/scalable/apps'), { recursive: true });
  copyFileSync(join(root, 'public', 'icon.png'), join(stage, 'usr/share/icons/hicolor/256x256/apps/clairiere.png'));
  copyFileSync(join(root, 'public', 'icon.svg'), join(stage, 'usr/share/icons/hicolor/scalable/apps/clairiere.svg'));

  normalizeModes(stage);
  const installedSize = folderKiB(stage);

  // Taken from the libraries the program really asks for (objdump -p); t64 names are Ubuntu 24.04 and later.
  const depends = [
    `libc6 (>= ${minimumGlibc()})`, 'libgcc-s1', 'libglib2.0-0t64 | libglib2.0-0', 'libnss3', 'libnspr4', 'libdbus-1-3',
    'libatk1.0-0t64 | libatk1.0-0', 'libatk-bridge2.0-0t64 | libatk-bridge2.0-0', 'libatspi2.0-0t64 | libatspi2.0-0',
    'libcups2t64 | libcups2', 'libcairo2', 'libgtk-3-0t64 | libgtk-3-0', 'libpango-1.0-0', 'libx11-6', 'libxcomposite1',
    'libxdamage1', 'libxext6', 'libxfixes3', 'libxrandr2', 'libgbm1', 'libexpat1', 'libxcb1', 'libxkbcommon0', 'libudev1',
    'libasound2t64 | libasound2', 'xdg-utils',
  ];
  write('DEBIAN/control', [
    'Package: clairiere',
    `Version: ${pkg.version}`,
    `Architecture: ${arch}`,
    // The format requires an address: GitHub's public no-reply one exposes no personal mailbox.
    `Maintainer: ${pkg.author.name} <ergen35@users.noreply.github.com>`,
    `Homepage: ${pkg.homepage}`,
    `Installed-Size: ${installedSize}`,
    `Depends: ${depends.join(', ')}`,
    // gio empties to the bin, pkexec asks the password for system clean-ups.
    'Recommends: libglib2.0-bin, pkexec | policykit-1',
    'Section: utils',
    'Priority: optional',
    `Description: ${pkg.description}`,
    ' Folder map, big files, protected deletion and one-click cache',
    ' clean-up, in English, French, Spanish, German, Chinese, Korean and Russian.',
    '',
  ].join('\n'));
  chmodSync(join(stage, 'DEBIAN'), 0o755);

  mkdirSync(outDir, { recursive: true });
  execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '-z6', '--build', stage, output], { stdio: 'inherit' });
  console.log(`${output} (${Math.round(statSync(output).size / 1e6)} MB)`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
