// The language the desktop side writes its messages in (disk names, clean-up labels, refusals).
import { DEFAULT_LANG, Key, Lang, Params, translator } from '../shared/i18n';

let translate = translator(DEFAULT_LANG);

export function setMainLang(lang: Lang) {
  translate = translator(lang);
}

export function tr(key: Key, params?: Params): string {
  return translate(key, params);
}
