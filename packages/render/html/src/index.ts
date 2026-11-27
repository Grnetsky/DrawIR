import { computeItemsBox, textItemLines } from '@drawir/core';
import type { VectorDocument, VectorImageItem, VectorItem, VectorTextItem } from '@drawir/core';
import type { Renderer, RenderOptions, Viewport } from '@drawir/render-core';
import { renderVectorItems, resolveSvgColor, type SvgState } from '@drawir/render-svg';

/**
 * HTML（DOM）渲染器：
 * - 文字项 → HTML 文字（可选中、复制、搜索、被翻译 / 读屏识别），按 IR 的锚点、对齐、旋转、宽度因子、镜像排版；
 * - 图片项 → `<img>`（object-fit 实现 fill / contain / cover，圆角、透明度）；
 * - 路径、图案填充、块引用、裁剪 → 内联 `<svg>`（复用 @drawir/render-svg，连续的几何项合并为一个 svg 减少节点数）。
 *
 * 视口是外层「世界层」上的 CSS 变换，平移缩放不需要重新生成内容。
 * render 返回 HTML 字符串；传了 target 时同时写入 target.innerHTML（浏览器中即渲染完成）。
 */

export interface HtmlTarget {
  innerHTML: string;
}

export interface HtmlRendererOptions extends RenderOptions {
  width?: number;
  height?: number;
  /** 覆盖文档的 '$fg' 颜色 */
  color?: string;
  lineWidth?: number;
  lineDash?: number[];
  /** 固定颜色也统一使用前景色 */
  tint?: boolean;
  /** 容器 / 元素 class 前缀，缺省 'drawir' */
  classPrefix?: string;
}

const MAX_DEPTH = 24;

function num(v: number) {
  return Number.isFinite(v) ? String(Number(v.toFixed(4))) : '0';
}

function esc(v: string) {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fitView(doc: VectorDocument, options: HtmlRendererOptions, width: number, height: number): Viewport {
  if (options.viewport) return { scale: options.viewport.scale ?? 1, x: options.viewport.x ?? 0, y: options.viewport.y ?? 0 };
  if (!options.fit) return { scale: 1, x: 0, y: 0 };
  const content = doc.width && doc.height ? { x: 0, y: 0, width: doc.width, height: doc.height } : doc.bbox;
  const padding = options.padding ?? 20;
  const scale = Math.min((width - padding * 2) / content.width, (height - padding * 2) / content.height);
  if (!(scale > 0) || !Number.isFinite(scale)) return { scale: 1, x: 0, y: 0 };
  return {
    scale,
    x: (width - content.width * scale) / 2 - content.x * scale,
    y: (height - content.height * scale) / 2 - content.y * scale,
  };
}

/** 文字项 → 绝对定位的 HTML 文字。变换顺序与 Canvas / SVG 后端一致：平移到锚点 → 旋转 → 宽度因子 / 镜像 → 按对齐偏移 */
export function renderTextHtml(item: VectorTextItem, state: SvgState, cls = 'drawir'): string {
  const color = resolveSvgColor(item.fill, state, 'fg');
  if (!item.text || color === 'none' || !(item.h > 0)) return '';
  const h = item.h;
  const lh = (item.lh || 1.25) * h;
  const lines = textItemLines(item);
  const total = lines.length * lh;
  // 水平：锚点在文字块的左 / 中 / 右
  const ax = item.a === 'center' ? '-50%' : item.a === 'right' || item.a === 'end' ? '-100%' : '0';
  // 垂直：IR 的基线语义（多行时 middle 以整段中线、bottom 以末行、其余以首行对齐锚点）
  const halfLeading = (lh - h) / 2;
  let ay: number;
  switch (item.b) {
    case 'top':
    case 'hanging':
      ay = -halfLeading;
      break;
    case 'middle':
      ay = -total / 2;
      break;
    case 'bottom':
    case 'ideographic':
      ay = -total + halfLeading;
      break;
    default:
      // alphabetic：首行基线 ≈ 半行距 + 0.8 字高
      ay = -(halfLeading + h * 0.8);
  }
  const t = [`translate(${num(item.x)}px,${num(item.y)}px)`];
  item.r && t.push(`rotate(${num(item.r)}rad)`);
  (item.m || (item.w && item.w !== 1)) && t.push(`scale(${num(item.w || 1)},${item.m ? -1 : 1})`);
  t.push(`translate(${ax},${num(ay)}px)`);
  const style = [
    'position:absolute',
    'left:0',
    'top:0',
    'transform-origin:0 0',
    `transform:${t.join(' ')}`,
    'white-space:pre',
    `font-size:${num(h)}px`,
    `line-height:${num(lh)}px`,
    `font-family:${item.font || 'Arial, sans-serif'}`,
    `color:${color}`,
    `text-align:${item.a === 'center' ? 'center' : item.a === 'right' || item.a === 'end' ? 'right' : 'left'}`,
  ];
  item.bold && style.push('font-weight:bold');
  item.italic && style.push('font-style:italic');
  return `<div class="${cls}-text" style="${esc(style.join(';'))}">${lines.map(esc).join('\n')}</div>`;
}

const FIT = { fill: 'fill', contain: 'contain', cover: 'cover' } as const;

/** 图片项 → `<img>`：单位正方形经 m 映射；把 m 的两个轴归一化作为 CSS 变换，图片按框的真实宽高排版（object-fit 才正确） */
export function renderImageHtml(item: VectorImageItem, cls = 'drawir'): string {
  if (!item.src) return '';
  const m = item.m;
  const bw = Math.hypot(m[0], m[1]);
  const bh = Math.hypot(m[2], m[3]);
  if (!(bw > 0 && bh > 0)) return '';
  const t = [m[0] / bw, m[1] / bw, m[2] / bh, m[3] / bh, m[4], m[5]].map(num).join(',');
  const style = [
    'position:absolute',
    'left:0',
    'top:0',
    'transform-origin:0 0',
    `transform:matrix(${t})`,
    `width:${num(bw)}px`,
    `height:${num(bh)}px`,
    `object-fit:${FIT[item.fit || 'fill']}`,
  ];
  item.radius && item.radius > 0 && style.push(`border-radius:${num(item.radius)}px`);
  item.alpha !== undefined && style.push(`opacity:${num(item.alpha)}`);
  return `<img class="${cls}-image" alt="" draggable="false" src="${esc(item.src)}" style="${esc(style.join(';'))}">`;
}

/** 连续的几何项（路径 / 图案 / 引用 / 裁剪）→ 一个按包围盒定位的内联 svg */
function renderSvgRun(items: VectorItem[], doc: VectorDocument, state: SvgState, cls: string): string {
  const box = computeItemsBox(items, (id) => doc.vectors?.[id]);
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return '';
  // 描边会超出几何包围盒：四周留出余量，svg 自身 overflow 也设为可见
  const pad = Math.max(state.lineWidth, 1) * 2;
  const x = box.x - pad;
  const y = box.y - pad;
  const w = box.width + pad * 2;
  const h = box.height + pad * 2;
  const content = renderVectorItems(items, doc, state);
  if (!content) return '';
  return (
    `<svg class="${cls}-shape" xmlns="http://www.w3.org/2000/svg" ` +
    `style="position:absolute;left:${num(x)}px;top:${num(y)}px;overflow:visible" ` +
    `width="${num(w)}" height="${num(h)}" viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}">${content}</svg>`
  );
}

/** 顶层绘制项 → HTML 片段（世界坐标，未含视口变换） */
export function renderVectorItemsHtml(items: VectorItem[], doc: VectorDocument, state: SvgState, cls = 'drawir', depth = 0): string {
  const out: string[] = [];
  let run: VectorItem[] = [];
  const flush = () => {
    run.length && out.push(renderSvgRun(run, doc, state, cls));
    run = [];
  };
  for (const item of items) {
    if (item.t === 't') {
      flush();
      out.push(renderTextHtml(item, state, cls));
    } else if (item.t === 'i') {
      flush();
      out.push(renderImageHtml(item, cls));
    } else if (item.t === 'c' && depth < MAX_DEPTH && item.items.some((it) => it.t === 't' || it.t === 'i')) {
      // 裁剪里有文字 / 图片：用 CSS clip-path 裁剪一个世界坐标的容器，内容照常输出为 HTML
      flush();
      const id = `${cls}-clip-${state.nextId()}`;
      const rule = item.rule ? ` clip-rule="${item.rule}"` : '';
      const d = renderVectorItems([{ t: 'p', d: item.d }], doc, state).match(/ d="([^"]*)"/)?.[1] || '';
      out.push(
        `<svg width="0" height="0" style="position:absolute"><defs><clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${d}"${rule}/></clipPath></defs></svg>` +
          `<div class="${cls}-clip" style="position:absolute;left:0;top:0;width:0;height:0;overflow:visible;clip-path:url(#${id})">` +
          renderVectorItemsHtml(item.items, doc, state, cls, depth + 1) +
          '</div>',
      );
    } else {
      run.push(item);
    }
  }
  flush();
  return out.join('');
}

export class HtmlRenderer implements Renderer<HtmlRendererOptions, string> {
  readonly name = 'html';
  private target?: HtmlTarget;
  private defaults: HtmlRendererOptions;

  constructor(target?: HtmlTarget, options: HtmlRendererOptions = {}) {
    this.target = target;
    this.defaults = options;
  }

  render(doc: VectorDocument, renderOptions: HtmlRendererOptions = {}) {
    const options = { ...this.defaults, ...renderOptions };
    const cls = options.classPrefix || 'drawir';
    const width = Math.max(1, options.width ?? doc.width ?? doc.bbox.width ?? 1);
    const height = Math.max(1, options.height ?? doc.height ?? doc.bbox.height ?? 1);
    const view = fitView(doc, options, width, height);
    const background = options.background ?? doc.background;
    let nextId = 0;
    const state: SvgState = {
      color: options.color ?? doc.color ?? '#000000',
      background,
      lineWidth: options.lineWidth ?? doc.lineWidth ?? 1,
      lineDash: options.lineDash ?? doc.lineDash,
      tint: options.tint ?? false,
      nextId: () => ++nextId,
    };
    const content = renderVectorItemsHtml(doc.items, doc, state, cls);
    const bg = background && background !== 'none' ? `background:${background};` : '';
    const html =
      `<div class="${cls}" style="${esc(`position:relative;overflow:hidden;width:${num(width)}px;height:${num(height)}px;${bg}`)}">` +
      `<div class="${cls}-world" style="position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;` +
      `transform:translate(${num(view.x)}px,${num(view.y)}px) scale(${num(view.scale)})">${content}</div></div>`;
    if (this.target) this.target.innerHTML = html;
    return html;
  }
}

export function renderHtml(doc: VectorDocument, options: HtmlRendererOptions = {}) {
  return new HtmlRenderer(undefined, options).render(doc);
}
