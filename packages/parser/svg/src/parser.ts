import { createGeom, isGradient, type VectorImageItem, type VectorItem, type VectorPathItem } from '@drawir/core';
import type { RelGradient } from './gradient';
import { SvgToIR, resolveOptions, type PenGradient, type ResolvedOptions, type SvgLeaf, type SvgTree, type SvgUnit } from './ir';
import { textSpecOfItem, type TextSpec } from './text';
import type { SvgDocument, SvgParseOptions, SvgPenInfo } from './types';
import { penRectOfGeom, s8 } from './util';

export interface ImageSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 角度（度，顺时针） */
  rotate?: number;
  src: string;
  alpha?: number;
  radius?: number;
  contain?: boolean;
}

/** 版本适配层：坐标一律为画布绝对坐标；1.x 的相对坐标在 finish 中换算 */
export interface SvgPenAdapter {
  vector(pen: any, label: string | undefined): void;
  text(spec: TextSpec, opts: { id: string; label?: string; svg: SvgPenInfo }): any;
  image(spec: ImageSpec, opts: { id: string; label?: string; svg: SvgPenInfo }): any;
  gradient(pen: any, g: RelGradient): void;
  group(g: { id: string; label?: string; svg: SvgPenInfo; x: number; y: number; width: number; height: number }, children: any[]): any[];
  finish?(pens: any[]): void;
}

const isFixed = (c: unknown): c is string => typeof c === 'string' && !!c && c !== 'none' && c[0] !== '$';

export class SvgConverter {
  private opts: ResolvedOptions;

  constructor(
    options: SvgParseOptions = {},
    private adapter: SvgPenAdapter,
  ) {
    this.opts = resolveOptions(options);
  }

  convert(data: Uint8Array | string): SvgDocument {
    return this.convertTree(new SvgToIR(this.opts).build(data));
  }

  convertTree(tree: SvgTree): SvgDocument {
    const t0 = now();
    const pens: any[] = [];
    for (const units of tree.pages) for (const u of units) pens.push(...this.emit(u));
    this.adapter.finish?.(pens);
    const { stats, pageList } = tree;
    stats.pens = pens.length;
    stats.ms += Math.round(now() - t0);
    const last = pageList[pageList.length - 1];
    const doc: SvgDocument = {
      pens,
      vectors: tree.vectors,
      width: last ? last.x + last.width - this.opts.origin.x : 0,
      height: Math.max(0, ...pageList.map((p) => p.height)),
      pageList,
      stats,
    };
    tree.background && (doc.background = tree.background);
    return doc;
  }

  private emit(u: SvgUnit): any[] {
    if (u.kind === 'leaf') return this.leaf(u);
    return this.wrap(
      u.children.flatMap((c) => this.emit(c)),
      u.info,
      u.name,
    );
  }

  /** 直接子图元 ≥ 2 才组合 */
  private wrap(all: any[], info: SvgPenInfo, name?: string): any[] {
    const direct = all.filter((p) => !p.parentId);
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
    const [group] = this.adapter.group({ id: s8(), label: name, svg: { ...info }, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, direct);
    return [group, ...all];
  }

  private leaf(leaf: SvgLeaf): any[] {
    if (!this.opts.editable) {
      const pen = this.vectorPen(leaf.items, leaf);
      return pen ? this.shadow([pen], leaf) : [];
    }
    const out: any[] = [];
    let run: number[] = [];
    const flush = () => {
      if (!run.length) return;
      const pen = this.vectorPen(
        run.map((i) => leaf.items[i]),
        leaf,
      );
      if (pen) {
        this.bindStyle(
          pen,
          run.map((i) => leaf.grads[i]),
        );
        out.push(pen);
      }
      run = [];
    };
    leaf.items.forEach((item, i) => {
      if (item.t === 't') {
        if (!item.text || !(item.h > 0)) return;
        flush();
        out.push(this.adapter.text(textSpecOfItem(item), { id: s8(), label: leaf.name, svg: { ...leaf.info, part: 'label' } }));
        return;
      }
      if (item.t === 'i') {
        const spec = imageSpec(item);
        if (spec) {
          flush();
          out.push(this.adapter.image(spec, { id: s8(), label: leaf.name, svg: { ...leaf.info, part: 'image' } }));
          return;
        }
      }
      run.push(i);
    });
    flush();
    this.shadow(out, leaf);
    return out.length > 1 ? this.wrap(out, leaf.info, leaf.name) : out;
  }

  private vectorPen(items: VectorItem[], leaf: SvgLeaf) {
    if (!items.length) return undefined;
    const geom = createGeom(items);
    const { bbox } = geom;
    if (!Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) || !(bbox.width >= 0 && bbox.height >= 0)) return undefined;
    const pen: any = { id: s8(), ...penRectOfGeom(bbox), vector: geom, disableAnchor: true, anchors: [] as any[], svg: { ...leaf.info } };
    this.adapter.vector(pen, leaf.name);
    return pen;
  }

  /** 同色描边 → pen.color + '$fg'；同色填充 → pen.background + '$bg'；同线宽 → pen.lineWidth + '$lw'；唯一渐变 → 图元渐变 */
  private bindStyle(pen: any, grads: (PenGradient | undefined)[]) {
    const all = pen.vector.items as VectorItem[];
    const paths = all.map((it, i) => ({ it, i })).filter((x) => x.it.t === 'p') as { it: VectorPathItem; i: number }[];
    if (!paths.length || paths.length !== all.length) return; // 混有裁剪 / 文字 / 图片时不绑定
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
      const g = fills.length === 1 ? grads[fills[0].i] : undefined;
      if (g && pen.width > 0 && pen.height > 0) {
        this.adapter.gradient(pen, {
          ...g,
          x0: (g.x0 - pen.x) / pen.width,
          y0: (g.y0 - pen.y) / pen.height,
          x1: (g.x1 - pen.x) / pen.width,
          y1: (g.y1 - pen.y) / pen.height,
        });
        fills[0].it.s.fill = '$bg';
      }
    } else if (isFixed(f0) && fills.every((x) => x.it.s.fill === f0)) {
      pen.background = f0;
      fills.forEach((x) => (x.it.s.fill = '$bg'));
    }
  }

  private shadow(pens: any[], leaf: SvgLeaf) {
    const sh = leaf.shadow;
    if (sh) for (const p of pens) if (!p.parentId) Object.assign(p, { shadowColor: sh.color, shadowBlur: sh.blur, shadowOffsetX: sh.x, shadowOffsetY: sh.y });
    return pens;
  }
}

/** 无斜切、无镜像、非 cover 的图片 → 原生图片 */
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
  item.alpha !== undefined && item.alpha < 1 && (spec.alpha = item.alpha);
  item.radius > 0 && (spec.radius = item.radius);
  item.fit === 'contain' && (spec.contain = true);
  return spec;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
