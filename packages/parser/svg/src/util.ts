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

/** 字符串的 FNV-1a 32 位哈希（十六进制），用作内嵌图片的键 */
export function hashString(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
