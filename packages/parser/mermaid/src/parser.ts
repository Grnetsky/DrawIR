import { createGeom, type VectorItem, type VectorPathItem } from '@drawir/core';
import { MermaidToIR, labelItems, resolveOptions, type MermaidArrow, type MermaidEdge, type MermaidLabel, type MermaidLeaf, type MermaidTextStyle, type MermaidTree, type MermaidUnit, type ResolvedOptions } from './ir';
import type { MermaidDocument, MermaidParseOptions, MermaidPenInfo } from './types';
import { penRectOfGeom, s8 } from './util';

export interface TextStyle extends MermaidTextStyle {}
export interface TextSpec extends MermaidTextStyle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextRect { x: number; y: number; width: number; height: number }
export interface LineSpec { from?: MermaidArrow; to?: MermaidArrow; background?: string }

/** 通用图元 → 指定 meta2d 版本；Converter 内始终使用画布绝对坐标 */
export interface MermaidPenAdapter {
  vector(pen: any, label: string | undefined): void;
  line(pen: any, label: string | undefined, spec: LineSpec): void;
  text(spec: TextSpec, opts: { id: string; label?: string; mermaid: MermaidPenInfo }): any;
  hostText(pen: any, style: MermaidTextStyle, rect: TextRect): void;
  lineLabel(line: any, spec: TextSpec, at: { segment: number; position: number }, opts: { id: string; mermaid: MermaidPenInfo }): any;
  group(group: { id: string; label?: string; mermaid: MermaidPenInfo; x: number; y: number; width: number; height: number }, children: any[]): any[];
  connect(line: any, lineAnchor: any, node: any, anchor: any): void;
  isLine(pen: any): boolean;
  finish?(pens: any[]): void;
}

const isFixed = (c: unknown): c is string => typeof c === 'string' && !!c && c !== 'none' && c[0] !== '$';

export class MermaidConverter {
  private opts: ResolvedOptions;
  private hosts = new Map<string, any>();
  private lines: { pen: any; source?: string; target?: string }[] = [];

  constructor(options: MermaidParseOptions = {}, private adapter: MermaidPenAdapter) {
    this.opts = resolveOptions(options);
  }

  convert(data: string | Uint8Array): MermaidDocument {
    return this.convertTree(new MermaidToIR(this.opts).build(data));
  }

  convertTree(tree: MermaidTree): MermaidDocument {
    const t0 = now();
    const pens: any[] = [];
    for (const units of tree.pages) {
      this.hosts.clear();
      this.lines = [];
      for (const unit of units) pens.push(...this.emit(unit));
      this.connectLines();
    }
    this.adapter.finish?.(pens);
    const { stats, pageList } = tree;
    stats.pens = pens.length;
    stats.ms += Math.round(now() - t0);
    const last = pageList[pageList.length - 1];
    return { pens, vectors: {}, width: last ? last.x + last.width - this.opts.origin.x : 0, height: Math.max(0, ...pageList.map((p) => p.height)), pageList, stats };
  }

  private emit(unit: MermaidUnit): any[] {
    if (unit.kind === 'leaf') return this.leaf(unit);
    return this.wrap(unit.children.flatMap((child) => this.emit(child)), unit.info, unit.name);
  }

  private wrap(all: any[], info: MermaidPenInfo, name?: string): any[] {
    const direct = all.filter((p) => !p.parentId && !this.adapter.isLine(p));
    if (direct.length < 2 || !this.opts.group) return all;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of direct) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.width); y1 = Math.max(y1, p.y + p.height);
    }
    const [group] = this.adapter.group({ id: s8(), label: name, mermaid: { ...info }, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, direct);
    return [group, ...all];
  }

  private leaf(leaf: MermaidLeaf): any[] {
    if (!this.opts.editable) {
      const pen = this.vectorPen([...leaf.items, ...leaf.labels.flatMap(labelItems)], leaf, leaf.box);
      return pen ? [pen] : [];
    }
    if (leaf.edge?.native && leaf.edge.points.length > 1) return this.edgePens(leaf);
    const out: any[] = [];
    const host = this.vectorPen(leaf.items, leaf, leaf.box);
    if (host) {
      this.bindStyle(host);
      out.push(host);
      if (leaf.info.type === 'node' && leaf.info.id) this.hosts.set(leaf.info.id, host);
    }
    leaf.labels.forEach((label, i) => {
      if (host && i === 0) this.adapter.hostText(host, label.style, { x: label.x - host.x, y: label.y - host.y, width: label.width, height: label.height });
      else out.push(this.adapter.text(labelSpec(label), { id: s8(), label: leaf.name, mermaid: { ...leaf.info, part: 'label' } }));
    });
    return out.length > 1 ? this.wrap(out, leaf.info, leaf.name) : out;
  }

  private vectorPen(items: VectorItem[], leaf: MermaidLeaf, box?: MermaidLeaf['box']) {
    if (!items.length) return undefined;
    const geom = createGeom(items);
    if (box && box.w > 0 && box.h > 0) geom.bbox = { x: box.x, y: box.y, width: box.w, height: box.h };
    const { bbox } = geom;
    if (!Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) || !(bbox.width >= 0 && bbox.height >= 0)) return undefined;
    const pen: any = { id: s8(), ...penRectOfGeom(bbox), vector: geom, disableAnchor: true, anchors: [] as any[], mermaid: { ...leaf.info } };
    this.adapter.vector(pen, leaf.name);
    return pen;
  }

  private bindStyle(pen: any) {
    const paths = (pen.vector.items as VectorItem[]).filter((it) => it.t === 'p') as VectorPathItem[];
    if (!paths.length || paths.length !== pen.vector.items.length) return;
    paths.forEach((path) => path.s = { ...(path.s || {}) });
    const stroked = paths.filter((p) => p.s.stroke && p.s.stroke !== 'none');
    const color = stroked[0]?.s.stroke;
    if (isFixed(color) && stroked.every((p) => p.s.stroke === color)) {
      pen.color = color;
      stroked.forEach((p) => p.s.stroke = '$fg');
    }
    const lineWidth = stroked[0]?.s.lw;
    if (!stroked.length) pen.lineWidth = 0;
    else if (typeof lineWidth === 'number' && stroked.every((p) => p.s.lw === lineWidth)) {
      pen.lineWidth = lineWidth;
      stroked.forEach((p) => p.s.lw = '$lw');
    }
    const fills = paths.filter((p) => p.s.fill && p.s.fill !== 'none' && p.s.fill !== '$fg');
    const fill = fills[0]?.s.fill;
    if (isFixed(fill) && fills.every((p) => p.s.fill === fill)) {
      pen.background = fill;
      fills.forEach((p) => p.s.fill = '$bg');
    }
  }

  private edgePens(leaf: MermaidLeaf): any[] {
    const edge = leaf.edge!;
    const anchors = edge.points.map((p) => ({ id: s8(), x: p.x, y: p.y }));
    const xs = anchors.map((a) => a.x), ys = anchors.map((a) => a.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const pen: any = { id: s8(), x: x0, y: y0, width: Math.max(Math.max(...xs) - x0, 1), height: Math.max(Math.max(...ys) - y0, 1), anchors, lineWidth: edge.lineWidth, mermaid: { ...leaf.info } };
    edge.color && (pen.color = edge.color);
    edge.dash && (pen.lineDash = edge.dash);
    this.adapter.line(pen, leaf.name, { from: edge.from, to: edge.to, background: edge.background });
    this.lines.push({ pen, source: edge.source, target: edge.target });
    const out = [pen];
    for (const label of leaf.labels) {
      const spec = labelSpec(label);
      const at = nearestOnPolyline(anchors, spec.x + spec.width / 2, spec.y + spec.height / 2);
      const text = this.adapter.lineLabel(pen, spec, at, { id: s8(), mermaid: { ...leaf.info, part: 'label' } });
      text && out.push(text);
    }
    return out;
  }

  private connectLines() {
    for (const { pen, source, target } of this.lines) {
      const ends: [string | undefined, any][] = [[source, pen.anchors[0]], [target, pen.anchors[pen.anchors.length - 1]]];
      for (const [id, lineAnchor] of ends) {
        const node = id !== undefined ? this.hosts.get(id) : undefined;
        if (!node || !lineAnchor || node === pen) continue;
        node.anchors ||= [];
        let anchor = node.anchors.find((a: any) => Math.hypot(a.x - lineAnchor.x, a.y - lineAnchor.y) < 0.5);
        if (!anchor) node.anchors.push(anchor = { id: s8(), x: lineAnchor.x, y: lineAnchor.y });
        delete node.disableAnchor;
        this.adapter.connect(pen, lineAnchor, node, anchor);
      }
    }
  }
}

function labelSpec(label: MermaidLabel): TextSpec {
  return { ...label.style, x: label.x, y: label.y, width: label.width, height: label.height };
}

function nearestOnPolyline(points: { x: number; y: number }[], x: number, y: number) {
  let segment = 0, position = 0.5, distance = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(x - a.x - dx * t, y - a.y - dy * t);
    if (d < distance) { distance = d; segment = i - 1; position = t; }
  }
  return { segment, position };
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
