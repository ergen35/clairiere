import { useRef } from 'react';
import type { ScanProgress } from '../shared/types';
import { formatBytes, formatCount, formatDuration, shortPath } from './format';
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
        <h1>Analyse de {shortPath(root, home)}</h1>
        <p className="scan-current" title={p?.current}>{p?.current ? shortPath(p.current, home) : 'Démarrage…'}</p>
      </header>

      {expected ? <Bar value={(p?.bytes ?? 0) / expected} /> : <div className="pulse" role="presentation" />}

      <dl className="scan-figures">
        <div><dt>Trouvé</dt><dd className="num">{formatBytes(p?.bytes ?? 0)}</dd></div>
        <div><dt>Fichiers</dt><dd className="num">{formatCount(p?.files ?? 0)}</dd></div>
        <div><dt>Dossiers</dt><dd className="num">{formatCount(p?.dirs ?? 0)}</dd></div>
        <div><dt>Vitesse</dt><dd className="num">{speed ? `${formatCount(Math.round(speed))} /s` : '—'}</dd></div>
        <div><dt>Temps</dt><dd className="num">{formatDuration(p?.ms ?? 0)}</dd></div>
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

      <button className="btn ghost" onClick={onCancel}>Arrêter l'analyse</button>
    </div>
  );
}
