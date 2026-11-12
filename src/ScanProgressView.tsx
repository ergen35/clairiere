import { useRef } from 'react';
import type { ScanProgress } from '../shared/types';
import { formatBytes, formatCount, formatDuration, shortPath } from './format';
import { t } from './i18n';
import { Rolling } from './Rolling';
import { Bar } from './ui';

interface Props {
  root: string;
  home: string;
  progress: ScanProgress | null;
  /** How full the disk says it is, when analysing a whole disk. */
  expected?: number;
  onCancel(): void;
}

export function ScanProgressView({ root, home, progress, expected, onCancel }: Props) {
  const p = progress;
  const maxTop = p?.top[0]?.bytes ?? 1;
  // Bars keep their place while the numbers climb, so the eye can follow them.
  const order = useRef(new Map<string, number>());
  const speed = p && p.ms > 200 ? (p.files / p.ms) * 1000 : 0;

  return (
    <div className="page scanning" aria-live="polite">
      <header className="page-head">
        <h1>{t('scan.title', { path: shortPath(root, home) })}</h1>
        <p className="scan-current" title={p?.current}>{p?.current ? shortPath(p.current, home) : t('scan.starting')}</p>
      </header>

      {expected ? <Bar value={(p?.bytes ?? 0) / expected} /> : <div className="pulse" role="presentation" />}

      <dl className="scan-figures">
        <div><dt>{t('scan.found')}</dt><dd className="num"><Rolling text={formatBytes(p?.bytes ?? 0, true)} /></dd></div>
        <div><dt>{t('scan.files')}</dt><dd className="num"><Rolling text={formatCount(p?.files ?? 0)} /></dd></div>
        <div><dt>{t('scan.dirs')}</dt><dd className="num"><Rolling text={formatCount(p?.dirs ?? 0)} /></dd></div>
        <div><dt>{t('scan.speed')}</dt><dd className="num"><Rolling text={speed ? t('scan.perSecond', { n: formatCount(Math.round(speed)) }) : '—'} /></dd></div>
        <div><dt>{t('scan.time')}</dt><dd className="num"><Rolling text={formatDuration(p?.ms ?? 0, true)} /></dd></div>
      </dl>

      <ul className="scan-top">
        {(p?.top ?? []).slice(0, 10).map((t) => {
          if (!order.current.has(t.name)) order.current.set(t.name, order.current.size);
          return (
            <li key={t.name}>
              <span className="scan-top-name" title={t.name}>{t.name}</span>
              <Bar value={t.bytes / maxTop} />
              <span className="num">{formatBytes(t.bytes)}</span>
            </li>
          );
        })}
      </ul>

      <button className="btn ghost" onClick={onCancel}>{t('scan.stop')}</button>
    </div>
  );
}
