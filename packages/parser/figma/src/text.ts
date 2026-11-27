import { applyMatrix, estimateTextWidth, type VectorTextItem } from '@drawir/core';
import type { FigmaTextBox } from './ir';

/** 与 meta2d 版本无关的原生文字图元描述，适配层再换成 1.x / 2.x 的字段 */
export interface TextSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 角度（度，顺时针） */
  rotate?: number;
  flipX?: boolean;
  flipY?: boolean;
  text: string;
  fontSize: number;
  /** 行高倍数 */
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  color?: string;
  fontFamily?: string;
  fontWeight?: number | 'bold';
  italic?: boolean;
  letterSpacing?: number;
}

/** 单一样式的 Figma 文字节点：图元框 = Figma 文字框，对齐方式、行高与 Figma 一致 */
export function textSpecOfBox(item: VectorTextItem, box: FigmaTextBox): TextSpec {
  const m = box.m;
  const sx = Math.hypot(m[0], m[1]) || 1;
  const sy = Math.hypot(m[2], m[3]) || 1;
  const width = Math.max(box.w * sx, 1);
  const height = Math.max(box.h * sy, 1);
  const [cx, cy] = applyMatrix(m, box.w / 2, box.h / 2);
  const spec: TextSpec = {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    text: item.text,
    fontSize: item.h,
    lineHeight: box.lh > 0 ? box.lh : 1.2,
    align: box.align,
    valign: box.valign,
  };
  let r = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  if (m[0] * m[3] - m[1] * m[2] < 0) {
    if (m[0] < 0) {
      spec.flipX = true;
      r += 180;
      r > 180 && (r -= 360);
    } else {
      spec.flipY = true;
    }
  }
  Math.abs(r) > 1e-3 && (spec.rotate = r);
  fillStyle(spec, item, box.weight);
  box.spacing && (spec.letterSpacing = box.spacing * sx);
  return spec;
}

/**
 * 多样式文字的一段（IR 文字项，锚点为基线）→ 原生文字。
 * 原生文字每行占 fontSize * lineHeight 并在行内垂直居中，字形约占 [基线 - 0.8h, 基线 + 0.2h]
 */
export function textSpecOfItem(item: VectorTextItem): TextSpec {
  const size = item.h;
  const lh = item.lh || 1.2;
  const lines = item.text.split('\n');
  const rowHeight = size * lh;
  const width = Math.max(estimateTextWidth(item.text, size) * (item.w || 1) * 1.08 + size * 0.2, size);
  const height = rowHeight * lines.length;
  const align: TextSpec['align'] = item.a === 'right' || item.a === 'end' ? 'right' : item.a === 'center' ? 'center' : 'left';
  const r = item.r || 0;
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
  const cx0 = left + width / 2;
  const cy0 = top + height / 2;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const cx = item.x + cx0 * cos - cy0 * sin;
  const cy = item.y + cx0 * sin + cy0 * cos;
  const spec: TextSpec = {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    text: item.text,
    fontSize: size,
    lineHeight: lh,
    align,
    valign,
  };
  Math.abs(r) > 1e-6 && (spec.rotate = (r * 180) / Math.PI);
  item.m && (spec.flipY = true);
  fillStyle(spec, item);
  return spec;
}

function fillStyle(spec: TextSpec, item: VectorTextItem, weight?: number) {
  item.fill && item.fill !== '$fg' && item.fill !== 'none' && (spec.color = item.fill);
  item.font && (spec.fontFamily = item.font);
  if (weight && weight !== 400) spec.fontWeight = weight;
  else if (item.bold) spec.fontWeight = 'bold';
  item.italic && (spec.italic = true);
}
