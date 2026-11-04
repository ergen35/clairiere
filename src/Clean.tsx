import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artefact, CleanOutcome, CleanProgress, CleanStats, CleanTarget, DeleteItem, DeleteOutcome, TargetGroup } from '../shared/types';
import { api } from './api';
import { ARTEFACT_LABEL } from './Explorer';
import { baseName, formatAge, formatBytes, formatDuration, parentPath, plural, shortPath } from './format';
import { Bar, ConfirmDelete, Icon, Modal } from './ui';

const GROUPS: { id: TargetGroup; title: string }[] = [
  { id: 'quick', title: 'Essentiels' },
  { id: 'browsers', title: 'Navigateurs' },
  { id: 'apps', title: 'Applications' },
  { id: 'dev', title: 'Outils de développement' },
  { id: 'system', title: 'Système' },
  { id: 'custom', title: 'Mes emplacements' },
];

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
          setTargets((prev) => prev.map((t) => (t.id === m.id ? { ...t, bytes: m.unknown ? null : m.bytes, files: m.files } : t)));
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
    setProgress({ targetId: '', label: 'Préparation', freed: 0, index: 0, count: ids.length });
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
        say(`Nettoyage automatique : ${formatBytes(auto.freed)} libérés.`);
        onChanged();
      }
      await refresh();
    })();
    // Once, when the app opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSelected = useCallback((id: string, selected: boolean) => {
    setTargets((prev) => prev.map((t) => (t.id === id ? { ...t, selected } : t)));
    void api.setTargetSelected(id, selected);
  }, []);

  const toClean = targets.filter((t) => t.selected && !t.blockedBy);
  const reclaimable = measuring && targets.every((t) => t.bytes === null) ? null : toClean.reduce((s, t) => s + (t.bytes ?? 0), 0);

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
  return ms ? formatAge(ms / 1000) : 'jamais';
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

  const maxBytes = useMemo(() => Math.max(1, ...targets.map((t) => t.bytes ?? 0)), [targets]);

  const start = (list: CleanTarget[]) => {
    if (list.some((t) => t.risk === 'review' || t.needsPassword)) setAsking(list);
    else void run(list.map((t) => t.id));
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
      say(o.mode === 'trash' ? `${formatBytes(o.moved)} déplacés à la corbeille.` : `${formatBytes(o.freed)} libérés.`);
    }
    if (o.failed.length) say(`${baseName(o.failed[0].path)} : ${o.failed[0].reason}`);
  };

  const pickedItems: DeleteItem[] = (projects ?? []).filter((p) => picked.has(p.path)).map((p) => ({ path: p.path, size: p.bytes }));
  const projectsTotal = (projects ?? []).reduce((s, p) => s + p.bytes, 0);

  return (
    <div className="page clean">
      <section className="hero" aria-live="polite">
        {progress ? (
          <>
            <div className="hero-figure">
              <span className="hero-label">Nettoyage en cours : {progress.label}</span>
              <strong className="num">{formatBytes(progress.freed)}</strong>
              <span className="muted">libérés</span>
            </div>
            <div className="hero-action">
              <Bar value={progress.count ? progress.index / progress.count : 0} />
              <button className="btn ghost" onClick={() => void api.cancelClean()}>Arrêter</button>
            </div>
          </>
        ) : (
          <>
            <div className="hero-figure">
              <span className="hero-label">Votre sélection</span>
              <strong className="num">{reclaimable === null ? '…' : formatBytes(reclaimable)}</strong>
              <span className="muted">
                à récupérer · dernier nettoyage {age(stats?.lastCleanAt)}
                {stats && stats.totalFreed > 0 && <> · {formatBytes(stats.totalFreed)} libérés depuis le début</>}
              </span>
            </div>
            <div className="hero-action">
              <button className="btn primary big" disabled={!toClean.length || measuring} onClick={() => start(toClean)}>
                <Icon name="clean" size={18} /> Nettoyer maintenant
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
                Nettoyer à chaque ouverture de Clairière
                <small>(seulement ce qui se recrée tout seul)</small>
              </label>
            </div>
          </>
        )}
      </section>

      {outcome && !progress && (
        <section className="result">
          <Icon name="check" size={18} />
          <div>
            <strong>{outcome.cancelled ? 'Nettoyage arrêté' : 'Terminé'} : {formatBytes(outcome.freed)} libérés en {formatDuration(outcome.ms)}.</strong>
            {outcome.results.filter((r) => r.note).map((r) => (
              <div key={r.id} className="muted">{r.label} — {r.note}</div>
            ))}
          </div>
          <button className="btn icon-only ghost" aria-label="Fermer" onClick={() => setOutcome(null)}><Icon name="x" /></button>
        </section>
      )}

      {GROUPS.map((g) => {
        const rows = targets.filter((t) => t.group === g.id).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
        if (rows.length === 0 && g.id !== 'custom') return null;
        return (
          <section key={g.id} className="group">
            <h2>{g.title}</h2>
            <ul className="targets">
              {rows.map((t) => (
                <li key={t.id} className={t.selected ? 'on' : ''}>
                  <input
                    type="checkbox"
                    id={`t-${t.id}`}
                    checked={t.selected}
                    onChange={(e) => setSelected(t.id, e.target.checked)}
                  />
                  <label htmlFor={`t-${t.id}`} className="target-main">
                    <span className="target-title">
                      <strong>{t.label}</strong>
                      {t.needsPassword && <em className="chip"><Icon name="lock" size={12} /> mot de passe</em>}
                      {t.blockedBy && <em className="chip warn"><Icon name="warn" size={12} /> {t.blockedBy} est ouvert : ignoré</em>}
                    </span>
                    <small>{t.hint}</small>
                  </label>
                  <span className="target-size">
                    <span className="num">{t.bytes === null ? (measuring ? '…' : 'Inconnu') : formatBytes(t.bytes)}</span>
                    <Bar value={(t.bytes ?? 0) / maxBytes} />
                  </span>
                  <span className="target-actions">
                    <button className="btn small" disabled={!!progress || !!t.blockedBy || t.bytes === 0} onClick={() => start([t])}>Vider</button>
                    {t.group === 'custom' && (
                      <button
                        className="btn small ghost icon-only"
                        aria-label={`Retirer ${t.label} de mes emplacements`}
                        title="Retirer de la liste (le dossier reste en place)"
                        onClick={() => void api.removeCustomTarget(t.id).then(refresh)}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    )}
                  </span>
                </li>
              ))}
              {g.id === 'custom' && (
                <li className="add-row">
                  <button className="btn ghost" onClick={() => void addFolder()}><Icon name="plus" /> Ajouter un dossier à vider régulièrement</button>
                </li>
              )}
            </ul>
          </section>
        );
      })}

      <section className="group">
        <h2>
          Dossiers de projets recréables
          {projects && projects.length > 0 && <small className="num"> {formatBytes(projectsTotal)}</small>}
        </h2>
        <p className="group-note">
          Dépendances et résultats de compilation de vos projets, dans votre dossier personnel. Un projet les recrée à sa prochaine installation : choisissez ceux que vous n'utilisez plus.
        </p>
        {lookingProjects && <p className="muted loading">Recherche dans votre dossier personnel…</p>}
        {projects && projects.length === 0 && !lookingProjects && <p className="empty">Aucun trouvé.</p>}
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
                    <em className="chip">{ARTEFACT_LABEL[p.kind]}</em>
                  </span>
                  <small title={p.path}>{shortPath(p.path, home)} · modifié {formatAge(p.mtime)}</small>
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
            <span>{plural(pickedItems.length, 'dossier choisi', 'dossiers choisis')} · <strong className="num">{formatBytes(pickedItems.reduce((s, i) => s + i.size, 0))}</strong></span>
            <button className="btn danger" onClick={() => setConfirmProjects(pickedItems)}><Icon name="trash" /> Supprimer…</button>
          </div>
        )}
      </section>

      {asking && (
        <Modal title="Vider ces emplacements ?" onClose={() => setAsking(null)}>
          <ul className="confirm-list">
            {asking.map((t) => (
              <li key={t.id}>
                <span className="confirm-path">{t.label}</span>
                <span className="num">{t.bytes === null ? '—' : formatBytes(t.bytes)}</span>
                {t.risk === 'review' && <em className="warn"><Icon name="warn" size={13} /> {t.hint}</em>}
                {t.needsPassword && <em><Icon name="lock" size={13} /> Le système vous demandera votre mot de passe.</em>}
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <button className="btn ghost" data-autofocus onClick={() => setAsking(null)}>Annuler</button>
            <span className="spacer" />
            <button
              className="btn primary"
              onClick={() => {
                const ids = asking.map((t) => t.id);
                setAsking(null);
                void run(ids);
              }}
            >
              Vider
            </button>
          </div>
        </Modal>
      )}
      {confirmProjects && <ConfirmDelete items={confirmProjects} home={home} onClose={() => setConfirmProjects(null)} onDone={afterProjects} />}
    </div>
  );
}
