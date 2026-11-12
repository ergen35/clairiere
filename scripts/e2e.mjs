// Drives the real app against a throw-away home folder in /tmp. System commands are replaced by
// stand-ins that only write down how they were called, so nothing real is ever cleaned.
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// To test the content of the installable package instead of the development copy.
const packagedExe = process.env.CLAIRIERE_EXE;
const appUnderTest = packagedExe ? join(dirname(packagedExe), 'resources', 'app') : appDir;
const shots = join(appDir, 'shots');
mkdirSync(shots, { recursive: true });

const base = mkdtempSync(join(tmpdir(), 'clairiere-e2e-'));
if (!base.startsWith('/tmp/')) throw new Error('Refusing to run outside /tmp');
const HOME = join(base, 'home');
const stubs = join(base, 'bin');
const log = join(base, 'commands.log');
const MB = 1 << 20;

function file(rel, size = 4096, content) {
  const p = join(HOME, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content ?? Buffer.alloc(size, 7));
  return p;
}

function stub(name, body) {
  const p = join(stubs, name);
  writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
  chmodSync(p, 0o755);
}

function fixtures() {
  mkdirSync(stubs, { recursive: true });
  stub('pkexec', 'exit 0');
  stub('xdg-open', 'exit 0');
  stub('docker', 'if [ "$1" = system ]; then printf "Images\\t1.5GB (80%%)\\nContainers\\t0B\\nBuild Cache\\t500MB\\n"; fi; exit 0');
  file('Documents/rapport.txt', 4 * MB);
  file('Documents/garder/contrat.pdf', 1 * MB);
  file('Vidéos/film.bin', 10 * MB);
  file('Vidéos/court.bin', 2 * MB);
  file('Images/photo.bin', 3 * MB);
  file('.cache/thumbnails/large/a.png', 1 * MB);
  file('.cache/pip/http/x', 2 * MB);
  file('.cache/autre-app/y', 1 * MB);
  file('.cache/fichier-seul.bin', 1 * MB);
  file('.npm/_cacache/content/z', 3 * MB);
  file('.local/share/Trash/files/ancien.bin', 1 * MB);
  file('.local/share/Trash/info/ancien.bin.trashinfo', 100);
  file('projets/site/package.json', 100, '{}');
  file('projets/site/src/index.js', 100);
  file('projets/site/node_modules/lib/index.js', 5 * MB);
  file('projets/site/node_modules/lib/node_modules/dedans/i.js', 1 * MB);
  file('projets/moteur/Cargo.toml', 100);
  file('projets/moteur/target/debug/gros', 6 * MB);
  file('.vscode/extensions/ext/package.json', 100, '{}');
  file('.vscode/extensions/ext/node_modules/lib/i.js', 2 * MB);
  // Traps: links that lead away, and a read-only folder like package managers leave behind.
  symlinkSync(join(HOME, 'Documents'), join(HOME, '.cache/thumbnails/piege-documents'));
  symlinkSync('/usr', join(HOME, 'vers-usr'));
  file('.cache/go-build/verrou/f', 1 * MB);
  chmodSync(join(HOME, '.cache/go-build/verrou'), 0o555);
  file('lien-a-effacer-cible/garde.txt', 10);
  symlinkSync(join(HOME, 'lien-a-effacer-cible'), join(HOME, 'lien-a-effacer'));
  file('Archives/grosse-archive.bin', 20 * MB);
  // A file name that is not valid text, as old disks and archives sometimes produce.
  file('Bizarre/normal.txt', 1 * MB);
  writeFileSync(Buffer.from(`${join(HOME, 'Bizarre')}/nom-\xff-casse.bin`, 'latin1'), Buffer.alloc(2 * MB, 7));
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` : ${detail}`}`);
  if (!ok) failures += 1;
}

const home = (rel) => join(HOME, rel);

async function launch() {
  const app = await electron.launch({
    executablePath: packagedExe ?? join(appDir, 'node_modules/electron/dist/electron'),
    args: packagedExe ? ['--no-sandbox'] : ['.'],
    cwd: appDir,
    env: {
      ...process.env,
      HOME,
      XDG_CONFIG_HOME: join(HOME, '.config'),
      XDG_CACHE_HOME: join(HOME, '.cache'),
      XDG_DATA_HOME: join(HOME, '.local/share'),
      PATH: `${stubs}:${process.env.PATH}`,
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.brand');
  await page.waitForTimeout(300);
  const picker = (await page.locator('.lang-card').count()) > 0;
  if (picker) {
    // First start: the language is chosen before anything else. These checks read French.
    await page.getByRole('radio', { name: 'Français' }).click();
    await page.waitForSelector('#lang-title:text("Choisissez votre langue")');
    await page.getByRole('button', { name: 'Continuer' }).click();
    await page.waitForSelector('.lang-card', { state: 'detached' });
    await page.waitForSelector('.nav:has-text("Disques")');
  }
  return { app, page, picker };
}

const invoke = (page, name, ...args) => page.evaluate(([n, a]) => window.clairiere.invoke(n, ...a), [name, args]);

async function main() {
  fixtures();
  let { app, page, picker } = await launch();
  check('the language is asked at the very first start', picker);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize?.({ width: 1280, height: 800 }).catch(() => {});

  // ---- Scan and map
  await page.getByRole('button', { name: /Mon dossier personnel/ }).click();
  await page.waitForSelector('.row', { timeout: 15000 });
  await page.waitForSelector('.map canvas');
  await page.waitForTimeout(400);
  const expected = Number(execFileSync('du', ['-sB1', '--one-file-system', HOME], { encoding: 'utf8' }).split('\t')[0]);
  const scan = await page.evaluate(() => document.querySelector('.ex-summary strong').textContent);
  console.log(`     analysed total shown: ${scan}, du says ${expected} bytes`);
  const names = await page.$$eval('.row-label', (els) => els.map((e) => e.textContent));
  check('list shows folders biggest first', names[0] === 'Archives', names.slice(0, 4).join(', '));
  check('list shows hidden caches', names.includes('.cache'));
  await page.screenshot({ path: join(shots, 'map-blocks.png') });

  await page.getByRole('button', { name: 'Anneaux' }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, 'map-rings.png') });
  await page.getByRole('button', { name: 'Rectangles' }).click();

  // Into a folder and back
  await page.locator('.row-label.as-link', { hasText: 'Vidéos' }).click();
  await page.waitForFunction(() => document.querySelector('.crumbs .current')?.textContent === 'Vidéos');
  check('entering a folder updates the path', true);
  await page.getByRole('button', { name: 'Dossier parent' }).click();
  await page.waitForFunction(() => document.querySelector('.crumbs .current')?.textContent !== 'Vidéos');

  // Expand in the list
  await page.locator('.row', { hasText: 'projets' }).first().locator('.twist').click();
  await page.waitForSelector('.row-label:text("site")');
  check('a folder unfolds in the list', true);
  await page.waitForTimeout(150);

  await page.getByRole('tab', { name: /Gros fichiers/ }).click();
  await page.waitForSelector('.flat li');
  const biggest = await page.locator('.flat li strong').first().textContent();
  check('biggest files are listed', biggest === 'grosse-archive.bin', biggest);
  await page.getByRole('tab', { name: /Projets/ }).click();
  const projectPaths = await page.$$eval('.flat small', (els) => els.map((e) => e.textContent));
  check('rebuildable project folders found', projectPaths.length === 2, projectPaths.join(' | '));
  check('nothing inside application folders is offered', !projectPaths.join().includes('.vscode'));
  await page.getByRole('tab', { name: 'Dossiers' }).click();

  // ---- Keyboard
  await page.locator('.list').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  await page.waitForSelector('.tray');
  check('space picks the row with the keyboard', (await page.locator('.tray').textContent()).includes('1 élément'));
  await page.keyboard.press('Delete');
  await page.waitForSelector('.modal');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });
  check('escape closes the confirmation, nothing deleted', existsSync(home('Archives/grosse-archive.bin')));
  await page.keyboard.press('Space');
  await page.waitForSelector('.tray', { state: 'detached' });

  // ---- An unreadable file name
  await page.locator('.row-label.as-link', { hasText: 'Bizarre' }).click();
  await page.waitForFunction(() => document.querySelector('.crumbs .current')?.textContent === 'Bizarre');
  await page.waitForSelector('.row');
  const brokenRow = page.locator('.row', { hasText: 'casse' });
  check('an unreadable name is shown but cannot be picked', await brokenRow.locator('input').isDisabled());
  check('its neighbour still can', !(await page.locator('.row', { hasText: 'normal.txt' }).locator('input').isDisabled()));
  await page.getByRole('button', { name: 'Dossier parent' }).click();
  await page.waitForFunction(() => document.querySelector('.crumbs .current')?.textContent !== 'Bizarre');

  // ---- Deleting one big file from its list
  await page.getByRole('tab', { name: /Gros fichiers/ }).click();
  await page.locator('.flat li', { hasText: 'grosse-archive.bin' }).locator('input').check();
  await page.locator('.tray .btn.danger').click();
  await page.waitForSelector('.modal .btn.danger');
  const beforeFile = await page.locator('.ex-summary strong').textContent();
  await page.locator('.modal .btn.danger').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForTimeout(300);
  check('a big file is deleted and leaves its list', !existsSync(home('Archives/grosse-archive.bin')) && (await page.locator('.flat li', { hasText: 'grosse-archive.bin' }).count()) === 0);
  const afterFile = await page.locator('.ex-summary strong').textContent();
  check('the total goes down at once', beforeFile !== afterFile, `${beforeFile} → ${afterFile}`);
  await page.getByRole('tab', { name: 'Dossiers' }).click();

  // ---- An analysis elsewhere, then back
  const again = await page.evaluate(() => window.clairiere.invoke('scan', '/usr/share').then(() => 'done', (e) => e.message));
  check('an analysis outside the home folder works', again === 'done', again);
  await page.getByRole('button', { name: /Disques/ }).click();
  await page.getByRole('button', { name: /Mon dossier personnel/ }).click();
  await page.waitForSelector('.row', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.crumbs .current')?.textContent === '~');
  await page.waitForTimeout(300);

  // ---- Deleting one folder for good
  await page.locator('.row', { hasText: 'Vidéos' }).first().locator('input').check();
  await page.waitForSelector('.tray');
  await page.screenshot({ path: join(shots, 'selection.png') });
  await page.locator('.tray .btn.danger').click();
  await page.waitForSelector('.modal');
  await page.waitForSelector('.modal .btn.danger');
  await page.screenshot({ path: join(shots, 'confirm.png') });
  check('confirmation warns about personal folders', (await page.locator('.modal').textContent()).includes('personnels'));
  await page.locator('.modal .btn.danger').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForTimeout(300);
  check('deleted for good: gone from disk', !existsSync(home('Vidéos')));
  check('other folders untouched', existsSync(home('Documents/rapport.txt')) && existsSync(home('Images/photo.bin')));
  const after = await page.$$eval('.row-label', (els) => els.map((e) => e.textContent));
  check('deleted folder left the list at once', !after.includes('Vidéos'), after.join(', '));

  // ---- To the bin
  const outcome = await invoke(page, 'deleteItems', [{ path: home('Images'), size: 3 * MB }], 'trash');
  check('moved to the bin', outcome.done.length === 1 && !existsSync(home('Images')) && readdirSync(home('.local/share/Trash/files')).includes('Images'), JSON.stringify(outcome));
  check('moving to the bin does not count as freed', outcome.freed === 0 && outcome.moved > 0);

  // ---- What must be refused, however it is asked
  // Real paths only ever go through the read-only check, never through the deleting call.
  const realPaths = ['/', '/usr', '/usr/bin', '/etc', '/home', '/boot', '/var', '/tmp', appUnderTest, join(appUnderTest, 'dist'), join(appUnderTest, 'engine-bin'), dirname(appUnderTest), `${HOME}/../..`];
  const verdicts = await invoke(page, 'checkItems', realPaths);
  const allowedReal = verdicts.filter((v) => !v.refused).map((v) => v.path);
  check('every real critical path refused by the check', allowedReal.length === 0, allowedReal.join(', '));
  // The deleting call itself is tried on stand-ins inside the throw-away home.
  file('.ssh/id', 100);
  file('.config/app/reglages', 100);
  const forbidden = [HOME, home('.config'), home('.cache'), home('.local'), home('.ssh'), home('.ssh/id'), home('vers-usr/bin'), 'relatif/chemin'];
  const refused = await invoke(page, 'deleteItems', forbidden.map((path) => ({ path, size: 0 })), 'permanent');
  check('the deleting call refuses them too', refused.failed.length === forbidden.length && refused.done.length === 0, JSON.stringify(refused.done));
  check('stand-ins still there', existsSync(home('.ssh/id')) && existsSync(home('.config/app/reglages')) && existsSync(home('.cache/pip')));

  // A link is removed, what it points to stays.
  const linkOutcome = await invoke(page, 'deleteItems', [{ path: home('lien-a-effacer'), size: 0 }], 'permanent');
  check('deleting a link keeps its target', linkOutcome.done.length === 1 && existsSync(home('lien-a-effacer-cible/garde.txt')), JSON.stringify(linkOutcome));

  // ---- Cleaning
  await page.getByRole('button', { name: /Nettoyage/ }).click();
  await page.waitForSelector('.targets li');
  await page.waitForFunction(() => !document.querySelector('.hero .btn.primary')?.disabled, null, { timeout: 15000 });
  await page.waitForSelector('.projects li', { timeout: 15000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(shots, 'clean.png') });
  const labels = await page.$$eval('.targets li strong', (els) => els.map((e) => e.textContent));
  check('known caches found', ['Miniatures', 'npm', 'pip', 'Corbeille'].every((l) => labels.includes(l)), labels.join(', '));
  const unknownSizes = async () => page.$$eval('.targets:not(.projects) li', (els) =>
    els.filter((e) => e.querySelector('.target-size .num')?.textContent === 'Inconnu').map((e) => e.querySelector('strong').textContent));
  const unknownFirst = await unknownSizes();
  check('every size is measured', unknownFirst.length === 0, unknownFirst.join(', '));
  const dockerRow = await page.locator('.targets li', { hasText: 'Docker' }).textContent();
  check('docker offered with its reclaimable size', dockerRow.includes('2 Go'), dockerRow);

  await page.locator('.hero .btn.primary').click();
  await page.waitForSelector('.result', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.hero .btn.primary')?.disabled, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, 'clean-done.png') });
  const unknownAfter = await unknownSizes();
  check('every size is measured again after a clean', unknownAfter.length === 0, unknownAfter.join(', '));
  const summary = await page.locator('.result').textContent();
  console.log(`     ${summary}`);
  check('thumbnails emptied, folder kept', existsSync(home('.cache/thumbnails')) && !existsSync(home('.cache/thumbnails/large')));
  check('npm and pip emptied', !existsSync(home('.npm/_cacache/content')) && !existsSync(home('.cache/pip/http')));
  check('read-only folder removed too', !existsSync(home('.cache/go-build/verrou')));
  check('a link in a cache does not reach what it points to', existsSync(home('Documents/rapport.txt')) && existsSync(home('Documents/garder/contrat.pdf')));
  check('bin left alone unless chosen', existsSync(home('.local/share/Trash/files/ancien.bin')));
  check('other caches left alone unless chosen', existsSync(home('.cache/autre-app/y')));
  check('project folders left alone', existsSync(home('projets/site/node_modules')));
  check('no password asked in a normal clean', !existsSync(log) || !readFileSync(log, 'utf8').includes('pkexec'));

  // One emplacement at a time, with a confirmation for what deserves one
  await page.locator('.targets li', { hasText: 'Corbeille' }).getByRole('button', { name: 'Vider' }).click();
  await page.waitForSelector('.modal');
  await page.locator('.modal .btn.primary').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForFunction(() => !document.querySelector('.hero .btn.primary')?.disabled || document.querySelector('.hero .btn.primary') === null, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  check('bin emptied on request', !existsSync(home('.local/share/Trash/files/ancien.bin')) && existsSync(home('.local/share/Trash/files')));

  await page.locator('.targets li', { hasText: 'Docker' }).getByRole('button', { name: 'Vider' }).click();
  await page.waitForSelector('.modal');
  await page.locator('.modal .btn.primary').click();
  await page.waitForTimeout(800);
  await page.locator('.targets li', { hasText: 'Paquets Ubuntu' }).getByRole('button', { name: 'Vider' }).click();
  await page.waitForSelector('.modal');
  check('password warning shown first', (await page.locator('.modal').textContent()).includes('mot de passe'));
  await page.locator('.modal .btn.primary').click();
  await page.waitForTimeout(800);
  const commands = readFileSync(log, 'utf8');
  check('docker runs its two fixed commands', commands.includes('docker image prune -af') && commands.includes('docker builder prune -af'), commands);
  check('package cache goes through the password prompt', commands.includes('pkexec apt-get clean'), commands);

  // My own folders
  file('Dossier-rendu/sortie.bin', 1 * MB);
  check('a personal folder can be added', (await invoke(page, 'addCustomTarget', home('Dossier-rendu'))) === null);
  check('a system folder cannot', typeof (await invoke(page, 'addCustomTarget', '/usr')) === 'string');
  check('the home folder cannot', typeof (await invoke(page, 'addCustomTarget', HOME)) === 'string');

  // Project folders
  await page.locator('.projects li', { hasText: 'site' }).locator('input').check();
  await page.locator('.project-actions .btn.danger').click();
  await page.waitForSelector('.modal .btn.danger');
  await page.locator('.modal .btn.danger').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForTimeout(300);
  check('project dependencies deleted, project kept', !existsSync(home('projets/site/node_modules')) && existsSync(home('projets/site/package.json')) && existsSync(home('projets/site/src/index.js')));

  // ---- Remembered, and the clean on opening
  await page.locator('.targets li', { hasText: 'pip' }).locator('input').uncheck();
  await page.locator('.auto input').check();
  check('no errors in the window', errors.length === 0, errors.join(' | '));

  // ---- Credits
  await page.getByRole('button', { name: /À propos/ }).click();
  await page.waitForSelector('.modal');
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(shots, 'about.png') });
  const about = await page.locator('.modal').textContent();
  const { version } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
  check('credits name the developer', about.includes('Serge Eric Hotegni'), about);
  check('credits show the running version', about.includes(`Version ${version}`), about);
  check('credits show both addresses', about.includes('github.com/ergen35/clairiere') && about.includes('github.com/ergen35'), about);
  await page.getByRole('button', { name: 'github.com/ergen35/clairiere' }).click();
  await page.waitForTimeout(800);
  check('the project link opens in the browser', readFileSync(log, 'utf8').includes('xdg-open https://github.com/ergen35/clairiere'));
  const blocked = await page.evaluate(() => window.clairiere.invoke('openLink', 'https://example.com/').then(() => 'opened', () => 'refused'));
  check('any other address is refused', blocked === 'refused' && !readFileSync(log, 'utf8').includes('example.com'), blocked);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });

  // ---- The launcher in the applications menu
  await page.getByRole('button', { name: /Disques/ }).click();
  if (packagedExe) {
    await page.waitForTimeout(300);
    check('the installed app does not offer a second launcher', (await page.getByRole('button', { name: /menu des applications/ }).count()) === 0);
  } else {
    await page.getByRole('button', { name: /menu des applications/ }).click();
    await page.waitForSelector('text=est maintenant dans le menu');
    const entry = readFileSync(home('.local/share/applications/clairiere.desktop'), 'utf8');
    const exec = /^Exec="(.+)"$/m.exec(entry)?.[1];
    const icon = /^Icon=(.+)$/m.exec(entry)?.[1];
    check('the launcher points at something that exists', !!exec && existsSync(exec) && !!icon && existsSync(icon), entry);
  }
  await app.close();

  file('.cache/thumbnails/nouveau.png', 1 * MB);
  file('.cache/pip/garde', 1 * MB);
  file('.local/share/Trash/files/encore.bin', 1 * MB);
  ({ app, page, picker } = await launch());
  check('the language chosen is remembered', !picker && (await page.locator('.nav', { hasText: 'Disques' }).count()) === 1);
  await page.waitForTimeout(1500);
  check('clean on opening empties what is chosen', !existsSync(home('.cache/thumbnails/nouveau.png')));
  check('a choice is remembered between sessions', existsSync(home('.cache/pip/garde')));
  check('clean on opening never empties the bin', existsSync(home('.local/share/Trash/files/encore.bin')));
  await page.getByRole('button', { name: /Nettoyage/ }).click();
  await page.waitForSelector('.targets li');
  check('my folder is still listed', (await page.$$eval('.targets li strong', (els) => els.map((e) => e.textContent))).includes('Dossier-rendu'));
  await app.close();
}

try {
  await main();
} catch (e) {
  failures += 1;
  console.error('FAIL (stopped):', e);
} finally {
  execFileSync('chmod', ['-R', 'u+rwX', base]);
  rmSync(base, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
