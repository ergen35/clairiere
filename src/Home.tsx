import { useEffect, useState } from 'react';
import type { DiskInfo } from '../shared/types';
import { api } from './api';
import { formatBytes, formatPercent, shortPath } from './format';
import { rich, t } from './i18n';
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
        <h1>{t('home.title')}</h1>
        <p>{t('home.lead')}</p>
      </header>

      {tight && (
        <section className="alert">
          <Icon name="warn" size={20} />
          <div>
            <strong>
              {tight.system
                ? t('home.tightSystem', { percent: formatPercent(tight.used, tight.total) })
                : t('home.tightOther', { label: tight.label, percent: formatPercent(tight.used, tight.total) })}
            </strong>{' '}
            {reclaimable
              ? t('home.leftReclaim', { free: formatBytes(tight.free), reclaim: formatBytes(reclaimable) })
              : t('home.left', { free: formatBytes(tight.free) })}
          </div>
          <button className="btn primary" onClick={onClean}>{t('home.makeRoom')}</button>
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
                  <span className="num">{rich(t('disk.free', { size: formatBytes(d.free) }))}</span>
                  <span className="muted num">{t('disk.usedOf', { used: formatBytes(d.used), total: formatBytes(d.total) })}</span>
                </div>
              </div>
              <button className="btn" onClick={() => onScan(d.mount)}>{t('disk.analyse')}</button>
            </li>
          );
        })}
        {disks.length === 0 && <li className="empty">{t('disk.none')}</li>}
      </ul>

      <div className="shortcuts">
        <button className="shortcut" onClick={() => onScan(home)}>
          <Icon name="home" size={18} />
          <span>
            <strong>{t('home.homeFolder')}</strong>
            <small className="muted">{t('home.homeHint', { path: shortPath(home, home) || home })}</small>
          </span>
          <Icon name="chevron" />
        </button>
        <button className="shortcut" onClick={() => void pick()}>
          <Icon name="folder" size={18} />
          <span>
            <strong>{t('home.otherFolder')}</strong>
            <small className="muted">{t('home.otherHint')}</small>
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
            {t('home.launcherAdd')}
          </button>
          {t('home.launcherRest')}
        </p>
      )}
      {installed && <p className="foot-note">{t('home.launcherDone')}</p>}
    </div>
  );
}
