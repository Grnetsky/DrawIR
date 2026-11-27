import { IDENTITY, VectorPathBuilder, createGeom, pathItem, type VectorItem, type VectorPathItem } from '@drawir/core';
import { GenCADToIR, resolveOptions, type GenCADEdge, type GenCADLeaf, type GenCADTextBox, type GenCADTree, type GenCADUnit, type ResolvedOptions } from './ir';
import type { GenCADDocument, GenCADParseOptions, GenCADPenInfo } from './types';
import { penRectOfGeom, s8 } from './util';

export interface TextSpec extends GenCADTextBox {
  text: string;
  fontSize: number;
  color?: string;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
}

export interface LineSpec {
  pixelWidth?: boolean;
}

/** 坐标一律为画布绝对坐标；1.x 的相对坐标在 finish 中换算 */
export interface GenCADPenAdapter {
  vector(pen: any, label: string | undefined): void;
  line(pen: any, label: string | undefined, spec: LineSpec): void;
  text(spec: TextSpec, opts: { id: string; label?: string; gencad: GenCADPenInfo }): any;
  group(g: { id: string; label?: string; gencad: GenCADPenInfo; x: number; y: number; width: number; height: number }, children: any[]): any[];
  connect(line: any, lineAnchor: any, node: any, anchor: any): void;
  isLine(pen: any): boolean;
  finish?(pens: any[]): void;
}

const isFixed = (c: unknown): c is string => typeof c === 'string' && !!c && c !== 'none' && c[0] !== '$';

export class GenCADConverter {
  private opts: ResolvedOptions;
  private hosts = new Map<string, any>();
  private lines: { pen: any; source?: string; target?: string }[] = [];

  constructor(options: GenCADParseOptions = {}, private adapter: GenCADPenAdapter) {
    this.opts = resolveOptions(options);
  }

  convert(data: Uint8Array | string): GenCADDocument {
    return this.convertTree(new GenCADToIR(this.opts).build(data));
  }

  convertTree(tree: GenCADTree): GenCADDocument {
    const t0 = now();
    const pens: any[] = [];
    for (const units of tree.pages) {
      this.hosts.clear();
      this.lines = [];
      for (const u of units) pens.push(...this.emit(u));
      this.connectLines();
    }
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
      background: tree.background,
      header: tree.header,
      layers: tree.layers,
    };
  }

  private emit(u: GenCADUnit): any[] {
    if (u.kind === 'leaf') return this.leaf(u);
    return this.wrap(u.children.flatMap((c) => this.emit(c)), u.info, u.name);
  }

  private wrap(all: any[], info: GenCADPenInfo, name?: string): any[] {
    const direct = all.filter((p) => !p.parentId && !this.adapter.isLine(p));
    if (direct.length < 2 || !this.opts.group) return all;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of direct) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.width);
      y1 = Math.max(y1, p.y + p.height);
    }
    const [group] = this.adapter.group({ id: s8(), label: name, gencad: { ...info }, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, direct);
    return [group, ...all];
  }

  private leaf(leaf: GenCADLeaf): any[] {
    if (!this.opts.editable) {
      const items = leaf.edge ? [...leaf.items, edgeVectorItem(leaf.edge)] : leaf.items;
      const pen = this.vectorPen(items, leaf);
      if (pen) {
        this.bindStyle(pen);
        this.registerHost(pen, leaf);
      }
      return pen ? [pen] : [];
    }
    if (leaf.edge?.native && leaf.edge.points.length > 1) return this.edgePens(leaf);
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
    leaf.items.forEach((item, i) => {
      if (item.t === 't') {
        flush();
        const box = leaf.boxes[i];
        if (!box) return;
        out.push(this.adapter.text({
          ...box, text: item.text, fontSize: item.h,
          color: item.fill && item.fill !== 'none' && item.fill[0] !== '$' ? item.fill : undefined,
          fontFamily: item.font, bold: item.bold, italic: item.italic,
        }, { id: s8(), label: leaf.name, gencad: { ...leaf.info, part: 'label' } }));
      } else run.push(item);
    });
    flush();
    const host = out.find((p) => p.vector);
    host && this.registerHost(host, leaf);
    return out;
  }

  private registerHost(pen: any, leaf: GenCADLeaf) {
    if (leaf.anchors?.length) {
      delete pen.disableAnchor;
      pen.anchors = leaf.anchors;
    }
    leaf.info.id && this.hosts.set(leaf.info.id, pen);
  }

  private vectorPen(items: VectorItem[], leaf: GenCADLeaf) {
    if (!items.length) return undefined;
    const geom = createGeom(items);
    const { bbox } = geom;
    if (!Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) || !(bbox.width >= 0 && bbox.height >= 0)) return undefined;
    const pen: any = { id: s8(), ...penRectOfGeom(bbox), vector: geom, disableAnchor: true, anchors: [] as any[], gencad: { ...leaf.info } };
    this.adapter.vector(pen, leaf.name);
    return pen;
  }

  private bindStyle(pen: any) {
    const paths = (pen.vector.items as VectorItem[]).filter((it): it is VectorPathItem => it.t === 'p');
    if (!paths.length || paths.length !== pen.vector.items.length) return;
    paths.forEach((p) => (p.s = { ...(p.s || {}) }));
    const stroked = paths.filter((p) => p.s.stroke && p.s.stroke !== 'none');
    const stroke = stroked[0]?.s.stroke;
    if (isFixed(stroke) && stroked.every((p) => p.s.stroke === stroke)) {
      pen.color = stroke;
      stroked.forEach((p) => (p.s.stroke = '$fg'));
    }
    const lw = stroked[0]?.s.lw;
    if (!stroked.length) pen.lineWidth = 0;
    else if (typeof lw === 'number' && stroked.every((p) => p.s.lw === lw)) {
      pen.lineWidth = lw;
      stroked.forEach((p) => (p.s.lw = '$lw'));
    }
    const fills = paths.filter((p) => p.s.fill && p.s.fill !== 'none' && p.s.fill !== '$fg');
    const fill = fills[0]?.s.fill;
    if (isFixed(fill) && fills.every((p) => p.s.fill === fill)) {
      pen.background = fill;
      fills.forEach((p) => (p.s.fill = '$bg'));
    }
  }

  private edgePens(leaf: GenCADLeaf): any[] {
    const e = leaf.edge!;
    const anchors = e.points.map((p) => ({ id: s8(), x: p.x, y: p.y }));
    const xs = anchors.map((a) => a.x);
    const ys = anchors.map((a) => a.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const pen: any = {
      id: s8(), x: x0, y: y0,
      width: Math.max(Math.max(...xs) - x0, 1), height: Math.max(Math.max(...ys) - y0, 1),
      anchors, lineWidth: e.lineWidth, color: e.color, lineCap: 'round', gencad: { ...leaf.info },
    };
    this.adapter.line(pen, leaf.name, { pixelWidth: e.pixelWidth });
    this.lines.push({ pen, source: e.source, target: e.target });
    return [pen];
  }

  private connectLines() {
    for (const { pen, source, target } of this.lines) {
      const ends: [string | undefined, any][] = [[source, pen.anchors[0]], [target, pen.anchors[pen.anchors.length - 1]]];
      for (const [id, la] of ends) {
        const node = id !== undefined ? this.hosts.get(id) : undefined;
        if (!node || !la || node === pen) continue;
        node.anchors = node.anchors || [];
        let anchor = node.anchors.find((a: any) => Math.hypot(a.x - la.x, a.y - la.y) < 0.5);
        if (!anchor) node.anchors.push((anchor = { id: s8(), x: la.x, y: la.y }));
        delete node.disableAnchor;
        this.adapter.connect(pen, la, node, anchor);
      }
    }
  }
}

function edgeVectorItem(edge: GenCADEdge): VectorItem {
  const b = new VectorPathBuilder(IDENTITY);
  edge.points.forEach((p, i) => i ? b.lineTo(p.x, p.y) : b.moveTo(p.x, p.y));
  const style = edge.pixelWidth ? { stroke: edge.color, px: edge.lineWidth, cap: 'round' as const } : { stroke: edge.color, lw: edge.lineWidth, cap: 'round' as const };
  return pathItem(b.d, style);
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
