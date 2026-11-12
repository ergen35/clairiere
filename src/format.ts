import { currentLocale, t, tn } from './i18n';

const cache = new Map<string, Intl.NumberFormat>();
function nf(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${currentLocale()}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(currentLocale(), options);
    cache.set(key, f);
  }
  return f;
}

const one = () => nf({ maximumFractionDigits: 1 });
/** Always one decimal: figures that keep changing keep the same layout ("4.0", never "4"). */
const oneFixed = () => nf({ minimumFractionDigits: 1, maximumFractionDigits: 1 });
const whole = () => nf({ maximumFractionDigits: 0 });

/** Sizes in the units file managers use: 1 GB = 1000 MB. `steady` keeps the decimal ("61.0 GB"). */
export function formatBytes(bytes: number, steady = false): string {
  const units = t('units').split(',');
  if (bytes < 1000) return `${whole().format(bytes)} ${units[0]}`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? whole().format(value) : (steady ? oneFixed() : one()).format(value)} ${units[unit]}`;
}

export function formatCount(n: number): string {
  return whole().format(n);
}

export function formatPercent(part: number, total: number): string {
  const pct = (digits: number) => nf({ style: 'percent', maximumFractionDigits: digits });
  if (total <= 0) return pct(0).format(0);
  const p = part / total;
  if (p > 0 && p < 0.001) return `< ${pct(1).format(0.001)}`;
  return p >= 0.1 ? pct(0).format(p) : pct(1).format(p);
}

function unit(u: string, value: number, digits = 0, steady = false) {
  return nf({ style: 'unit', unit: u, unitDisplay: 'short', maximumFractionDigits: digits, minimumFractionDigits: steady ? digits : 0 }).format(value);
}

/** `steady` keeps the decimal of the seconds ("4.0 s"), for a clock that keeps running. */
export function formatDuration(ms: number, steady = false): string {
  if (ms < 1000 && !steady) return unit('millisecond', Math.round(ms));
  if (ms < 60_000) return unit('second', Math.floor(ms / 100) / 10, 1, steady);
  const min = Math.floor(ms / 60_000);
  return `${unit('minute', min)} ${unit('second', Math.round((ms % 60_000) / 1000))}`;
}

/** "3 days ago", from a time in seconds. */
export function formatAge(seconds: number | undefined): string {
  if (!seconds) return '—';
  const days = (Date.now() / 1000 - seconds) / 86400;
  if (days < 1 / 24) return t('age.now');
  const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto', style: 'short' });
  if (days < 1) return rtf.format(-Math.round(days * 24), 'hour');
  if (days < 30) return rtf.format(-Math.round(days), 'day');
  if (days < 365) return rtf.format(-Math.round(days / 30), 'month');
  return rtf.format(-Math.round(days / 365), 'year');
}

/** "3 files", "1 folder"… in the current language. */
export function count(key: 'count.file' | 'count.folder' | 'count.item' | 'count.smallItems', n: number): string {
  return tn(key, n);
}

// ----- Paths: "/home/me/x" on Linux and macOS, "C:\Users\me\x" on Windows -----

function sepOf(path: string): '/' | '\\' {
  return /^[A-Za-z]:\\|^\\\\/.test(path) || (path.includes('\\') && !path.includes('/')) ? '\\' : '/';
}

function isRoot(path: string): boolean {
  return path === '/' || /^[A-Za-z]:\\?$/.test(path);
}

export function joinPath(base: string, name: string): string {
  const sep = sepOf(base);
  return base.endsWith(sep) ? base + name : `${base}${sep}${name}`;
}

export function baseName(path: string): string {
  if (isRoot(path)) return path;
  return path.split(sepOf(path)).filter(Boolean).pop() ?? path;
}

export function parentPath(path: string): string {
  const sep = sepOf(path);
  const i = path.lastIndexOf(sep);
  if (i <= 0) return sep === '/' ? '/' : path;
  const parent = path.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** True when `path` is `folder` itself or somewhere inside it. */
export function isInside(path: string, folder: string): boolean {
  if (path === folder) return true;
  const sep = sepOf(folder);
  const prefix = folder.endsWith(sep) ? folder : folder + sep;
  return sep === '\\' ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix);
}

/** Replaces the home folder with ~ to keep long paths readable. */
export function shortPath(path: string, home: string): string {
  return home && isInside(path, home) ? `~${path.slice(home.length)}` : path;
}
