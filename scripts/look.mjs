// Read-only look at the real computer: scans and takes pictures, never deletes or cleans anything.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(appDir, 'shots');
mkdirSync(shots, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'clairiere-look-'));

const app = await electron.launch({
  executablePath: join(appDir, 'node_modules/electron/dist/electron'),
  args: ['.', `--user-data-dir=${userData}`],
  cwd: appDir,
});
const page = await app.firstWindow();
await page.waitForSelector('.brand');
const invoke = (name, ...args) => page.evaluate(([n, a]) => window.clairiere.invoke(n, ...a), [name, args]);

async function timed(label, fn) {
  const t = performance.now();
  const r = await fn();
  console.log(`${label}: ${Math.round(performance.now() - t)} ms`);
  return r;
}

await page.waitForTimeout(1500);
await page.screenshot({ path: join(shots, 'real-home.png') });

const t0 = performance.now();
await page.getByRole('button', { name: /Mon dossier personnel/ }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: join(shots, 'real-scanning.png') });
await page.waitForSelector('.row', { timeout: 120000 });
console.log(`click to first results: ${Math.round(performance.now() - t0)} ms`);
await page.waitForTimeout(800);
await page.screenshot({ path: join(shots, 'real-map.png') });
console.log('summary:', (await page.locator('.ex-summary').textContent()).replace(/\s+/g, ' '));

await timed('list of a big folder', () => invoke('view', 0, { depth: 1, maxChildren: 3000 }));
await timed('map of the whole scan', async () => {
  const v = await invoke('view', 0, { depth: 4, minBytes: 30_000_000, maxChildren: 300, budget: 5000 });
  const count = (n) => 1 + (n.children ?? []).reduce((s, c) => s + count(c), 0);
  console.log('  cells:', count(v.node));
});

await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(400);
await page.screenshot({ path: join(shots, 'real-map-dark.png') });
await page.getByRole('button', { name: 'Anneaux' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: join(shots, 'real-rings-dark.png') });
await page.emulateMedia({ colorScheme: 'light' });
await page.waitForTimeout(200);
await page.screenshot({ path: join(shots, 'real-rings.png') });

await page.getByRole('tab', { name: /Projets/ }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: join(shots, 'real-projects.png') });

// Showing the cleaning page measures sizes; it deletes nothing unless a button is pressed.
await page.getByRole('button', { name: /Nettoyage/ }).click();
await page.waitForSelector('.projects li', { timeout: 120000 });
await page.waitForTimeout(500);
await page.screenshot({ path: join(shots, 'real-clean.png') });
const rows = await page.$$eval('.targets:not(.projects) li', (els) =>
  els.map((e) => `${e.querySelector('input')?.checked ? '[x]' : '[ ]'} ${e.querySelector('strong')?.textContent} — ${e.querySelector('.target-size .num')?.textContent}`),
);
console.log(rows.join('\n'));

// Whole disk, stopped right away: the screen must go back to the previous results.
await page.getByRole('button', { name: /Disques/ }).click();
await page.getByRole('button', { name: 'Analyser' }).first().click();
await page.waitForSelector('.scanning');
await page.waitForTimeout(250);
await page.getByRole('button', { name: "Arrêter l'analyse" }).click();
await page.waitForSelector('.scanning', { state: 'detached', timeout: 10000 });
console.log('stop: back to previous results:', await page.locator('.ex-summary strong').textContent());

// Whole disk, to the end.
await page.getByRole('button', { name: /Disques/ }).click();
await page.getByRole('button', { name: 'Analyser' }).first().click();
await page.waitForSelector('.scanning');
await page.waitForSelector('.scanning', { state: 'detached', timeout: 180000 });
await page.waitForTimeout(1000);
console.log('whole disk:', (await page.locator('.ex-summary').textContent()).replace(/\s+/g, ' '));
await page.screenshot({ path: join(shots, 'real-disk.png') });
await app.close();
console.log('home scanned:', homedir());
