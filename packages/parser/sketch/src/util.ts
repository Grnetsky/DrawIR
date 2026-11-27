import type { VectorBox, VectorGeom } from '@drawir/core';

export function s8() {
  return (((1 + Math.random()) * 0x100000000) | 0).toString(16).substring(1);
}

/**
 * 图元框的最小边长（画布坐标），与 @meta2d/core 的 MIN_PEN_SIZE 一致。
 * meta2d 的视口筛选会跳过宽或高小于 2 的图元，水平线、竖线的包围盒某个方向为 0，必须撑开。
 */
export const MIN_PEN_SIZE = 2;

/** 由几何包围盒得到图元的 x / y / width / height：细的方向撑到 MIN_PEN_SIZE 并居中，几何不变 */
export function penRectOfGeom(bbox: VectorBox) {
  const width = Math.max(bbox.width, MIN_PEN_SIZE);
  const height = Math.max(bbox.height, MIN_PEN_SIZE);
  return { x: bbox.x - (width - bbox.width) / 2, y: bbox.y - (height - bbox.height) / 2, width, height };
}

/** 解析器输出的 meta2d 图纸数据：可直接 meta2d.open()，也可 addVectors + addPens 追加到当前图纸 */
export interface Meta2dPensDocument {
  pens: any[];
  /** 共享几何定义 */
  vectors?: Record<string, VectorGeom>;
  width?: number;
  height?: number;
}

/** 顶层图元的外接盒 */
export function contentBox(pens: any[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pens) {
    if (p.parentId) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.width);
    y1 = Math.max(y1, p.y + p.height);
  }
  return x1 > x0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 0, height: 0 };
}

const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0');

/** 0~1 浮点 RGBA → CSS 颜色 */
export function rgbaCss(r: number, g: number, b: number, a = 1): string {
  if (a >= 0.999) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  const ch = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${ch(r)},${ch(g)},${ch(b)},${+Math.max(0, a).toFixed(3)})`;
}
