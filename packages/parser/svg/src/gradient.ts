import { colorCss, type RGBA } from './color';

/** 相对图元框的渐变（适配层输入）：起止点为 0~1 比例，径向半径为画布像素 */
export interface RelGradient {
  type: 'linear' | 'radial';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
  stops: { i: number; c: RGBA }[];
}

type Stop = RelGradient['stops'][number];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 渐变参数 t 处的颜色（两端外延为端点颜色） */
export function colorAt(stops: Stop[], t: number): RGBA {
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

/** 色标从渐变参数 t 换到目标渐变线位置 u = u0 + t(u1-u0)，裁到 [0,1]，越界部分用插值端点色 */
export function remapStops(stops: Stop[], u0: number, u1: number): Stop[] {
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

export function stopCss(s: Stop) {
  return `${colorCss(s.c)} ${+(s.i * 100).toFixed(2)}%`;
}
