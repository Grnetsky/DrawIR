import { estimateTextWidth, type VectorTextItem } from '@drawir/core';

/** 与 meta2d 版本无关的原生文字图元描述，适配层再换成 1.x / 2.x 的字段 */
export interface TextSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 角度（度，顺时针） */
  rotate?: number;
  text: string;
  fontSize: number;
  /** 行高倍数 */
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  color?: string;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
}

/**
 * IR 文字项（锚点在基线上）→ 原生文字。
 * 原生文字每行占 fontSize * lineHeight 并在行内垂直居中，字形约占 [基线 - 0.8h, 基线 + 0.2h]
 */
export function textSpecOfItem(item: VectorTextItem): TextSpec {
  const size = item.h;
  const lh = 1.2;
  const lines = item.text.split('\n');
  const rowHeight = size * lh;
  const width = Math.max(estimateTextWidth(item.text, size) * (item.w || 1) * 1.08 + size * 0.2, size);
  const height = rowHeight * lines.length;
  let align: TextSpec['align'] = item.a === 'right' || item.a === 'end' ? 'right' : item.a === 'center' ? 'center' : 'left';
  let r = item.r || 0;
  if (item.m) {
    // 镜像文字：旋转 + π 并对调左右对齐，得到正向可读、覆盖同一区域的文字
    r += Math.PI;
    r > Math.PI && (r -= Math.PI * 2);
    align = align === 'left' ? 'right' : align === 'right' ? 'left' : align;
  }
  const left = align === 'left' ? 0 : align === 'center' ? -width / 2 : -width;
  const pad = (rowHeight - size) / 2;
  let top: number;
  let valign: TextSpec['valign'] = 'top';
  switch (item.b) {
    case 'top':
    case 'hanging':
      top = -pad;
      break;
    case 'middle':
      top = -height / 2;
      valign = 'middle';
      break;
    case 'bottom':
    case 'ideographic':
      top = -height + pad;
      valign = 'bottom';
      break;
    default:
      top = -pad - size * 0.8;
  }
  // 框中心绕锚点旋转 r 后的位置 → 原生图元绕自身中心旋转，结果一致
  const cx0 = left + width / 2;
  const cy0 = top + height / 2;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const cx = item.x + cx0 * cos - cy0 * sin;
  const cy = item.y + cx0 * sin + cy0 * cos;
  const spec: TextSpec = { x: cx - width / 2, y: cy - height / 2, width, height, text: item.text, fontSize: size, lineHeight: lh, align, valign };
  Math.abs(r) > 1e-6 && (spec.rotate = (r * 180) / Math.PI);
  item.fill && item.fill[0] !== '$' && item.fill !== 'none' && (spec.color = item.fill);
  item.font && (spec.fontFamily = item.font);
  item.bold && (spec.bold = true);
  item.italic && (spec.italic = true);
  return spec;
}
