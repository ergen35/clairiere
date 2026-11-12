import { useEffect, useMemo, useRef, useState } from 'react';
import { Lang, LANGUAGES, localeOf, translator } from '../shared/i18n';
import { Icon } from './ui';

interface Props {
  initial: Lang;
  /** At the very first start there is nothing to go back to: a language must be chosen. */
  first: boolean;
  onChoose(lang: Lang): void;
  onClose(): void;
}

/** Each language is written in its own words, and the card speaks the one being pointed at. */
export function LanguagePicker({ initial, first, onChoose, onClose }: Props) {
  const [picked, setPicked] = useState<Lang>(initial);
  const tr = useMemo(() => translator(picked), [picked]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !first) onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
    // Focus once, when opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = (e: React.KeyboardEvent) => {
    const i = LANGUAGES.findIndex((l) => l.code === picked);
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = LANGUAGES[(i + step + LANGUAGES.length) % LANGUAGES.length].code;
    setPicked(next);
    ref.current?.querySelector<HTMLElement>(`[data-lang="${next}"]`)?.focus();
  };

  return (
    <div className={`modal-back lang-back ${first ? 'first' : ''}`} onMouseDown={(e) => !first && e.target === e.currentTarget && onClose()}>
      <div className="modal lang-card" ref={ref} role="dialog" aria-modal="true" aria-labelledby="lang-title" lang={localeOf(picked)}>
        <div className="lang-head">
          <img src="./icon.svg" alt="" width={40} height={40} />
          <div>
            <h2 id="lang-title">{tr('lang.title')}</h2>
            <p className="muted">{tr('lang.lead')}</p>
          </div>
        </div>
        <div className="lang-grid" role="radiogroup" aria-labelledby="lang-title" onKeyDown={move}>
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              data-lang={l.code}
              role="radio"
              aria-checked={picked === l.code}
              tabIndex={picked === l.code ? 0 : -1}
              className={picked === l.code ? 'lang-option on' : 'lang-option'}
              lang={l.locale}
              onClick={() => setPicked(l.code)}
              onDoubleClick={() => onChoose(l.code)}
            >
              <span className="lang-name">{l.name}</span>
              {picked === l.code && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          {!first && <button className="btn ghost" onClick={onClose}>{tr('common.cancel')}</button>}
          <span className="spacer" />
          <button className="btn primary" onClick={() => onChoose(picked)}>{tr('common.continue')}</button>
        </div>
      </div>
    </div>
  );
}
