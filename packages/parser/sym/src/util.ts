import type { VectorBox, VectorGeom } from '@drawir/core';

export function s8() {
  return (((1 + Math.random()) * 0x100000000) | 0).toString(16).substring(1);
}

export const MIN_PEN_SIZE = 2;

export function penRectOfGeom(bbox: VectorBox) {
  const width = Math.max(bbox.width, MIN_PEN_SIZE);
  const height = Math.max(bbox.height, MIN_PEN_SIZE);
  return { x: bbox.x - (width - bbox.width) / 2, y: bbox.y - (height - bbox.height) / 2, width, height };
}

export interface Meta2dPensDocument {
  pens: any[];
  vectors?: Record<string, VectorGeom>;
  width?: number;
  height?: number;
}

export function contentBox(pens: any[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pens) {
    if (p.parentId) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.width);
    y1 = Math.max(y1, p.y + p.height);
  }
  return x1 > x0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 0, height: 0 };
}

export function symColor(value: number | undefined): string {
  if (value === undefined || value < 0) return 'none';
  const n = value >>> 0;
  const r = n & 0xff;
  const g = (n >>> 8) & 0xff;
  const b = (n >>> 16) & 0xff;
  const alphaByte = (n >>> 24) & 0xff;
  const a = Math.max(0, Math.min(1, (100 - (alphaByte === 255 ? 0 : alphaByte)) / 100));
  return a >= 0.999 ? `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}` : `rgba(${r},${g},${b},${+a.toFixed(3)})`;
}
