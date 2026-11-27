import { createGeom, type VectorImageItem, type VectorItem, type VectorTextItem } from '@drawir/core';
import { penGradient, type PenGradient } from './gradient';
import { FigmaToIR, resolveOptions, type FigmaLeaf, type FigmaShadow, type FigmaUnit, type ResolvedOptions } from './ir';
import { textSpecOfBox, textSpecOfItem, type TextSpec } from './text';
import type { FigmaDocument, FigmaParseOptions, FigmaPenInfo } from './types';
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

/** 把通用图元转成某个 meta2d 版本的图元格式 */
export interface FigmaPenAdapter {
  /** 矢量图元（pen.vector 已就绪）：补上图元类型 */
  vector(pen: any, label: string | undefined): void;
  text(spec: TextSpec, opts: { id: string; label?: string; figma: FigmaPenInfo; gradient?: PenGradient }): any;
  image(spec: ImageSpec, opts: { id: string; label?: string; figma: FigmaPenInfo }): any;
  /** 填充渐变（pen.vector 中的 '$bg' 填充跟随图元背景） */
  gradient(pen: any, g: PenGradient): void;
  /** children 为直接子图元（绝对坐标），返回 [父, ...子] */
  group(group: { id: string; label?: string; figma: FigmaPenInfo; x: number; y: number; width: number; height: number }, children: any[]): any[];
}

/**
 * Figma .fig → meta2d 图元。
 *
 * 遍历和几何由 FigmaToIR 完成（得到每个图元的 Vector IR 项）；这里按 editable 把 IR 项分成：
 * - 文字项 → 原生文字图元（单一样式的文字节点按 Figma 文字框生成，对齐、行高一致）；
 * - 无斜切、非裁剪的图片项 → 原生图片图元（可替换图片、改圆角）；
 * - 其余连续的路径 / 图片项 → 一个矢量图元；单路径图元的填充、描边、线宽、渐变绑定到图元属性。
 * 一个 Figma 图层拆出多个图元时组成组合；Frame / Group / 组件实例按层级组合。
 */
export class FigmaConverter {
  private opts: ResolvedOptions;

  constructor(options: FigmaParseOptions = {}, private adapter: FigmaPenAdapter) {
    this.opts = resolveOptions(options);
  }

  convert(data: Uint8Array): FigmaDocument {
    const ir = new FigmaToIR(this.opts);
    const tree = ir.build(data);
    const t0 = now();
    const pens: any[] = [];
    for (const units of tree.pages) for (const u of units) pens.push(...this.emit(u));
    const { stats, pageList } = tree;
    stats.pens = pens.length;
    stats.ms += Math.round(now() - t0);
    const last = pageList[pageList.length - 1];
    const doc: FigmaDocument = {
      pens,
      vectors: {},
      width: last ? last.x + last.width - (this.opts.origin?.x || 0) : 0,
      height: Math.max(0, ...pageList.map((p) => p.height)),
      pageList,
      stats,
    };
    const bg = pageList.find((p) => p.background)?.background;
    bg && (doc.background = bg);
    return doc;
  }

  /**
   * 单个 IR 图元树节点 → 图元（顶层图元为绝对坐标，组合子图元为相对比例）。
   * 供只转换部分节点的调用方使用（如原型蓝图按画面生成页面）：先用 FigmaToIR 构建一次，再按节点挑选
   */
  emitUnit(u: FigmaUnit): any[] {
    return this.emit(u);
  }

  private emit(u: FigmaUnit): any[] {
    if (u.kind === 'leaf') return this.leaf(u);
    const all = u.children.flatMap((c) => this.emit(c));
    return this.wrap(all, u.info);
  }

  /** 组合：all 中没有 parentId 的是直接子图元 */
  private wrap(all: any[], info: FigmaPenInfo): any[] {
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
    const [group] = this.adapter.group({ id: s8(), label: info.name, figma: { ...info }, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, direct);
    return [group, ...all];
  }

  private leaf(leaf: FigmaLeaf): any[] {
    const label = leaf.info.name;
    const out: any[] = [];
    if (!this.opts.editable) {
      const pen = this.vectorPen(leaf.items, label, leaf.info);
      pen && out.push(pen);
      this.applyShadow(out, leaf.shadow);
      return out;
    }
    let run: number[] = [];
    const flush = () => {
      if (!run.length) return;
      const items = run.map((i) => leaf.items[i]);
      const pen = this.vectorPen(items, label, leaf.info);
      if (pen) {
        if (items.length === 1 && items[0].t === 'p') this.bindStyle(pen, leaf.grads[run[0]]);
        out.push(pen);
      }
      run = [];
    };
    leaf.items.forEach((item, i) => {
      if (item.t === 't' && this.opts.text === 'text') {
        if (!item.text || !(item.h > 0)) return;
        flush();
        const box = leaf.boxes[i];
        const spec = box ? textSpecOfBox(item, box) : textSpecOfItem(item);
        const g = leaf.grads[i] && penGradient(leaf.grads[i]!, spec);
        out.push(this.adapter.text(spec, { id: s8(), label, figma: { ...leaf.info }, gradient: g }));
        return;
      }
      if (item.t === 'i') {
        const spec = imageSpec(item);
        if (spec) {
          flush();
          out.push(this.adapter.image(spec, { id: s8(), label, figma: { ...leaf.info, part: leaf.info.part || 'image' } }));
          return;
        }
      }
      run.push(i);
    });
    flush();
    this.applyShadow(out, leaf.shadow);
    return out.length > 1 ? this.wrap(out, leaf.info) : out;
  }

  private vectorPen(items: VectorItem[], label: string | undefined, info: FigmaPenInfo) {
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
      figma: { ...info },
    };
    this.adapter.vector(pen, label);
    return pen;
  }

  /** 单路径图元：颜色、线宽、渐变交给图元属性（'$fg' / '$bg' / '$lw'），属性面板可改 */
  private bindStyle(pen: any, grad: FigmaLeaf['grads'][number]) {
    const it = pen.vector.items[0];
    const st = { ...(it.s || {}) };
    const { stroke, fill } = st;
    if (fill && fill !== 'none' && fill !== '$fg' && fill !== '$bg') {
      // 渐变：交给图元的渐变背景（属性面板可改）；换算失败时保留 IR 渐变
      const g = grad && penGradient(grad, pen);
      if (g) {
        this.adapter.gradient(pen, g);
        st.fill = '$bg';
      } else if (typeof fill === 'string') {
        pen.background = fill;
        st.fill = '$bg';
      }
    }
    if (typeof stroke === 'string' && stroke !== 'none') {
      stroke !== '$fg' && (pen.color = stroke);
      delete st.stroke;
      if (typeof st.lw === 'number') {
        pen.lineWidth = st.lw;
        st.lw = '$lw';
      }
    } else {
      // 只填充：图元线宽 0，避免属性面板误以为有边框
      pen.lineWidth = 0;
    }
    it.s = st;
  }

  private applyShadow(pens: any[], sh: FigmaShadow | undefined) {
    if (!sh) return;
    for (const p of pens) {
      if (p.parentId) continue;
      p.shadowColor = sh.color;
      p.shadowBlur = sh.blur;
      p.shadowOffsetX = sh.x;
      p.shadowOffsetY = sh.y;
    }
  }
}

/** 能用原生图片图元表示的图片项（无斜切、无镜像、非裁剪），否则返回 undefined，留在矢量图元里绘制 */
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

export type { VectorTextItem };
