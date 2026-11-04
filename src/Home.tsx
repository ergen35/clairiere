import { useEffect, useState } from 'react';
import type { DiskInfo } from '../shared/types';
import { api } from './api';
import { formatBytes, formatPercent, shortPath } from './format';
import { Bar, Icon, usageTone } from './ui';

interface Props {
  disks: DiskInfo[];
  home: string;
  reclaimable: number | null;
  onScan(path: string): void;
  onClean(): void;
}

export function Home({ disks, home, reclaimable, onScan, onClean }: Props) {
  const [canInstall, setCanInstall] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    void api.launcherInstalled().then((yes) => setCanInstall(!yes));
  }, []);

  const tight = disks.find((d) => usageTone(d.used, d.total) === 'crit' && d.total > 8e9);

  const pick = async () => {
    const path = await api.pickFolder();
    if (path) onScan(path);
  };

  return (
    <div className="page home">
      <header className="page-head">
        <h1>Vos disques</h1>
        <p>Choisissez ce qu'il faut analyser. Les résultats arrivent en quelques secondes.</p>
      </header>

      {tight && (
        <section className="alert">
          <Icon name="warn" size={20} />
          <div>
            <strong>
              {tight.system ? 'Votre disque système' : tight.label} est plein à {formatPercent(tight.used, tight.total)}.
            </strong>{' '}
            Il ne reste que {formatBytes(tight.free)}
            {reclaimable ? <>, et {formatBytes(reclaimable)} de caches peuvent partir tout de suite.</> : '.'}
          </div>
          <button className="btn primary" onClick={onClean}>Faire de la place</button>
        </section>
      )}

      <ul className="disk-list">
        {disks.map((d) => {
          const tone = usageTone(d.used, d.total);
          return (
            <li key={d.id} className="disk">
              <div className="disk-main">
                <div className="disk-name">
                  <Icon name="disk" size={18} />
                  <strong>{d.label}</strong>
                  <span className="muted">{d.mount} · {d.detail}</span>
                </div>
                <Bar value={d.used / d.total} tone={tone} />
                <div className="disk-figures">
                  <span><strong className="num">{formatBytes(d.free)}</strong> libres</span>
                  <span className="muted num">{formatBytes(d.used)} utilisés sur {formatBytes(d.total)}</span>
                </div>
              </div>
              <button className="btn" onClick={() => onScan(d.mount)}>Analyser</button>
            </li>
          );
        })}
        {disks.length === 0 && <li className="empty">Aucun disque trouvé.</li>}
      </ul>

      <div className="shortcuts">
        <button className="shortcut" onClick={() => onScan(home)}>
          <Icon name="home" size={18} />
          <span>
            <strong>Mon dossier personnel</strong>
            <small className="muted">{shortPath(home, home) || home} : c'est souvent là que tout se cache</small>
          </span>
          <Icon name="chevron" />
        </button>
        <button className="shortcut" onClick={() => void pick()}>
          <Icon name="folder" size={18} />
          <span>
            <strong>Un autre dossier…</strong>
            <small className="muted">Analyser seulement ce qui vous intéresse</small>
          </span>
          <Icon name="chevron" />
        </button>
      </div>

      {canInstall && !installed && (
        <p className="foot-note">
          <button
            className="link"
            onClick={() => {
              void api.installLauncher().then(() => setInstalled(true));
            }}
          >
            Ajouter Clairière au menu des applications
          </button>{' '}
          pour la retrouver sans passer par ici.
        </p>
      )}
      {installed && <p className="foot-note">Clairière est maintenant dans le menu des applications.</p>}
    </div>
  );
}
