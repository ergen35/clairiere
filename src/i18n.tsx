import { createContext, Fragment, ReactNode, useContext } from 'react';
import { DEFAULT_LANG, Key, Lang, localeOf, Params, translator } from '../shared/i18n';

let current: Lang = DEFAULT_LANG;
let translate = translator(current);

/** Switches every phrase and number format; the whole window re-renders right after. */
export function applyLang(lang: Lang) {
  current = lang;
  translate = translator(lang);
  document.documentElement.lang = localeOf(lang);
}

export function currentLang(): Lang {
  return current;
}

export function currentLocale(): string {
  return localeOf(current);
}

export function t(key: Key, params?: Params): string {
  return translate(key, params);
}

/** A phrase for a quantity: picks the right plural form for the language. */
export function tn(key: Key, n: number, params: Params = {}): string {
  return translate(key, { ...params, n });
}

/** Turns **these words** into bold text. */
export function rich(text: string): ReactNode {
  const parts = text.split('**');
  return parts.map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>));
}

export const LangContext = createContext<Lang>(DEFAULT_LANG);

/** For drawings that must be redone when the language changes. */
export function useLang(): Lang {
  return useContext(LangContext);
}
