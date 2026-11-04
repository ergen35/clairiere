import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TreeNode } from '../shared/types';
import { formatBytes, formatPercent, plural } from './format';
import { Arc, Cell, hitArc, hitCell, layoutRings, layoutTreemap } from './mapLayout';
import { mapTheme, MapTheme, mix, slotColor, textOn } from './palette';

export type MapMode = 'blocks' | 'rings';

export interface MapHit {
  node: TreeNode;
  path: string;
}

interface Props {
  mode: MapMode;
  root: TreeNode;
  rootPath: string;
  highlightPath: string | null;
  onHover(hit: MapHit | null): void;
  onOpen(hit: MapHit): void;
  onUp(): void;
  onContext(hit: MapHit, x: number, y: number): void;
}

const MAX_BLOCK_DEPTH = 4;
const MAX_RING_DEPTH = 4;

function otherLabel(node: TreeNode) {
  return node.kind === 'other' ? plural(node.count ?? 0, 'petit élément', 'petits éléments') : node.name;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo >= 2 ? `${text.slice(0, lo)}…` : '';
}

function cellFill(cell: Cell, theme: MapTheme): string {
  if (cell.node.kind === 'other') return mix(theme.neutral, theme, 0.45);
  const base = slotColor(cell.slot, theme);
  if (cell.frame) return mix(base, theme, 0.62 + Math.min(cell.depth, 3) * 0.06);
  const amount = cell.node.kind === 'file' ? 0.3 : 0.08 + Math.min(cell.depth, 3) * 0.1;
  return mix(base, theme, amount);
}

function drawBlocks(ctx: CanvasRenderingContext2D, cells: Cell[], theme: MapTheme, font: string) {
  for (const c of cells) {
    const fill = cellFill(c, theme);
    ctx.fillStyle = fill;
    if (c.w > 6 && c.h > 6) {
      ctx.beginPath();
      ctx.roundRect(c.x, c.y, c.w, c.h, 3);
      ctx.fill();
    } else {
      ctx.fillRect(c.x, c.y, c.w, c.h);
    }
    if (c.w < 42 || c.h < 16) continue;
    const label = otherLabel(c.node);
    const color = c.frame ? (theme.dark ? '#f0efec' : '#14160f') : textOn(fill);
    ctx.fillStyle = color;
    ctx.font = `${c.depth === 0 ? 600 : 500} 12px ${font}`;
    ctx.textBaseline = 'middle';
    const size = formatBytes(c.node.size);
    if (c.frame || c.h < 36) {
      const sizeW = c.w > 110 ? ctx.measureText(size).width + 12 : 0;
      ctx.fillText(ellipsize(ctx, label, c.w - 12 - sizeW), c.x + 6, c.y + 10.5);
      if (sizeW) {
        ctx.globalAlpha = 0.72;
        ctx.font = `400 11px ${font}`;
        ctx.textAlign = 'right';
        ctx.fillText(size, c.x + c.w - 6, c.y + 10.5);
        ctx.textAlign = 'left';
        ctx.globalAlpha = 1;
      }
    } else {
      ctx.fillText(ellipsize(ctx, label, c.w - 12), c.x + 6, c.y + 12);
      ctx.globalAlpha = 0.78;
      ctx.font = `400 11px ${font}`;
      ctx.fillText(size, c.x + 6, c.y + 27);
      ctx.globalAlpha = 1;
    }
  }
}

function arcFill(arc: Arc, theme: MapTheme): string {
  if (arc.node.kind === 'other') return mix(theme.neutral, theme, 0.4);
  return mix(slotColor(arc.slot, theme), theme, arc.node.kind === 'file' ? 0.45 : Math.min(arc.depth, 4) * 0.13);
}

function arcPath(ctx: CanvasRenderingContext2D, arc: Arc, cx: number, cy: number) {
  // Leave a thin surface gap between neighbours, without eating tiny arcs entirely.
  const pad = Math.min(0.9 / Math.max(arc.r1, 1), (arc.a1 - arc.a0) * 0.2);
  ctx.beginPath();
  ctx.arc(cx, cy, arc.r1 - 1, arc.a0 + pad, arc.a1 - pad);
  ctx.arc(cx, cy, arc.r0 + 1, arc.a1 - pad, arc.a0 + pad, true);
  ctx.closePath();
}

function drawRings(ctx: CanvasRenderingContext2D, arcs: Arc[], cx: number, cy: number, theme: MapTheme, font: string) {
  for (const arc of arcs) {
    arcPath(ctx, arc, cx, cy);
    const fill = arcFill(arc, theme);
    ctx.fillStyle = fill;
    ctx.fill();
    const mid = (arc.a0 + arc.a1) / 2;
    const thickness = arc.r1 - arc.r0;
    const rm = (arc.r0 + arc.r1) / 2;
    if ((arc.a1 - arc.a0) * rm < 16 || arc.depth > 1) continue;
    ctx.save();
    ctx.translate(cx + Math.cos(mid) * rm, cy + Math.sin(mid) * rm);
    const flip = mid > Math.PI / 2 && mid < (3 * Math.PI) / 2;
    ctx.rotate(flip ? mid + Math.PI : mid);
    ctx.fillStyle = textOn(fill);
    ctx.font = `500 11.5px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, otherLabel(arc.node), thickness - 10), 0, 0);
    ctx.restore();
  }
}

export function FolderMap({ mode, root, rootPath, highlightPath, onHover, onOpen, onUp, onContext }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [themeTick, setThemeTick] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  const hoverRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current!;
    const measure = () => setSize({ w: box.clientWidth, h: box.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const q = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setThemeTick((t) => t + 1);
    q.addEventListener('change', change);
    return () => q.removeEventListener('change', change);
  }, []);

  const cx = size.w / 2;
  const cy = size.h / 2;
  const ringGeom = useMemo(() => {
    const radius = Math.max(40, Math.min(size.w, size.h) / 2 - 8);
    const center = Math.max(44, radius * 0.2);
    return { center, ring: (radius - center) / MAX_RING_DEPTH };
  }, [size]);

  const cells = useMemo(
    () => (mode === 'blocks' && size.w > 0 ? layoutTreemap(root, rootPath, size.w, size.h, MAX_BLOCK_DEPTH) : []),
    [mode, root, rootPath, size],
  );
  const arcs = useMemo(
    () => (mode === 'rings' && size.w > 0 ? layoutRings(root, rootPath, ringGeom.center, ringGeom.ring, MAX_RING_DEPTH) : []),
    [mode, root, rootPath, size, ringGeom],
  );

  const prepare = useCallback((canvas: HTMLCanvasElement) => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }, [size]);

  // The picture itself; hover is drawn on a second layer so moving the mouse stays instant.
  useEffect(() => {
    if (!baseRef.current || size.w === 0) return;
    const ctx = prepare(baseRef.current);
    const theme = mapTheme();
    const font = getComputedStyle(document.body).fontFamily;
    ctx.clearRect(0, 0, size.w, size.h);
    if (mode === 'blocks') {
      drawBlocks(ctx, cells, theme, font);
    } else {
      drawRings(ctx, arcs, cx, cy, theme, font);
      ctx.beginPath();
      ctx.arc(cx, cy, ringGeom.center - 2, 0, Math.PI * 2);
      ctx.fillStyle = mix(theme.neutral, theme, 0.78);
      ctx.fill();
      ctx.fillStyle = theme.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${ringGeom.center > 60 ? 16 : 13}px ${font}`;
      ctx.fillText(formatBytes(root.size), cx, cy);
    }
  }, [mode, cells, arcs, size, cx, cy, ringGeom, root.size, prepare, themeTick]);

  useEffect(() => {
    if (!overlayRef.current || size.w === 0) return;
    const ctx = prepare(overlayRef.current);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!highlightPath) return;
    const theme = mapTheme();
    ctx.strokeStyle = theme.outline;
    ctx.lineWidth = 2;
    if (mode === 'blocks') {
      const c = cells.find((x) => x.path === highlightPath && x.node.kind !== 'other');
      if (c) {
        ctx.beginPath();
        ctx.roundRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2, 3);
        ctx.stroke();
      }
    } else {
      const a = arcs.find((x) => x.path === highlightPath && x.node.kind !== 'other');
      if (a) {
        arcPath(ctx, a, cx, cy);
        ctx.stroke();
      }
    }
  }, [highlightPath, cells, arcs, mode, size, cx, cy, prepare]);

  const locate = (e: React.MouseEvent): MapHit | null => {
    const rect = boxRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = mode === 'blocks' ? hitCell(cells, x, y) : hitArc(arcs, x - cx, y - cy);
    return hit ? { node: hit.node, path: hit.path } : null;
  };

  const inCenter = (e: React.MouseEvent) => {
    if (mode !== 'rings') return false;
    const rect = boxRef.current!.getBoundingClientRect();
    return Math.hypot(e.clientX - rect.left - cx, e.clientY - rect.top - cy) < ringGeom.center;
  };

  const tipTotal = root.size;

  return (
    <div
      className={`map ${mode}`}
      ref={boxRef}
      role="img"
      aria-label={`Carte du contenu de ${rootPath}, ${formatBytes(root.size)}. La liste à côté donne les mêmes informations.`}
      onMouseMove={(e) => {
        const hit = locate(e);
        const key = hit ? `${hit.path}|${hit.node.kind}` : null;
        if (key !== hoverRef.current) {
          hoverRef.current = key;
          onHover(hit);
        }
        const rect = boxRef.current!.getBoundingClientRect();
        setTip(hit ? { x: e.clientX - rect.left, y: e.clientY - rect.top, node: hit.node } : null);
      }}
      onMouseLeave={() => {
        hoverRef.current = null;
        onHover(null);
        setTip(null);
      }}
      onClick={(e) => {
        if (inCenter(e)) {
          onUp();
          return;
        }
        const hit = locate(e);
        if (hit && hit.node.kind === 'dir' && hit.node.hasChildren) onOpen(hit);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const hit = locate(e);
        if (hit && hit.node.kind !== 'other') onContext(hit, e.clientX, e.clientY);
      }}
    >
      <canvas ref={baseRef} />
      <canvas ref={overlayRef} className="overlay" />
      {tip && (
        <div
          className="map-tip"
          style={{
            left: Math.min(tip.x + 14, size.w - 240),
            top: tip.y + 90 > size.h ? tip.y - 74 : tip.y + 16,
          }}
        >
          <strong>{otherLabel(tip.node)}</strong>
          <span>
            {formatBytes(tip.node.size)} · {formatPercent(tip.node.size, tipTotal)}
          </span>
          {tip.node.kind === 'dir' && tip.node.files !== undefined && <span>{plural(tip.node.files, 'fichier')}</span>}
        </div>
      )}
    </div>
  );
}
