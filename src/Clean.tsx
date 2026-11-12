import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artefact, CleanOutcome, CleanProgress, CleanStats, CleanTarget, DeleteItem, DeleteOutcome, TargetGroup } from '../shared/types';
import { api } from './api';
import { artefactLabel } from './Explorer';
import { baseName, formatAge, formatBytes, formatDuration, parentPath, shortPath } from './format';
import { t, tn } from './i18n';
import { Bar, ConfirmDelete, Icon, Modal } from './ui';

const GROUPS: TargetGroup[] = ['quick', 'browsers', 'apps', 'dev', 'system', 'custom'];

export function useCleaning(onChanged: () => void, say: (text: string) => void) {
  const [targets, setTargets] = useState<CleanTarget[]>([]);
  const [measuring, setMeasuring] = useState(true);
  const [stats, setStats] = useState<CleanStats | null>(null);
  const [progress, setProgress] = useState<CleanProgress | null>(null);
  const [outcome, setOutcome] = useState<CleanOutcome | null>(null);

  const busy = useRef(false);
  const again = useRef(false);

  // One measurement at a time: a request during one simply triggers another round after it.
  const refresh = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    setMeasuring(true);
    try {
      do {
        again.current = false;
        const list = await api.cleanTargets();
        setTargets(list);
        await api.measureTargets((m) => {
          setTargets((prev) => prev.map((x) => (x.id === m.id ? { ...x, bytes: m.unknown ? null : m.bytes, files: m.files } : x)));
        });
      } while (again.current);
      setStats(await api.stats());
    } finally {
      busy.current = false;
      setMeasuring(false);
    }
  }, []);

  const run = useCallback(async (ids: string[]) => {
    setOutcome(null);
    setProgress({ targetId: '', label: t('clean.preparing'), freed: 0, index: 0, count: ids.length });
    try {
      const result = await api.cleanRun(ids, setProgress);
      setOutcome(result);
      onChanged();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setProgress(null);
      void refresh();
    }
  }, [onChanged, refresh, say]);

  useEffect(() => {
    void (async () => {
      const auto = await api.runAutoClean();
      if (auto && auto.freed > 0) {
        say(t('clean.autoDone', { size: formatBytes(auto.freed) }));
        onChanged();
      }
      await refresh();
    })();
    // Once, when the app opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSelected = useCallback((id: string, selected: boolean) => {
    setTargets((prev) => prev.map((x) => (x.id === id ? { ...x, selected } : x)));
    void api.setTargetSelected(id, selected);
  }, []);

  const toClean = targets.filter((x) => x.selected && !x.blockedBy);
  const reclaimable = measuring && targets.every((x) => x.bytes === null) ? null : toClean.reduce((sum, x) => sum + (x.bytes ?? 0), 0);

  return { targets, measuring, stats, setStats, progress, outcome, setOutcome, refresh, run, setSelected, toClean, reclaimable };
}

export type Cleaning = ReturnType<typeof useCleaning>;

interface Props {
  cleaning: Cleaning;
  home: string;
  say(text: string): void;
  onChanged(): void;
}

function age(ms: number | null | undefined) {
  return ms ? formatAge(ms / 1000) : t('clean.never');
}

export function Clean({ cleaning, home, say, onChanged }: Props) {
  const { targets, measuring, stats, setStats, progress, outcome, setOutcome, refresh, run, setSelected, toClean, reclaimable } = cleaning;
  const [asking, setAsking] = useState<CleanTarget[] | null>(null);
  const [projects, setProjects] = useState<Artefact[] | null>(null);
  const [lookingProjects, setLookingProjects] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirmProjects, setConfirmProjects] = useState<DeleteItem[] | null>(null);

  const look = useCallback(async () => {
    setLookingProjects(true);
    try {
      setProjects(await api.findProjects());
    } finally {
      setLookingProjects(false);
    }
  }, []);

  useEffect(() => {
    void look();
  }, [look]);

  const maxBytes = useMemo(() => Math.max(1, ...targets.map((x) => x.bytes ?? 0)), [targets]);

  const start = (list: CleanTarget[]) => {
    if (list.some((x) => x.risk === 'review' || x.needsPassword)) setAsking(list);
    else void run(list.map((x) => x.id));
  };

  const addFolder = async () => {
    const path = await api.pickFolder();
    if (!path) return;
    const why = await api.addCustomTarget(path);
    if (why) say(why);
    else void refresh();
  };

  const afterProjects = (o: DeleteOutcome) => {
    setConfirmProjects(null);
    setPicked(new Set());
    setProjects((prev) => prev?.filter((p) => !o.done.includes(p.path)) ?? null);
    onChanged();
    if (o.done.length) {
      say(o.mode === 'trash' ? t('toast.movedSize', { size: formatBytes(o.moved) }) : t('toast.freed', { size: formatBytes(o.freed) }));
    }
    if (o.failed.length) say(t('toast.failed', { name: baseName(o.failed[0].path), reason: o.failed[0].reason }));
  };

  const pickedItems: DeleteItem[] = (projects ?? []).filter((p) => picked.has(p.path)).map((p) => ({ path: p.path, size: p.bytes }));
  const projectsTotal = (projects ?? []).reduce((s, p) => s + p.bytes, 0);

  return (
    <div className="page clean">
      <section className="hero" aria-live="polite">
        {progress ? (
          <>
            <div className="hero-figure">
              <span className="hero-label">{t('clean.running', { label: progress.label })}</span>
              <strong className="num">{formatBytes(progress.freed)}</strong>
              <span className="muted">{t('clean.freedWord')}</span>
            </div>
            <div className="hero-action">
              <Bar value={progress.count ? progress.index / progress.count : 0} />
              <button className="btn ghost" onClick={() => void api.cancelClean()}>{t('clean.stop')}</button>
            </div>
          </>
        ) : (
          <>
            <div className="hero-figure">
              <span className="hero-label">{t('clean.selection')}</span>
              <strong className="num">{reclaimable === null ? '…' : formatBytes(reclaimable)}</strong>
              <span className="muted">
                {t('clean.toRecover', { age: age(stats?.lastCleanAt) })}
                {stats && stats.totalFreed > 0 && t('clean.sinceStart', { size: formatBytes(stats.totalFreed) })}
              </span>
            </div>
            <div className="hero-action">
              <button className="btn primary big" disabled={!toClean.length || measuring} onClick={() => start(toClean)}>
                <Icon name="clean" size={18} /> {t('clean.now')}
              </button>
              <label className="auto">
                <input
                  type="checkbox"
                  checked={stats?.autoClean ?? false}
                  onChange={(e) => {
                    const on = e.target.checked;
                    if (stats) setStats({ ...stats, autoClean: on });
                    void api.setAutoClean(on);
                  }}
                />
                {t('clean.auto')}
                <small>{t('clean.autoHint')}</small>
              </label>
            </div>
          </>
        )}
      </section>

      {outcome && !progress && (
        <section className="result">
          <Icon name="check" size={18} />
          <div>
            <strong>{t(outcome.cancelled ? 'clean.summaryStopped' : 'clean.summaryDone', { size: formatBytes(outcome.freed), time: formatDuration(outcome.ms) })}</strong>
            {outcome.results.filter((r) => r.note).map((r) => (
              <div key={r.id} className="muted">{r.label} — {r.note}</div>
            ))}
          </div>
          <button className="btn icon-only ghost" aria-label={t('common.close')} onClick={() => setOutcome(null)}><Icon name="x" /></button>
        </section>
      )}

      {GROUPS.map((g) => {
        const rows = targets.filter((x) => x.group === g).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
        if (rows.length === 0 && g !== 'custom') return null;
        return (
          <section key={g} className="group">
            <h2>{t(`group.${g}`)}</h2>
            <ul className="targets">
              {rows.map((row) => (
                <li key={row.id} className={row.selected ? 'on' : ''}>
                  <input
                    type="checkbox"
                    id={`t-${row.id}`}
                    checked={row.selected}
                    onChange={(e) => setSelected(row.id, e.target.checked)}
                  />
                  <label htmlFor={`t-${row.id}`} className="target-main">
                    <span className="target-title">
                      <strong>{row.label}</strong>
                      {row.needsPassword && <em className="chip"><Icon name="lock" size={12} /> {t('chip.password')}</em>}
                      {row.blockedBy && <em className="chip warn"><Icon name="warn" size={12} /> {t('chip.blocked', { name: row.blockedBy })}</em>}
                    </span>
                    <small>{row.hint}</small>
                  </label>
                  <span className="target-size">
                    <span className="num">{row.bytes === null ? (measuring ? '…' : t('size.unknown')) : formatBytes(row.bytes)}</span>
                    <Bar value={(row.bytes ?? 0) / maxBytes} />
                  </span>
                  <span className="target-actions">
                    <button className="btn small" disabled={!!progress || !!row.blockedBy || row.bytes === 0} onClick={() => start([row])}>{t('clean.empty')}</button>
                    {row.group === 'custom' && (
                      <button
                        className="btn small ghost icon-only"
                        aria-label={t('clean.removeCustom', { label: row.label })}
                        title={t('clean.removeCustomTitle')}
                        onClick={() => void api.removeCustomTarget(row.id).then(refresh)}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    )}
                  </span>
                </li>
              ))}
              {g === 'custom' && (
                <li className="add-row">
                  <button className="btn ghost" onClick={() => void addFolder()}><Icon name="plus" /> {t('clean.addFolder')}</button>
                </li>
              )}
            </ul>
          </section>
        );
      })}

      <section className="group">
        <h2>
          {t('projects.title')}
          {projects && projects.length > 0 && <small className="num"> {formatBytes(projectsTotal)}</small>}
        </h2>
        <p className="group-note">
          {t('projects.note')}
        </p>
        {lookingProjects && <p className="muted loading">{t('projects.looking')}</p>}
        {projects && projects.length === 0 && !lookingProjects && <p className="empty">{t('projects.none')}</p>}
        {projects && projects.length > 0 && (
          <ul className="targets projects">
            {projects.slice(0, 200).map((p) => (
              <li key={p.path} className={picked.has(p.path) ? 'on' : ''}>
                <input
                  type="checkbox"
                  id={`p-${p.id}`}
                  disabled={p.lossy}
                  checked={picked.has(p.path)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(p.path);
                    else next.delete(p.path);
                    setPicked(next);
                  }}
                />
                <label htmlFor={`p-${p.id}`} className="target-main">
                  <span className="target-title">
                    <strong>{baseName(parentPath(p.path))}</strong>
                    <em className="chip">{artefactLabel(p.kind)}</em>
                  </span>
                  <small title={p.path}>{t('projects.modified', { path: shortPath(p.path, home), age: formatAge(p.mtime) })}</small>
                </label>
                <span className="target-size">
                  <span className="num">{formatBytes(p.bytes)}</span>
                  <Bar value={p.bytes / (projects[0]?.bytes || 1)} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {pickedItems.length > 0 && (
          <div className="project-actions">
            <span>{tn('projects.picked', pickedItems.length)} · <strong className="num">{formatBytes(pickedItems.reduce((s, i) => s + i.size, 0))}</strong></span>
            <button className="btn danger" onClick={() => setConfirmProjects(pickedItems)}><Icon name="trash" /> {t('action.delete')}</button>
          </div>
        )}
      </section>

      {asking && (
        <Modal title={t('clean.confirmTitle')} onClose={() => setAsking(null)}>
          <ul className="confirm-list">
            {asking.map((row) => (
              <li key={row.id}>
                <span className="confirm-path">{row.label}</span>
                <span className="num">{row.bytes === null ? '—' : formatBytes(row.bytes)}</span>
                {row.risk === 'review' && <em className="warn"><Icon name="warn" size={13} /> {row.hint}</em>}
                {row.needsPassword && <em><Icon name="lock" size={13} /> {t('clean.passwordNote')}</em>}
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <button className="btn ghost" data-autofocus onClick={() => setAsking(null)}>{t('common.cancel')}</button>
            <span className="spacer" />
            <button
              className="btn primary"
              onClick={() => {
                const ids = asking.map((x) => x.id);
                setAsking(null);
                void run(ids);
              }}
            >
              {t('clean.empty')}
            </button>
          </div>
        </Modal>
      )}
      {confirmProjects && <ConfirmDelete items={confirmProjects} home={home} onClose={() => setConfirmProjects(null)} onDone={afterProjects} />}
    </div>
  );
}
