import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artefact, ArtefactKind, DeleteItem, DeleteOutcome, Platform, ScanResult, TreeNode, ViewResult } from '../shared/types';
import { api } from './api';
import { FolderMap, MapHit, MapMode } from './FolderMap';
import { baseName, count, formatAge, formatBytes, formatCount, formatDuration, formatPercent, isInside, joinPath, parentPath, shortPath } from './format';
import { t, tn } from './i18n';
import { mapTheme, slotColor } from './palette';
import { Bar, ConfirmDelete, ContextMenu, Icon, MenuAction } from './ui';

const ROW = 30;

interface Row {
  key: string;
  node: TreeNode;
  path: string;
  level: number;
  parentSize: number;
  slot: number;
  deletable: boolean;
}

export function artefactLabel(kind: ArtefactKind): string {
  return t(`art.${kind}`);
}

const REVEAL = { linux: 'menu.revealLinux', darwin: 'menu.revealMac', win32: 'menu.revealWin' } as const;

interface Props {
  result: ScanResult;
  home: string;
  platform: Platform;
  onSummary(outcome: DeleteOutcome): void;
  onRescan(): void;
  onAddRegular(path: string): void;
  say(text: string): void;
}

type Tab = 'folders' | 'files' | 'projects';

export function Explorer({ result, home, platform, onSummary, onRescan, onAddRegular, say }: Props) {
  const [nodeId, setNodeId] = useState(0);
  const [list, setList] = useState<ViewResult | null>(null);
  const [mapData, setMapData] = useState<ViewResult | null>(null);
  const [mode, setMode] = useState<MapMode>('blocks');
  const [tab, setTab] = useState<Tab>('folders');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [kids, setKids] = useState<Map<number, TreeNode[]>>(new Map());
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const [hoverPath, setHoverPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; actions: MenuAction[] } | null>(null);
  const [confirm, setConfirm] = useState<DeleteItem[] | null>(null);
  const [version, setVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(500);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const token = useRef(0);

  useEffect(() => {
    setNodeId(0);
    setExpanded(new Set());
    setKids(new Map());
    setSelected(new Map());
    setVersion((v) => v + 1);
  }, [result.root, result.ms]);

  useEffect(() => {
    const mine = ++token.current;
    void (async () => {
      const l = await api.view(nodeId, { depth: 1, maxChildren: 3000 });
      if (mine !== token.current) return;
      setList(l);
      setActive(0);
      const min = Math.ceil(l.node.size * 0.0006);
      const m = await api.view(nodeId, { depth: 4, minBytes: min, maxChildren: 300, budget: 5000 });
      if (mine !== token.current) return;
      setMapData(m);
    })().catch((e: Error) => say(e.message));
  }, [nodeId, version, say]);

  // Folders opened in the list stay open after a deletion, with fresh content.
  useEffect(() => {
    if (expanded.size === 0) return;
    const ids = [...expanded];
    void Promise.all(ids.map((id) => api.view(id, { depth: 1, maxChildren: 3000 }).catch(() => null))).then((views) => {
      setKids(new Map(views.flatMap((v, i) => (v ? [[ids[i], v.node.children ?? []] as [number, TreeNode[]]] : []))));
    });
    // Only when the data changed; opening one folder is handled in toggle().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewHeight(el.clientHeight));
    ro.observe(el);
    setViewHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [tab]);

  const toggle = useCallback((node: TreeNode) => {
    if (node.id === undefined) return;
    const id = node.id;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        void api.view(id, { depth: 1, maxChildren: 3000 }).then((v) => {
          setKids((k) => new Map(k).set(id, v.node.children ?? []));
        }).catch((e: Error) => say(e.message));
      }
      return next;
    });
  }, [say]);

  const open = useCallback((node: TreeNode) => {
    if (node.kind === 'dir' && node.id !== undefined && node.hasChildren) {
      setNodeId(node.id);
      listRef.current?.scrollTo({ top: 0 });
      setScrollTop(0);
    }
  }, []);

  const rows = useMemo(() => {
    const out: Row[] = [];
    if (!list) return out;
    const base = list.path;
    const walk = (children: TreeNode[], parent: string, level: number, parentSize: number, slotBase: number, lossy: boolean) => {
      children.forEach((node, i) => {
        const slot = level === 0 ? (node.kind === 'other' ? -1 : i) : slotBase;
        const path = node.kind === 'other' ? `${parent}#other` : joinPath(parent, node.name);
        const nodeLossy = lossy || !!node.lossy;
        out.push({ key: path, node, path, level, parentSize, slot, deletable: node.kind !== 'other' && !nodeLossy });
        if (node.id !== undefined && expanded.has(node.id)) {
          const inner = kids.get(node.id);
          if (inner) walk(inner, path, level + 1, node.size, slot, nodeLossy);
        }
      });
    };
    walk(list.node.children ?? [], base, 0, list.node.size, -1, list.pathLossy);
    return out;
  }, [list, kids, expanded]);

  const theme = mapTheme();

  const toggleSelect = (path: string, size: number) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(path)) next.delete(path);
      else next.set(path, size);
      return next;
    });
  };

  // A folder and something inside it count once.
  const topSelected = useMemo(() => {
    const paths = [...selected.keys()];
    return paths.filter((p) => !paths.some((q) => q !== p && isInside(p, q))).map((path) => ({ path, size: selected.get(path)! }));
  }, [selected]);
  const selectedTotal = topSelected.reduce((s, i) => s + i.size, 0);

  const afterDelete = (outcome: DeleteOutcome) => {
    setConfirm(null);
    setSelected(new Map());
    onSummary(outcome);
    setVersion((v) => v + 1);
    const done = outcome.done.length;
    if (done) {
      say(outcome.mode === 'trash'
        ? tn('toast.movedItems', done, { size: formatBytes(outcome.moved) })
        : t('toast.freed', { size: formatBytes(outcome.freed) }));
    }
    if (outcome.failed.length) say(t('toast.failed', { name: baseName(outcome.failed[0].path), reason: outcome.failed[0].reason }));
  };

  const menuFor = (item: { path: string; size: number; isDir: boolean; node?: TreeNode; lossy?: boolean }, x: number, y: number) => {
    const actions: MenuAction[] = [];
    if (item.node?.kind === 'dir' && item.node.hasChildren) {
      actions.push({ label: t('menu.enter'), icon: 'map', run: () => open(item.node!) });
    }
    actions.push(
      { label: t('menu.open'), icon: 'open', disabled: item.lossy, run: () => void api.open(item.path) },
      { label: t(REVEAL[platform]), icon: 'folder', disabled: item.lossy, run: () => void api.reveal(item.path) },
      { label: t('menu.copy'), icon: 'file', run: () => void api.copyPath(item.path).then(() => say(t('toast.copied'))) },
    );
    if (item.isDir) {
      actions.push({ label: t('menu.addRegular'), icon: 'clean', disabled: item.lossy, run: () => onAddRegular(item.path) });
    }
    actions.push({
      label: t('action.delete'), icon: 'trash', danger: true, disabled: item.lossy,
      run: () => setConfirm([{ path: item.path, size: item.size }]),
    });
    setMenu({ x, y, actions });
  };

  const onMapContext = (hit: MapHit, x: number, y: number) => {
    menuFor({ path: hit.path, size: hit.node.size, isDir: hit.node.kind === 'dir', node: hit.node, lossy: hit.node.lossy }, x, y);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const row = rows[active];
    const move = (to: number) => {
      const next = Math.max(0, Math.min(rows.length - 1, to));
      setActive(next);
      const el = listRef.current;
      if (el) {
        if (next * ROW < el.scrollTop) el.scrollTop = next * ROW;
        else if ((next + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (next + 1) * ROW - el.clientHeight;
      }
    };
    if (e.key === 'ArrowDown') move(active + 1);
    else if (e.key === 'ArrowUp') move(active - 1);
    else if (e.key === 'PageDown') move(active + 15);
    else if (e.key === 'PageUp') move(active - 15);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(rows.length - 1);
    else if (!row) return;
    else if (e.key === 'ArrowRight' && row.node.id !== undefined && row.node.hasChildren && !expanded.has(row.node.id)) toggle(row.node);
    else if (e.key === 'ArrowLeft' && row.node.id !== undefined && expanded.has(row.node.id)) toggle(row.node);
    else if (e.key === 'Enter') open(row.node);
    else if (e.key === ' ' && row.deletable) toggleSelect(row.path, row.node.size);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && (topSelected.length || row.deletable)) {
      setConfirm(topSelected.length ? topSelected : [{ path: row.path, size: row.node.size }]);
    } else return;
    e.preventDefault();
  };

  const notAnalysed = result.diskUsed && result.diskUsed > result.bytes * 1.01 ? result.diskUsed - result.bytes : 0;
  const crumbs = list ? [...list.ancestors, { id: nodeId, name: list.node.name }] : [];
  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW) - 8);
  const lastVisible = Math.min(rows.length, Math.ceil((scrollTop + viewHeight) / ROW) + 8);

  return (
    <div className="page explorer">
      <header className="ex-head">
        <button className="btn icon-only" aria-label={t('ex.parent')} title={t('ex.parent')} disabled={crumbs.length < 2} onClick={() => setNodeId(crumbs[crumbs.length - 2].id)}>
          <Icon name="up" />
        </button>
        <nav className="crumbs" aria-label={t('ex.location')}>
          {crumbs.map((c, i) => (
            <span key={c.id}>
              {i > 0 && <i>/</i>}
              <button className={i === crumbs.length - 1 ? 'current' : ''} onClick={() => setNodeId(c.id)}>
                {i === 0 ? shortPath(c.name, home) : c.name}
              </button>
            </span>
          ))}
        </nav>
        <span className="spacer" />
        <div className="segmented" role="group" aria-label={t('ex.mapShape')}>
          <button className={mode === 'blocks' ? 'on' : ''} aria-pressed={mode === 'blocks'} onClick={() => setMode('blocks')}><Icon name="map" /> {t('ex.blocks')}</button>
          <button className={mode === 'rings' ? 'on' : ''} aria-pressed={mode === 'rings'} onClick={() => setMode('rings')}><Icon name="rings" /> {t('ex.rings')}</button>
        </div>
        <button className="btn" onClick={onRescan}><Icon name="refresh" /> {t('ex.rescan')}</button>
      </header>

      <div className="ex-summary">
        <strong className="num">{formatBytes(list?.node.size ?? result.bytes)}</strong>
        {list && list.node.files !== undefined && <span>{t('ex.contains', { files: count('count.file', list.node.files), dirs: count('count.folder', list.node.dirs ?? 0) })}</span>}
        <span className="muted">{t('ex.analysedIn', { time: formatDuration(result.ms) })}</span>
        {notAnalysed > 0 && (
          <span className="muted" title={t('ex.outOfReachTitle')}>
            {t('ex.outOfReach', { size: formatBytes(notAnalysed) })}
          </span>
        )}
        {result.errors > 0 && (
          <span className="muted" title={result.denied.slice(0, 12).join('\n')}>
            {tn('ex.denied', result.errors)}
          </span>
        )}
        {result.skippedMounts.length > 0 && (
          <span className="muted" title={result.skippedMounts.join('\n')}>
            {tn('ex.skipped', result.skippedMounts.length)}
          </span>
        )}
      </div>

      {platform === 'darwin' && result.errors > 0 && (
        <div className="ex-hint">
          <Icon name="lock" size={14} />
          <span>{t('ex.fda')}</span>
          <button className="link" onClick={() => void api.openDiskAccessSettings()}>{t('ex.fdaOpen')}</button>
        </div>
      )}

      <div className="ex-body">
        <section className="panel" aria-label={t('ex.content')}>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'folders'} className={tab === 'folders' ? 'on' : ''} onClick={() => setTab('folders')}>{t('tab.folders')}</button>
            <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
              {t('tab.files')} <small>{formatCount(result.topFiles.length)}</small>
            </button>
            <button role="tab" aria-selected={tab === 'projects'} className={tab === 'projects' ? 'on' : ''} onClick={() => setTab('projects')}>
              {t('tab.projects')} <small>{formatCount(result.artefacts.length)}</small>
            </button>
          </div>

          {tab === 'folders' && (
            <>
              <div className="list-head">
                <span>{t('col.name')}</span><span>{t('col.share')}</span><span>{t('col.size')}</span><span>{t('col.modified')}</span>
              </div>
              <div
                className="list"
                ref={listRef}
                role="tree"
                tabIndex={0}
                aria-label={t('list.aria')}
                aria-activedescendant={rows[active] ? `row-${active}` : undefined}
                onKeyDown={onKey}
                onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              >
                <div style={{ height: rows.length * ROW, position: 'relative' }}>
                  {rows.slice(firstVisible, lastVisible).map((row, i) => {
                    const index = firstVisible + i;
                    const { node } = row;
                    const isOpen = node.id !== undefined && expanded.has(node.id);
                    const expandable = node.kind === 'dir' && node.hasChildren;
                    return (
                      <div
                        key={row.key}
                        id={`row-${index}`}
                        role="treeitem"
                        aria-level={row.level + 1}
                        aria-expanded={expandable ? isOpen : undefined}
                        aria-selected={selected.has(row.path)}
                        className={`row ${index === active ? 'active' : ''} ${hoverPath === row.path ? 'hover' : ''} ${selected.has(row.path) ? 'picked' : ''}`}
                        style={{ top: index * ROW }}
                        onClick={() => {
                          setActive(index);
                          listRef.current?.focus({ preventScroll: true });
                        }}
                        onDoubleClick={() => open(node)}
                        onMouseEnter={() => setHoverPath(row.path)}
                        onMouseLeave={() => setHoverPath(null)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (node.kind !== 'other') menuFor({ path: row.path, size: node.size, isDir: node.kind === 'dir', node, lossy: !row.deletable }, e.clientX, e.clientY);
                        }}
                      >
                        <span className="row-name" style={{ paddingLeft: row.level * 16 }}>
                          <input
                            type="checkbox"
                            tabIndex={-1}
                            aria-label={t('row.pick', { name: node.name })}
                            title={row.deletable ? t('row.pickTitle') : node.kind === 'other' ? '' : t('row.lossyTitle')}
                            checked={selected.has(row.path)}
                            disabled={!row.deletable}
                            onChange={() => toggleSelect(row.path, node.size)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          {expandable ? (
                            <button
                              className={`twist ${isOpen ? 'open' : ''}`}
                              tabIndex={-1}
                              aria-label={isOpen ? t('row.collapse') : t('row.expand')}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(node);
                              }}
                            >
                              <Icon name="chevron" size={14} />
                            </button>
                          ) : (
                            <span className="twist none" />
                          )}
                          {row.level === 0 && <i className="swatch" style={{ background: slotColor(row.slot, theme) }} />}
                          <Icon name={node.kind === 'file' ? 'file' : node.kind === 'other' ? 'map' : 'folder'} size={15} />
                          {node.kind === 'dir' && node.hasChildren ? (
                            <button className="row-label as-link" title={t('row.enter', { name: node.name })} onClick={(e) => {
                              e.stopPropagation();
                              open(node);
                            }}>{node.name}</button>
                          ) : (
                            <span className="row-label" title={node.name}>{node.kind === 'other' ? count('count.smallItems', node.count ?? 0) : node.name}</span>
                          )}
                          {node.denied && (
                            <span className="row-lock" title={t('row.deniedTitle')} role="img" aria-label={t('row.locked')}>
                              <Icon name="lock" size={13} />
                            </span>
                          )}
                        </span>
                        <span className="row-share">
                          <Bar value={row.parentSize > 0 ? node.size / row.parentSize : 0} />
                          <small className="num">{formatPercent(node.size, row.parentSize)}</small>
                        </span>
                        <span className="row-size num">{formatBytes(node.size)}</span>
                        <span className="row-age">{formatAge(node.mtime)}</span>
                      </div>
                    );
                  })}
                </div>
                {list && rows.length === 0 && <p className="empty">{t('ex.emptyFolder')}</p>}
              </div>
            </>
          )}

          {tab === 'files' && (
            <FlatList
              items={result.topFiles.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime, lossy: f.lossy, tag: undefined }))}
              home={home}
              selected={selected}
              onToggle={toggleSelect}
              onContext={(item, x, y) => menuFor({ path: item.path, size: item.size, isDir: false, lossy: item.lossy }, x, y)}
              empty={t('files.none', { size: formatBytes(1e6) })}
            />
          )}

          {tab === 'projects' && (
            <FlatList
              items={result.artefacts.map((a: Artefact) => ({ path: a.path, size: a.bytes, mtime: a.mtime, lossy: a.lossy, tag: artefactLabel(a.kind), title: baseName(parentPath(a.path)) }))}
              home={home}
              selected={selected}
              onToggle={toggleSelect}
              onContext={(item, x, y) => menuFor({ path: item.path, size: item.size, isDir: true, lossy: item.lossy }, x, y)}
              empty={t('projects.noneHere')}
            />
          )}
        </section>

        <section className="panel map-panel" aria-label={t('ex.map')}>
          {mapData ? (
            <FolderMap
              mode={mode}
              root={mapData.node}
              rootPath={mapData.path}
              highlightPath={hoverPath}
              onHover={(hit) => setHoverPath(hit ? hit.path : null)}
              onOpen={(hit) => open(hit.node)}
              onUp={() => crumbs.length > 1 && setNodeId(crumbs[crumbs.length - 2].id)}
              onContext={onMapContext}
            />
          ) : (
            <div className="map-wait" />
          )}
        </section>
      </div>

      {topSelected.length > 0 && (
        <footer className="tray">
          <span>
            <strong>{tn('tray.picked', topSelected.length)}</strong>{' '}
            <span className="num">{formatBytes(selectedTotal)}</span>
          </span>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setSelected(new Map())}>{t('tray.clear')}</button>
          <button className="btn danger" onClick={() => setConfirm(topSelected)}><Icon name="trash" /> {t('action.delete')}</button>
        </footer>
      )}

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {confirm && <ConfirmDelete items={confirm} home={home} onClose={() => setConfirm(null)} onDone={afterDelete} />}
    </div>
  );
}

interface FlatItem {
  path: string;
  size: number;
  mtime: number;
  lossy: boolean;
  tag?: string;
  /** Shown instead of the file name, when that name says little ("node_modules"). */
  title?: string;
}

function FlatList({ items, home, selected, onToggle, onContext, empty }: {
  items: FlatItem[];
  home: string;
  selected: Map<string, number>;
  onToggle(path: string, size: number): void;
  onContext(item: FlatItem, x: number, y: number): void;
  empty: string;
}) {
  if (items.length === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="flat">
      {items.map((item) => (
        <li
          key={item.path}
          className={selected.has(item.path) ? 'picked' : ''}
          onContextMenu={(e) => {
            e.preventDefault();
            onContext(item, e.clientX, e.clientY);
          }}
        >
          <input
            type="checkbox"
            aria-label={t('row.pick', { name: baseName(item.path) })}
            checked={selected.has(item.path)}
            disabled={item.lossy}
            onChange={() => onToggle(item.path, item.size)}
          />
          <span className="flat-main">
            <strong title={item.path}>{item.title ?? baseName(item.path)}</strong>
            <small title={item.path}>
              {item.tag && <em className="chip">{item.tag}</em>} {shortPath(item.title ? parentPath(parentPath(item.path)) : parentPath(item.path), home)}
            </small>
          </span>
          <span className="row-age">{formatAge(item.mtime)}</span>
          <span className="num flat-size">{formatBytes(item.size)}</span>
        </li>
      ))}
    </ul>
  );
}
