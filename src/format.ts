const one = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/** Sizes in the units the system's file manager uses: 1 Go = 1000 Mo. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${whole.format(bytes)} o`;
  const units = ['Ko', 'Mo', 'Go', 'To', 'Po'];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? whole.format(value) : one.format(value)} ${units[unit]}`;
}

export function formatCount(n: number): string {
  return whole.format(n);
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(n)} ${n > 1 ? pluralForm : singular}`;
}

export function formatPercent(part: number, total: number): string {
  if (total <= 0) return '0 %';
  const p = (part / total) * 100;
  if (p > 0 && p < 0.1) return '< 0,1 %';
  return `${p >= 10 ? whole.format(p) : one.format(p)} %`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${whole.format(ms)} ms`;
  if (ms < 60_000) return `${one.format(ms / 1000)} s`;
  const min = Math.floor(ms / 60_000);
  return `${min} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** "il y a 3 jours", from a time in seconds. */
export function formatAge(seconds: number | undefined): string {
  if (!seconds) return '—';
  const days = (Date.now() / 1000 - seconds) / 86400;
  if (days < 1 / 24) return "à l'instant";
  if (days < 1) return `il y a ${Math.round(days * 24)} h`;
  if (days < 30) return `il y a ${Math.round(days)} j`;
  if (days < 365) return `il y a ${Math.round(days / 30)} mois`;
  const years = Math.round(days / 365);
  return `il y a ${years} an${years > 1 ? 's' : ''}`;
}

export function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? base + name : `${base}/${name}`;
}

export function baseName(path: string): string {
  return path === '/' ? '/' : path.split('/').filter(Boolean).pop() ?? path;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

/** Replaces the home folder with ~ to keep long paths readable. */
export function shortPath(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}
