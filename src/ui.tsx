import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DeleteItem, DeleteMode, DeleteOutcome, ItemCheck } from '../shared/types';
import { api } from './api';
import { count, formatBytes, shortPath } from './format';
import { rich, t, tn } from './i18n';

const PATHS: Record<string, ReactNode> = {
  disk: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M7 15h.01M11 15h6" /></>,
  map: <><rect x="3" y="4" width="10" height="16" rx="1.5" /><rect x="15" y="4" width="6" height="7" rx="1.5" /><rect x="15" y="13" width="6" height="7" rx="1.5" /></>,
  rings: <><circle cx="12" cy="12" r="3" /><path d="M12 5a7 7 0 1 1-7 7" /><path d="M12 2a10 10 0 0 1 10 10" /></>,
  clean: <><path d="M14 3l7 7" /><path d="M16.5 5.5L10 12" /><path d="M10 12c-3-1-6 1-7 7 2 0 3 0 4-1 0 1 0 2 1 2 3 0 6-3 5-5z" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
  chevron: <path d="M9 6l6 6-6 6" />,
  up: <path d="M6 15l6-6 6 6" />,
  refresh: <><path d="M20 11a8 8 0 0 0-14-5l-2 2" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14 5l2-2" /><path d="M20 20v-4h-4" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  home: <><path d="M4 11l8-7 8 7" /><path d="M6 10v10h12V10" /></>,
  open: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v6H4V6h6" /></>,
  warn: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" /></>,
  check: <path d="M5 12l5 5 9-10" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></>,
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export interface MenuAction {
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  run(): void;
}

export function ContextMenu({ x, y, actions, onClose }: { x: number; y: number; actions: MenuAction[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ left: Math.min(x, window.innerWidth - r.width - 8), top: Math.min(y, window.innerHeight - r.height - 8) });
    ref.current!.querySelector('button')?.focus();
  }, [x, y]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  return (
    <div className="menu" ref={ref} style={pos} role="menu">
      {actions.map((a) => (
        <button
          key={a.label}
          role="menuitem"
          className={a.danger ? 'danger' : ''}
          disabled={a.disabled}
          onClick={() => {
            onClose();
            a.run();
          }}
        >
          <Icon name={a.icon ?? 'chevron'} size={15} />
          {a.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Confirmation before anything is deleted. Says what, how much, and what can't be undone. */
export function ConfirmDelete({ items, home, onClose, onDone }: { items: DeleteItem[]; home: string; onClose(): void; onDone(o: DeleteOutcome): void }) {
  const [checks, setChecks] = useState<ItemCheck[] | null>(null);
  const [busy, setBusy] = useState<DeleteMode | null>(null);

  useEffect(() => {
    void api.checkItems(items.map((i) => i.path)).then(setChecks);
  }, [items]);

  const refused = useMemo(() => new Map((checks ?? []).filter((c) => c.refused).map((c) => [c.path, c.refused!])), [checks]);
  const warnings = useMemo(() => new Map((checks ?? []).filter((c) => c.warning).map((c) => [c.path, c.warning!])), [checks]);
  const allowed = items.filter((i) => !refused.has(i.path));
  const total = allowed.reduce((s, i) => s + i.size, 0);

  const run = async (mode: DeleteMode) => {
    setBusy(mode);
    try {
      onDone(await api.deleteItems(allowed, mode));
    } finally {
      setBusy(null);
    }
  };

  const title = allowed.length === 1 ? t('confirm.one') : t('confirm.many', { items: count('count.item', allowed.length) });
  const shown = items.slice(0, 6);

  return (
    <Modal title={refused.size === items.length && checks ? t('confirm.impossible') : title} onClose={busy ? () => {} : onClose}>
      <ul className="confirm-list">
        {shown.map((i) => (
          <li key={i.path} className={refused.has(i.path) ? 'refused' : ''}>
            <span className="confirm-path" title={i.path}>{shortPath(i.path, home)}</span>
            <span className="num">{formatBytes(i.size)}</span>
            {refused.has(i.path) && <em><Icon name="lock" size={13} /> {refused.get(i.path)}</em>}
            {warnings.has(i.path) && !refused.has(i.path) && <em className="warn"><Icon name="warn" size={13} /> {warnings.get(i.path)}</em>}
          </li>
        ))}
        {items.length > shown.length && <li className="more">{tn('confirm.more', items.length - shown.length)}</li>}
      </ul>
      {allowed.length > 0 && (
        <p className="confirm-note">{rich(t('confirm.note', { size: formatBytes(total) }))}</p>
      )}
      <div className="modal-actions">
        <button className="btn ghost" data-autofocus disabled={!!busy} onClick={onClose}>{t('common.cancel')}</button>
        <span className="spacer" />
        {allowed.length > 0 && checks && (
          <>
            <button className="btn" disabled={!!busy} onClick={() => void run('trash')}>
              {busy === 'trash' ? t('confirm.moving') : t('confirm.toTrash')}
            </button>
            <button className="btn danger" disabled={!!busy} onClick={() => void run('permanent')}>
              {busy === 'permanent' ? t('confirm.deleting') : t('confirm.permanent')}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

export function Bar({ value, tone }: { value: number; tone?: 'ok' | 'warn' | 'crit' }) {
  return (
    <span className={`bar ${tone ?? ''}`} role="presentation">
      <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, value))})` }} />
    </span>
  );
}

export function usageTone(used: number, total: number): 'ok' | 'warn' | 'crit' {
  const f = total > 0 ? used / total : 0;
  if (f >= 0.92) return 'crit';
  if (f >= 0.8) return 'warn';
  return 'ok';
}
