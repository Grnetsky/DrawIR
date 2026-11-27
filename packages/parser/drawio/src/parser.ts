import { applyMatrix, createGeom, isGradient, type VectorImageItem, type VectorItem, type VectorPathItem } from '@drawir/core';
import type { PenGradient } from './gradient';
import {
  DrawioToIR,
  leafItems,
  resolveOptions,
  type DrawioArrow,
  type DrawioLabel,
  type DrawioLeaf,
  type DrawioTextStyle,
  type DrawioTree,
  type DrawioUnit,
  type ResolvedOptions,
} from './ir';
import type { DrawioDocument, DrawioParseOptions, DrawioPenInfo } from './types';
import { penRectOfGeom, s8 } from './util';

/** 独立文字图元（与 meta2d 版本无关） */
export interface TextSpec extends DrawioTextStyle {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 角度（度，顺时针） */
  rotate?: number;
}

/** 原生图片图元 */
export interface ImageSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate?: number;
  src: string;
  alpha?: number;
  /** 等比完整显示 */
  contain?: boolean;
  flipX?: boolean;
  flipY?: boolean;
}

/** 文字框相对图元框左上角（未旋转）的位置 */
export interface TextRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 原生连线的箭头和端点信息 */
export interface LineSpec {
  from?: DrawioArrow;
  to?: DrawioArrow;
  /** 空心箭头的填充色 */
  background?: string;
}

/** 把通用图元转成某个 meta2d 版本的图元格式。坐标一律为画布绝对坐标，1.x 的相对坐标在 finish 中换算 */
export interface DrawioPenAdapter {
  /** 矢量图元（pen.vector 已就绪）：补上图元类型 */
  vector(pen: any, label: string | undefined): void;
  /** 原生连线：pen 已有 anchors（绝对坐标）、x / y / width / height、color、lineWidth、lineDash */
  line(pen: any, label: string | undefined, spec: LineSpec): void;
  text(spec: TextSpec, opts: { id: string; label?: string; drawio: DrawioPenInfo }): any;
  /** 标签作为图元自身的文字（双击编辑） */
  hostText(pen: any, style: DrawioTextStyle, rect: TextRect): void;
  /** 连线的标签：2.x 为连线的子文字图元（随连线移动），1.x 为独立文字图元 */
  lineLabel(line: any, spec: TextSpec, at: { segment: number; position: number }, opts: { id: string; drawio: DrawioPenInfo }): any;
  image(spec: ImageSpec, opts: { id: string; label?: string; drawio: DrawioPenInfo }): any;
  /** 填充渐变（pen.vector 中的 '$bg' 填充跟随图元背景） */
  gradient(pen: any, g: PenGradient): void;
  /** children 为直接子图元，返回 [父, ...子] */
  group(group: { id: string; label?: string; drawio: DrawioPenInfo; x: number; y: number; width: number; height: number }, children: any[]): any[];
  /** 连线端点连到图元锚点 */
  connect(line: any, lineAnchor: any, node: any, anchor: any): void;
  isLine(pen: any): boolean;
  /** 全部图元生成后调用（1.x：锚点、组合子图元换算为相对坐标） */
  finish?(pens: any[]): void;
}

const isFixed = (c: unknown): c is string => typeof c === 'string' && !!c && c !== 'none' && c[0] !== '$';

/**
 * draw.io → meta2d 图元。
 *
 * 遍历、连线路由和几何由 DrawioToIR 完成（得到每个单元格的 Vector IR 项和标签）；这里按 editable 生成：
 * - 顶点 → 矢量图元（图元框即单元格框，旋转为图元的 rotate），标签为图元文字；纯图片为原生图片图元；
 * - 连线 → 原生连线（端点连到顶点的锚点），曲线、特殊箭头的连线为矢量图元；
 * - 竖排标签、单独的文字 → 原生文字图元；
 * - 容器、分组、泳道按层级组合。
 */
export class DrawioConverter {
  private opts: ResolvedOptions;
  /** 单元格 id → 宿主图元（连线端点连接用） */
  private hosts = new Map<string, any>();
  private lines: { pen: any; source?: string; target?: string }[] = [];

  constructor(options: DrawioParseOptions = {}, private adapter: DrawioPenAdapter) {
    this.opts = resolveOptions(options);
  }

  convert(data: string | Uint8Array): DrawioDocument {
    const tree = new DrawioToIR(this.opts).build(data);
    return this.convertTree(tree);
  }

  convertTree(tree: DrawioTree): DrawioDocument {
    const t0 = now();
    const pens: any[] = [];
    tree.pages.forEach((units, i) => {
      this.hosts.clear();
      this.lines = [];
      const bg = tree.pageBackgrounds[i];
      if (bg) pens.push(this.pageBackground(bg, units[0]?.info.page ?? i, tree.pageList[i]?.name));
      for (const u of units) pens.push(...this.emit(u));
      this.connectLines();
    });
    this.adapter.finish?.(pens);
    const { stats, pageList } = tree;
    stats.pens = pens.length;
    stats.ms += Math.round(now() - t0);
    const last = pageList[pageList.length - 1];
    const doc: DrawioDocument = {
      pens,
      vectors: {},
      width: last ? last.x + last.width - this.opts.origin.x : 0,
      height: Math.max(0, ...pageList.map((p) => p.height)),
      pageList,
      stats,
    };
    const bg = pageList.find((p) => p.background)?.background;
    bg && (doc.background = bg);
    return doc;
  }

  private emit(u: DrawioUnit): any[] {
    if (u.kind === 'leaf') return this.leaf(u);
    const all = u.children.flatMap((c) => this.emit(c));
    // 连线和它的标签不组合：连线端点要跟随形状，组合后无法单独调整
    if (u.info.type === 'edge' && all.some((p) => this.adapter.isLine(p))) return all;
    return this.wrap(all, u.info, u.name);
  }

  /** 组合：all 中没有 parentId 的是直接子图元。连线不放进组合（端点要跟随所连的形状） */
  private wrap(all: any[], info: DrawioPenInfo, name?: string): any[] {
    const direct = all.filter((p) => !p.parentId && !this.adapter.isLine(p));
    if (direct.length < 2 || !this.opts.group) return all;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of direct) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.width);
      y1 = Math.max(y1, p.y + p.height);
    }
    const [group] = this.adapter.group({ id: s8(), label: name, drawio: { ...info }, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, direct);
    return [group, ...all];
  }

  private leaf(leaf: DrawioLeaf): any[] {
    const out: any[] = [];
    const isCell = leaf.info.type === 'vertex' || leaf.info.type === 'edge';
    if (!this.opts.editable || !isCell) {
      const pen = this.vectorPen(leafItems(leaf), leaf);
      pen && out.push(pen);
      this.applyShadow(out, leaf);
      return out;
    }
    if (leaf.edge?.native && leaf.edge.points.length > 1) return this.edgePens(leaf);

    // 宿主图元：纯图片 → 原生图片；其余 → 矢量图元（图元框为单元格框，旋转交给 rotate）
    let host: any;
    const only = leaf.items.length === 1 ? leaf.items[0] : undefined;
    const img = only?.t === 'i' && leaf.box ? imageSpec(only, leaf) : undefined;
    if (img) {
      host = this.adapter.image(img, { id: s8(), label: leaf.name, drawio: { ...leaf.info } });
    } else if (leaf.items.length) {
      host = this.vectorPen(leaf.items, leaf, leaf.box);
      // 1.x / 2.x 的图元文字没有 textColor 时用 pen.color：跟随主题的标签不能把描边色绑到 pen.color
      const themeText = leaf.labels.some((l) => !l.style.color && !l.vertical && !l.auto);
      host && this.bindStyle(host, leaf, themeText);
    }
    if (host) {
      leaf.rotate && (host.rotate = leaf.rotate);
      if (leaf.info.type === 'vertex') {
        delete host.disableAnchor;
        host.anchors = sideAnchors(host);
        this.hosts.set(leaf.info.id, host);
      }
      out.push(host);
    }
    for (const l of leaf.labels) {
      if (host && !host.text && leaf.box && !l.vertical && !l.auto) {
        this.adapter.hostText(host, l.style, { x: l.x - host.x, y: l.y - host.y, width: l.width, height: l.height });
        continue;
      }
      out.push(this.adapter.text(labelSpec(l), { id: s8(), label: leaf.name, drawio: { ...leaf.info, part: 'label' } }));
    }
    this.applyShadow(host ? [host] : out, leaf);
    return out.length > 1 ? this.wrap(out, leaf.info, leaf.name) : out;
  }

  /** 原生连线 + 标签 */
  private edgePens(leaf: DrawioLeaf): any[] {
    const e = leaf.edge!;
    const anchors = e.points.map((p) => ({ id: s8(), x: p.x, y: p.y }));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const a of anchors) {
      x0 = Math.min(x0, a.x);
      y0 = Math.min(y0, a.y);
      x1 = Math.max(x1, a.x);
      y1 = Math.max(y1, a.y);
    }
    const pen: any = { id: s8(), x: x0, y: y0, width: Math.max(x1 - x0, 1), height: Math.max(y1 - y0, 1), anchors, lineWidth: e.lineWidth, drawio: { ...leaf.info } };
    e.color && (pen.color = e.color);
    e.dash && (pen.lineDash = e.dash);
    e.alpha !== undefined && (pen.globalAlpha = e.alpha);
    this.adapter.line(pen, leaf.name, { from: e.from, to: e.to, background: e.background });
    this.applyShadow([pen], leaf);
    this.lines.push({ pen, source: e.source, target: e.target });
    const out = [pen];
    for (const l of leaf.labels) {
      const spec = labelSpec(l);
      const at = nearestOnPolyline(anchors, spec.x + spec.width / 2, spec.y + spec.height / 2);
      const t = this.adapter.lineLabel(pen, spec, at, { id: s8(), drawio: { ...leaf.info, part: 'label' } });
      t && out.push(t);
    }
    return out;
  }

  /** 连线端点连到源 / 目标顶点：复用端点处已有的锚点，没有时在端点处新建一个 */
  private connectLines() {
    for (const { pen, source, target } of this.lines) {
      const ends: [string | undefined, any][] = [
        [source, pen.anchors[0]],
        [target, pen.anchors[pen.anchors.length - 1]],
      ];
      for (const [id, la] of ends) {
        const node = id !== undefined ? this.hosts.get(id) : undefined;
        if (!node || !la) continue;
        node.anchors = node.anchors || [];
        let anchor = node.anchors.find((a: any) => Math.hypot(a.x - la.x, a.y - la.y) < 0.5);
        if (!anchor) {
          anchor = { id: s8(), x: la.x, y: la.y };
          node.anchors.push(anchor);
        }
        this.adapter.connect(pen, la, node, anchor);
      }
    }
  }

  private vectorPen(items: VectorItem[], leaf: DrawioLeaf, box?: DrawioLeaf['box']) {
    if (!items.length) return undefined;
    const geom = createGeom(items);
    // 顶点：几何框取单元格框（图元框、旋转中心与 draw.io 一致，超出框的描边照常绘制）
    if (box && box.w > 0 && box.h > 0) geom.bbox = { x: box.x, y: box.y, width: box.w, height: box.h };
    const { bbox } = geom;
    if (!Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) || !(bbox.width >= 0 && bbox.height >= 0)) return undefined;
    const pen: any = {
      id: s8(),
      ...penRectOfGeom(bbox),
      vector: geom,
      disableAnchor: true,
      anchors: [] as any[],
      drawio: { ...leaf.info },
    };
    this.adapter.vector(pen, leaf.name);
    return pen;
  }

  /**
   * 颜色、线宽交给图元属性（'$fg' / '$bg' / '$lw'），属性面板可改：
   * 所有描边同色 → pen.color；所有填充同色 → pen.background（与描边同色的填充如箭头跟随 pen.color）；
   * 线宽相同 → pen.lineWidth；唯一的渐变填充 → 图元渐变
   */
  private bindStyle(pen: any, leaf: DrawioLeaf, keepStroke = false) {
    const paths = (pen.vector.items as VectorItem[]).map((it, i) => ({ it, i })).filter((x) => x.it.t === 'p') as { it: VectorPathItem; i: number }[];
    if (!paths.length) return;
    paths.forEach((x) => (x.it.s = { ...(x.it.s || {}) }));
    const stroked = paths.filter((x) => x.it.s.stroke && x.it.s.stroke !== 'none');
    const s0 = stroked[0]?.it.s.stroke;
    const sameStroke = !keepStroke && isFixed(s0) && stroked.every((x) => x.it.s.stroke === s0);
    const filled = paths.filter((x) => x.it.s.fill && x.it.s.fill !== 'none');
    if (sameStroke) {
      pen.color = s0;
      stroked.forEach((x) => (x.it.s.stroke = '$fg'));
      filled.forEach((x) => x.it.s.fill === s0 && (x.it.s.fill = '$fg'));
    }
    const lw0 = stroked[0]?.it.s.lw;
    if (!stroked.length) pen.lineWidth = 0;
    else if (typeof lw0 === 'number' && stroked.every((x) => x.it.s.lw === lw0)) {
      pen.lineWidth = lw0;
      stroked.forEach((x) => (x.it.s.lw = '$lw'));
    }
    const fills = filled.filter((x) => x.it.s.fill !== '$fg');
    if (!fills.length) return;
    const f0 = fills[0].it.s.fill;
    if (isGradient(f0)) {
      const g = fills.length === 1 ? leaf.grads[fills[0].i] : undefined;
      if (g) {
        this.adapter.gradient(pen, g);
        fills[0].it.s.fill = '$bg';
      }
    } else if (isFixed(f0) && fills.every((x) => x.it.s.fill === f0)) {
      pen.background = f0;
      fills.forEach((x) => (x.it.s.fill = '$bg'));
    }
  }

  private applyShadow(pens: any[], leaf: DrawioLeaf) {
    if (!leaf.shadow) return;
    const k = this.opts.scale > 0 ? this.opts.scale : 1;
    for (const p of pens) {
      if (p.parentId) continue;
      p.shadowColor = 'rgba(0,0,0,0.25)';
      p.shadowBlur = 3 * k;
      p.shadowOffsetX = 2 * k;
      p.shadowOffsetY = 3 * k;
    }
  }

  private pageBackground(bg: NonNullable<DrawioTree['pageBackgrounds'][number]>, page: number, name?: string) {
    const d = [0, bg.x, bg.y, 1, bg.x + bg.width, bg.y, 1, bg.x + bg.width, bg.y + bg.height, 1, bg.x, bg.y + bg.height, 4];
    const pen = this.vectorPen([{ t: 'p', d, s: { fill: '$bg', stroke: 'none' } }], {
      kind: 'leaf',
      info: { page, type: 'page', part: 'page' },
      name: name || 'page',
      items: [],
      grads: [],
      rotate: 0,
      labels: [],
    })!;
    pen.background = bg.color;
    pen.lineWidth = 0;
    return pen;
  }
}

/** 标签 → 独立文字图元：文字框中心经标签矩阵变换到页面，角度取矩阵的旋转 */
function labelSpec(l: DrawioLabel): TextSpec {
  const [cx, cy] = applyMatrix(l.m, l.x + l.width / 2, l.y + l.height / 2);
  const spec: TextSpec = { ...l.style, x: cx - l.width / 2, y: cy - l.height / 2, width: l.width, height: l.height };
  const r = (Math.atan2(l.m[1], l.m[0]) * 180) / Math.PI;
  Math.abs(r) > 1e-3 && (spec.rotate = r);
  return spec;
}

/** 单元格框内的图片项 → 原生图片 */
function imageSpec(item: VectorImageItem, leaf: DrawioLeaf): ImageSpec | undefined {
  const { x, y, w, h } = leaf.box!;
  if (!(w > 0 && h > 0)) return undefined;
  const m = item.m;
  if (Math.abs(Math.abs(m[0]) - w) > 1e-6 || Math.abs(Math.abs(m[3]) - h) > 1e-6 || m[1] || m[2]) return undefined;
  const spec: ImageSpec = { x, y, width: w, height: h, src: item.src };
  item.fit === 'contain' && (spec.contain = true);
  item.alpha !== undefined && item.alpha < 1 && (spec.alpha = item.alpha);
  m[0] < 0 && (spec.flipX = true);
  m[3] < 0 && (spec.flipY = true);
  return spec;
}

/** 四边中点锚点（画布绝对坐标，已按图元旋转） */
function sideAnchors(pen: any) {
  const cx = pen.x + pen.width / 2;
  const cy = pen.y + pen.height / 2;
  const rad = ((pen.rotate || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [0.5, 0],
    [1, 0.5],
    [0.5, 1],
    [0, 0.5],
  ].map(([u, v]) => {
    const dx = (u - 0.5) * pen.width;
    const dy = (v - 0.5) * pen.height;
    return { id: s8(), x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  });
}

/** 点在折线上的最近位置：第几段、段内比例 */
function nearestOnPolyline(pts: { x: number; y: number }[], x: number, y: number) {
  let best = { segment: 0, position: 0.5, d: Infinity };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1e-12;
    const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    const d = Math.hypot(a.x + dx * u - x, a.y + dy * u - y);
    d < best.d && (best = { segment: i, position: u, d });
  }
  return { segment: best.segment, position: best.position };
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
