import type { VectorBox, VectorGeom, VectorItem, VectorStyle } from '@drawir/core';

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

/**
 * 把图元上的颜色 / 背景 / 线宽写回它的矢量项，得到不依赖图元属性的纯 IR：
 * '$fg' 及缺省描边、文字色、未着色的块引用 → pen.color；'$bg' → pen.background；'$lw' → pen.lineWidth。
 * 结果与 meta2d 绘制该图元时的效果一致，供 parseXxxVector 输出 VectorDocument。
 */
export function bakePenStyle(items: VectorItem[], pen: { color?: string; background?: string; lineWidth?: number }): VectorItem[] {
  const fg = pen.color;
  const bg = pen.background;
  const lw = pen.lineWidth;
  const paint = (c: any, fallback: boolean) =>
    c === '$fg' || (c === undefined && fallback) ? fg ?? c : c === '$bg' ? bg ?? c : c;
  const bake = (it: VectorItem): VectorItem => {
    switch (it.t) {
      case 'p': {
        const s: VectorStyle = { ...(it.s || {}) };
        const stroke = paint(s.stroke, true);
        stroke === undefined ? delete s.stroke : (s.stroke = stroke);
        const fill = paint(s.fill, false);
        fill === undefined ? delete s.fill : (s.fill = fill);
        s.lw === '$lw' && lw !== undefined && (s.lw = lw);
        const out = { ...it };
        Object.keys(s).length ? (out.s = s) : delete out.s;
        return out;
      }
      case 't': {
        const fill = paint(it.fill, true);
        return fill === undefined ? it : { ...it, fill };
      }
      case 'h': {
        const stroke = paint(it.stroke, true);
        return stroke === undefined ? it : { ...it, stroke };
      }
      case 'r': {
        const c = paint(it.c, true);
        return c === undefined ? it : { ...it, c };
      }
      case 'c':
        return { ...it, items: it.items.map(bake) };
      default:
        return it;
    }
  };
  return fg === undefined && bg === undefined && lw === undefined ? items : items.map(bake);
}
