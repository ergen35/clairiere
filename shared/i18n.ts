// The languages Clairière speaks, shared by the window and the desktop side.
import { de } from './locales/de';
import { en } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { ko } from './locales/ko';
import { ru } from './locales/ru';
import { zh } from './locales/zh';

/** One phrase, or its forms by quantity (as Intl.PluralRules names them). */
export type Entry = string | { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
export type Key = keyof typeof en;
export type Dict = Record<Key, Entry>;
export type Params = Record<string, string | number>;
export type Translate = (key: Key, params?: Params) => string;

export const LANGUAGES = [
  { code: 'en', name: 'English', locale: 'en-US' },
  { code: 'fr', name: 'Français', locale: 'fr-FR' },
  { code: 'es', name: 'Español', locale: 'es-ES' },
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
  { code: 'zh', name: '中文（简体）', locale: 'zh-CN' },
  { code: 'ko', name: '한국어', locale: 'ko-KR' },
  { code: 'ru', name: 'Русский', locale: 'ru-RU' },
] as const;

export type Lang = (typeof LANGUAGES)[number]['code'];
export const DEFAULT_LANG: Lang = 'en';

const DICTS: Record<Lang, Dict> = { en, fr, es, de, zh, ko, ru };

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && LANGUAGES.some((l) => l.code === value);
}

export function localeOf(lang: Lang): string {
  return LANGUAGES.find((l) => l.code === lang)?.locale ?? 'en-US';
}

export function translator(lang: Lang): Translate {
  const dict = DICTS[lang] ?? en;
  const rules = new Intl.PluralRules(localeOf(lang));
  const numbers = new Intl.NumberFormat(localeOf(lang), { maximumFractionDigits: 1 });
  return (key, params = {}) => {
    const entry: Entry = dict[key] ?? en[key] ?? key;
    let text: string;
    if (typeof entry === 'string') {
      text = entry;
    } else {
      const n = Number(params.n ?? 0);
      text = entry[rules.select(n)] ?? entry.other;
    }
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = params[name];
      if (value === undefined) return whole;
      return typeof value === 'number' ? numbers.format(value) : value;
    });
  };
}
