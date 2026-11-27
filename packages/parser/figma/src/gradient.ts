import type { FigmaGradient, Rgba } from './ir';
import { rgbaCss } from './util';

export interface GradientStop {
  /** 0~1 */
  i: number;
  c: Rgba;
}

/**
 * 相对图元框的渐变（与 meta2d 版本无关）：
 * - 线性：起点 (x0, y0) → 终点 (x1, y1)，相对图元框的 0~1 比例，色标位置沿起点 → 终点；
 * - 径向：圆心 (x0, y0) 相对图元框，半径 r 为画布像素。
 */
export interface PenGradient {
  type: 'linear' | 'radial';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
  stops: GradientStop[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function penGradient(g: FigmaGradient, rect: Rect): PenGradient | undefined {
  const { x, y, width: w, height: h } = rect;
  if (!(w > 0 && h > 0)) return undefined;
  const rx = (px: number) => (px - x) / w;
  const ry = (py: number) => (py - y) / h;
  if (g.type === 'linear') {
    return { type: 'linear', x0: rx(g.p0[0]), y0: ry(g.p0[1]), x1: rx(g.p1[0]), y1: ry(g.p1[1]), r: 0, stops: g.stops };
  }
  const r1 = Math.hypot(g.p1[0] - g.p0[0], g.p1[1] - g.p0[1]);
  const r2 = g.p2 ? Math.hypot(g.p2[0] - g.p0[0], g.p2[1] - g.p0[1]) : r1;
  return { type: 'radial', x0: rx(g.p0[0]), y0: ry(g.p0[1]), x1: 0, y1: 0, r: (r1 + r2) / 2, stops: g.stops };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 渐变参数 t 处的颜色（两端外延为端点颜色） */
export function colorAt(stops: GradientStop[], t: number): Rgba {
  if (t <= stops[0].i) return stops[0].c;
  for (let k = 1; k < stops.length; k++) {
    const a = stops[k - 1];
    const b = stops[k];
    if (t <= b.i) {
      const u = b.i > a.i ? (t - a.i) / (b.i - a.i) : 1;
      return [lerp(a.c[0], b.c[0], u), lerp(a.c[1], b.c[1], u), lerp(a.c[2], b.c[2], u), lerp(a.c[3], b.c[3], u)];
    }
  }
  return stops[stops.length - 1].c;
}

/**
 * 色标从「渐变参数 t」换到「目标渐变线上的位置 u = u0 + t (u1 - u0)」，并裁剪到 [0, 1]：
 * 超出范围的部分用插值出的端点颜色代替（CSS 字符串和 canvas 的色标都只能在 0~1）
 */
export function remapStops(stops: GradientStop[], u0: number, u1: number): GradientStop[] {
  const sorted = [...stops].sort((a, b) => a.i - b.i);
  if (!(Math.abs(u1 - u0) > 1e-9)) {
    const c = colorAt(sorted, 0.5);
    return [
      { i: 0, c },
      { i: 1, c },
    ];
  }
  const us = new Set<number>([0, 1]);
  for (const s of sorted) {
    const u = u0 + s.i * (u1 - u0);
    u > 0 && u < 1 && us.add(u);
  }
  return [...us].sort((a, b) => a - b).map((u) => ({ i: u, c: colorAt(sorted, (u - u0) / (u1 - u0)) }));
}

export function stopCss(s: GradientStop) {
  return `${rgbaCss(s.c[0], s.c[1], s.c[2], s.c[3])} ${+(s.i * 100).toFixed(2)}%`;
}
