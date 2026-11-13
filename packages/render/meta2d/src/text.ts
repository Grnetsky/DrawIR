import { estimateTextWidth, textItemLines, type VectorTextItem } from '@drawir/core';

/** meta2d 1.x 原生文字的行高倍数（每行占 fontSize × 1.5，行内垂直居中） */
export const LINE_HEIGHT = 1.5;

/**
 * IR 文字项 → meta2d 1.x 原生文字图元（name: 'text'），双击可改内容、属性面板可改字号颜色字体。
 * 与 @meta2d/core 的 textItemToPen 规则一致（这里重写一份，使转换层不在运行时依赖 @meta2d/core，可在 Worker 中运行）。
 * 返回的几何在文档坐标中，由调用方再做缩放和平移。
 */
export function textItemToPen(item: VectorTextItem, color: string | undefined): any {
  const size = item.h;
  // 定宽文字：图元宽度 = 框宽，交给原生文字自动换行。原生文字不支持宽度因子，框宽同样除以宽度因子
  const fixed = (item.bw || 0) > 0;
  const lines = fixed ? textItemLines(item) : item.text.split('\n');
  const rowHeight = size * LINE_HEIGHT;
  // 估算宽度不准时留一点余量，避免被裁剪
  const width = fixed
    ? Math.max(item.bw! / (item.w || 1), size)
    : Math.max(estimateTextWidth(item.text, size) * (item.w || 1) * 1.08 + size * 0.2, size);
  const height = rowHeight * lines.length;

  // 镜像文字：原生文字不能镜像字形。「旋转 r、沿基线镜像」= 「旋转 r+π、左右镜像」，去掉左右镜像即得正向可读的文字
  let a: 'left' | 'center' | 'right' = item.a === 'right' || item.a === 'end' ? 'right' : item.a === 'center' ? 'center' : 'left';
  let r = item.r || 0;
  if (item.m) {
    r += Math.PI;
    r > Math.PI && (r -= Math.PI * 2);
    a = a === 'left' ? 'right' : a === 'right' ? 'left' : a;
  }
  // 框相对锚点的位置（未旋转，Y 向下）
  const left = a === 'left' ? 0 : a === 'center' ? -width / 2 : -width;
  const pad = (rowHeight - size) / 2;
  let top: number;
  let baseline = 'top';
  switch (item.b) {
    case 'top':
    case 'hanging':
      top = -pad;
      break;
    case 'middle':
      top = -height / 2;
      baseline = 'middle';
      break;
    case 'bottom':
    case 'ideographic':
      top = -height + pad;
      baseline = 'bottom';
      break;
    default:
      // alphabetic：锚点是首行基线，字形约占 [基线 - 0.8h, 基线 + 0.2h]
      top = -pad - size * 0.8;
  }
  const cx0 = left + width / 2;
  const cy0 = top + height / 2;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const cx = item.x + cx0 * cos - cy0 * sin;
  const cy = item.y + cx0 * sin + cy0 * cos;
  const fill = item.fill && item.fill !== '$fg' && item.fill !== 'none' ? item.fill : color;

  const pen: any = {
    name: 'text',
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    text: item.text,
    fontSize: size,
    lineHeight: LINE_HEIGHT,
    textAlign: a,
    textBaseline: baseline,
    // 自适应宽度的文字不换行；定宽文字按图元宽度换行。均不省略
    whiteSpace: fixed ? undefined : 'nowrap',
    ellipsis: false,
    disableAnchor: true,
    anchors: [],
  };
  fill && (pen.textColor = fill);
  Math.abs(r) > 1e-6 && (pen.rotate = (r * 180) / Math.PI);
  item.font && (pen.fontFamily = item.font);
  item.bold && (pen.fontWeight = 'bold');
  item.italic && (pen.fontStyle = 'italic');
  return pen;
}
