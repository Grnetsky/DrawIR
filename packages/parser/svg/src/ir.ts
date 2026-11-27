/**
 * SVG → DrawIR 单元树。
 *
 * 格式调研（阶段 0）：
 * 1. 容器：XML 文本（UTF-8 / XML 声明中的编码 / BOM）；.svgz 为 gzip 压缩。无 DOM 依赖，自带 XML 解析器。
 * 2. 页面：单页。页面范围为根视口（width / height / viewBox），没有时取内容范围。
 * 3. 坐标：用户单位 = CSS 像素，Y 向下，原点左上；width / height 支持 px pt pc mm cm in em ex。
 * 4. 变换：transform 属性 / CSS transform（matrix translate scale rotate skewX skewY），逐级累乘；
 *    嵌套 <svg>、<symbol>、<marker> 的 viewBox + preserveAspectRatio；<use> 的 x / y。
 *    旋转、斜切全部烘进矩阵（与 Figma 解析器相同），不使用 pen.rotate。
 * 5. 几何：path（M L H V C S Q T A Z，相对 / 绝对，端点参数圆弧换成圆心参数）、rect（rx / ry 圆角）、
 *    circle、ellipse、line、polyline、polygon。
 * 6. 样式：表现属性 < <style> 样式表 < style 属性（!important 反转）；fill / stroke 及各自不透明度、
 *    stroke-width / dasharray / linecap / linejoin、fill-rule、opacity（组不透明度近似为逐项相乘）、
 *    currentColor（没有 color 时为 '$fg'）、vector-effect: non-scaling-stroke（显示线宽 px）。
 *    渐变：linearGradient / radialGradient，objectBoundingBox / userSpaceOnUse、gradientTransform、
 *    href 继承、焦点；能等价表达时同时记录图元渐变（可在属性面板编辑）。
 * 7. 文字：<text> / <tspan> 单行文字，x / y / dx / dy 定位，text-anchor、dominant-baseline、字体属性；
 *    空白按 xml:space 规则折叠。多样式文本按估算字宽依次排列。
 * 8. 复用：<use>（引用元素、<symbol>、<svg>）在 IR 阶段展开（样式从 <use> 继承，不能共享几何）。
 * 9. 层级：<g> / <a> / <svg> / <use> → 组合；<switch> 取第一个可渲染的子元素。
 * 10. 连线：SVG 没有连接语义，线条均为矢量图元。<marker> 按顶点方向展开到线条图元里。
 * 11. 图片：<image>，data URL 或外链；imageUrls 可替换地址（键见 readSvgImages）。
 * 12. 不支持：filter（除投影外，计 filter:*）、mask（按白色内容轮廓近似为裁剪，计 mask）、描边 / 文字的 pattern（取主色，计 pattern；填充的 pattern 平铺展开）、
 *     textPath、foreignObject、per-glyph 定位 / rotate、stroke-dashoffset、spreadMethod reflect / repeat、动画、混合模式。
 */
import {
  accumulatePathBox,
  applyMatrix,
  BoxAccumulator,
  composeMatrix,
  computeItemsBox,
  createGeom,
  estimateTextWidth,
  IDENTITY,
  invertMatrix,
  isSimilarity,
  matrixScale,
  multiplyMatrix,
  pathItem,
  rotateMatrix,
  scaleMatrix,
  transformBox,
  transformItem,
  translateMatrix,
  VectorPathBuilder,
  type VectorBox,
  type VectorClipItem,
  type VectorGeom,
  type VectorGradient,
  type VectorItem,
  type VectorMatrix,
  type VectorPaint,
  type VectorPathData,
  type VectorStyle,
  type VectorTextItem,
} from '@drawir/core';
import { gunzipSync } from 'fflate';
import { colorCss, parseColor, type RGBA } from './color';
import { parseStylesheet, type CssRule } from './css';
import { bitmapSize, decodeDataUrl, imageKey } from './image';
import { bisect, ellipseSegs, emitSegs, parsePath, parsePoints, pathVertices, pointsToSegs, rectSegs, type Seg } from './path';
import {
  fontFamilyCss,
  hrefId,
  parseAspectRatio,
  parseLength,
  parseList,
  parseTransform,
  parseViewBox,
  ROOT_STYLE,
  StyleResolver,
  urlId,
  viewBoxMatrix,
  type Computed,
  type Paint,
} from './style';
import type { SvgPageInfo, SvgParseOptions, SvgParseStats, SvgPenInfo } from './types';
import { childElements, parseXml, textContent, type XmlElement } from './xml';

/** 图元渐变（画布坐标）。Converter 换算为相对图元框后交给适配层 */
export interface PenGradient {
  type: 'linear' | 'radial';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 径向半径（画布像素） */
  r: number;
  /** 色标，颜色为 0~1 RGBA */
  stops: { i: number; c: RGBA }[];
}

export interface SvgLeaf {
  kind: 'leaf';
  info: SvgPenInfo;
  name?: string;
  /** 画布坐标（Y 向下） */
  items: VectorItem[];
  /** 与 items 一一对应 */
  grads: (PenGradient | undefined)[];
  shadow?: { color: string; x: number; y: number; blur: number };
}

export interface SvgGroup {
  kind: 'group';
  info: SvgPenInfo;
  name?: string;
  children: SvgUnit[];
}

export type SvgUnit = SvgLeaf | SvgGroup;

export interface SvgTree {
  pages: SvgUnit[][];
  pageList: SvgPageInfo[];
  vectors: Record<string, VectorGeom>;
  stats: SvgParseStats;
  background?: string;
}

export function resolveOptions(o: SvgParseOptions = {}) {
  return {
    scale: 1,
    origin: { x: 0, y: 0 },
    page: 'viewport' as 'viewport' | 'content',
    pageBorder: false,
    granularity: 'node' as 'node' | 'layer' | 'page',
    group: true,
    editable: true,
    images: true,
    imageUrls: {} as Record<string, string>,
    skipImages: [] as string[],
    currentColor: '$fg',
    ...o,
  };
}
export type ResolvedOptions = ReturnType<typeof resolveOptions>;

export function unitItems(u: SvgUnit): VectorItem[] {
  return u.kind === 'leaf' ? u.items : u.children.flatMap(unitItems);
}

/** 遍历上下文 */
interface Ctx {
  /** 当前用户坐标 → 页面坐标 */
  m: VectorMatrix;
  style: Computed;
  /** 视口尺寸（百分比长度的基准） */
  vw: number;
  vh: number;
  depth: number;
  /** 正在展开的 use / marker 引用（检测循环引用） */
  refs: Set<XmlElement>;
}

interface ClipRegion {
  d: VectorPathData;
  rule?: 'nonzero' | 'evenodd';
  box: VectorBox;
  /** 轴对齐矩形（可精确判断「完全在内」） */
  rect?: boolean;
  /** 轴对齐、等半径的圆角矩形：恰好铺满它的图片改用图片圆角，不再裁剪 */
  radius?: number;
}

/** 会产生图形的元素 */
const RENDERABLE = new Set(['g', 'a', 'svg', 'switch', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image']);
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const MARKABLE = new Set(['path', 'line', 'polyline', 'polygon']);
/** 不绘制、静默跳过的元素 */
const SILENT = new Set([
  'defs', 'symbol', 'clipPath', 'mask', 'marker', 'pattern', 'linearGradient', 'radialGradient', 'style', 'script', 'title',
  'desc', 'metadata', 'filter', 'font', 'font-face', 'animate', 'animateMotion', 'animateTransform', 'set', 'cursor', 'view',
  'mpath', 'discard', 'solidcolor', 'stop', 'hatch', 'meshgradient',
]);

export class SvgToIR {
  private opts: ResolvedOptions;
  private ids = new Map<string, XmlElement>();
  private styles!: StyleResolver;
  stats!: SvgParseStats;

  constructor(options: SvgParseOptions = {}) {
    this.opts = resolveOptions(options);
  }

  build(data: Uint8Array | string): SvgTree {
    const t0 = now();
    this.stats = { nodes: 0, shapes: 0, texts: 0, images: 0, gradients: 0, uses: 0, clips: 0, markers: 0, pens: 0, unsupported: {}, errors: [], ms: 0 };
    const root = parseSvgRoot(data);
    this.ids.clear();
    const rules: CssRule[] = [];
    const scan = (el: XmlElement) => {
      el.attrs.id && !this.ids.has(el.attrs.id) && this.ids.set(el.attrs.id, el);
      if (el.tag === 'style' && (!el.attrs.type || /css/i.test(el.attrs.type))) parseStylesheet(textContent(el), rules);
      for (const c of el.children) c.kind === 'element' && scan(c);
    };
    scan(root);
    this.styles = new StyleResolver(rules);

    // 根视口
    const rootStyle = this.styles.compute(root, ROOT_STYLE);
    const vb = parseViewBox(root.attrs.viewBox);
    const size = (v: string | undefined) => (v && !v.trim().endsWith('%') ? parseLength(v, NaN, { fontSize: rootStyle.fontSize }) : NaN);
    let W = size(root.attrs.width);
    let H = size(root.attrs.height);
    if (vb) {
      if (!(W > 0) && H > 0) W = (H * vb[2]) / vb[3];
      else if (!(H > 0) && W > 0) H = (W * vb[3]) / vb[2];
      else if (!(W > 0) && !(H > 0)) {
        W = vb[2];
        H = vb[3];
      }
    }
    const hasViewport = W > 0 && H > 0;
    const m0: VectorMatrix = vb && hasViewport ? viewBoxMatrix(vb, 0, 0, W, H, parseAspectRatio(root.attrs.preserveAspectRatio)) : IDENTITY;
    const ctx: Ctx = {
      m: multiplyMatrix(m0, parseTransform(rootStyle.transform)),
      style: rootStyle,
      vw: vb ? vb[2] : hasViewport ? W : 300,
      vh: vb ? vb[3] : hasViewport ? H : 150,
      depth: 0,
      refs: new Set(),
    };
    this.stats.nodes++;
    let units = this.post(root, rootStyle, ctx.m, ctx, this.children(root, ctx));

    // 粒度
    if (this.opts.granularity === 'page') {
      units = units.length ? [mergeUnits(units, this.info(root))] : [];
    } else if (this.opts.granularity === 'layer') {
      // 只有一个顶层分组（如 Inkscape 图层、导出工具的外层 <g>）时按它的子元素拆分
      while (units.length === 1 && units[0].kind === 'group') units = units[0].children;
      units = units.map((u) => (u.kind === 'leaf' ? u : mergeUnits(u.children, u.info, u.name)));
    }

    // 页面定位：页面框左上角 → origin，按 scale 缩放
    const k = this.opts.scale > 0 ? this.opts.scale : 1;
    const box = this.opts.page === 'viewport' && hasViewport ? { x: 0, y: 0, width: W, height: H } : unitsBox(units);
    if (this.opts.pageBorder && box.width > 0 && box.height > 0) {
      const b = new VectorPathBuilder();
      emitSegs(rectSegs(box.x, box.y, box.width, box.height, 0, 0), b);
      units.unshift({ kind: 'leaf', info: { tag: 'svg', part: 'page' }, items: [pathItem(b.d, { stroke: '#c0c0c0', px: 1 })], grads: [undefined] });
    }
    const { x: ox, y: oy } = this.opts.origin;
    const pm: VectorMatrix = [k, 0, 0, k, ox - box.x * k, oy - box.y * k];
    units.forEach((u) => transformUnit(u, pm));
    const bg = this.styles.declared(root)['background-color'] ?? this.styles.declared(root).background;
    const bgc = bg ? parseColor(bg.split(/\s+/)[0]) : undefined;
    const info: SvgPageInfo = { name: this.label(root) || 'SVG', x: ox, y: oy, width: box.width * k, height: box.height * k };
    bgc && bgc[3] > 0 && (info.background = colorCss(bgc));
    this.stats.ms = Math.round(now() - t0);
    return { pages: [units], pageList: [info], vectors: {}, stats: this.stats, background: info.background };
  }

  // ───────────────────────────── 遍历 ─────────────────────────────

  private children(el: XmlElement, ctx: Ctx): SvgUnit[] {
    const out: SvgUnit[] = [];
    for (const c of childElements(el)) this.visit(c, ctx, out);
    return out;
  }

  private visit(el: XmlElement, ctx: Ctx, out: SvgUnit[]) {
    if (ctx.depth > 128) return;
    const tag = el.tag;
    if (!RENDERABLE.has(tag)) {
      if (tag === 'foreignObject' || tag === 'textPath' || tag === 'iframe' || tag === 'video' || tag === 'audio' || tag === 'canvas') this.count(tag);
      else if (!SILENT.has(tag) && !tag.includes(':')) this.count(`element:${tag}`);
      return;
    }
    const s = this.styles.compute(el, ctx.style);
    if (s.display === 'none') return;
    this.stats.nodes++;
    try {
      // 嵌套 svg / use 的位置变换在 transform 之后
      const m = multiplyMatrix(ctx.m, parseTransform(s.transform));
      const sub: Ctx = { ...ctx, m, style: s, depth: ctx.depth + 1 };
      let units: SvgUnit[] = [];
      switch (tag) {
        case 'g':
        case 'a':
          units = this.children(el, sub);
          break;
        case 'switch': {
          const first = childElements(el).find((c) => RENDERABLE.has(c.tag) && !c.attrs.requiredExtensions);
          first && this.visit(first, sub, units);
          break;
        }
        case 'svg':
          units = this.nestedSvg(el, sub);
          break;
        case 'use':
          units = this.use(el, sub);
          break;
        default: {
          const leaf = this.leaf(el);
          if (SHAPES.has(tag)) this.drawShape(el, s, sub, leaf);
          else if (tag === 'text') this.drawText(el, s, sub, leaf);
          else if (tag === 'image') this.drawImage(el, s, sub, leaf);
          leaf.items.length && units.push(leaf);
        }
      }
      units = this.post(el, s, m, sub, units);
      if (tag === 'g' || tag === 'a' || tag === 'svg' || tag === 'use' || tag === 'switch') {
        if (this.opts.group && this.opts.granularity === 'node' && units.length > 1) units = [{ kind: 'group', info: this.info(el), name: this.label(el), children: units }];
      }
      out.push(...units);
    } catch (e: any) {
      this.stats.errors.push(`${tag}${el.attrs.id ? '#' + el.attrs.id : ''}: ${e?.message || e}`);
    }
  }

  /** 元素级效果：filter（投影）→ clip-path → mask → opacity */
  private post(el: XmlElement, s: Computed, m: VectorMatrix, ctx: Ctx, units: SvgUnit[]): SvgUnit[] {
    if (!units.length) return units;
    if (s.filter) this.applyFilter(s.filter, m, units);
    if (s.clipPath) {
      const clip = this.clipRegion(s.clipPath, m, ctx, units);
      clip && (units = this.clipUnits(units, clip));
    } else if (/^\s*(inset|circle|ellipse|polygon|path)\(/.test(this.styles.declared(el)['clip-path'] || '')) this.count('clip-path:shape');
    if (s.mask) {
      const clip = this.maskRegion(s.mask, m, ctx, units);
      clip && (units = this.clipUnits(units, clip));
    }
    if (s.opacity < 1) units.forEach((u) => fadeUnit(u, s.opacity));
    return units;
  }

  private nestedSvg(el: XmlElement, ctx: Ctx, size?: { w?: string; h?: string }): SvgUnit[] {
    const lc = { fontSize: ctx.style.fontSize };
    const x = parseLength(el.attrs.x, 0, { ...lc, percentBase: ctx.vw });
    const y = parseLength(el.attrs.y, 0, { ...lc, percentBase: ctx.vh });
    const w = parseLength(size?.w ?? el.attrs.width ?? '100%', ctx.vw, { ...lc, percentBase: ctx.vw });
    const h = parseLength(size?.h ?? el.attrs.height ?? '100%', ctx.vh, { ...lc, percentBase: ctx.vh });
    if (!(w > 0 && h > 0)) return [];
    return this.viewport(el, ctx, x, y, w, h);
  }

  /** 新视口（嵌套 svg / symbol）：viewBox 映射 + overflow 裁剪 */
  private viewport(el: XmlElement, ctx: Ctx, x: number, y: number, w: number, h: number): SvgUnit[] {
    const vb = parseViewBox(el.attrs.viewBox);
    const inner = vb ? viewBoxMatrix(vb, x, y, w, h, parseAspectRatio(el.attrs.preserveAspectRatio)) : translateMatrix(x, y);
    const units = this.children(el, { ...ctx, m: multiplyMatrix(ctx.m, inner), vw: vb ? vb[2] : w, vh: vb ? vb[3] : h });
    const overflow = this.styles.declared(el).overflow || el.attrs.overflow;
    if (overflow === 'visible' || overflow === 'auto') return units;
    return this.clipUnits(units, this.rectClip(ctx.m, x, y, w, h));
  }

  private use(el: XmlElement, ctx: Ctx): SvgUnit[] {
    const id = hrefId(el);
    const ref = id ? this.ids.get(id) : undefined;
    if (!ref) {
      this.count(id ? 'use:missing' : 'use:external');
      return [];
    }
    if (ctx.refs.has(ref) || ref === el) {
      this.stats.errors.push(`use#${id}: 循环引用`);
      return [];
    }
    this.stats.uses++;
    const lc = { fontSize: ctx.style.fontSize };
    const x = parseLength(el.attrs.x, 0, { ...lc, percentBase: ctx.vw });
    const y = parseLength(el.attrs.y, 0, { ...lc, percentBase: ctx.vh });
    const refs = new Set(ctx.refs).add(ref);
    const sub: Ctx = { ...ctx, m: multiplyMatrix(ctx.m, translateMatrix(x, y)), refs };
    if (ref.tag === 'symbol') {
      const s = this.styles.compute(ref, ctx.style);
      if (s.display === 'none') return [];
      const w = parseLength(el.attrs.width ?? ref.attrs.width ?? '100%', ctx.vw, { ...lc, percentBase: ctx.vw });
      const h = parseLength(el.attrs.height ?? ref.attrs.height ?? '100%', ctx.vh, { ...lc, percentBase: ctx.vh });
      if (!(w > 0 && h > 0)) return [];
      const symM = multiplyMatrix(sub.m, parseTransform(s.transform));
      const symCtx: Ctx = { ...sub, m: symM, style: s, depth: ctx.depth + 1 };
      const units = this.viewport(ref, symCtx, parseLength(ref.attrs.x, 0, lc), parseLength(ref.attrs.y, 0, lc), w, h);
      return this.post(ref, s, symM, symCtx, units);
    }
    const out: SvgUnit[] = [];
    if (ref.tag === 'svg') {
      const s = this.styles.compute(ref, ctx.style);
      if (s.display === 'none') return [];
      const m = multiplyMatrix(sub.m, parseTransform(s.transform));
      const svgCtx: Ctx = { ...sub, m, style: s, depth: ctx.depth + 1 };
      const units = this.nestedSvg(ref, svgCtx, { w: el.attrs.width, h: el.attrs.height });
      return this.post(ref, s, m, svgCtx, units);
    }
    this.visit(ref, sub, out);
    return out;
  }

  private leaf(el: XmlElement): SvgLeaf {
    const leaf: SvgLeaf = { kind: 'leaf', info: this.info(el), items: [], grads: [] };
    const name = this.label(el);
    name && (leaf.name = name);
    return leaf;
  }

  private info(el: XmlElement): SvgPenInfo {
    const info: SvgPenInfo = { tag: el.tag };
    el.attrs.id && (info.id = el.attrs.id);
    const name = this.label(el);
    name && (info.name = name);
    el.attrs.class && (info.class = el.attrs.class);
    return info;
  }

  /** 图层名：inkscape:label / data-name / <title> / id */
  private label(el: XmlElement): string | undefined {
    const a = el.attrs;
    const title = childElements(el).find((c) => c.tag === 'title');
    const t = title ? textContent(title).trim() : '';
    return a['inkscape:label'] || a['data-name'] || a['aria-label'] || t || a.id || undefined;
  }

  private push(leaf: SvgLeaf, item: VectorItem, grad?: PenGradient) {
    leaf.items.push(item);
    leaf.grads.push(grad);
  }

  // ───────────────────────────── 图形 ─────────────────────────────

  private shapeSegs(el: XmlElement, ctx: Ctx): Seg[] {
    const a = el.attrs;
    const lc = { fontSize: ctx.style.fontSize };
    const X = (v: string | undefined, d = 0) => parseLength(v, d, { ...lc, percentBase: ctx.vw });
    const Y = (v: string | undefined, d = 0) => parseLength(v, d, { ...lc, percentBase: ctx.vh });
    const diag = Math.sqrt((ctx.vw * ctx.vw + ctx.vh * ctx.vh) / 2);
    const R = (v: string | undefined, d = 0) => parseLength(v, d, { ...lc, percentBase: diag });
    switch (el.tag) {
      case 'path':
        return parsePath(a.d);
      case 'rect': {
        let rx = a.rx !== undefined && a.rx !== 'auto' ? X(a.rx, NaN) : NaN;
        let ry = a.ry !== undefined && a.ry !== 'auto' ? Y(a.ry, NaN) : NaN;
        if (!(rx >= 0)) rx = ry >= 0 ? ry : 0;
        if (!(ry >= 0)) ry = rx;
        return rectSegs(X(a.x), Y(a.y), X(a.width), Y(a.height), rx, ry);
      }
      case 'circle': {
        const r = R(a.r);
        return ellipseSegs(X(a.cx), Y(a.cy), r, r);
      }
      case 'ellipse': {
        let rx = a.rx !== undefined && a.rx !== 'auto' ? X(a.rx, NaN) : NaN;
        let ry = a.ry !== undefined && a.ry !== 'auto' ? Y(a.ry, NaN) : NaN;
        if (!(rx >= 0)) rx = ry;
        if (!(ry >= 0)) ry = rx;
        return ellipseSegs(X(a.cx), Y(a.cy), rx, ry);
      }
      case 'line':
        return [
          { c: 'M', x: X(a.x1), y: Y(a.y1) },
          { c: 'L', x: X(a.x2), y: Y(a.y2) },
        ];
      case 'polyline':
        return pointsToSegs(parsePoints(a.points), false);
      case 'polygon':
        return pointsToSegs(parsePoints(a.points), true);
    }
    return [];
  }

  private drawShape(el: XmlElement, s: Computed, ctx: Ctx, leaf: SvgLeaf) {
    const segs = this.shapeSegs(el, ctx);
    if (!segs.length || s.visibility === 'hidden') return;
    const m = ctx.m;
    const b = new VectorPathBuilder(m);
    emitSegs(segs, b);
    if (b.empty) return;
    this.stats.shapes++;
    let localBox: VectorBox | undefined;
    const getBox = () => (localBox ??= segsBox(segs));
    // 图案填充：平铺图案内容并裁剪到形状内（Figma / Sketch 导出的图片填充即为单块图案）
    let patternFill: VectorItem[] | undefined;
    if (el.tag !== 'line' && s.fill.type === 'url') {
      const ref = this.ids.get(s.fill.id);
      if (ref?.tag === 'pattern') {
        const axis = Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
        const rx = rectRadius(segs);
        const region: ClipRegion = { d: b.d, box: pathBox(b.d), rule: s.fillRule === 'evenodd' ? 'evenodd' : undefined };
        if (el.tag === 'rect' && axis) rx > 0 ? Math.abs(Math.abs(m[0]) - Math.abs(m[3])) < 1e-9 && (region.radius = rx * Math.abs(m[0])) : (region.rect = true);
        patternFill = this.patternItems(ref, s.fillOpacity, ctx, getBox(), region);
      }
    }
    patternFill?.forEach((it) => this.push(leaf, it));
    const fill = el.tag === 'line' || patternFill ? undefined : this.paint(s.fill, s.fillOpacity, s, ctx, getBox);
    const strokePaint = this.paint(s.stroke, s.strokeOpacity, s, ctx, getBox);
    const style: VectorStyle = { stroke: 'none' };
    fill && (style.fill = fill.paint);
    s.fillRule === 'evenodd' && (style.rule = 'evenodd');
    const sw = this.strokeWidth(s, ctx);
    if (strokePaint && sw > 0) {
      const nonScaling = s.vectorEffect === 'non-scaling-stroke';
      const k = nonScaling ? 1 : matrixScale(m);
      style.stroke = strokePaint.paint;
      nonScaling ? (style.px = sw) : (style.lw = sw * k);
      const dash = this.dash(s, ctx, k);
      dash && (style.dash = dash);
      s.cap !== 'butt' && (style.cap = s.cap);
      s.join !== 'miter' && (style.join = s.join);
    }
    if (style.fill || style.stroke !== 'none') {
      // paint-order: stroke 在 fill 之前时拆成两项
      if (style.fill && style.stroke !== 'none' && /^\s*(stroke|markers\s+stroke)/.test(s.paintOrder)) {
        const { fill: f, ...stroke } = style;
        this.push(leaf, pathItem(b.d, stroke));
        this.push(leaf, pathItem(b.d, { fill: f, rule: style.rule, stroke: 'none' }), fill?.grad);
      } else this.push(leaf, pathItem(b.d, style), fill?.grad);
    }
    if (MARKABLE.has(el.tag) && (s.markerStart || s.markerMid || s.markerEnd)) this.drawMarkers(segs, s, ctx, sw, leaf);
  }

  private strokeWidth(s: Computed, ctx: Ctx) {
    const diag = Math.sqrt((ctx.vw * ctx.vw + ctx.vh * ctx.vh) / 2);
    const v = parseLength(s.strokeWidth, 1, { fontSize: s.fontSize, percentBase: diag });
    return v > 0 ? v : 0;
  }

  /** stroke-dasharray → 画布单位；无效值按实线（与浏览器一致） */
  private dash(s: Computed, ctx: Ctx, k: number): number[] | undefined {
    if (!s.dash || s.dash === 'none') return undefined;
    const diag = Math.sqrt((ctx.vw * ctx.vw + ctx.vh * ctx.vh) / 2);
    let list = parseList(s.dash, { fontSize: s.fontSize, percentBase: diag });
    if (!list.length || list.some((v) => !(v >= 0)) || !list.some((v) => v > 0)) return undefined;
    list.length % 2 && (list = [...list, ...list]);
    parseLength(s.dashOffset, 0) !== 0 && this.count('stroke-dashoffset');
    return list.map((v) => v * k);
  }

  /** 填充 / 描边 → IR 颜色或渐变（与可绑定的图元渐变） */
  private paint(p: Paint, opacity: number, s: Computed, ctx: Ctx, box: () => VectorBox): { paint: VectorPaint; grad?: PenGradient } | undefined {
    switch (p.type) {
      case 'none':
        return undefined;
      case 'color':
        return p.c[3] * opacity > 0 ? { paint: colorCss(p.c, opacity) } : undefined;
      case 'current':
        if (s.color) return s.color[3] * opacity > 0 ? { paint: colorCss(s.color, opacity) } : undefined;
        return { paint: this.opts.currentColor };
      case 'url': {
        const ref = this.ids.get(p.id);
        if (ref && (ref.tag === 'linearGradient' || ref.tag === 'radialGradient')) {
          const g = this.gradient(ref, opacity, ctx, box);
          if (g) return g;
          return p.fallback ? this.paint(p.fallback, opacity, s, ctx, box) : undefined;
        }
        if (ref && ref.tag === 'pattern') {
          // 描边 / 文字的图案、无法平铺的图案：取主色近似
          this.count('pattern');
          if (p.fallback) return this.paint(p.fallback, opacity, s, ctx, box);
          const c = this.patternColor(ref);
          return c ? { paint: colorCss(c, opacity * 0.6) } : undefined;
        }
        if (ref && ref.tag === 'solidcolor') {
          const c = parseColor(this.styles.declared(ref)['solid-color'] || ref.attrs['solid-color']);
          return c ? { paint: colorCss(c, opacity) } : undefined;
        }
        return p.fallback ? this.paint(p.fallback, opacity, s, ctx, box) : undefined;
      }
    }
  }

  /** 沿 href 链取图案属性 / 内容 */
  private patternChain(el: XmlElement): XmlElement[] {
    const out: XmlElement[] = [];
    for (let g: XmlElement | undefined = el; g && out.length < 16 && !out.includes(g); ) {
      out.push(g);
      const id = hrefId(g);
      g = id ? this.ids.get(id) : undefined;
      g && g.tag !== 'pattern' && (g = undefined);
    }
    return out;
  }

  /**
   * 图案填充 → 平铺的图案内容（每块按图块裁剪），整体裁剪到形状轮廓 shape。
   * 返回 undefined 表示无法展开（图块过多、尺寸无效），由调用方退化为主色
   */
  private patternItems(el: XmlElement, opacity: number, ctx: Ctx, box: VectorBox, shape: ClipRegion): VectorItem[] | undefined {
    if (ctx.refs.has(el)) return undefined;
    const chain = this.patternChain(el);
    const attr = (name: string) => chain.find((g) => g.attrs[name] !== undefined)?.attrs[name];
    const content = chain.find((g) => childElements(g).length) || el;
    const obb = attr('patternUnits') !== 'userSpaceOnUse';
    const contentObb = attr('patternContentUnits') === 'objectBoundingBox';
    const lc = { fontSize: ctx.style.fontSize };
    const len = (name: string, base: number, origin: number, size: number) => {
      const v = attr(name);
      if (v === undefined) return obb ? origin : 0;
      if (obb) {
        const n = parseFloat(v);
        return Number.isFinite(n) ? origin + (v.trim().endsWith('%') ? n / 100 : n) * size : 0;
      }
      return parseLength(v, 0, { ...lc, percentBase: base });
    };
    const x = len('x', ctx.vw, box.x, box.width);
    const y = len('y', ctx.vh, box.y, box.height);
    const w = len('width', ctx.vw, 0, box.width);
    const h = len('height', ctx.vh, 0, box.height);
    if (!(w > 0 && h > 0)) return [];
    const P = multiplyMatrix(ctx.m, parseTransform(attr('patternTransform')));
    const inv = invertMatrix(multiplyMatrix(invertMatrix(ctx.m) || IDENTITY, P));
    const pb = inv ? transformBox(inv, box) : box;
    const i0 = Math.floor((pb.x - x) / w);
    const i1 = Math.ceil((pb.x + pb.width - x) / w);
    const j0 = Math.floor((pb.y - y) / h);
    const j1 = Math.ceil((pb.y + pb.height - y) / h);
    if ((i1 - i0) * (j1 - j0) > 400) {
      this.count('pattern:tiles');
      return undefined;
    }
    const vb = parseViewBox(attr('viewBox'));
    const inner: VectorMatrix = vb
      ? viewBoxMatrix(vb, 0, 0, w, h, parseAspectRatio(attr('preserveAspectRatio')))
      : contentObb
        ? [box.width, 0, 0, box.height, 0, 0]
        : IDENTITY;
    const refs = new Set(ctx.refs).add(el);
    const style = this.styles.inTree(content);
    let units: SvgUnit[] = [];
    for (let i = i0; i < Math.max(i1, i0 + 1); i++) {
      for (let j = j0; j < Math.max(j1, j0 + 1); j++) {
        const tx = x + i * w;
        const ty = y + j * h;
        const tm = multiplyMatrix(P, multiplyMatrix(translateMatrix(tx, ty), inner));
        const tile = this.children(content, { m: tm, style, vw: vb ? vb[2] : w, vh: vb ? vb[3] : h, depth: ctx.depth + 1, refs });
        const overflow = this.styles.declared(content).overflow || content.attrs.overflow;
        units.push(...(overflow === 'visible' ? tile : this.clipUnits(tile, this.rectClip(P, tx, ty, w, h))));
      }
    }
    units = this.clipUnits(units, shape);
    opacity < 1 && units.forEach((u) => fadeUnit(u, opacity));
    return mergeUnits(units, {}).items;
  }

  /** 图案的主色（不支持图案填充时的近似） */
  private patternColor(el: XmlElement, depth = 0): RGBA | undefined {
    if (depth > 8) return undefined;
    for (const c of childElements(el)) {
      if (SHAPES.has(c.tag) || c.tag === 'text') {
        const s = this.styles.inTree(c);
        if (s.fill.type === 'color') return s.fill.c;
        if (s.stroke.type === 'color') return s.stroke.c;
      }
      const sub = this.patternColor(c, depth + 1);
      if (sub) return sub;
    }
    const id = hrefId(el);
    const ref = id ? this.ids.get(id) : undefined;
    return ref && ref !== el ? this.patternColor(ref, depth + 1) : undefined;
  }

  /** 沿 href 链取渐变属性 */
  private gradAttr(el: XmlElement, name: string): string | undefined {
    for (let i = 0, g: XmlElement | undefined = el; g && i < 16; i++) {
      if (g.attrs[name] !== undefined) return g.attrs[name];
      const id = hrefId(g);
      g = id ? this.ids.get(id) : undefined;
      if (g && g.tag !== 'linearGradient' && g.tag !== 'radialGradient') break;
    }
    return undefined;
  }

  private gradStops(el: XmlElement): XmlElement[] {
    for (let i = 0, g: XmlElement | undefined = el; g && i < 16; i++) {
      const stops = childElements(g).filter((c) => c.tag === 'stop');
      if (stops.length) return stops;
      const id = hrefId(g);
      g = id ? this.ids.get(id) : undefined;
    }
    return [];
  }

  private gradient(el: XmlElement, opacity: number, ctx: Ctx, box: () => VectorBox): { paint: VectorPaint; grad?: PenGradient } | undefined {
    const stops: { o: number; c: RGBA }[] = [];
    for (const st of this.gradStops(el)) {
      const s = this.styles.inTree(st);
      const off = st.attrs.offset ?? this.styles.declared(st).offset ?? '0';
      let o = parseFloat(off);
      Number.isFinite(o) || (o = 0);
      off.trim().endsWith('%') && (o /= 100);
      o = Math.max(0, Math.min(1, o), stops.length ? stops[stops.length - 1].o : 0);
      const sc = !s.stopColor || s.stopColor === 'currentColor' || s.stopColor === 'currentcolor' ? (s.stopColor ? s.color : undefined) ?? [0, 0, 0, 1] : parseColor(s.stopColor) ?? [0, 0, 0, 1];
      stops.push({ o, c: [sc[0], sc[1], sc[2], sc[3] * s.stopOpacity * opacity] });
    }
    if (!stops.length) return undefined;
    if (stops.length === 1) return stops[0].c[3] > 0 ? { paint: colorCss(stops[0].c) } : undefined;
    const obb = this.gradAttr(el, 'gradientUnits') !== 'userSpaceOnUse';
    let gm: VectorMatrix = IDENTITY;
    if (obb) {
      const b = box();
      // 宽或高为 0 的元素不绘制 objectBoundingBox 渐变（规范）：退化为平均色
      if (!(b.width > 0 && b.height > 0)) return { paint: colorCss(stops[Math.floor(stops.length / 2)].c) };
      gm = [b.width, 0, 0, b.height, b.x, b.y];
    }
    const G = multiplyMatrix(ctx.m, multiplyMatrix(gm, parseTransform(this.gradAttr(el, 'gradientTransform'))));
    const diag = Math.sqrt((ctx.vw * ctx.vw + ctx.vh * ctx.vh) / 2);
    const len = (name: string, def: string, base: number) => {
      const v = this.gradAttr(el, name) ?? def;
      if (obb) {
        const n = parseFloat(v);
        return Number.isFinite(n) ? (v.trim().endsWith('%') ? n / 100 : n) : parseFloat(def) / 100;
      }
      return parseLength(v, 0, { fontSize: ctx.style.fontSize, percentBase: base });
    };
    const spread = this.gradAttr(el, 'spreadMethod');
    spread && spread !== 'pad' && this.count(`gradient:${spread}`);
    this.stats.gradients++;
    const irStops = stops.map((s) => ({ o: s.o, c: colorCss(s.c) }));
    const penStops = stops.map((s) => ({ i: s.o, c: s.c }));
    if (el.tag === 'linearGradient') {
      const x1 = len('x1', '0%', ctx.vw);
      const y1 = len('y1', '0%', ctx.vh);
      const x2 = len('x2', '100%', ctx.vw);
      const y2 = len('y2', '0%', ctx.vh);
      const g: VectorGradient = { type: 'linear', x0: x1, y0: y1, x1: x2, y1: y2, m: G, stops: irStops };
      let grad: PenGradient | undefined;
      // 图元渐变的等值线垂直于渐变方向：只有渐变空间到画布是相似变换，或方向轴对齐且无旋转斜切时才等价
      if (isSimilarity(G) || (Math.abs(G[1]) < 1e-9 && Math.abs(G[2]) < 1e-9 && (x1 === x2 || y1 === y2))) {
        const [ax, ay] = applyMatrix(G, x1, y1);
        const [bx, by] = applyMatrix(G, x2, y2);
        grad = { type: 'linear', x0: ax, y0: ay, x1: bx, y1: by, r: 0, stops: penStops };
      }
      return { paint: g, grad };
    }
    const cx = len('cx', '50%', ctx.vw);
    const cy = len('cy', '50%', ctx.vh);
    const r = len('r', '50%', diag);
    const fx = this.gradAttr(el, 'fx') !== undefined ? len('fx', '50%', ctx.vw) : cx;
    const fy = this.gradAttr(el, 'fy') !== undefined ? len('fy', '50%', ctx.vh) : cy;
    const fr = this.gradAttr(el, 'fr') !== undefined ? len('fr', '0%', diag) : 0;
    const g: VectorGradient = { type: 'radial', x0: fx, y0: fy, r0: fr, x1: cx, y1: cy, r1: r, m: G, stops: irStops };
    let grad: PenGradient | undefined;
    if (isSimilarity(G) && Math.abs(fx - cx) < 1e-9 && Math.abs(fy - cy) < 1e-9 && fr === 0) {
      const [px, py] = applyMatrix(G, cx, cy);
      grad = { type: 'radial', x0: px, y0: py, x1: px, y1: py, r: r * matrixScale(G), stops: penStops };
    }
    return { paint: g, grad };
  }

  // ───────────────────────────── 标记 ─────────────────────────────

  private drawMarkers(segs: Seg[], s: Computed, ctx: Ctx, sw: number, leaf: SvgLeaf) {
    const verts = pathVertices(segs);
    const n = verts.length;
    if (!n) return;
    verts.forEach((v, i) => {
      const id = i === 0 ? s.markerStart : i === n - 1 ? s.markerEnd : s.markerMid;
      const marker = id ? this.ids.get(id) : undefined;
      if (!marker || marker.tag !== 'marker' || ctx.refs.has(marker)) return;
      const dir = i === 0 ? v.dirOut ?? v.dirIn : i === n - 1 ? v.dirIn ?? v.dirOut : bisect(v.dirIn, v.dirOut);
      this.drawMarker(marker, v.x, v.y, dir ?? 0, i === 0, sw, ctx, leaf);
    });
  }

  private drawMarker(el: XmlElement, x: number, y: number, dir: number, isStart: boolean, sw: number, ctx: Ctx, leaf: SvgLeaf) {
    const a = el.attrs;
    const ms = this.styles.inTree(el);
    if (ms.display === 'none') return;
    const mw = parseLength(a.markerWidth, 3);
    const mh = parseLength(a.markerHeight, 3);
    if (!(mw > 0 && mh > 0)) return;
    const orient = (a.orient || '0').trim();
    let rot = 0;
    if (orient === 'auto') rot = dir;
    else if (orient === 'auto-start-reverse') rot = isStart ? dir + Math.PI : dir;
    else rot = ((parseFloat(orient) || 0) * (orient.endsWith('rad') ? 180 / Math.PI : orient.endsWith('turn') ? 360 : 1) * Math.PI) / 180;
    const scale = a.markerUnits === 'userSpaceOnUse' ? 1 : sw;
    const vb = parseViewBox(a.viewBox);
    const vbM: VectorMatrix = vb ? viewBoxMatrix(vb, 0, 0, mw, mh, parseAspectRatio(a.preserveAspectRatio)) : IDENTITY;
    const [rx, ry] = applyMatrix(vbM, parseLength(a.refX, 0), parseLength(a.refY, 0));
    const local = composeMatrix(vbM, translateMatrix(-rx, -ry), scaleMatrix(scale), rotateMatrix(rot), translateMatrix(x, y));
    const m = multiplyMatrix(ctx.m, local);
    const refs = new Set(ctx.refs).add(el);
    const units = this.children(el, { m, style: ms, vw: vb ? vb[2] : mw, vh: vb ? vb[3] : mh, depth: ctx.depth + 1, refs });
    if (!units.length) return;
    this.stats.markers++;
    const merged = mergeUnits(units, leaf.info);
    merged.items.forEach((it, i) => this.push(leaf, it, merged.grads[i]));
  }

  // ───────────────────────────── 文字 ─────────────────────────────

  private drawText(el: XmlElement, s: Computed, ctx: Ctx, leaf: SvgLeaf) {
    interface Run {
      text: string;
      s: Computed;
      x: number;
      y: number;
      /** 新文本块（绝对定位）开始 */
      chunk: boolean;
    }
    const runs: Run[] = [];
    const lc = { fontSize: s.fontSize };
    let x = 0;
    let y = 0;
    let pendingChunk = true;
    /** 上一个输出字符是空白（折叠用，文字开头视为空白以去掉前导空格） */
    let lastSpace = true;
    const walk = (node: XmlElement, ns: Computed, depth: number) => {
      if (depth > 32) return;
      const xs = parseList(node.attrs.x, { ...lc, percentBase: ctx.vw });
      const ys = parseList(node.attrs.y, { ...lc, percentBase: ctx.vh });
      const dxs = parseList(node.attrs.dx, { ...lc, percentBase: ctx.vw });
      const dys = parseList(node.attrs.dy, { ...lc, percentBase: ctx.vh });
      if (xs.length && Number.isFinite(xs[0])) {
        x = xs[0];
        pendingChunk = true;
      }
      if (ys.length && Number.isFinite(ys[0])) {
        y = ys[0];
        pendingChunk = true;
      }
      dxs.length && Number.isFinite(dxs[0]) && (x += dxs[0]);
      dys.length && Number.isFinite(dys[0]) && (y += dys[0]);
      (xs.length > 1 || ys.length > 1 || dxs.length > 1 || dys.length > 1) && this.count('text:glyph-position');
      node.attrs.rotate && this.count('text:rotate');
      for (const c of node.children) {
        if (c.kind === 'text') {
          let t = c.text.replace(/[\r\n]+/g, ns.preserveSpace ? ' ' : '').replace(/\t/g, ' ');
          if (!ns.preserveSpace) {
            t = t.replace(/ {2,}/g, ' ');
            lastSpace && (t = t.replace(/^ /, ''));
          }
          if (!t) continue;
          lastSpace = t.endsWith(' ');
          const prev = runs[runs.length - 1];
          if (prev && !pendingChunk && prev.s === ns && prev.y === y) prev.text += t;
          else {
            runs.push({ text: t, s: ns, x, y, chunk: pendingChunk });
          }
          pendingChunk = false;
          // 估算前进量（后续未定位的文字接在后面）
          x += this.advance(t, ns);
          continue;
        }
        if (c.tag === 'tspan' || c.tag === 'a' || c.tag === 'textPath') {
          c.tag === 'textPath' && this.count('textPath');
          const cs = this.styles.compute(c, ns);
          if (cs.display === 'none') continue;
          walk(c, cs, depth + 1);
        } else if (c.tag === 'tref') this.count('tref');
      }
    };
    walk(el, s, 0);
    // 去掉末尾空白
    if (!s.preserveSpace) {
      for (let i = runs.length - 1; i >= 0; i--) {
        runs[i].text = runs[i].text.replace(/ +$/, '');
        if (runs[i].text) break;
      }
    }
    const visible = runs.filter((r) => r.text);
    if (!visible.length) return;
    // 按文本块对齐（text-anchor 作用于整块）
    const chunks: Run[][] = [];
    for (const r of visible) {
      if (r.chunk || !chunks.length) chunks.push([r]);
      else chunks[chunks.length - 1].push(r);
    }
    for (const c of chunks) {
      const anchor = c[0].s.textAnchor;
      if (c.length === 1) {
        this.textItem(c[0].text, c[0].s, c[0].x, c[0].y, anchor, ctx, leaf);
        continue;
      }
      const total = c.reduce((w, r) => w + this.advance(r.text, r.s), 0);
      const dx = anchor === 'middle' ? -total / 2 : anchor === 'end' ? -total : 0;
      for (const r of c) this.textItem(r.text, r.s, r.x + dx, r.y, 'start', ctx, leaf);
    }
  }

  private advance(text: string, s: Computed) {
    const ls = parseLength(s.letterSpacing, 0, { fontSize: s.fontSize });
    // 粗体字宽约宽 8%
    return estimateTextWidth(text, s.fontSize) * (s.fontWeight >= 600 ? 1.08 : 1) + ls * text.length;
  }

  private textItem(text: string, s: Computed, x: number, y: number, anchor: Computed['textAnchor'], ctx: Ctx, leaf: SvgLeaf) {
    if (s.visibility === 'hidden') return;
    const fill = this.textFill(s, ctx);
    if (!fill) return;
    const m = ctx.m;
    const [px, py] = applyMatrix(m, x, y);
    const sx = Math.hypot(m[0], m[1]);
    const sy = Math.hypot(m[2], m[3]);
    const det = m[0] * m[3] - m[1] * m[2];
    const item: VectorTextItem = { t: 't', text, x: px, y: py, h: s.fontSize * sy };
    if (!(item.h > 0)) return;
    const r = Math.atan2(m[1], m[0]);
    Math.abs(r) > 1e-6 && (item.r = r);
    sy > 0 && Math.abs(sx / sy - 1) > 1e-3 && (item.w = sx / sy);
    det < 0 && (item.m = 1);
    const rtl = s.direction === 'rtl';
    const a = anchor === 'middle' ? 'center' : (anchor === 'end') !== rtl ? 'right' : 'left';
    a !== 'left' && (item.a = a);
    const b = baseline(s.baseline);
    b !== 'alphabetic' && (item.b = b);
    const font = fontFamilyCss(s.fontFamily);
    font && (item.font = font);
    s.fontWeight >= 600 && (item.bold = true);
    s.fontStyle === 'italic' && (item.italic = true);
    fill !== '$fg' && (item.fill = fill);
    s.stroke.type !== 'none' && this.count('text:stroke');
    this.stats.texts++;
    this.push(leaf, item);
  }

  /** 文字颜色（文字项只支持纯色，渐变取代表色） */
  private textFill(s: Computed, ctx: Ctx): string | undefined {
    const p = this.paint(s.fill, s.fillOpacity, s, ctx, () => ({ x: 0, y: 0, width: 1, height: 1 }));
    if (!p) return undefined;
    if (typeof p.paint === 'string') return p.paint;
    this.count('text:gradient');
    const st = p.paint.stops;
    return st[Math.floor(st.length / 2)]?.c;
  }

  // ───────────────────────────── 图片 ─────────────────────────────

  private drawImage(el: XmlElement, s: Computed, ctx: Ctx, leaf: SvgLeaf) {
    if (!this.opts.images || s.visibility === 'hidden') return;
    const href = (el.attrs.href ?? el.attrs['xlink:href'] ?? '').trim();
    if (!href) return;
    const a = el.attrs;
    const lc = { fontSize: s.fontSize };
    let w = a.width && a.width !== 'auto' ? parseLength(a.width, NaN, { ...lc, percentBase: ctx.vw }) : NaN;
    let h = a.height && a.height !== 'auto' ? parseLength(a.height, NaN, { ...lc, percentBase: ctx.vh }) : NaN;
    let natural: { width: number; height: number } | undefined;
    if (href.startsWith('data:')) {
      const data = decodeDataUrl(href);
      natural = data && bitmapSize(data.bytes);
    }
    if (natural) {
      if (!(w > 0) && h > 0) w = (h * natural.width) / natural.height;
      else if (!(h > 0) && w > 0) h = (w * natural.height) / natural.width;
      else if (!(w > 0) && !(h > 0)) {
        w = natural.width;
        h = natural.height;
      }
    }
    if (!(w > 0 && h > 0)) {
      this.count('image:size');
      return;
    }
    const x = parseLength(a.x, 0, { ...lc, percentBase: ctx.vw });
    const y = parseLength(a.y, 0, { ...lc, percentBase: ctx.vh });
    const par = parseAspectRatio(a.preserveAspectRatio);
    let fit: 'fill' | 'contain' | 'cover' = par.align === 'none' ? 'fill' : par.slice ? 'cover' : 'contain';
    // 已知原始宽高比与框一致时直接拉伸（原生图片图元更好编辑）
    if (fit !== 'fill' && natural && Math.abs((natural.width / natural.height) * (h / w) - 1) < 0.01) fit = 'fill';
    fit !== 'fill' && par.align.toLowerCase() !== 'xmidymid' && this.count('image:align');
    const key = imageKey(href);
    if (this.opts.skipImages?.includes(key)) return;
    const src = this.opts.imageUrls[key] || href;
    const item: VectorItem = { t: 'i', src, m: multiplyMatrix(ctx.m, [w, 0, 0, h, x, y]) };
    fit !== 'fill' && (item.fit = fit);
    this.stats.images++;
    this.push(leaf, item);
  }

  // ───────────────────────────── 裁剪 / 蒙版 / 滤镜 ─────────────────────────────

  private rectClip(m: VectorMatrix, x: number, y: number, w: number, h: number): ClipRegion {
    const b = new VectorPathBuilder(m);
    emitSegs(rectSegs(x, y, w, h, 0, 0), b);
    return { d: b.d, box: pathBox(b.d), rect: Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 };
  }

  /** 目标内容在元素用户坐标中的包围盒（objectBoundingBox 单位用） */
  private localBox(units: SvgUnit[], m: VectorMatrix): VectorBox {
    const inv = invertMatrix(m);
    const box = unitsBox(units, true);
    return inv ? transformBox(inv, box) : box;
  }

  /** 收集裁剪 / 蒙版内容的轮廓（多个子元素的并集，nonzero） */
  private outline(container: XmlElement, cm: VectorMatrix, ctx: Ctx, accept: (el: XmlElement, s: Computed) => boolean) {
    const b = new VectorPathBuilder(cm);
    let rule: 'nonzero' | 'evenodd' | undefined;
    let count = 0;
    let rect = false;
    const base = this.styles.inTree(container);
    const walk = (el: XmlElement, parent: Computed, m: VectorMatrix, d: number) => {
      if (d > 16) return;
      for (const c of childElements(el)) {
        const s = this.styles.compute(c, parent);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const cmx = multiplyMatrix(m, parseTransform(s.transform));
        if (c.tag === 'use') {
          const id = hrefId(c);
          const ref = id ? this.ids.get(id) : undefined;
          if (!ref || d > 8) continue;
          const lc = { fontSize: s.fontSize };
          const um = multiplyMatrix(cmx, translateMatrix(parseLength(c.attrs.x, 0, lc), parseLength(c.attrs.y, 0, lc)));
          walk({ ...c, children: [ref] } as XmlElement, s, um, d + 1);
          continue;
        }
        if (c.tag === 'g' || c.tag === 'a') {
          walk(c, s, cmx, d + 1);
          continue;
        }
        if (!SHAPES.has(c.tag)) {
          c.tag === 'text' && this.count('clip:text');
          continue;
        }
        if (!accept(c, s)) continue;
        const segs = this.shapeSegs(c, { ...ctx, style: s });
        if (!segs.length) continue;
        b.matrix = cmx;
        emitSegs(segs, b);
        rule ??= s.clipRule;
        count++;
        rect = c.tag === 'rect' && !(parseFloat(c.attrs.rx) > 0 || parseFloat(c.attrs.ry) > 0) && Math.abs(cmx[1]) < 1e-9 && Math.abs(cmx[2]) < 1e-9;
      }
    };
    walk(container, base, cm, 0);
    const out: ClipRegion = { d: b.d, box: pathBox(b.d) };
    rule === 'evenodd' && (out.rule = 'evenodd');
    count === 1 && rect && (out.rect = true);
    return out;
  }

  private clipRegion(id: string, m: VectorMatrix, ctx: Ctx, units: SvgUnit[]): ClipRegion | undefined {
    const cp = this.ids.get(id);
    if (!cp || cp.tag !== 'clipPath') return undefined;
    const cs = this.styles.inTree(cp);
    let cm = m;
    if (cp.attrs.clipPathUnits === 'objectBoundingBox') {
      const b = this.localBox(units, m);
      cm = multiplyMatrix(m, [b.width, 0, 0, b.height, b.x, b.y]);
    }
    cm = multiplyMatrix(cm, parseTransform(cs.transform));
    cs.clipPath && this.count('clip:nested');
    return this.outline(cp, cm, ctx, () => true);
  }

  /** 蒙版近似：亮色内容的轮廓作为裁剪区域 */
  private maskRegion(id: string, m: VectorMatrix, ctx: Ctx, units: SvgUnit[]): ClipRegion | undefined {
    const mk = this.ids.get(id);
    if (!mk || mk.tag !== 'mask') return undefined;
    this.count('mask');
    let cm = m;
    if (mk.attrs.maskContentUnits === 'objectBoundingBox') {
      const b = this.localBox(units, m);
      cm = multiplyMatrix(m, [b.width, 0, 0, b.height, b.x, b.y]);
    }
    const bright = (s: Computed) => {
      const p = s.fill;
      if (p.type === 'none') return false;
      if (p.type === 'color') return 0.2126 * p.c[0] + 0.7152 * p.c[1] + 0.0722 * p.c[2] >= 0.5 && p.c[3] * s.fillOpacity > 0.1;
      return true;
    };
    const region = this.outline(mk, cm, ctx, (_el, s) => bright(s));
    // 没有亮色内容：整体不可见
    return region;
  }

  private clipUnits(units: SvgUnit[], clip: ClipRegion): SvgUnit[] {
    for (const u of units) this.clipUnit(u, clip);
    return prune(units);
  }

  private clipUnit(u: SvgUnit, clip: ClipRegion) {
    if (u.kind === 'group') return u.children.forEach((c) => this.clipUnit(c, clip));
    const items: VectorItem[] = [];
    const grads: SvgLeaf['grads'] = [];
    let run: VectorItem[] = [];
    const flush = () => {
      if (!run.length) return;
      const item: VectorClipItem = { t: 'c', d: clip.d, items: run };
      clip.rule && (item.rule = clip.rule);
      items.push(item);
      grads.push(undefined);
      this.stats.clips++;
      run = [];
    };
    u.items.forEach((it, i) => {
      const box = computeItemsBox([it]);
      if (clip.radius > 0 && it.t === 'i' && Math.abs(it.m[1]) < 1e-9 && Math.abs(it.m[2]) < 1e-9 && it.m[0] > 0 && it.m[3] > 0 && sameBox(box, clip.box)) {
        flush();
        items.push({ ...it, radius: clip.radius });
        grads.push(u.grads[i]);
        return;
      }
      const rel = clipRelation(box, clip);
      if (rel === 'out') return;
      if (rel === 'in') {
        flush();
        items.push(it);
        grads.push(u.grads[i]);
      } else run.push(it);
    });
    flush();
    u.items = items;
    u.grads = grads;
  }

  /** filter：投影（feDropShadow、feOffset + feGaussianBlur + feMerge、CSS drop-shadow()）→ 图元阴影，其它计入 unsupported */
  private applyFilter(filter: string, m: VectorMatrix, units: SvgUnit[]) {
    const k = matrixScale(m);
    let shadow: SvgLeaf['shadow'];
    const css = /drop-shadow\(\s*([^)]*\))?[^)]*\)/.exec(filter);
    if (css) {
      const parts = css[0].slice(12, -1).trim();
      const color = /(#[0-9a-f]+|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)\s*$/i.exec(parts)?.[1];
      const nums = parts.replace(color || '', '').trim().split(/\s+/).map((v) => parseLength(v, 0));
      const c = parseColor(color) ?? [0, 0, 0, 1];
      shadow = { color: colorCss(c), x: (nums[0] || 0) * k, y: (nums[1] || 0) * k, blur: (nums[2] || 0) * k };
    } else {
      const id = urlId(filter);
      const f = id ? this.ids.get(id) : undefined;
      if (!f || f.tag !== 'filter') {
        this.count('filter:css');
        return;
      }
      const prims = childElements(f);
      const drop = prims.find((p) => p.tag === 'feDropShadow');
      if (drop) {
        const ds = this.styles.declared(drop);
        const c = parseColor(ds['flood-color'] || drop.attrs['flood-color']) ?? [0, 0, 0, 1];
        const op = parseFloat(ds['flood-opacity'] ?? drop.attrs['flood-opacity'] ?? '1');
        const sd = parseFloat(drop.attrs.stdDeviation ?? '2');
        shadow = { color: colorCss(c, Number.isFinite(op) ? op : 1), x: parseFloat(drop.attrs.dx ?? '2') * k, y: parseFloat(drop.attrs.dy ?? '2') * k, blur: (sd || 0) * 2 * k };
      } else {
        const off = prims.find((p) => p.tag === 'feOffset');
        const blur = prims.find((p) => p.tag === 'feGaussianBlur');
        const merge = prims.find((p) => p.tag === 'feMerge');
        const keepsSource = merge && childElements(merge).some((n) => (n.attrs.in || '') === 'SourceGraphic');
        if (off && keepsSource) {
          const flood = prims.find((p) => p.tag === 'feFlood');
          const fd = flood ? this.styles.declared(flood) : {};
          const c = parseColor(fd['flood-color'] || flood?.attrs['flood-color']) ?? [0, 0, 0, 1];
          const op = parseFloat(fd['flood-opacity'] ?? flood?.attrs['flood-opacity'] ?? (flood ? '1' : '0.5'));
          const sd = parseFloat(blur?.attrs.stdDeviation ?? '0');
          shadow = { color: colorCss(c, Number.isFinite(op) ? op : 0.5), x: parseFloat(off.attrs.dx ?? '0') * k, y: parseFloat(off.attrs.dy ?? '0') * k, blur: (sd || 0) * 2 * k };
        } else {
          for (const p of prims) this.count(`filter:${p.tag}`);
          return;
        }
      }
    }
    const walk = (u: SvgUnit) => (u.kind === 'group' ? u.children.forEach(walk) : (u.shadow = shadow));
    units.forEach(walk);
  }

  private count(key: string) {
    this.stats.unsupported[key] = (this.stats.unsupported[key] || 0) + 1;
  }
}

// ───────────────────────────── 解码 ─────────────────────────────

/** 字节 / 文本 → <svg> 根元素；不是 SVG 时抛出可读的错误 */
export function parseSvgRoot(data: Uint8Array | string): XmlElement {
  let text: string;
  if (typeof data === 'string') text = data;
  else {
    let bytes = data;
    // .svgz
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      try {
        bytes = gunzipSync(bytes);
      } catch (e: any) {
        throw new Error(`SVGZ 解压失败：${e?.message || e}`);
      }
    }
    text = decodeText(bytes);
  }
  text = text.replace(/^﻿/, '');
  const doc = parseXml(text);
  const root = findRoot(doc);
  if (!root) throw new Error('不是有效的 SVG 文件（缺少 <svg> 根元素）');
  return root;
}

function findRoot(el: XmlElement, depth = 0): XmlElement | undefined {
  if (depth > 4) return undefined;
  for (const c of childElements(el)) {
    if (c.tag === 'svg') return c;
    const r = findRoot(c, depth + 1);
    if (r) return r;
  }
  return undefined;
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const enc = /<\?xml[^>]*encoding\s*=\s*["']([\w.-]+)["']/i.exec(head)?.[1];
  if (enc && !/^utf-?8$/i.test(enc)) {
    try {
      return new TextDecoder(enc).decode(bytes);
    } catch {
      // 不支持的编码按 UTF-8
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

// ───────────────────────────── 工具 ─────────────────────────────

function baseline(v: string): NonNullable<VectorTextItem['b']> {
  switch (v) {
    case 'middle':
    case 'central':
    case 'mathematical':
      return 'middle';
    case 'hanging':
      return 'hanging';
    case 'text-before-edge':
    case 'before-edge':
    case 'text-top':
      return 'top';
    case 'text-after-edge':
    case 'after-edge':
    case 'text-bottom':
      return 'bottom';
    case 'ideographic':
      return 'ideographic';
    default:
      return 'alphabetic';
  }
}

function pathBox(d: VectorPathData): VectorBox {
  const acc = new BoxAccumulator();
  accumulatePathBox(d, acc);
  return acc.empty ? { x: 0, y: 0, width: 0, height: 0 } : acc.box();
}

/** 指令在自身坐标系中的几何包围盒（不含线宽） */
function segsBox(segs: Seg[]): VectorBox {
  const b = new VectorPathBuilder();
  emitSegs(segs, b);
  return pathBox(b.d);
}

/** 内容框与裁剪区域的关系：in 完全在内（不用裁剪），out 完全在外，cross 跨边界 */
function clipRelation(b: VectorBox, clip: ClipRegion): 'in' | 'out' | 'cross' {
  if (!clip.d.length) return 'out';
  const c = clip.box;
  const e = 0.5;
  const bx1 = b.x + b.width;
  const by1 = b.y + b.height;
  const cx1 = c.x + c.width;
  const cy1 = c.y + c.height;
  if (b.x >= cx1 - 1e-6 || bx1 <= c.x + 1e-6 || b.y >= cy1 - 1e-6 || by1 <= c.y + 1e-6) {
    // 零宽 / 零高的内容（水平线、竖线）恰好在边上时不算在外
    if (!(b.width === 0 || b.height === 0) || b.x > cx1 || bx1 < c.x || b.y > cy1 || by1 < c.y) return 'out';
  }
  if (!clip.rect || b.x < c.x - e || b.y < c.y - e || bx1 > cx1 + e || by1 > cy1 + e) return 'cross';
  return 'in';
}

function sameBox(a: VectorBox, b: VectorBox, e = 0.5) {
  return Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e && Math.abs(a.width - b.width) < e && Math.abs(a.height - b.height) < e;
}

/** rectSegs 生成的圆角矩形的圆角半径（rx = ry 时），否则 0 */
function rectRadius(segs: Seg[]): number {
  const a = segs.find((s) => s.c === 'A') as Extract<Seg, { c: 'A' }> | undefined;
  return a && Math.abs(a.rx - a.ry) < 1e-9 ? a.rx : 0;
}

function hasContent(u: SvgUnit): boolean {
  return u.kind === 'leaf' ? u.items.length > 0 : u.children.length > 0;
}

/** 去掉裁剪后没有内容的图元、组合 */
function prune(units: SvgUnit[]): SvgUnit[] {
  return units.filter((u) => {
    if (u.kind === 'group') u.children = prune(u.children);
    return hasContent(u);
  });
}

/** 子树合并为一个 leaf（'layer' / 'page' 粒度、marker） */
function mergeUnits(units: SvgUnit[], info: SvgPenInfo, name?: string): SvgLeaf {
  const leaf: SvgLeaf = { kind: 'leaf', info, items: [], grads: [] };
  name && (leaf.name = name);
  const walk = (u: SvgUnit) => {
    if (u.kind === 'group') return u.children.forEach(walk);
    leaf.items.push(...u.items);
    leaf.grads.push(...u.grads);
    u.shadow && !leaf.shadow && (leaf.shadow = u.shadow);
  };
  units.forEach(walk);
  return leaf;
}

/** 组不透明度：近似为每项不透明度相乘 */
function fadeUnit(u: SvgUnit, a: number) {
  if (u.kind === 'group') return u.children.forEach((c) => fadeUnit(c, a));
  u.items = u.items.map((it) => fadeItem(it, a));
}

function fadeItem(it: VectorItem, a: number): VectorItem {
  switch (it.t) {
    case 'p':
      return { ...it, s: { ...(it.s || {}), alpha: (it.s?.alpha ?? 1) * a } };
    case 't': {
      const c = parseColor(it.fill);
      return c ? { ...it, fill: colorCss(c, a) } : it;
    }
    case 'i':
      return { ...it, alpha: (it.alpha ?? 1) * a };
    case 'c':
      return { ...it, items: it.items.map((c) => fadeItem(c, a)) };
    default:
      return it;
  }
}

function unitsBox(units: SvgUnit[], geometryOnly = false): VectorBox {
  const acc = new BoxAccumulator();
  const walk = (u: SvgUnit) => {
    if (u.kind === 'group') return u.children.forEach(walk);
    if (!u.items.length) return;
    if (geometryOnly) {
      for (const it of u.items) it.t === 'p' ? accumulatePathBox(it.d, acc) : acc.addBox(computeItemsBox([it]));
    } else acc.addBox(createGeom(u.items).bbox);
  };
  units.forEach(walk);
  return acc.empty ? { x: 0, y: 0, width: 0, height: 0 } : acc.box();
}

/** 页面定位矩阵只含平移 + 等比缩放，旁路数据按同一矩阵换算 */
function transformUnit(u: SvgUnit, m: VectorMatrix) {
  if (u.kind === 'group') return u.children.forEach((c) => transformUnit(c, m));
  const k = matrixScale(m);
  const map = (x: number, y: number) => [m[0] * x + m[4], m[3] * y + m[5]];
  u.items = u.items.map((it) => transformItem(it, m, k));
  u.grads = u.grads.map((g) => {
    if (!g) return g;
    const [x0, y0] = map(g.x0, g.y0);
    const [x1, y1] = map(g.x1, g.y1);
    return { ...g, x0, y0, x1, y1, r: g.r * k };
  });
  u.shadow && (u.shadow = { ...u.shadow, x: u.shadow.x * k, y: u.shadow.y * k, blur: u.shadow.blur * k });
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
