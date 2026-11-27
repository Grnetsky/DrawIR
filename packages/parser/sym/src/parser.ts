import { applyMatrix, createGeom, estimateTextWidth, type VectorItem, type VectorPathItem } from '@drawir/core';
import { resolveOptions, SymToIR, type ResolvedOptions, type SymLeaf, type SymTree, type SymUnit } from './ir';
import type { SymDocument, SymParseOptions, SymPenInfo } from './types';
import { penRectOfGeom, s8 } from './util';

export interface TextSpec {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotate?: number;
  fontSize: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  wrap: boolean;
  color?: string;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
}

export interface SymPenAdapter {
  vector(pen: any, label: string | undefined): void;
  text(spec: TextSpec, opts: { id: string; label?: string; sym: SymPenInfo }): any;
  group(g: { id: string; label?: string; sym: SymPenInfo; x: number; y: number; width: number; height: number }, children: any[]): any[];
  finish?(pens: any[]): void;
}

const isFixed = (c: unknown): c is string => typeof c === 'string' && !!c && c !== 'none' && c[0] !== '$';

export class SymConverter {
  private opts: ResolvedOptions;

  constructor(options: SymParseOptions = {}, private adapter: SymPenAdapter) {
    this.opts = resolveOptions(options);
  }

  convert(data: Uint8Array): SymDocument {
    return this.convertTree(new SymToIR(this.opts).build(data));
  }

  convertTree(tree: SymTree): SymDocument {
    const t0 = now();
    const pens = tree.pages.flatMap((units) => units.flatMap((u) => this.emit(u)));
    this.adapter.finish?.(pens);
    const { stats, pageList } = tree;
    stats.pens = pens.length;
    stats.ms += Math.round(now() - t0);
    const last = pageList[pageList.length - 1];
    return {
      pens,
      vectors: {},
      width: last ? last.x + last.width - this.opts.origin.x : 0,
      height: Math.max(0, ...pageList.map((p) => p.height)),
      pageList,
      stats,
    };
  }

  private emit(u: SymUnit): any[] {
    if (u.kind === 'leaf') return this.leaf(u);
    return this.wrap(u.children.flatMap((c) => this.emit(c)), u.info, u.name);
  }

  private wrap(all: any[], info: SymPenInfo, name?: string): any[] {
    const direct = all.filter((p) => !p.parentId);
    if (direct.length < 2 || !this.opts.group) return all;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of direct) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.width);
      y1 = Math.max(y1, p.y + p.height);
    }
    const [group] = this.adapter.group({ id: s8(), label: name, sym: { ...info }, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, direct);
    return [group, ...all];
  }

  private leaf(leaf: SymLeaf): any[] {
    if (!this.opts.editable) {
      const pen = this.vectorPen(leaf.items, leaf);
      return pen ? [pen] : [];
    }
    const out: any[] = [];
    let run: VectorItem[] = [];
    const flush = () => {
      if (!run.length) return;
      const pen = this.vectorPen(run, leaf);
      if (pen) {
        this.bindStyle(pen);
        out.push(pen);
      }
      run = [];
    };
    for (const item of leaf.items) {
      if (item.t === 't') {
        if (!item.text || !(item.h > 0)) continue;
        flush();
        out.push(this.adapter.text(textSpec(item), { id: s8(), label: leaf.name, sym: { ...leaf.info, part: 'label' } }));
      } else {
        run.push(item);
      }
    }
    flush();
    return out.length > 1 ? this.wrap(out, leaf.info, leaf.name) : out;
  }

  private vectorPen(items: VectorItem[], leaf: SymLeaf) {
    if (!items.length) return undefined;
    const vector = createGeom(items);
    const { bbox } = vector;
    if (!Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) || !(bbox.width >= 0 && bbox.height >= 0)) return undefined;
    const pen: any = { id: s8(), ...penRectOfGeom(bbox), vector, disableAnchor: true, anchors: [] as any[], sym: { ...leaf.info } };
    this.adapter.vector(pen, leaf.name);
    return pen;
  }

  private bindStyle(pen: any) {
    const paths = (pen.vector.items as VectorItem[]).filter((it): it is VectorPathItem => it.t === 'p');
    if (!paths.length || paths.length !== pen.vector.items.length) return;
    paths.forEach((it) => (it.s = { ...(it.s || {}) }));
    const stroked = paths.filter((it) => it.s.stroke && it.s.stroke !== 'none');
    const stroke = stroked[0]?.s.stroke;
    if (isFixed(stroke) && stroked.every((it) => it.s.stroke === stroke)) {
      pen.color = stroke;
      stroked.forEach((it) => (it.s.stroke = '$fg'));
    }
    const lineWidth = stroked[0]?.s.lw;
    if (!stroked.length) pen.lineWidth = 0;
    else if (typeof lineWidth === 'number' && stroked.every((it) => it.s.lw === lineWidth)) {
      pen.lineWidth = lineWidth;
      stroked.forEach((it) => (it.s.lw = '$lw'));
    }
    const fills = paths.filter((it) => it.s.fill && it.s.fill !== 'none' && it.s.fill !== '$fg');
    const fill = fills[0]?.s.fill;
    if (isFixed(fill) && fills.every((it) => it.s.fill === fill)) {
      pen.background = fill;
      fills.forEach((it) => (it.s.fill = '$bg'));
    }
  }
}

function textSpec(item: Extract<VectorItem, { t: 't' }>): TextSpec {
  const size = item.h;
  const rows = item.text.split('\n').length;
  const lineHeight = item.lh || 1.5;
  const width = item.bw > 0 ? item.bw : Math.max(estimateTextWidth(item.text, size) * (item.w || 1) * 1.08 + size * 0.2, size);
  const height = size * lineHeight * rows;
  const align = item.a === 'right' || item.a === 'end' ? 'right' : item.a === 'center' ? 'center' : 'left';
  const left = align === 'left' ? 0 : align === 'center' ? -width / 2 : -width;
  const pad = (size * lineHeight - size) / 2;
  const top = item.b === 'middle' ? -height / 2 : item.b === 'bottom' || item.b === 'ideographic' ? -height + pad : item.b === 'top' || item.b === 'hanging' ? -pad : -pad - size * 0.8;
  const r = item.r || 0;
  const [cx, cy] = applyMatrix([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), item.x, item.y], left + width / 2, top + height / 2);
  const valign = item.b === 'middle' ? 'middle' : item.b === 'bottom' || item.b === 'ideographic' ? 'bottom' : 'top';
  return {
    text: item.text,
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    rotate: r * 180 / Math.PI,
    fontSize: size,
    lineHeight,
    align,
    valign,
    wrap: item.bw > 0,
    color: item.fill && item.fill !== 'none' ? item.fill : undefined,
    fontFamily: item.font,
    bold: item.bold,
    italic: item.italic,
  };
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
