import {
  applyMatrix,
  composeMatrix,
  createGeom,
  estimateTextWidth,
  IDENTITY,
  invertMatrix,
  isIdentity,
  pathItem,
  rotateMatrix,
  textItemBox,
  transformItem,
  translateMatrix,
  VectorPathBuilder,
  type VectorGradient,
  type VectorImageItem,
  type VectorItem,
  type VectorMatrix,
  type VectorStyle,
  type VectorTextItem,
} from '@drawir/core';
import { readPages } from './decode';
import {
  center,
  edgePath,
  elbowRoute,
  entityRelationRoute,
  fixedPoint,
  loopRoute,
  marker,
  orthogonalRoute,
  pointAlong,
  sideOf,
  straightRoute,
  type Pt,
  type Rect,
  type Terminal,
} from './edge';
import type { PenGradient } from './gradient';
import { buildShape, isShapeName, perimeterOf, resolveShapeName } from './shapes';
import { color, flag, num, parseStyle, withAlpha, type Style } from './style';
import { fillPlaceholders, htmlToText } from './text';
import type { DrawioPageInfo, DrawioParseOptions, DrawioParseStats, DrawioPenInfo } from './types';
import { hashKey, parseColor } from './util';
import { child, type XmlNode } from './xml';

const DEG = Math.PI / 180;
export const DEFAULT_FONT = 'Helvetica, Arial, sans-serif';

/** 与 meta2d 版本无关的文字样式 */
export interface DrawioTextStyle {
  text: string;
  fontSize: number;
  /** 行高倍数 */
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  /** 在框宽内自动换行（whiteSpace=wrap） */
  wrap: boolean;
  /** 固定颜色；跟随主题时缺省 */
  color?: string;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 标签背景色 */
  background?: string;
}

/** 单元格的标签 */
export interface DrawioLabel {
  style: DrawioTextStyle;
  /** 文字框（文字坐标系，扣除 spacing 后的范围） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 文字坐标系 → 页面坐标（刚体变换：形状旋转、竖排的 -90°） */
  m: VectorMatrix;
  /** 竖排（horizontal=0） */
  vertical: boolean;
  /** 连线标签：文字框按文字估算 */
  auto: boolean;
  /** 等价的 IR 项（页面坐标，已含旋转）：标签背景 + 文字 */
  items: VectorItem[];
}

/** 连线端点的箭头（能用 meta2d 原生箭头表示的几种） */
export interface DrawioArrow {
  type: 'triangle' | 'line' | 'circle' | 'diamond';
  filled: boolean;
  /** 箭头长度（画布像素） */
  size: number;
}

/** 连线（供生成原生连线） */
export interface DrawioEdge {
  /** 折线点（页面坐标），含两个端点 */
  points: Pt[];
  /** 固定颜色；跟随主题时缺省 */
  color?: string;
  lineWidth: number;
  dash?: number[];
  alpha?: number;
  from?: DrawioArrow;
  to?: DrawioArrow;
  /** 箭头的空心填充色（固定颜色时） */
  background?: string;
  source?: string;
  target?: string;
  /** 能用原生连线表示：直线 / 折线 / 圆角折线，箭头都能对应到原生箭头 */
  native: boolean;
}

export interface DrawioLeaf {
  kind: 'leaf';
  info: DrawioPenInfo;
  /** 图元名（标签文字或形状名） */
  name?: string;
  /** 形状 / 连线 / 图片的 IR 项（页面坐标，未旋转，旋转见 rotate） */
  items: VectorItem[];
  /** items 中各项填充渐变（相对 box 的比例，供绑定到图元渐变） */
  grads: (PenGradient | undefined)[];
  /** 顶点框（页面坐标，未旋转）；连线没有 */
  box?: { x: number; y: number; w: number; h: number };
  /** 绕 box 中心的顺时针旋转（度） */
  rotate: number;
  labels: DrawioLabel[];
  shadow?: boolean;
  edge?: DrawioEdge;
}

export interface DrawioGroup {
  kind: 'group';
  info: DrawioPenInfo;
  name?: string;
  children: DrawioUnit[];
}

export type DrawioUnit = DrawioLeaf | DrawioGroup;

export interface DrawioTree {
  /** 每页的顶层单元（node 粒度为图层内的单元格树，layer / page 粒度为合并后的叶子） */
  pages: DrawioUnit[][];
  pageList: DrawioPageInfo[];
  stats: DrawioParseStats;
  /** colors = 'light' 时每页铺的页面背景（页面坐标） */
  pageBackgrounds: ({ x: number; y: number; width: number; height: number; color: string } | undefined)[];
}

interface Geo {
  x: number;
  y: number;
  w: number;
  h: number;
  relative: boolean;
  points: Pt[];
  sourcePoint?: Pt;
  targetPoint?: Pt;
  offset?: Pt;
}

interface Cell {
  id: string;
  parent?: string;
  value: string;
  /** UserObject / object 上的自定义属性（占位符用） */
  attrs?: Record<string, string>;
  style: Style;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  geo?: Geo;
  visible: boolean;
  collapsed: boolean;
  children: Cell[];
}

const EMPTY_GEO: Geo = { x: 0, y: 0, w: 0, h: 0, relative: false, points: [] };

export type ResolvedOptions = Required<Omit<DrawioParseOptions, 'pages' | 'imageUrls' | 'skipImages' | 'origin'>> &
  Pick<DrawioParseOptions, 'pages' | 'imageUrls' | 'skipImages'> & { origin: { x: number; y: number } };

export function resolveOptions(o: DrawioParseOptions = {}): ResolvedOptions {
  return {
    pageGap: 40,
    scale: 1,
    pageBorder: false,
    colors: 'theme',
    granularity: 'node',
    group: true,
    editable: true,
    images: true,
    imageBase: 'https://app.diagrams.net/',
    ...o,
    origin: o.origin || { x: 0, y: 0 },
  };
}

/** draw.io 内置图库相对地址 / 省略 ;base64 的 data URL → 可直接加载的地址 */
export function normalizeImageSrc(v: string | undefined, base: string): string | undefined {
  if (!v) return undefined;
  v = v.trim();
  if (!v || v === 'none') return undefined;
  if (/^data:/i.test(v)) {
    // 样式串以 ';' 分隔，draw.io 把 data:image/png;base64,xxx 存成 data:image/png,xxx
    const comma = v.indexOf(',');
    if (comma < 0) return undefined;
    const head = v.slice(5, comma);
    const body = v.slice(comma + 1);
    if (/;base64$/i.test(head)) return v;
    if (/^[A-Za-z0-9+/=\s]+$/.test(body.slice(0, 256))) return `data:${head};base64,${body}`;
    return v;
  }
  if (/^(https?:|blob:|\/\/|\/)/i.test(v)) return v;
  return base ? base.replace(/\/?$/, '/') + v.replace(/^\.?\//, '') : v;
}

/**
 * draw.io（diagrams.net）→ 单元格树（每个单元格是若干 Vector IR 项 + 标签）。
 * 连线路由、命名样式和 HTML 标签都在转换期解析。
 */
export class DrawioToIR {
  private opts: ResolvedOptions;
  private cells = new Map<string, Cell>();
  private boundsCache = new Map<string, Rect | undefined>();
  private edgeCache = new Map<string, Pt[] | undefined>();
  private busy = new Set<string>();
  private page = 0;
  /** 当前页的固定背景色（标签背景 default 取页面背景） */
  private pageBg?: string;
  stats!: DrawioParseStats;

  constructor(options: DrawioParseOptions = {}) {
    // resolveOptions 幂等，已解析的选项可以直接传入
    this.opts = resolveOptions(options);
  }

  build(data: string | Uint8Array): DrawioTree {
    const t0 = now();
    this.stats = { pages: 0, cells: 0, vertices: 0, edges: 0, images: 0, gradients: 0, pens: 0, unsupported: {}, errors: [], ms: 0 };
    const pages = readPages(data);
    if (!pages.length) throw new Error('draw.io 文件中没有任何页面');

    const k = this.opts.scale > 0 ? this.opts.scale : 1;
    const out: DrawioUnit[][] = [];
    const pageList: DrawioPageInfo[] = [];
    const pageBackgrounds: DrawioTree['pageBackgrounds'] = [];
    const light = this.opts.colors === 'light';
    const pad = light ? 20 : 0;
    let ox = this.opts.origin.x;
    const oy = this.opts.origin.y;
    pages.forEach((page, index) => {
      if (this.opts.pages && !this.opts.pages.includes(index)) return;
      this.page = index;
      const bgAttr = page.model.attrs.background;
      let bg = bgAttr && bgAttr !== 'none' ? color(bgAttr, undefined, 'bg') : undefined;
      bg && bg[0] === '$' && (bg = undefined);
      light && !bg && (bg = '#ffffff');
      this.pageBg = bg;
      let units: DrawioUnit[] = [];
      try {
        units = this.convertPage(page.model);
      } catch (e: any) {
        this.stats.errors.push(`页面 ${page.name}：${e?.message || e}`);
      }

      const all = units.flatMap(unitItems);
      const box = all.length ? createGeom(all).bbox : { x: 0, y: 0, width: 0, height: 0 };
      // 页面坐标 → 画布：缩放 k，内容左上角放到 (ox + pad, oy + pad)
      const m: VectorMatrix = [k, 0, 0, k, ox + pad * k - box.x * k, oy + pad * k - box.y * k];
      isIdentity(m) || units.forEach((u) => placeUnit(u, m, k));
      const info: DrawioPageInfo = { name: page.name, x: ox, y: oy, width: (box.width + pad * 2) * k, height: (box.height + pad * 2) * k };
      page.id && (info.id = page.id);
      bg && (info.background = bg);
      pageList.push(info);
      pageBackgrounds.push(light && bg ? { x: info.x, y: info.y, width: info.width, height: info.height, color: bg } : undefined);
      if (this.opts.pageBorder) units.unshift(this.pageBorder(info, index));
      out.push(this.opts.granularity === 'node' ? units : this.merge(units, index, page.name));
      ox += info.width + this.opts.pageGap * k;
      this.stats.pages++;
    });
    this.stats.ms = Math.round(now() - t0);
    return { pages: out, pageList, stats: this.stats, pageBackgrounds };
  }

  /** layer / page 粒度：合并为每层（或每页）一个叶子 */
  private merge(units: DrawioUnit[], page: number, name: string): DrawioUnit[] {
    const leaf = (items: VectorItem[], info: DrawioPenInfo, label?: string): DrawioLeaf => ({
      kind: 'leaf',
      info,
      name: label,
      items,
      grads: [],
      rotate: 0,
      labels: [],
    });
    if (this.opts.granularity === 'page') {
      const items = units.flatMap(unitItems);
      return items.length ? [leaf(items, { page, type: 'page' }, name)] : [];
    }
    // layer：node 粒度下 convertPage 已按图层分组（图层为 group，info.type = 'layer'）
    const out: DrawioUnit[] = [];
    for (const u of units) {
      const items = unitItems(u);
      if (!items.length) continue;
      out.push(u.info.type === 'layer' ? leaf(items, { ...u.info }, u.name) : leaf(items, { ...u.info, type: 'layer' }, u.name));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 单元格读取
  // -------------------------------------------------------------------------

  private convertPage(model: XmlNode): DrawioUnit[] {
    this.cells.clear();
    this.boundsCache.clear();
    this.edgeCache.clear();
    this.busy.clear();
    const root = child(model, 'root');
    if (!root) return [];
    const order: Cell[] = [];
    for (const node of root.children) {
      const cell = readCell(node);
      if (!cell) continue;
      if (this.cells.has(cell.id)) cell.id = `${cell.id}#${order.length}`;
      this.cells.set(cell.id, cell);
      order.push(cell);
    }
    this.stats.cells += order.length;
    const roots: Cell[] = [];
    for (const cell of order) {
      const parent = cell.parent !== undefined ? this.cells.get(cell.parent) : undefined;
      if (parent && parent !== cell) parent.children.push(cell);
      else roots.push(cell);
    }
    const out: DrawioUnit[] = [];
    for (const r of roots) {
      if (!r.visible) continue;
      // 根单元格（id 0）的子单元格是图层；图层不画、不组合（layer 粒度按图层合并）
      const own = this.visit(r, 0);
      if (own) {
        out.push(own);
        continue;
      }
      for (const layer of r.children) {
        if (!layer.visible) continue;
        if (layer.vertex || layer.edge) {
          const u = this.visit(layer, 1);
          u && out.push(u);
          continue;
        }
        const children = layer.collapsed ? [] : layer.children.map((c) => this.visit(c, 2)).filter(Boolean);
        if (!children.length) continue;
        if (this.opts.granularity === 'layer') {
          out.push({ kind: 'group', info: { page: this.page, id: layer.id, type: 'layer' }, name: this.labelText(layer) || undefined, children });
        } else out.push(...children);
      }
    }
    return out;
  }

  /** 单元格及其子单元格 → 单元（自己没有内容、只有一个子单元时直接返回子单元） */
  private visit(cell: Cell, depth: number): DrawioUnit | undefined {
    if (!cell.visible || depth > 64) return undefined;
    let own: DrawioLeaf | undefined;
    try {
      if (cell.vertex) own = this.vertexLeaf(cell);
      else if (cell.edge) own = this.edgeLeaf(cell);
    } catch (e: any) {
      this.stats.errors.push(`${cell.edge ? 'edge' : 'vertex'}#${cell.id}: ${e?.message || e}`);
    }
    if (!cell.vertex && !cell.edge && depth === 0) return undefined;
    const children = cell.collapsed ? [] : cell.children.map((c) => this.visit(c, depth + 1)).filter(Boolean);
    const hasOwn = !!own && (own.items.length > 0 || own.labels.length > 0);
    if (!children.length) return hasOwn ? own : undefined;
    if (!hasOwn && children.length === 1) return children[0];
    return { kind: 'group', info: this.info(cell), name: own?.name, children: hasOwn ? [own!, ...children] : children };
  }

  private info(cell: Cell): DrawioPenInfo {
    const info: DrawioPenInfo = { page: this.page, id: cell.id };
    cell.vertex ? (info.type = 'vertex') : cell.edge && (info.type = 'edge');
    if (cell.vertex) info.shape = cell.style.shape || 'rect';
    if (cell.attrs) {
      const { id, label, placeholders, link, tooltip, ...rest } = cell.attrs;
      Object.keys(rest).length && (info.attrs = rest);
      link && (info.link = link);
      tooltip && (info.tooltip = tooltip);
    }
    return info;
  }

  /** 单元格及其所有祖先都可见，且没有被折叠的祖先 */
  private shown(cell: Cell): boolean {
    if (!cell.visible) return false;
    let p = cell.parent !== undefined ? this.cells.get(cell.parent) : undefined;
    for (let i = 0; p && i < 64; i++) {
      if (!p.visible || p.collapsed) return false;
      p = p.parent !== undefined ? this.cells.get(p.parent) : undefined;
    }
    return true;
  }

  private parentOf(cell: Cell) {
    return cell.parent !== undefined ? this.cells.get(cell.parent) : undefined;
  }

  /** 顶点的页面绝对范围（未旋转） */
  private bounds(cell: Cell): Rect | undefined {
    if (this.boundsCache.has(cell.id)) return this.boundsCache.get(cell.id);
    if (this.busy.has(cell.id)) return undefined;
    this.busy.add(cell.id);
    let r: Rect | undefined;
    const geo = cell.geo;
    if (geo) {
      const parent = this.parentOf(cell);
      const off = geo.offset ?? { x: 0, y: 0 };
      if (parent?.edge && geo.relative) {
        // 连线上的标签：x ∈ [-1, 1] 为沿线位置，y 为法向偏移
        const pts = this.edgePoints(parent);
        if (pts && pts.length > 1) {
          const p = pointOnEdge(pts, geo.x, geo.y);
          r = { x: p.x + off.x - geo.w / 2, y: p.y + off.y - geo.h / 2, w: geo.w, h: geo.h };
        }
      } else {
        const pb = parent?.vertex ? this.bounds(parent) : undefined;
        if (geo.relative && pb) {
          r = { x: pb.x + geo.x * pb.w + off.x, y: pb.y + geo.y * pb.h + off.y, w: geo.w, h: geo.h };
        } else {
          r = { x: (pb?.x ?? 0) + geo.x, y: (pb?.y ?? 0) + geo.y, w: geo.w, h: geo.h };
        }
      }
    }
    this.busy.delete(cell.id);
    this.boundsCache.set(cell.id, r);
    return r;
  }

  /** 连线控制点所在坐标系的原点（父顶点的左上角） */
  private origin(cell: Cell): Pt {
    const p = this.parentOf(cell);
    const b = p?.vertex ? this.bounds(p) : undefined;
    return b ? { x: b.x, y: b.y } : { x: 0, y: 0 };
  }

  /** draw.io 颜色 → IR 颜色；colors = 'light' 时 default 固定为浅色主题的颜色 */
  private col(v: string | undefined, def: string | undefined, kind: 'fg' | 'bg') {
    const c = color(v, def, kind);
    if (this.opts.colors !== 'light' || !c) return c;
    return c === '$fg' ? '#000000' : c === '$bg' ? '#ffffff' : c;
  }

  // -------------------------------------------------------------------------
  // 顶点
  // -------------------------------------------------------------------------

  private vertexLeaf(cell: Cell): DrawioLeaf | undefined {
    const box = this.bounds(cell);
    if (!box) return undefined;
    const st = cell.style;
    this.stats.vertices++;
    let shape = resolveShapeName(st.shape);
    let image: string | undefined;
    let icon = false;
    if (shape === 'image' || (st.image && shape !== 'label')) {
      image = st.image;
      shape = 'none';
    } else if (st.image) {
      image = st.image;
      icon = true;
    }
    const leaf: DrawioLeaf = { kind: 'leaf', info: this.info(cell), items: [], grads: [], box: { ...box }, rotate: num(st.rotation, 0), labels: [] };
    leaf.info.shape = st.shape || (image && !icon ? 'image' : 'rect');
    flag(st.shadow) && (leaf.shadow = true);
    const opacity = num(st.opacity, 100) / 100;

    if (shape !== 'none' && box.w >= 0 && box.h >= 0) {
      // 局部绘制坐标 → 形状框：direction → 翻转 → 平移（旋转交给图元的 rotate）
      let dw = box.w;
      let dh = box.h;
      let dirM: VectorMatrix = IDENTITY;
      switch (st.direction) {
        case 'south':
          dirM = [0, 1, -1, 0, box.w, 0];
          [dw, dh] = [box.h, box.w];
          break;
        case 'north':
          dirM = [0, -1, 1, 0, 0, box.h];
          [dw, dh] = [box.h, box.w];
          break;
        case 'west':
          dirM = [-1, 0, 0, -1, box.w, box.h];
          break;
      }
      const flips: VectorMatrix[] = [];
      flag(st.flipH) && flips.push([-1, 0, 0, 1, box.w, 0]);
      flag(st.flipV) && flips.push([1, 0, 0, -1, 0, box.h]);
      const m = composeMatrix(dirM, ...flips, translateMatrix(box.x, box.y));

      let parts = buildShape(shape, dw, dh, st, m);
      if (!parts) {
        this.count(`shape:${shape}`);
        parts = buildShape('rect', dw, dh, st, m)!;
      }
      const sw = num(st.strokeWidth, 1);
      const fill = withAlpha(this.col(st.fillColor, '$bg', 'bg'), num(st.fillOpacity, 100) / 100);
      const stroke = withAlpha(this.col(st.strokeColor, '$fg', 'fg'), num(st.strokeOpacity, 100) / 100);
      const alt = this.col(st.swimlaneFillColor, undefined, 'bg');
      const grad = this.gradient(st, fill, box);
      const base: VectorStyle = { lw: sw, dash: dashOf(st, sw), alpha: opacity < 1 ? opacity : undefined };
      flag(st.rounded) && (base.join = 'round');
      for (const part of parts) {
        if (part.d.length < 3) continue;
        const s: VectorStyle = { ...base };
        s.stroke = part.fill === 'fillOnly' ? 'none' : stroke;
        let g: PenGradient | undefined;
        if (part.fill === 'main' || part.fill === 'fillOnly') {
          s.fill = grad ? grad.ir : fill;
          g = grad?.pen;
        } else if (part.fill === 'alt') s.fill = alt;
        const noFill = !s.fill || s.fill === 'none';
        if (s.stroke === 'none' && noFill) continue;
        if (noFill) delete s.fill;
        s.alpha === undefined && delete s.alpha;
        s.dash === undefined && delete s.dash;
        leaf.items.push(pathItem(part.d, s));
        leaf.grads.push(g);
      }
    }

    if (image) this.imageItem(leaf, image, st, box, icon, opacity);

    // 标签框：泳道为标题栏，其余为形状框
    let lb: Rect = box;
    if (shape === 'swimlane') {
      const ss = num(st.startSize, 23);
      lb = st.horizontal === '0' ? { ...box, w: Math.min(ss, box.w) } : { ...box, h: Math.min(ss, box.h) };
    }
    const c = center(box);
    const rot = leaf.rotate * DEG;
    const rotM = rot ? composeMatrix(translateMatrix(-c.x, -c.y), rotateMatrix(rot), translateMatrix(c.x, c.y)) : IDENTITY;
    const label = this.label(cell, lb, st, rotM, false);
    label && leaf.labels.push(label);
    leaf.name = (label?.style.text.split('\n')[0] || '').slice(0, 40) || undefined;
    return leaf;
  }

  /** 填充渐变（gradientColor + gradientDirection），返回 IR 渐变和相对形状框的图元渐变 */
  private gradient(st: Style, fill: string | undefined, box: Rect): { ir: VectorGradient; pen?: PenGradient } | undefined {
    if (!st.gradientColor || st.gradientColor === 'none') return undefined;
    const to = withAlpha(this.col(st.gradientColor, undefined, 'bg'), num(st.fillOpacity, 100) / 100);
    if (!fill || fill === 'none' || fill[0] === '$' || !to || to === 'none' || to[0] === '$') {
      // 跟随主题的颜色不能做渐变色标
      this.count('gradient:themeColor');
      return undefined;
    }
    this.stats.gradients++;
    const dir = st.gradientDirection || 'south';
    // 渐变空间为单位正方形，m 映射到形状框
    const m: VectorMatrix = [box.w || 1, 0, 0, box.h || 1, box.x, box.y];
    const stops = [
      { o: 0, c: fill },
      { o: 1, c: to },
    ];
    let p: [number, number, number, number];
    switch (dir) {
      case 'north':
        p = [0.5, 1, 0.5, 0];
        break;
      case 'east':
        p = [0, 0.5, 1, 0.5];
        break;
      case 'west':
        p = [1, 0.5, 0, 0.5];
        break;
      case 'radial':
        p = [0.5, 0.5, 0.5, 0.5];
        break;
      default:
        p = [0.5, 0, 0.5, 1];
    }
    const radial = dir === 'radial';
    const ir: VectorGradient = radial
      ? { type: 'radial', x0: 0.5, y0: 0.5, r0: 0, x1: 0.5, y1: 0.5, r1: 0.5, m, stops }
      : { type: 'linear', x0: p[0], y0: p[1], x1: p[2], y1: p[3], m, stops };
    const c0 = parseColor(fill);
    const c1 = parseColor(to);
    if (!c0 || !c1) return { ir };
    const pstops = [
      { i: 0, c: c0 },
      { i: 1, c: c1 },
    ];
    const pen: PenGradient = radial
      ? { type: 'radial', x0: 0.5, y0: 0.5, x1: 0, y1: 0, r: (box.w + box.h) / 4, stops: pstops }
      : { type: 'linear', x0: p[0], y0: p[1], x1: p[2], y1: p[3], r: 0, stops: pstops };
    return { ir, pen };
  }

  /** 图片形状 / 带图标的 label 形状 → IR 图片项 */
  private imageItem(leaf: DrawioLeaf, raw: string, st: Style, box: Rect, icon: boolean, opacity: number) {
    this.stats.images++;
    if (!this.opts.images) return;
    const src0 = normalizeImageSrc(raw, this.opts.imageBase);
    if (!src0) return;
    const key = hashKey(src0);
    if (this.opts.skipImages?.includes(key)) return;
    const src = this.opts.imageUrls?.[key] || src0;
    let x = box.x;
    let y = box.y;
    let w = box.w;
    let h = box.h;
    if (icon) {
      // mxLabel.getImageBounds：图标缺省在左侧垂直居中，间距 spacing + 5
      w = num(st.imageWidth, 24);
      h = num(st.imageHeight, 24);
      const sp = num(st.spacing, 2) + 5;
      const ia = st.imageAlign || 'left';
      const iv = st.imageVerticalAlign || 'middle';
      x = ia === 'center' ? box.x + (box.w - w) / 2 : ia === 'right' ? box.x + box.w - w - sp : box.x + sp;
      y = iv === 'top' ? box.y + sp : iv === 'bottom' ? box.y + box.h - h - sp : box.y + (box.h - h) / 2;
    }
    if (!(w > 0 && h > 0)) return;
    let m: VectorMatrix = [w, 0, 0, h, x, y];
    if (!icon && flag(st.flipH)) m = [-w, 0, 0, h, x + w, y];
    if (!icon && flag(st.flipV)) m = [m[0], 0, 0, -h, m[4], y + h];
    const item: VectorImageItem = { t: 'i', src, m };
    // imageAspect 缺省 1：等比完整显示
    st.imageAspect !== '0' && (item.fit = 'contain');
    opacity < 1 && (item.alpha = opacity);
    leaf.items.push(item);
    leaf.grads.push(undefined);
    !icon && (leaf.info.part = leaf.items.length === 1 ? 'image' : leaf.info.part);
  }

  // -------------------------------------------------------------------------
  // 连线
  // -------------------------------------------------------------------------

  private terminal(cell: Cell, which: 'source' | 'target'): Terminal {
    const st = cell.style;
    const geo = cell.geo ?? EMPTY_GEO;
    const o = this.origin(cell);
    const raw = which === 'source' ? geo.sourcePoint : geo.targetPoint;
    const pt = raw ? { x: raw.x + o.x, y: raw.y + o.y } : undefined;
    const dangling: Terminal = { rot: 0, perimeter: 'rect', fixed: pt };
    const id = which === 'source' ? cell.source : cell.target;
    const tc = id !== undefined ? this.cells.get(id) : undefined;
    if (!tc || !this.shown(tc)) return dangling;

    if (tc.edge) {
      // 连到另一条连线：取其中点
      const pts = tc !== cell ? this.edgePoints(tc) : undefined;
      return pts && pts.length > 1 ? { rot: 0, perimeter: 'rect', fixed: pointAlong(pts, 0.5).p } : dangling;
    }
    const box = this.bounds(tc);
    if (!box) return dangling;
    const tst = tc.style;
    const rot = num(tst.rotation, 0) * DEG;
    const shape = resolveShapeName(tst.shape);
    let perimeter = perimeterOf(shape, tst);
    if (perimeter === 'triangle' && tst.direction && tst.direction !== 'east') perimeter = 'rect';
    const t: Terminal = { box, rot, perimeter };
    const key = which === 'source' ? 'exit' : 'entry';
    const fx = st[`${key}X`];
    const fy = st[`${key}Y`];
    if (fx !== undefined && fy !== undefined && fx !== '' && fy !== '') {
      const x = num(fx, 0.5);
      const y = num(fy, 0.5);
      t.fixed = fixedPoint(box, rot, x, y, num(st[`${key}Dx`], 0), num(st[`${key}Dy`], 0));
      t.dir = sideOf(x, y);
    }
    return t;
  }

  /** 连线的折线点（页面绝对坐标），带缓存 */
  private edgePoints(cell: Cell): Pt[] | undefined {
    if (this.edgeCache.has(cell.id)) return this.edgeCache.get(cell.id);
    if (this.busy.has(cell.id)) return undefined;
    this.busy.add(cell.id);
    let pts: Pt[] | undefined;
    try {
      const st = cell.style;
      const o = this.origin(cell);
      const wps = (cell.geo?.points ?? []).map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
      const s = this.terminal(cell, 'source');
      const e = this.terminal(cell, 'target');
      const es = st.edgeStyle;
      if (cell.source !== undefined && cell.source === cell.target && !wps.length && !s.fixed && !e.fixed) {
        pts = loopRoute(s);
      } else {
        switch (es) {
          case 'orthogonalEdgeStyle':
          case 'segmentEdgeStyle':
          case 'isometricEdgeStyle':
            pts = orthogonalRoute(s, e, wps);
            break;
          case 'elbowEdgeStyle':
            pts = elbowRoute(s, e, wps, st.elbow === 'vertical' ? 'elbow-v' : 'elbow-h');
            break;
          case 'sideToSideEdgeStyle':
            pts = elbowRoute(s, e, wps, 'h');
            break;
          case 'topToBottomEdgeStyle':
            pts = elbowRoute(s, e, wps, 'v');
            break;
          case 'entityRelationEdgeStyle':
            pts = entityRelationRoute(s, e, num(st.segment, 30));
            break;
          case 'loopEdgeStyle':
            pts = loopRoute(s) ?? straightRoute(s, e, wps);
            break;
          default:
            if (es && es !== 'none') this.count(`edgeStyle:${es}`);
            pts = straightRoute(s, e, wps);
        }
      }
    } finally {
      this.busy.delete(cell.id);
    }
    this.edgeCache.set(cell.id, pts);
    return pts;
  }

  private edgeLeaf(cell: Cell): DrawioLeaf | undefined {
    const pts = this.edgePoints(cell);
    if (!pts || pts.length < 2) {
      this.stats.errors.push(`edge#${cell.id}: 无法确定端点`);
      return undefined;
    }
    this.stats.edges++;
    const st = cell.style;
    const leaf: DrawioLeaf = { kind: 'leaf', info: this.info(cell), items: [], grads: [], rotate: 0, labels: [] };
    flag(st.shadow) && (leaf.shadow = true);
    if (st.shape && st.shape !== 'connector') this.count(`edgeShape:${st.shape}`);
    const sw = st.shape === 'flexArrow' ? num(st.width, 10) : num(st.strokeWidth, 1);
    const opacity = num(st.opacity, 100) / 100;
    const alpha = opacity < 1 ? opacity : undefined;
    const stroke = withAlpha(this.col(st.strokeColor, '$fg', 'fg'), num(st.strokeOpacity, 100) / 100)!;
    const bgFill = this.col(undefined, '$bg', 'bg');

    const curved = flag(st.curved);
    const edge: DrawioEdge = { points: pts.map((p) => ({ ...p })), lineWidth: sw, native: !curved && (!st.shape || st.shape === 'connector') };
    stroke[0] !== '$' && (edge.color = stroke);
    bgFill && bgFill[0] !== '$' && (edge.background = bgFill);
    alpha !== undefined && (edge.alpha = alpha);
    const ed = dashOf(st, sw);
    ed && (edge.dash = ed);
    cell.source !== undefined && (edge.source = cell.source);
    cell.target !== undefined && (edge.target = cell.target);
    const arrowOf = (type: string | undefined, size: number, fill: boolean) => {
      if (!type || type === 'none') return undefined;
      const a = ARROWS[type];
      if (!a) {
        edge.native = false;
        return undefined;
      }
      // meta2d 原生箭头的长度：draw.io 箭头尺寸为 size + 线宽
      return { type: a, filled: a === 'line' ? false : fill, size: (size + sw) * (a === 'triangle' ? 1.6 : 1.2) } as DrawioArrow;
    };
    edge.to = arrowOf(st.endArrow ?? 'classic', num(st.endSize, 6), st.endFill !== '0');
    edge.from = arrowOf(st.startArrow, num(st.startSize, 6), st.startFill !== '0');
    edge.to || delete edge.to;
    edge.from || delete edge.from;
    stroke !== 'none' && (leaf.edge = edge);

    if (stroke !== 'none') {
      const line = pts.map((p) => ({ ...p }));
      const markerItems: VectorItem[] = [];
      const end = (type: string | undefined, atEnd: boolean, size: number, fill: boolean) => {
        if (!type || type === 'none') return;
        const n = pts.length;
        const tip = atEnd ? pts[n - 1] : pts[0];
        // 找到与端点不重合的相邻点确定方向
        let prev: Pt | undefined;
        for (let i = 1; i < n && !prev; i++) {
          const q = atEnd ? pts[n - 1 - i] : pts[i];
          if (Math.hypot(q.x - tip.x, q.y - tip.y) > 1e-6) prev = q;
        }
        if (!prev) return;
        const len = Math.hypot(tip.x - prev.x, tip.y - prev.y);
        const ux = (tip.x - prev.x) / len;
        const uy = (tip.y - prev.y) / len;
        const r = marker(type, tip, ux, uy, size, sw, fill);
        if (!r.known) this.count(`arrow:${type}`);
        const back = Math.min(r.back, len * 0.9);
        const target = atEnd ? line[n - 1] : line[0];
        target.x = tip.x - ux * back;
        target.y = tip.y - uy * back;
        for (const mk of r.markers) {
          const filled = mk.filled ? (mk.bgFill ? bgFill : stroke) : undefined;
          const s: VectorStyle = { stroke, lw: sw };
          filled && (s.fill = filled);
          alpha !== undefined && (s.alpha = alpha);
          markerItems.push(pathItem(mk.d, s));
        }
      };
      end(st.endArrow ?? 'classic', true, num(st.endSize, 6), st.endFill !== '0');
      end(st.startArrow, false, num(st.startSize, 6), st.startFill !== '0');
      const mode = curved ? 'curved' : flag(st.rounded) ? 'rounded' : 'line';
      const s: VectorStyle = { stroke, lw: sw };
      const dash = dashOf(st, sw);
      dash && (s.dash = dash);
      alpha !== undefined && (s.alpha = alpha);
      mode !== 'line' && (s.join = 'round');
      leaf.items.push(pathItem(edgePath(line, mode, num(st.arcSize, 20) / 2), s), ...markerItems);
      leaf.grads.push(...leaf.items.map(() => undefined));
    }

    // 连线自身的标签：geometry.x 为沿线相对位置，y 为法向偏移，offset 为绝对偏移
    const geo = cell.geo ?? EMPTY_GEO;
    const p = pointOnEdge(pts, geo.x, geo.y);
    const off = geo.offset ?? { x: 0, y: 0 };
    const est: Style = { labelBackgroundColor: 'default', ...st };
    const label = this.label(cell, { x: p.x + off.x, y: p.y + off.y, w: 0, h: 0 }, est, IDENTITY, true);
    label && leaf.labels.push(label);
    leaf.name = (label?.style.text.split('\n')[0] || '').slice(0, 40) || undefined;
    return leaf;
  }

  // -------------------------------------------------------------------------
  // 标签
  // -------------------------------------------------------------------------

  private labelText(cell: Cell): string {
    const st = cell.style;
    let v = cell.value;
    if (cell.attrs && (flag(cell.attrs.placeholders) || flag(st.placeholders))) v = fillPlaceholders(v, cell.attrs);
    if (!v) return '';
    return flag(st.html) ? htmlToText(v) : v.replace(/\r\n?/g, '\n');
  }

  private label(cell: Cell, box: Rect, st: Style, rotM: VectorMatrix, isEdge: boolean): DrawioLabel | undefined {
    if (flag(st.noLabel)) return undefined;
    const text = this.labelText(cell);
    if (!text.trim()) return undefined;
    const fill = withAlpha(this.col(st.fontColor, '$fg', 'fg'), num(st.textOpacity, 100) / 100);
    if (fill === 'none') return undefined;

    let { x, y, w, h } = box;
    if (!isEdge) {
      if (st.labelPosition === 'left') x -= w;
      else if (st.labelPosition === 'right') x += w;
      if (st.verticalLabelPosition === 'top') y -= h;
      else if (st.verticalLabelPosition === 'bottom') y += h;
    }
    const horizontal = st.horizontal !== '0';
    const lc = { x: x + w / 2, y: y + h / 2 };
    if (!horizontal) {
      [w, h] = [h, w];
      x = lc.x - w / 2;
      y = lc.y - h / 2;
    }
    const sp = num(st.spacing, 2);
    const sl = num(st.spacingLeft, 0);
    const sr = num(st.spacingRight, 0);
    const stp = num(st.spacingTop, 0);
    const sb = num(st.spacingBottom, 0);
    const align = isEdge && !st.align ? 'center' : st.align || 'center';
    const valign = isEdge && !st.verticalAlign ? 'middle' : st.verticalAlign || 'middle';

    const fontStyle = num(st.fontStyle, 0) | 0;
    const ff = st.fontFamily;
    const fontSize = num(st.fontSize, 11);
    if (!(fontSize > 0)) return undefined;
    const item: VectorTextItem = {
      t: 't',
      text,
      x: align === 'left' ? x + sp + sl : align === 'right' ? x + w - sp - sr : x + w / 2 + (sl - sr) / 2,
      y: valign === 'top' ? y + sp + stp : valign === 'bottom' ? y + h - sp - sb : y + h / 2 + (stp - sb) / 2,
      h: fontSize,
      a: align === 'left' ? 'left' : align === 'right' ? 'right' : 'center',
      b: valign === 'top' ? 'top' : valign === 'bottom' ? 'bottom' : 'middle',
      lh: 1.2,
      font: ff ? `${ff.includes(',') ? ff : `"${ff}"`}, ${DEFAULT_FONT}` : DEFAULT_FONT,
      fill,
    };
    fontStyle & 1 && (item.bold = true);
    fontStyle & 2 && (item.italic = true);
    const auto = isEdge || !(w > 0 && h > 0);
    const wrap = !auto && st.whiteSpace === 'wrap';
    if (wrap) {
      const bw = w - 2 * sp - sl - sr;
      bw > 0 && (item.bw = bw);
    }

    const items: VectorItem[] = [];
    let bgc = this.col(st.labelBackgroundColor, undefined, 'bg');
    // 标签背景 default 为页面背景色
    bgc === '$bg' && this.pageBg && (bgc = this.pageBg);
    const bg = bgc && bgc !== 'none' ? bgc : undefined;
    const border = this.col(st.labelBorderColor, 'none', 'fg');
    if (bg || border !== 'none') {
      const tb = textItemBox(item);
      const pad = 2;
      const b = new VectorPathBuilder().polyline(
        [
          [tb.x - pad, tb.y - pad],
          [tb.x + tb.width + pad, tb.y - pad],
          [tb.x + tb.width + pad, tb.y + tb.height + pad],
          [tb.x - pad, tb.y + tb.height + pad],
        ],
        true,
      );
      const s: VectorStyle = { stroke: border };
      bg && (s.fill = bg);
      items.push(pathItem(b.d, s));
      border !== 'none' && this.count('labelBorder');
    }
    items.push(item);

    // 竖排标签先绕标签框中心转 -90°，再随形状旋转
    let m = rotM;
    if (!horizontal) {
      m = composeMatrix(translateMatrix(-lc.x, -lc.y), rotateMatrix(-Math.PI / 2), translateMatrix(lc.x, lc.y), rotM);
    }

    const style: DrawioTextStyle = {
      text,
      fontSize,
      lineHeight: 1.2,
      align: item.a as DrawioTextStyle['align'],
      valign: item.b as DrawioTextStyle['valign'],
      wrap,
    };
    fill && fill[0] !== '$' && (style.color = fill);
    ff && (style.fontFamily = item.font);
    item.bold && (style.bold = true);
    item.italic && (style.italic = true);
    fontStyle & 4 && (style.underline = true);
    bg && bg[0] !== '$' && (style.background = bg);

    // 文字框：扣除 spacing；连线标签、零尺寸单元格按文字估算，按对齐方式放在锚点处
    let tx = x + sp + sl;
    let ty = y + sp + stp;
    let tw = w - 2 * sp - sl - sr;
    let th = h - 2 * sp - stp - sb;
    if (auto) {
      const lines = text.split('\n');
      tw = Math.max(...lines.map((l) => estimateTextWidth(l, fontSize))) * 1.1 + fontSize * 0.4;
      th = lines.length * fontSize * style.lineHeight;
      tx = item.a === 'left' ? item.x : item.a === 'right' ? item.x - tw : item.x - tw / 2;
      ty = item.b === 'top' ? item.y : item.b === 'bottom' ? item.y - th : item.y - th / 2;
    } else {
      // 边距大于框时（窄形状、外部标签）至少留一个字宽
      tw < fontSize && ((tx -= (fontSize - tw) / 2), (tw = fontSize));
      th < fontSize * style.lineHeight && ((ty -= (fontSize * style.lineHeight - th) / 2), (th = fontSize * style.lineHeight));
    }

    return {
      style,
      x: tx,
      y: ty,
      width: tw,
      height: th,
      m,
      vertical: !horizontal,
      auto,
      items: isIdentity(m) ? items : items.map((it) => transformItem(it, m)),
    };
  }

  // -------------------------------------------------------------------------

  private pageBorder(p: DrawioPageInfo, page: number): DrawioLeaf {
    const b = new VectorPathBuilder().polyline(
      [
        [p.x, p.y],
        [p.x + p.width, p.y],
        [p.x + p.width, p.y + p.height],
        [p.x, p.y + p.height],
      ],
      true,
    );
    return {
      kind: 'leaf',
      info: { page, type: 'page', part: 'page' },
      name: p.name,
      items: [pathItem(b.d, { stroke: '#9aa4b2', dash: [6, 4] })],
      grads: [undefined],
      rotate: 0,
      labels: [],
    };
  }

  private count(key: string) {
    this.stats.unsupported[key] = (this.stats.unsupported[key] || 0) + 1;
  }
}

/** draw.io 箭头 → 原生箭头；不在表里的箭头（ER 符号、cross 等）只能画成矢量 */
const ARROWS: Record<string, DrawioArrow['type']> = {
  classic: 'triangle',
  classicThin: 'triangle',
  block: 'triangle',
  blockThin: 'triangle',
  open: 'line',
  openThin: 'line',
  oval: 'circle',
  dot: 'circle',
  diamond: 'diamond',
  diamondThin: 'diamond',
};

// ---------------------------------------------------------------------------
// 单元工具
// ---------------------------------------------------------------------------

/** 叶子绕框中心旋转的矩阵 */
export function leafRotation(leaf: DrawioLeaf): VectorMatrix {
  if (!leaf.rotate || !leaf.box) return IDENTITY;
  const { x, y, w, h } = leaf.box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return composeMatrix(translateMatrix(-cx, -cy), rotateMatrix(leaf.rotate * DEG), translateMatrix(cx, cy));
}

/** 叶子的全部 IR 项（页面坐标，已含旋转）：形状 + 标签 */
export function leafItems(leaf: DrawioLeaf): VectorItem[] {
  const m = leafRotation(leaf);
  const items = isIdentity(m) ? leaf.items : leaf.items.map((it) => transformItem(it, m));
  return [...items, ...leaf.labels.flatMap((l) => l.items)];
}

export function unitItems(u: DrawioUnit): VectorItem[] {
  return u.kind === 'leaf' ? leafItems(u) : u.children.flatMap(unitItems);
}

/** 页面坐标 → 画布坐标（均匀缩放 k + 平移） */
function placeUnit(u: DrawioUnit, m: VectorMatrix, k: number) {
  if (u.kind === 'group') {
    u.children.forEach((c) => placeUnit(c, m, k));
    return;
  }
  u.items = u.items.map((it) => transformItem(it, m, k));
  if (u.box) {
    const [x, y] = applyMatrix(m, u.box.x, u.box.y);
    u.box = { x, y, w: u.box.w * k, h: u.box.h * k };
  }
  u.grads = u.grads.map((g) => (g && g.type === 'radial' ? { ...g, r: g.r * k } : g));
  if (u.edge) {
    const e = u.edge;
    e.points = e.points.map((p) => {
      const [x, y] = applyMatrix(m, p.x, p.y);
      return { x, y };
    });
    e.lineWidth *= k;
    e.dash && (e.dash = e.dash.map((v) => v * k));
    e.from && (e.from = { ...e.from, size: e.from.size * k });
    e.to && (e.to = { ...e.to, size: e.to.size * k });
  }
  const inv = invertMatrix(m) || IDENTITY;
  for (const l of u.labels) {
    const [x, y] = applyMatrix(m, l.x, l.y);
    l.x = x;
    l.y = y;
    l.width *= k;
    l.height *= k;
    l.style.fontSize *= k;
    // 文字坐标系随页面一起缩放：m' = P · m · P⁻¹
    l.m = composeMatrix(inv, l.m, m);
    l.items = l.items.map((it) => transformItem(it, m, k));
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function readPoint(n: XmlNode | undefined): Pt | undefined {
  if (!n) return undefined;
  return { x: num(n.attrs.x, 0), y: num(n.attrs.y, 0) };
}

function readGeo(n: XmlNode | undefined): Geo | undefined {
  if (!n) return undefined;
  const a = n.attrs;
  const geo: Geo = {
    x: num(a.x, 0),
    y: num(a.y, 0),
    w: num(a.width, 0),
    h: num(a.height, 0),
    relative: a.relative === '1',
    points: [],
  };
  for (const c of n.children) {
    const as = c.attrs.as;
    if (c.tag === 'mxPoint') {
      if (as === 'sourcePoint') geo.sourcePoint = readPoint(c);
      else if (as === 'targetPoint') geo.targetPoint = readPoint(c);
      else if (as === 'offset') geo.offset = readPoint(c);
    } else if (c.tag === 'Array' && as === 'points') {
      for (const p of c.children) if (p.tag === 'mxPoint') geo.points.push(readPoint(p)!);
    }
  }
  return geo;
}

function readCell(node: XmlNode): Cell | undefined {
  let mx: XmlNode | undefined;
  let attrs: Record<string, string> | undefined;
  let value: string | undefined;
  let id: string | undefined;
  if (node.tag === 'mxCell') {
    mx = node;
    id = node.attrs.id;
    value = node.attrs.value;
  } else if (node.tag === 'UserObject' || node.tag === 'object') {
    mx = child(node, 'mxCell');
    attrs = node.attrs;
    id = node.attrs.id;
    value = node.attrs.label;
  }
  if (!mx || id === undefined) return undefined;
  const a = mx.attrs;
  const cell: Cell = {
    id,
    parent: a.parent,
    value: value ?? '',
    style: parseStyle(a.style, isShapeName),
    vertex: a.vertex === '1',
    edge: a.edge === '1',
    source: a.source,
    target: a.target,
    geo: readGeo(child(mx, 'mxGeometry')),
    visible: a.visible !== '0',
    collapsed: a.collapsed === '1',
    children: [],
  };
  attrs && (cell.attrs = attrs);
  return cell;
}

/** 连线上的点：gx ∈ [-1, 1] 为相对位置（0 = 中点），gy 为法向偏移 */
function pointOnEdge(pts: Pt[], gx: number, gy: number): Pt {
  const { p, ux, uy } = pointAlong(pts, (Math.max(-1, Math.min(1, gx)) + 1) / 2);
  return { x: p.x - uy * gy, y: p.y + ux * gy };
}

function dashOf(st: Style, sw: number): number[] | undefined {
  if (!flag(st.dashed)) return undefined;
  const pat = (st.dashPattern || '3 3')
    .split(/[\s,]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v) && v >= 0);
  if (!pat.length || pat.every((v) => v === 0)) return undefined;
  const k = flag(st.fixDash) ? 1 : sw;
  return pat.map((v) => Math.max(v * k, 0.01));
}
