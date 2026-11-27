/**
 * SVG 样式计算：表现属性 < 样式表 < style 属性（!important 反转），按 SVG 规则继承；
 * 以及长度单位、transform、viewBox / preserveAspectRatio。
 */
import { IDENTITY, multiplyMatrix, type VectorMatrix } from '@drawir/core';
import { parseColor, type RGBA } from './color';
import { matchRules, parseDeclarations, splitTop, type CssRule, type Declarations } from './css';
import type { XmlElement } from './xml';

export type Paint =
  | { type: 'none' }
  | { type: 'color'; c: RGBA }
  /** currentColor：使用处有 color 时取 color，否则交给 meta2d 前景色（'$fg'） */
  | { type: 'current' }
  | { type: 'url'; id: string; fallback?: Paint };

export interface Computed {
  fill: Paint;
  fillOpacity: number;
  fillRule: 'nonzero' | 'evenodd';
  stroke: Paint;
  /** 未解析的长度（百分比相对视口对角线） */
  strokeWidth: string;
  strokeOpacity: number;
  dash: string;
  dashOffset: string;
  cap: 'butt' | 'round' | 'square';
  join: 'bevel' | 'round' | 'miter';
  color?: RGBA;
  fontFamily?: string;
  /** 像素 */
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  textAnchor: 'start' | 'middle' | 'end';
  baseline: string;
  letterSpacing: string;
  visibility: 'visible' | 'hidden';
  markerStart?: string;
  markerMid?: string;
  markerEnd?: string;
  clipRule: 'nonzero' | 'evenodd';
  paintOrder: string;
  /** xml:space="preserve" */
  preserveSpace: boolean;
  direction: 'ltr' | 'rtl';
  // ↓ 不继承
  opacity: number;
  display: string;
  clipPath?: string;
  mask?: string;
  filter?: string;
  vectorEffect?: string;
  stopColor?: string;
  stopOpacity: number;
  transform?: string;
}

/** 视为 CSS 属性的表现属性 */
const PRESENTATION = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-linecap', 'stroke-linejoin', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font', 'text-anchor',
  'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'visibility', 'marker', 'marker-start', 'marker-mid', 'marker-end',
  'clip-rule', 'paint-order', 'opacity', 'display', 'clip-path', 'mask', 'filter', 'vector-effect', 'stop-color', 'stop-opacity',
  'direction', 'white-space',
]);

export const ROOT_STYLE: Computed = {
  fill: { type: 'color', c: [0, 0, 0, 1] },
  fillOpacity: 1,
  fillRule: 'nonzero',
  stroke: { type: 'none' },
  strokeWidth: '1',
  strokeOpacity: 1,
  dash: 'none',
  dashOffset: '0',
  cap: 'butt',
  join: 'miter',
  fontSize: 16,
  fontWeight: 400,
  fontStyle: 'normal',
  textAnchor: 'start',
  baseline: 'auto',
  letterSpacing: 'normal',
  visibility: 'visible',
  clipRule: 'nonzero',
  paintOrder: 'normal',
  preserveSpace: false,
  direction: 'ltr',
  opacity: 1,
  display: 'inline',
  stopOpacity: 1,
};

export class StyleResolver {
  private cache = new WeakMap<XmlElement, Record<string, string>>();
  /** 元素在文档树中的计算样式（marker / clipPath / pattern 等引用内容按定义处的祖先继承） */
  private treeCache = new WeakMap<XmlElement, Computed>();

  constructor(private rules: CssRule[]) {}

  /** 元素上声明的属性值（已层叠） */
  declared(el: XmlElement): Record<string, string> {
    let d = this.cache.get(el);
    if (d) return d;
    d = {};
    for (const k in el.attrs) PRESENTATION.has(k) && (d[k] = el.attrs[k].trim());
    // transform 属性也可被 CSS 覆盖
    el.attrs.transform && (d.transform = el.attrs.transform);
    const css = this.rules.length ? matchRules(el, this.rules) : {};
    const inline: Declarations = el.attrs.style ? parseDeclarations(el.attrs.style) : {};
    for (const k in css) css[k].important || (d[k] = css[k].value);
    for (const k in inline) inline[k].important || (d[k] = inline[k].value);
    for (const k in css) css[k].important && (d[k] = css[k].value);
    for (const k in inline) inline[k].important && (d[k] = inline[k].value);
    if (d.font) expandFont(d.font, d);
    if (d.marker) {
      d['marker-start'] ??= d.marker;
      d['marker-mid'] ??= d.marker;
      d['marker-end'] ??= d.marker;
    }
    el.attrs['xml:space'] && (d['xml:space'] = el.attrs['xml:space']);
    this.cache.set(el, d);
    return d;
  }

  /** 在父样式基础上计算元素样式 */
  compute(el: XmlElement, parent: Computed): Computed {
    const d = this.declared(el);
    const s: Computed = {
      ...parent,
      opacity: 1,
      display: 'inline',
      clipPath: undefined,
      mask: undefined,
      filter: undefined,
      vectorEffect: undefined,
      stopColor: undefined,
      stopOpacity: 1,
      transform: d.transform,
    };
    const get = (k: string) => {
      const v = d[k];
      if (v === undefined || v === 'inherit' || v === 'unset') return undefined;
      return v;
    };
    let v: string | undefined;
    // color 先算，currentColor 依赖它
    if ((v = get('color'))) {
      const c = v === 'currentColor' || v === 'currentcolor' ? parent.color : parseColor(v);
      c && (s.color = c);
    }
    (v = get('fill')) && (s.fill = parsePaint(v, s));
    (v = get('stroke')) && (s.stroke = parsePaint(v, s));
    (v = get('fill-opacity')) && (s.fillOpacity = opacityValue(v, parent.fillOpacity));
    (v = get('stroke-opacity')) && (s.strokeOpacity = opacityValue(v, parent.strokeOpacity));
    (v = get('fill-rule')) && (s.fillRule = v === 'evenodd' ? 'evenodd' : 'nonzero');
    (v = get('clip-rule')) && (s.clipRule = v === 'evenodd' ? 'evenodd' : 'nonzero');
    (v = get('stroke-width')) && (s.strokeWidth = v);
    (v = get('stroke-dasharray')) && (s.dash = v);
    (v = get('stroke-dashoffset')) && (s.dashOffset = v);
    (v = get('stroke-linecap')) && ['butt', 'round', 'square'].includes(v) && (s.cap = v as Computed['cap']);
    if ((v = get('stroke-linejoin'))) s.join = v === 'round' ? 'round' : v === 'bevel' ? 'bevel' : 'miter';
    (v = get('font-family')) && (s.fontFamily = v);
    (v = get('font-size')) && (s.fontSize = fontSizeValue(v, parent.fontSize));
    (v = get('font-weight')) && (s.fontWeight = fontWeightValue(v, parent.fontWeight));
    (v = get('font-style')) && (s.fontStyle = v === 'italic' || v === 'oblique' ? 'italic' : 'normal');
    (v = get('text-anchor')) && ['start', 'middle', 'end'].includes(v) && (s.textAnchor = v as Computed['textAnchor']);
    (v = get('dominant-baseline') || get('alignment-baseline')) && (s.baseline = v);
    (v = get('letter-spacing')) && (s.letterSpacing = v);
    (v = get('visibility')) && (s.visibility = v === 'hidden' || v === 'collapse' ? 'hidden' : 'visible');
    (v = get('marker-start')) && (s.markerStart = urlId(v));
    (v = get('marker-mid')) && (s.markerMid = urlId(v));
    (v = get('marker-end')) && (s.markerEnd = urlId(v));
    (v = get('paint-order')) && (s.paintOrder = v);
    (v = get('direction')) && (s.direction = v === 'rtl' ? 'rtl' : 'ltr');
    (v = get('xml:space')) && (s.preserveSpace = v === 'preserve');
    (v = get('white-space')) && (s.preserveSpace = v === 'pre' || v === 'pre-wrap' || v === 'break-spaces');
    (v = get('opacity')) && (s.opacity = opacityValue(v, 1));
    (v = get('display')) && (s.display = v);
    (v = get('clip-path')) && (s.clipPath = urlId(v));
    (v = get('mask')) && (s.mask = urlId(v));
    (v = get('filter')) && v !== 'none' && (s.filter = v);
    (v = get('vector-effect')) && (s.vectorEffect = v);
    (v = get('stop-color')) && (s.stopColor = v);
    (v = get('stop-opacity')) && (s.stopOpacity = opacityValue(v, 1));
    // inherit 显式继承不继承属性
    d.opacity === 'inherit' && (s.opacity = parent.opacity);
    return s;
  }

  /** 元素在文档树中的样式（沿真实祖先链计算） */
  inTree(el: XmlElement): Computed {
    let s = this.treeCache.get(el);
    if (s) return s;
    const p = el.parent;
    s = this.compute(el, p && p.tag !== '#document' ? this.inTree(p) : ROOT_STYLE);
    this.treeCache.set(el, s);
    return s;
  }
}

function parsePaint(v: string, s: Computed): Paint | undefined {
  const t = v.trim();
  if (t === 'none') return { type: 'none' };
  // currentColor 按关键字继承，在使用处按该元素的 color 求值
  if (t === 'currentColor' || t === 'currentcolor') return { type: 'current' };
  if (t.startsWith('url(')) {
    const close = t.indexOf(')');
    const id = urlId(t.slice(0, close + 1));
    const rest = t.slice(close + 1).trim();
    const fallback = rest ? parsePaint(rest, s) : undefined;
    return id ? { type: 'url', id, fallback } : fallback;
  }
  // context-fill / context-stroke：近似为当前颜色
  if (t === 'context-fill' || t === 'context-stroke') return { type: 'current' };
  const c = parseColor(t);
  return c ? { type: 'color', c } : undefined;
}

/** url(#id) / url("#id") → id；外部引用返回 undefined */
export function urlId(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /url\(\s*['"]?\s*([^'")]*?)\s*['"]?\s*\)/.exec(v);
  if (!m) return undefined;
  const ref = m[1];
  const hash = ref.indexOf('#');
  return hash >= 0 ? decodeURIComponent(ref.slice(hash + 1)) : undefined;
}

/** href="#id" → id */
export function hrefId(el: XmlElement): string | undefined {
  const h = (el.attrs.href ?? el.attrs['xlink:href'])?.trim();
  return h && h[0] === '#' ? decodeURIComponent(h.slice(1)) : undefined;
}

function opacityValue(v: string, fallback: number) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, v.trim().endsWith('%') ? n / 100 : n));
}

const FONT_KEYWORDS: Record<string, number> = {
  'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48,
};

function fontSizeValue(v: string, parentSize: number) {
  const t = v.trim().toLowerCase();
  if (t in FONT_KEYWORDS) return FONT_KEYWORDS[t];
  if (t === 'smaller') return parentSize / 1.2;
  if (t === 'larger') return parentSize * 1.2;
  const n = parseLength(t, 0, { fontSize: parentSize, percentBase: parentSize });
  return n > 0 ? n : parentSize;
}

function fontWeightValue(v: string, parent: number) {
  const t = v.trim().toLowerCase();
  if (t === 'bold') return 700;
  if (t === 'normal') return 400;
  if (t === 'bolder') return Math.min(900, parent + 300);
  if (t === 'lighter') return Math.max(100, parent - 300);
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : parent;
}

/** font 简写：[style] [variant] [weight] size[/line-height] family */
function expandFont(v: string, d: Record<string, string>) {
  const m = /^(.*?)\s*((?:[\d.]+)(?:px|pt|em|rem|%|pc|mm|cm|in)?|xx-small|x-small|small|medium|large|x-large|xx-large)(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(v.trim());
  if (!m) return;
  for (const w of m[1].split(/\s+/).filter(Boolean)) {
    if (/^(italic|oblique)$/i.test(w)) d['font-style'] ??= 'italic';
    else if (/^(bold|bolder|lighter|\d{3})$/i.test(w)) d['font-weight'] ??= w;
  }
  d['font-size'] ??= m[2];
  d['font-family'] ??= m[3];
}

export interface LengthContext {
  fontSize?: number;
  /** 百分比的基准 */
  percentBase?: number;
}

const UNIT: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6 };

/** 长度 → 用户单位（px）。无法解析时返回 fallback */
export function parseLength(v: string | undefined, fallback: number, ctx: LengthContext = {}): number {
  if (v === undefined || v === null) return fallback;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(String(v));
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  if (!u) return n;
  if (u in UNIT) return n * UNIT[u];
  if (u === 'em' || u === 'rem') return n * (ctx.fontSize ?? 16);
  if (u === 'ex') return n * (ctx.fontSize ?? 16) * 0.5;
  if (u === '%') return ctx.percentBase !== undefined ? (n / 100) * ctx.percentBase : fallback;
  return fallback;
}

/** 数字列表（stroke-dasharray、x="1 2 3"…） */
export function parseList(v: string | undefined, ctx: LengthContext = {}): number[] {
  if (!v) return [];
  return v
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => parseLength(s, NaN, ctx));
}

const ANGLE: Record<string, number> = { deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 };

function angleDeg(s: string) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/i.exec(s.trim());
  if (!m) return NaN;
  return parseFloat(m[1]) * (ANGLE[m[2].toLowerCase()] ?? 1);
}

/** transform 属性 / CSS transform → 矩阵（从左到右依次作用于坐标系） */
export function parseTransform(v: string | undefined): VectorMatrix {
  if (!v || v === 'none') return IDENTITY;
  let m: VectorMatrix = IDENTITY;
  const re = /(matrix|translate|translateX|translateY|scale|scaleX|scaleY|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let r: RegExpExecArray | null;
  while ((r = re.exec(v))) {
    const fn = r[1].toLowerCase();
    const args = r[2].split(/[\s,]+/).filter(Boolean);
    const num = (i: number, d = 0) => {
      if (args[i] === undefined) return d;
      const n = parseLength(args[i], NaN);
      return Number.isFinite(n) ? n : d;
    };
    let t: VectorMatrix;
    switch (fn) {
      case 'matrix':
        t = [num(0, 1), num(1), num(2), num(3, 1), num(4), num(5)];
        break;
      case 'translate':
        t = [1, 0, 0, 1, num(0), num(1)];
        break;
      case 'translatex':
        t = [1, 0, 0, 1, num(0), 0];
        break;
      case 'translatey':
        t = [1, 0, 0, 1, 0, num(0)];
        break;
      case 'scale': {
        const sx = num(0, 1);
        t = [sx, 0, 0, args.length > 1 ? num(1, 1) : sx, 0, 0];
        break;
      }
      case 'scalex':
        t = [num(0, 1), 0, 0, 1, 0, 0];
        break;
      case 'scaley':
        t = [1, 0, 0, num(0, 1), 0, 0];
        break;
      case 'rotate': {
        const a = ((Number.isFinite(angleDeg(args[0] || '0')) ? angleDeg(args[0] || '0') : 0) * Math.PI) / 180;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const cx = num(1);
        const cy = num(2);
        t = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
        break;
      }
      case 'skewx':
        t = [1, 0, Math.tan((angleDeg(args[0] || '0') * Math.PI) / 180) || 0, 1, 0, 0];
        break;
      default:
        t = [1, Math.tan((angleDeg(args[0] || '0') * Math.PI) / 180) || 0, 0, 1, 0, 0];
    }
    m = multiplyMatrix(m, t);
  }
  return m;
}

export function parseViewBox(v: string | undefined): [number, number, number, number] | undefined {
  if (!v) return undefined;
  const n = v.trim().split(/[\s,]+/).map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x)) || !(n[2] > 0 && n[3] > 0)) return undefined;
  return n as [number, number, number, number];
}

export interface AspectRatio {
  /** none：不等比拉伸 */
  align: string;
  slice: boolean;
}

export function parseAspectRatio(v: string | undefined): AspectRatio {
  const parts = (v || '').trim().split(/\s+/).filter((p) => p && p !== 'defer');
  return { align: parts[0] || 'xMidYMid', slice: parts[1] === 'slice' };
}

/** viewBox → 视口 (x, y, w, h) 的矩阵 */
export function viewBoxMatrix(vb: [number, number, number, number], x: number, y: number, w: number, h: number, par: AspectRatio): VectorMatrix {
  let sx = w / vb[2];
  let sy = h / vb[3];
  if (par.align === 'none') return [sx, 0, 0, sy, x - vb[0] * sx, y - vb[1] * sy];
  const s = par.slice ? Math.max(sx, sy) : Math.min(sx, sy);
  sx = sy = s;
  const al = par.align.toLowerCase();
  const fx = al.includes('xmid') ? 0.5 : al.includes('xmax') ? 1 : 0;
  const fy = al.includes('ymid') ? 0.5 : al.includes('ymax') ? 1 : 0;
  const tx = x + (w - vb[2] * s) * fx - vb[0] * s;
  const ty = y + (h - vb[3] * s) * fy - vb[1] * s;
  return [s, 0, 0, s, tx, ty];
}

/** 字体名列表规范化：去掉多余空白，保留引号（Canvas font 可直接使用） */
export function fontFamilyCss(v: string | undefined) {
  if (!v) return undefined;
  const list = splitTop(v, ',').map((f) => f.trim()).filter(Boolean);
  return list.length ? list.join(', ') : undefined;
}
