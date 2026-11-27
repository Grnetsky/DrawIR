import { applyMatrix, estimateTextWidth, type VectorTextItem } from '@drawir/core';
import type { SketchTextBox } from './ir';

/** 与 meta2d 版本无关的原生文字图元描述，适配层再换成 1.x / 2.x 的字段 */
export interface TextSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 角度（度，顺时针） */
  rotate?: number;
  /**
   * 水平 / 垂直翻转（meta2d 的 flipX / flipY）：绕图元中心镜像，与 rotate 合成后的绘制变换为 R(rotate) · S(flipX ? -1 : 1, flipY ? -1 : 1)
   * （1.x ctxFlip + ctxRotate、2.x flipRender + rotateRender 在单向翻转时都把角度取反，等价于先翻转、再旋转）
   */
  flipX?: boolean;
  flipY?: boolean;
  text: string;
  fontSize: number;
  /** 行高倍数 */
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  /** 定宽自动换行 */
  wrap: boolean;
  color?: string;
  fontFamily?: string;
  fontWeight?: number | 'bold';
  italic?: boolean;
  letterSpacing?: number;
}

/** 有 Sketch 文字框：图元框 = 文字框，对齐、行高、换行与 Sketch 一致 */
export function textSpecOfBox(item: VectorTextItem, box: SketchTextBox): TextSpec {
  const m = box.m;
  const sx = Math.hypot(m[0], m[1]) || 1;
  const sy = Math.hypot(m[2], m[3]) || 1;
  const width = Math.max(box.w * sx, 1);
  const height = Math.max(box.h * sy, 1);
  const [cx, cy] = applyMatrix(m, box.w / 2, box.h / 2);
  let r = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  // 镜像（翻转）的文字框：用 meta2d 的 flipX / flipY 镜像字形（同 Sketch 显示）。
  // 线性部分 = R(r) · S(1, -1)（flipY，x 轴方向不变）= R(r ± 180) · S(-1, 1)（flipX），取旋转角小的一种
  let flipX = false;
  let flipY = false;
  if (m[0] * m[3] - m[1] * m[2] < 0) {
    const rx = (Math.atan2(-m[1], -m[0]) * 180) / Math.PI;
    if (Math.abs(rx) < Math.abs(r) - 1e-6) {
      r = rx;
      flipX = true;
    } else flipY = true;
  }
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
    wrap: box.wrap,
  };
  Math.abs(r) > 1e-3 && (spec.rotate = r);
  flipX && (spec.flipX = true);
  flipY && (spec.flipY = true);
  fillStyle(spec, item, box.weight);
  box.spacing && (spec.letterSpacing = box.spacing * sx);
  return spec;
}

/** 没有文字框时按 IR 文字项估算（锚点、基线 → 框） */
export function textSpecOfItem(item: VectorTextItem): TextSpec {
  const size = item.h;
  const lh = item.lh || 1.2;
  const lines = item.text.split('\n');
  const rowHeight = size * lh;
  const width = item.bw > 0 ? item.bw : Math.max(estimateTextWidth(item.text, size) * (item.w || 1) * 1.08 + size * 0.2, size);
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
  // 镜像（IR 的 m：旋转后沿基线 scale(1, -1)）：框中心关于基线对称，图元按 flipY 镜像字形
  const cy0 = (top + height / 2) * (item.m ? -1 : 1);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const spec: TextSpec = {
    x: item.x + cx0 * cos - cy0 * sin - width / 2,
    y: item.y + cx0 * sin + cy0 * cos - height / 2,
    width,
    height,
    text: item.text,
    fontSize: size,
    lineHeight: lh,
    align,
    valign,
    wrap: item.bw > 0,
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
