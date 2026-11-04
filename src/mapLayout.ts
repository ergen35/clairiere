import type { TreeNode } from '../shared/types';
import { joinPath } from './format';

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  node: TreeNode;
  path: string;
  depth: number;
  slot: number;
  /** A folder drawn as a frame around its content. */
  frame: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HEADER = 20;
const GAP = 2;

function worst(row: number[], side: number, sum: number): number {
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

/** Squarified layout: rectangles as close to square as possible, so sizes compare at a glance. */
export function squarify(values: number[], rect: Rect): Rect[] {
  const out: Rect[] = new Array(values.length);
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) {
    return values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  }
  const scale = (rect.w * rect.h) / total;
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < values.length) {
    const side = Math.min(w, h);
    const row: number[] = [];
    let sum = 0;
    let best = Infinity;
    let j = i;
    while (j < values.length) {
      const area = values[j] * scale;
      const nextSum = sum + area;
      const next = worst([...row, area], side, nextSum);
      if (row.length && next > best) break;
      row.push(area);
      sum = nextSum;
      best = next;
      j += 1;
    }
    const thick = sum / side;
    let offset = 0;
    row.forEach((area, k) => {
      const len = area / thick;
      out[i + k] = w >= h ? { x, y: y + offset, w: thick, h: len } : { x: x + offset, y, w: len, h: thick };
      offset += len;
    });
    if (w >= h) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
    i = j;
  }
  return out;
}

/** Lays out a folder's content into nested rectangles, biggest depth last so hits find the deepest. */
export function layoutTreemap(root: TreeNode, rootPath: string, width: number, height: number, maxDepth: number): Cell[] {
  const cells: Cell[] = [];
  const visit = (children: TreeNode[], parentPath: string, area: Rect, depth: number, parentSlot: number) => {
    const list = children.filter((c) => c.size > 0);
    const rects = squarify(list.map((c) => c.size), area);
    list.forEach((node, i) => {
      const r = rects[i];
      const slot = depth === 0 ? (node.kind === 'other' ? -1 : i) : parentSlot;
      const path = node.kind === 'other' ? parentPath : joinPath(parentPath, node.name);
      const cell: Cell = {
        x: r.x + GAP / 2, y: r.y + GAP / 2, w: Math.max(0, r.w - GAP), h: Math.max(0, r.h - GAP),
        node, path, depth, slot, frame: false,
      };
      if (cell.w < 1 || cell.h < 1) return;
      const inner = node.kind === 'dir' ? node.children?.filter((c) => c.size > 0) : undefined;
      const canNest = inner && inner.length > 0 && depth + 1 < maxDepth && cell.w > 44 && cell.h > HEADER + 18;
      cell.frame = !!canNest;
      cells.push(cell);
      if (canNest) {
        visit(inner!, path, { x: cell.x + 1, y: cell.y + HEADER, w: cell.w - 2, h: cell.h - HEADER - 1 }, depth + 1, slot);
      }
    });
  };
  visit(root.children ?? [], rootPath, { x: 0, y: 0, w: width, h: height }, 0, -1);
  return cells;
}

export function hitCell(cells: Cell[], x: number, y: number): Cell | null {
  for (let i = cells.length - 1; i >= 0; i -= 1) {
    const c = cells[i];
    if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return c;
  }
  return null;
}

export interface Arc {
  r0: number;
  r1: number;
  a0: number;
  a1: number;
  node: TreeNode;
  path: string;
  depth: number;
  slot: number;
}

/** Concentric rings, starting at the top and turning clockwise. */
export function layoutRings(root: TreeNode, rootPath: string, center: number, ringWidth: number, maxDepth: number): Arc[] {
  const arcs: Arc[] = [];
  const visit = (children: TreeNode[], parentPath: string, a0: number, a1: number, total: number, depth: number, parentSlot: number) => {
    let angle = a0;
    const span = a1 - a0;
    children.filter((c) => c.size > 0).forEach((node, i) => {
      const sweep = total > 0 ? (node.size / total) * span : 0;
      const slot = depth === 0 ? (node.kind === 'other' ? -1 : i) : parentSlot;
      const path = node.kind === 'other' ? parentPath : joinPath(parentPath, node.name);
      if (sweep > 0.004) {
        arcs.push({
          r0: center + depth * ringWidth, r1: center + (depth + 1) * ringWidth, a0: angle, a1: angle + sweep,
          node, path, depth, slot,
        });
        if (node.kind === 'dir' && node.children && depth + 1 < maxDepth) {
          visit(node.children, path, angle, angle + sweep, node.size, depth + 1, slot);
        }
      }
      angle += sweep;
    });
  };
  visit(root.children ?? [], rootPath, -Math.PI / 2, Math.PI * 1.5, root.size, 0, -1);
  return arcs;
}

export function hitArc(arcs: Arc[], x: number, y: number): Arc | null {
  const r = Math.hypot(x, y);
  let a = Math.atan2(y, x);
  if (a < -Math.PI / 2) a += Math.PI * 2;
  for (const arc of arcs) {
    if (r >= arc.r0 && r < arc.r1 && a >= arc.a0 && a < arc.a1) return arc;
  }
  return null;
}
