import { createGeom, isGradient, type VectorImageItem, type VectorItem, type VectorPathItem } from '@drawir/core';
import { penGradient, unrotateGradient, type PenGradient } from './gradient';
import { resolveOptions, SketchToIR, type ResolvedOptions, type SketchEdge, type SketchLeaf, type SketchShadow, type SketchTree, type SketchUnit } from './ir';
import { textSpecOfBox, textSpecOfItem, type TextSpec } from './text';
import type { SketchDocument, SketchParseOptions, SketchPenInfo } from './types';
import { penRectOfGeom, s8 } from './util';

/** 原生图片图元的描述（与 meta2d 版本无关） */
export interface ImageSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate?: number;
  src: string;
  alpha?: number;
  radius?: number;
  /** 等比完整显示 */
  contain?: boolean;
}

/** 原生连线的箭头 */
export interface LineSpec {
  from?: SketchEdge['from'];
  to?: SketchEdge['from'];
}

/** 把通用图元转成某个 meta2d 版本的图元格式。坐标一律为画布绝对坐标，1.x 的相对坐标在 finish 中换算 */
export interface SketchPenAdapter {
  /** 矢量图元（pen.vector 已就绪）：补上图元类型 */
  vector(pen: any, label: string | undefined): void;
  /** 原生连线（pen.anchors 为折点，绝对坐标） */
  line(pen: any, label: string | undefined, spec: LineSpec): void;
  text(spec: TextSpec, opts: { id: string; label?: string; sketch: SketchPenInfo; gradient?: PenGradient }): any;
  image(spec: ImageSpec, opts: { id: string; label?: string; sketch: SketchPenInfo }): any;
  /** 填充渐变（pen.vector 中的 '$bg' 填充跟随图元背景） */
  gradient(pen: any, g: PenGradient): void;
  /** children 为直接子图元（绝对坐标），返回 [父, ...子] */
  group(group: { id: string; label?: string; sketch: SketchPenInfo; x: number; y: number; width: number; height: number }, children: any[]): any[];
  isLine(pen: any): boolean;
  /** 全部图元生成后调用（1.x 换算相对坐标） */
  finish?(pens: any[]): void;
}

const isFixed = (c: unknown): c is string => typeof c === 'string' && !!c && c !== 'none' && c[0] !== '$';

/**
 * Sketch → meta2d 图元。
 *
 * 遍历和几何由 SketchToIR 完成（得到每个图元的 Vector IR 项）；这里按 editable 把 IR 项分成：
 * - 文字项 → 原生文字图元（按 Sketch 文字框生成，对齐、行高、换行一致）；
 * - 无斜切、无镜像、非裁剪的图片项 → 原生图片图元；
 * - 可映射的直线 / 折线 → 原生连线；
 * - 其余连续的路径 / 图片项 → 一个矢量图元；填充、描边、线宽、渐变尽量绑定到图元属性。
 * 一个 Sketch 图层拆出多个图元时组成组合；Group / Frame / 组件实例按层级组合。
 */
export class SketchConverter {
  private opts: ResolvedOptions;

  constructor(options: SketchParseOptions = {}, private adapter: SketchPenAdapter) {
    this.opts = resolveOptions(options);
  }

  convert(data: Uint8Array): SketchDocument {
    return this.convertTree(new SketchToIR(this.opts).build(data));
  }

  convertTree(tree: SketchTree): SketchDocument {
    const t0 = now();
    const pens: any[] = [];
    for (const units of tree.pages) for (const u of units) pens.push(...this.emitUnit(u));
    this.adapter.finish?.(pens);
    const { stats, pageList } = tree;
    stats.pens = pens.length;
    stats.ms += Math.round(now() - t0);
    const last = pageList[pageList.length - 1];
    return {
      pens,
      vectors: {},
      width: last ? last.x + last.width - (this.opts.origin?.x || 0) : 0,
      height: Math.max(0, ...pageList.map((p) => p.height)),
      pageList,
      stats,
    };
  }

  /** 单个 IR 单元 → 图元，供蓝图等增量生成场景复用 */
  emitUnit(u: SketchUnit): any[] {
    if (u.kind === 'leaf') return this.leaf(u);
    return this.wrap(
      u.children.flatMap((c) => this.emitUnit(c)),
      u.info,
    );
  }

  /** 组合：all 中没有 parentId 的是直接子图元；连线不进组合；直接子图元 ≥ 2 才组合 */
  private wrap(all: any[], info: SketchPenInfo): any[] {
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
    const [group] = this.adapter.group({ id: s8(), label: info.name, sketch: { ...info }, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, direct);
    return [group, ...all];
  }

  private leaf(leaf: SketchLeaf): any[] {
    const label = leaf.info.name;
    const out: any[] = [];
    if (!this.opts.editable) {
      const pen = this.vectorPen(leaf.items, label, leaf.info);
      pen && out.push(pen);
      this.applyShadow(out, leaf.shadow);
      return out;
    }
    const e = leaf.edge;
    if (e?.native && e.points.length > 1 && e.span === leaf.items.length) return this.applyShadow([this.edgePen(e, leaf)], leaf.shadow);
    let run: number[] = [];
    const flush = () => {
      if (!run.length) return;
      const items = run.map((i) => leaf.items[i]);
      const pen = this.vectorPen(items, label, leaf.info);
      if (pen) {
        this.bindStyle(pen, run.map((i) => leaf.grads[i]));
        out.push(pen);
      }
      run = [];
    };
    leaf.items.forEach((item, i) => {
      if (item.t === 't') {
        if (!item.text || !(item.h > 0)) return;
        flush();
        const box = leaf.boxes[i];
        const spec = box ? textSpecOfBox(item, box) : textSpecOfItem(item);
        const g = leaf.grads[i] && penGradient(unrotateGradient(leaf.grads[i]!, spec), spec);
        out.push(this.adapter.text(spec, { id: s8(), label, sketch: { ...leaf.info }, gradient: g }));
        return;
      }
      if (item.t === 'i') {
        const spec = imageSpec(item);
        if (spec) {
          flush();
          out.push(this.adapter.image(spec, { id: s8(), label, sketch: { ...leaf.info, part: leaf.info.part || 'image' } }));
          return;
        }
      }
      run.push(i);
    });
    flush();
    this.applyShadow(out, leaf.shadow);
    return out.length > 1 ? this.wrap(out, leaf.info) : out;
  }

  private vectorPen(items: VectorItem[], label: string | undefined, info: SketchPenInfo) {
    if (!items.length) return undefined;
    const geom = createGeom(items);
    const { bbox } = geom;
    if (!Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) || !(bbox.width >= 0 && bbox.height >= 0)) return undefined;
    const pen: any = {
      id: s8(),
      ...penRectOfGeom(bbox),
      vector: geom,
      // 矢量图元不显示锚点、不做连线吸附
      disableAnchor: true,
      anchors: [] as any[],
      sketch: { ...info },
    };
    this.adapter.vector(pen, label);
    return pen;
  }

  /**
   * 颜色、线宽、渐变交给图元属性（属性面板可改）：
   * 同色描边 → pen.color + '$fg'；同线宽 → pen.lineWidth + '$lw'；只填充 → lineWidth 0；
   * 同色填充 → pen.background + '$bg'；唯一的渐变填充 → 图元渐变 + '$bg'。混有图片 / 裁剪项时不绑定
   */
  private bindStyle(pen: any, grads: (SketchLeaf['grads'][number])[]) {
    const items = pen.vector.items as VectorItem[];
    if (!items.length || items.some((it) => it.t !== 'p')) return;
    const paths = items.map((it, i) => ({ it: it as VectorPathItem, i }));
    paths.forEach((x) => (x.it.s = { ...(x.it.s || {}) }));
    const stroked = paths.filter((x) => x.it.s.stroke && x.it.s.stroke !== 'none');
    const s0 = stroked[0]?.it.s.stroke;
    if (isFixed(s0) && stroked.every((x) => x.it.s.stroke === s0)) {
      pen.color = s0;
      stroked.forEach((x) => (x.it.s.stroke = '$fg'));
    }
    const lw0 = stroked[0]?.it.s.lw;
    if (!stroked.length) pen.lineWidth = 0;
    else if (typeof lw0 === 'number' && stroked.every((x) => x.it.s.lw === lw0)) {
      pen.lineWidth = lw0;
      stroked.forEach((x) => (x.it.s.lw = '$lw'));
    }
    const fills = paths.filter((x) => x.it.s.fill && x.it.s.fill !== 'none' && x.it.s.fill !== '$fg');
    if (!fills.length) return;
    const f0 = fills[0].it.s.fill;
    if (isGradient(f0)) {
      const sg = fills.length === 1 ? grads[fills[0].i] : undefined;
      const g = sg && penGradient(sg, pen);
      if (g) {
        this.adapter.gradient(pen, g);
        fills[0].it.s.fill = '$bg';
      }
    } else if (isFixed(f0) && fills.every((x) => x.it.s.fill === f0)) {
      pen.background = f0;
      fills.forEach((x) => (x.it.s.fill = '$bg'));
    }
  }

  private edgePen(e: SketchEdge, leaf: SketchLeaf): any {
    const anchors = e.points.map((p) => ({ id: s8(), x: p.x, y: p.y }));
    const xs = anchors.map((a) => a.x);
    const ys = anchors.map((a) => a.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const pen: any = {
      id: s8(),
      x: x0,
      y: y0,
      width: Math.max(Math.max(...xs) - x0, 1),
      height: Math.max(Math.max(...ys) - y0, 1),
      anchors,
      lineWidth: e.lineWidth,
      sketch: { ...leaf.info },
    };
    e.color && (pen.color = e.color);
    e.dash && (pen.lineDash = e.dash);
    this.adapter.line(pen, leaf.info.name, { from: e.from, to: e.to });
    return pen;
  }

  private applyShadow(pens: any[], sh: SketchShadow | undefined) {
    if (!sh) return pens;
    for (const p of pens) {
      if (p.parentId) continue;
      p.shadowColor = sh.color;
      p.shadowBlur = sh.blur;
      p.shadowOffsetX = sh.x;
      p.shadowOffsetY = sh.y;
    }
    return pens;
  }
}

/** 能用原生图片图元表示的图片项（无斜切、无镜像、非铺满裁剪），否则返回 undefined，留在矢量图元里绘制 */
function imageSpec(item: VectorImageItem): ImageSpec | undefined {
  const m = item.m;
  const w = Math.hypot(m[0], m[1]);
  const h = Math.hypot(m[2], m[3]);
  if (!(w > 0 && h > 0) || item.fit === 'cover') return undefined;
  if (Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-6 * w * h || m[0] * m[3] - m[1] * m[2] <= 0) return undefined;
  const cx = m[4] + (m[0] + m[2]) / 2;
  const cy = m[5] + (m[1] + m[3]) / 2;
  const spec: ImageSpec = { x: cx - w / 2, y: cy - h / 2, width: w, height: h, src: item.src };
  const r = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  Math.abs(r) > 1e-3 && (spec.rotate = r);
  item.alpha != undefined && item.alpha < 1 && (spec.alpha = item.alpha);
  item.radius > 0 && (spec.radius = item.radius);
  item.fit === 'contain' && (spec.contain = true);
  return spec;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
