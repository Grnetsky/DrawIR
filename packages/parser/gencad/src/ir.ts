/*
 * GenCAD 1.4：纯 ASCII 分区文本；单块 PCB，无多页；源单位由 UNITS 决定，Y 轴向上。
 * 节点由 PLACE + ROTATION + MIRRORX/MIRRORY 组成，父变换与局部变换链乘；ARC 从起点逆时针到终点。
 * 几何原语为 LINE/ARC/CIRCLE/RECTANGLE；PAD/PADSTACK/SHAPE 是复用定义，实例按覆盖参数展开。
 * 文件不含颜色，层色由解析选项提供；TEXT 为单样式文字，按中心/中线放置，镜像时保持字形可读。
 * ROUTE 使用 TRACK 线宽和 LAYER 层，LINE 可生成原生连线，ARC 画成矢量；VIA 复用 PADSTACK。
 * 无图片、渐变、压缩和 DOM 依赖；PLANE 支持填充，椭圆弧、伪记录等计入 unsupported。
 */
import {
  BoxAccumulator,
  IDENTITY,
  VectorPathBuilder,
  applyMatrix,
  composeMatrix,
  createGeom,
  estimateTextWidth,
  matrixScale,
  multiplyMatrix,
  pathItem,
  transformItem,
  type VectorItem,
  type VectorMatrix,
  type VectorStyle,
} from '@drawir/core';
import {
  decodeGenCAD,
  genCADNodeKey,
  genCADUnitToInches,
  type GenCADArcGeometry,
  type GenCADArtwork,
  type GenCADArtworkRef,
  type GenCADComponent,
  type GenCADDocumentSource,
  type GenCADGeometry,
  type GenCADLineGeometry,
  type GenCADPadStack,
  type GenCADPin,
  type GenCADText,
} from './decode';
import type { GenCADPageInfo, GenCADParseOptions, GenCADParseStats, GenCADPenInfo } from './types';
import { near, normalizeLayer } from './util';

export interface GenCADTextBox {
  x: number; y: number; width: number; height: number;
  rotate?: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  wrap: boolean;
}

export interface GenCADEdge {
  points: { x: number; y: number }[];
  color: string;
  lineWidth: number;
  pixelWidth?: boolean;
  source?: string;
  target?: string;
  native: boolean;
}

export interface GenCADLeaf {
  kind: 'leaf';
  info: GenCADPenInfo;
  name?: string;
  items: VectorItem[];
  boxes: (GenCADTextBox | undefined)[];
  anchors?: { id: string; x: number; y: number }[];
  edge?: GenCADEdge;
}

export interface GenCADGroup {
  kind: 'group';
  info: GenCADPenInfo;
  name?: string;
  children: GenCADUnit[];
}

export type GenCADUnit = GenCADLeaf | GenCADGroup;

export interface GenCADTree {
  pages: GenCADUnit[][];
  pageList: GenCADPageInfo[];
  vectors: Record<string, never>;
  stats: GenCADParseStats;
  header: GenCADDocumentSource['header'];
  layers: string[];
  background: string;
}

const DEFAULT_COLORS: Record<string, string> = {
  BOARD: '#15803d',
  EDGE_CUTS: '#15803d',
  TOP: '#dc2626',
  BOTTOM: '#2563eb',
  INNER: '#ca8a04',
  PAD_TOP: '#f59e0b',
  PAD_BOTTOM: '#f59e0b',
  VIA: '#eab308',
  SILKSCREEN_TOP: '#334155',
  SILKSCREEN_BOTTOM: '#64748b',
  SOLDERMASK_TOP: 'rgba(22,101,52,0.35)',
  SOLDERMASK_BOTTOM: 'rgba(30,64,175,0.3)',
  SOLDERPASTE_TOP: '#94a3b8',
  SOLDERPASTE_BOTTOM: '#94a3b8',
  DEFAULT: '#475569',
};

export function resolveOptions(o: GenCADParseOptions = {}) {
  return {
    scale: 0,
    fitWidth: 1920,
    fitHeight: 1080,
    origin: { x: 0, y: 0 },
    granularity: 'node' as const,
    group: true,
    editable: true,
    side: 'both' as const,
    pads: true,
    routes: true,
    components: true,
    texts: true,
    drills: true,
    background: '#ffffff',
    ...o,
    layerColors: { ...o.layerColors },
  };
}

export type ResolvedOptions = ReturnType<typeof resolveOptions>;

export function unitItems(u: GenCADUnit): VectorItem[] {
  return u.kind === 'leaf' ? (u.edge ? [...u.items, edgeItem(u.edge)] : u.items) : u.children.flatMap(unitItems);
}

interface HostPoint {
  id: string;
  net?: string;
  x: number;
  y: number;
}

export class GenCADToIR {
  private opts: ResolvedOptions;
  private doc: GenCADDocumentSource;
  private pageM: VectorMatrix = [1, 0, 0, -1, 0, 0];
  private hosts = new Map<string, HostPoint>();
  private layerFilter?: Set<string>;
  stats: GenCADParseStats;

  constructor(options: GenCADParseOptions = {}) {
    this.opts = resolveOptions(options);
    if (options.layers) this.layerFilter = new Set(options.layers.map(layerKey));
  }

  build(data: Uint8Array | string): GenCADTree {
    const t0 = now();
    const doc = (this.doc = decodeGenCAD(data));
    this.hosts.clear();
    this.stats = {
      pages: 0, nodes: 0, components: doc.components.length, pads: 0, routes: 0, vias: 0, pens: 0,
      unsupported: { ...doc.unsupported }, errors: [...doc.errors], ms: 0,
    };
    let units: GenCADUnit[] = [];
    this.collectHosts();
    this.emitBoard(units);
    if (this.opts.routes) doc.routes.forEach((route, i) => this.guard(`ROUTE#${i + 1}`, () => this.emitRoute(route, i, units)));
    if (this.opts.components) doc.components.forEach((component, i) => this.guard(`COMPONENT#${i + 1}:${component.name}`, () => this.emitComponent(component, i, units)));
    doc.holes.forEach((hole, i) => this.guard(`HOLE#${i + 1}`, () => this.emitHole(hole, i, units)));
    doc.probes.forEach((probe, i) => this.guard(`${probe.kind.toUpperCase()}#${i + 1}`, () => this.emitProbe(probe, i, units)));
    if (this.opts.granularity !== 'node') units = this.mergeUnits(units, this.opts.granularity === 'page');

    const box = unitsBox(units);
    const auto = Math.min(this.opts.fitWidth / (box.width || 1), this.opts.fitHeight / (box.height || 1));
    const k = this.opts.scale > 0 ? this.opts.scale : Number.isFinite(auto) && auto > 0 ? auto : 1;
    const ox = this.opts.origin.x;
    const oy = this.opts.origin.y;
    const m: VectorMatrix = [k, 0, 0, k, ox - box.x * k, oy - box.y * k];
    units.forEach((u) => transformUnit(u, m));
    const drawing = doc.header.drawing?.split(/[\\/]/).pop();
    const pageList: GenCADPageInfo[] = [{
      name: drawing || 'GenCAD PCB', x: ox, y: oy, width: box.width * k, height: box.height * k,
      background: this.opts.background, units: doc.header.units, drawing: doc.header.drawing,
    }];
    this.stats.pages = 1;
    this.stats.ms = Math.round(now() - t0);
    return { pages: [units], pageList, vectors: {}, stats: this.stats, header: doc.header, layers: doc.layers, background: this.opts.background };
  }

  private emitBoard(out: GenCADUnit[]) {
    const doc = this.doc;
    if (this.visible('BOARD') && doc.board.length) {
      const leaf = this.leaf({ page: 0, id: 'board', type: 'board', part: 'outline', layer: 'BOARD', name: 'Board outline' }, 'Board outline');
      const style: VectorStyle = { stroke: this.color('BOARD'), px: 1.5, cap: 'round', join: 'round' };
      if (this.opts.boardFill) {
        style.fill = this.opts.boardFill;
        style.rule = 'evenodd';
      }
      this.push(leaf, pathItem(closedPath(doc.board, this.pageM, 0, !!this.opts.boardFill), style));
      out.push(leaf);
    }
    doc.cutouts.forEach((geometry, i) => {
      if (!this.visible('BOARD')) return;
      const leaf = this.leaf({ page: 0, id: `cutout:${i}`, type: 'board', part: 'cutout', layer: 'BOARD', name: `Cutout ${i + 1}`, sourceLine: geometry[0]?.line }, `Cutout ${i + 1}`);
      this.push(leaf, pathItem(closedPath(geometry, this.pageM), { fill: '$bg', stroke: this.color('BOARD'), px: 1, rule: 'evenodd' }));
      out.push(leaf);
    });
    doc.boardArtworks.forEach((art, i) => this.emitArtwork(art, this.pageM, false, out, `board-artwork:${i}`));
    doc.boardTexts.forEach((text, i) => this.emitText(text, this.pageM, { page: 0, id: `board-text:${i}`, type: 'text', part: 'label', sourceLine: text.line }, out));
  }

  private emitComponent(component: GenCADComponent, index: number, out: GenCADUnit[]) {
    const m = this.componentMatrix(component);
    const children: GenCADUnit[] = [];
    const shape = component.shape && this.doc.shapes.get(component.shape);
    if (!shape && component.shape) {
      this.count('component:missingShape');
      this.stats.errors.push(`COMPONENT#${index + 1}:${component.name}: 找不到 SHAPE ${component.shape}`);
    }
    const silk = component.flip || component.layer === 'BOTTOM' ? 'SILKSCREEN_BOTTOM' : 'SILKSCREEN_TOP';
    if (shape && this.visible(silk)) {
      const leaf = this.leaf({ page: 0, id: `component:${index}:outline`, type: 'component', part: 'silkscreen', layer: silk, component: component.name, name: component.name, sourceLine: shape.line }, component.name);
      this.push(leaf, pathItem(openPath(shape.geometry, m), this.strokeStyle(silk, undefined, 1)));
      children.push(leaf);
      shape.artworks.forEach((ref, i) => this.emitArtworkRef(ref, m, component.flip, children, `component:${index}:shape-artwork:${i}`, component.name));
    }
    component.artworks.forEach((ref, i) => this.emitArtworkRef(ref, m, component.flip, children, `component:${index}:artwork:${i}`, component.name));
    shape?.pins.forEach((pin, pinIndex) => {
      if (!this.opts.pads) return;
      this.guard(`PIN#${pinIndex + 1}:${component.name}.${pin.name}`, () => {
        const id = pinId(index, pinIndex);
        const net = this.doc.signals.get(genCADNodeKey(component.name, pin.name));
        const pinM = multiplyMatrix(m, localMatrix(pin.x, pin.y, pin.rotation, pin.mirror));
        const leaf = this.leaf({ page: 0, id, type: 'pin', part: 'copper', layer: this.flipLayer(pin.layer, component.flip), net, component: component.name, pin: pin.name, padstack: pin.padstack, name: `${component.name}.${pin.name}`, sourceLine: pin.line }, `${component.name}.${pin.name}`);
        this.emitPadstack(leaf, pin.padstack, pinM, component.flip);
        const [x, y] = applyMatrix(pinM, 0, 0);
        leaf.anchors = [{ id: `${id}:center`, x, y }];
        if (hasContent(leaf)) {
          children.push(leaf);
          this.stats.pads++;
        }
      });
    });
    if (this.opts.texts) component.texts.forEach((text, i) => this.emitText(text, m, {
      page: 0, id: `component:${index}:text:${i}`, type: 'text', part: 'label', component: component.name, name: text.text, sourceLine: text.line,
    }, children));
    if (!children.length) return;
    const info: GenCADPenInfo = { page: 0, id: `component:${index}`, type: 'component', component: component.name, name: component.name, layer: component.layer, sourceLine: component.line };
    if (this.opts.group && children.length > 1) out.push({ kind: 'group', info, name: component.name, children });
    else out.push(...children);
  }

  private emitRoute(route: GenCADDocumentSource['routes'][number], routeIndex: number, out: GenCADUnit[]) {
    route.segments.forEach((segment, segmentIndex) => {
      const g = segment.geometry;
      if (!this.visible(segment.layer)) return;
      const info: GenCADPenInfo = { page: 0, id: `route:${routeIndex}:${segmentIndex}`, type: 'route', part: 'copper', layer: segment.layer, net: route.name, name: route.name, sourceLine: g.line };
      const leaf = this.leaf(info, route.name);
      const width = this.trackWidth(segment.track);
      if (g.kind === 'LINE') {
        const p1 = point(this.pageM, g.x1, g.y1);
        const p2 = point(this.pageM, g.x2, g.y2);
        leaf.edge = {
          points: [p1, p2], color: this.color(segment.layer), lineWidth: width || 1, pixelWidth: !width, native: true,
          source: this.findHost(route.name, g.x1, g.y1), target: this.findHost(route.name, g.x2, g.y2),
        };
        this.stats.routes++;
        out.push(leaf);
      } else {
        this.push(leaf, pathItem(openPath([g], this.pageM), this.strokeStyle(segment.layer, width, 1)));
        this.stats.routes++;
        out.push(leaf);
      }
    });
    route.planes.forEach((plane, i) => {
      if (!this.visible(plane.layer) || !plane.geometry.length) return;
      const leaf = this.leaf({ page: 0, id: `route:${routeIndex}:plane:${i}`, type: 'route', part: 'plane', layer: plane.layer, net: route.name, name: plane.name, sourceLine: plane.line }, plane.name);
      this.push(leaf, pathItem(closedPath(plane.geometry, this.pageM), { fill: this.color(plane.layer), stroke: 'none', rule: 'evenodd' }));
      out.push(leaf);
    });
    route.vias.forEach((via, i) => {
      if (!this.opts.pads) return;
      const id = viaId(routeIndex, i);
      const leaf = this.leaf({ page: 0, id, type: 'via', part: 'copper', layer: via.layer, net: route.name, padstack: via.padstack, name: via.name, sourceLine: via.line }, via.name);
      const m = multiplyMatrix(this.pageM, localMatrix(via.x, via.y, 0, '0'));
      this.emitPadstack(leaf, via.padstack, m, false, via.drill);
      const [x, y] = applyMatrix(m, 0, 0);
      leaf.anchors = [{ id: `${id}:center`, x, y }];
      if (hasContent(leaf)) {
        out.push(leaf);
        this.stats.vias++;
      }
    });
    route.testpads.forEach((pad, i) => {
      if (!this.opts.pads || !this.visible(pad.layer)) return;
      const leaf = this.leaf({ page: 0, id: `route:${routeIndex}:testpad:${i}`, type: 'pin', part: 'copper', layer: pad.layer, net: route.name, padstack: pad.padstack, name: pad.name, sourceLine: pad.line }, pad.name);
      const m = multiplyMatrix(this.pageM, localMatrix(pad.x, pad.y, pad.rotation, pad.mirror));
      this.emitPadstack(leaf, pad.padstack, m, false);
      const [x, y] = applyMatrix(m, 0, 0);
      leaf.anchors = [{ id: `${leaf.info.id}:center`, x, y }];
      hasContent(leaf) && out.push(leaf);
    });
    if (this.opts.texts) route.texts.forEach((text, i) => this.emitText(text, this.pageM, { page: 0, id: `route:${routeIndex}:text:${i}`, type: 'text', part: 'label', net: route.name, sourceLine: text.line }, out));
  }

  private emitPadstack(leaf: GenCADLeaf, name: string, m: VectorMatrix, flip: boolean, drillOverride = 0) {
    const stack = this.doc.padstacks.get(name);
    if (!stack) {
      this.count('padstack:missing');
      this.stats.errors.push(`${leaf.info.id}: 找不到 PADSTACK ${name}`);
      return;
    }
    const drill = drillOverride || stack.drill;
    const refs = [...stack.pads].sort((a, b) => layerOrder(a.layer) - layerOrder(b.layer));
    let emitted = false;
    for (const ref of refs) {
      const layer = this.flipLayer(ref.layer, flip);
      if (!this.visible(layer)) continue;
      const pad = this.doc.pads.get(ref.pad);
      if (!pad) {
        this.count('pad:missing');
        this.stats.errors.push(`${leaf.info.id}: 找不到 PAD ${ref.pad}`);
        continue;
      }
      const padM = multiplyMatrix(m, localMatrix(0, 0, ref.rotation, ref.mirror));
      const style: VectorStyle = { fill: this.padColor(layer), stroke: 'none', rule: 'evenodd' };
      this.push(leaf, pathItem(closedPath(pad.geometry, padM, this.opts.drills ? drill : 0), style));
      emitted = true;
    }
    if (!emitted && this.opts.drills && drill > 0 && stack.pads.some((p) => this.visible(this.flipLayer(p.layer, flip)))) {
      this.push(leaf, pathItem(closedPath([], m, drill), { fill: '$bg', stroke: 'none' }));
      leaf.info.part = 'drill';
    }
  }

  private emitArtworkRef(ref: GenCADArtworkRef, parentM: VectorMatrix, parentFlip: boolean, out: GenCADUnit[], id: string, component?: string) {
    const art = this.doc.artworks.get(ref.name);
    if (!art) {
      this.count('artwork:missing');
      this.stats.errors.push(`${id}: 找不到 ARTWORK ${ref.name}`);
      return;
    }
    const m = multiplyMatrix(parentM, localMatrix(ref.x, ref.y, ref.rotation, ref.mirror));
    this.emitArtwork(art, m, parentFlip !== !!ref.flip, out, id, component);
  }

  private emitArtwork(art: GenCADArtwork, m: VectorMatrix, flip: boolean, out: GenCADUnit[], id: string, component?: string) {
    const layer = this.flipLayer(art.layer, flip);
    if (this.visible(layer) && art.geometry.length) {
      const leaf = this.leaf({ page: 0, id, type: 'artwork', part: art.filled ? 'copper' : 'silkscreen', layer, component, name: art.name, sourceLine: art.line }, art.name);
      const width = this.trackWidth(art.track);
      const style = art.filled
        ? { fill: this.color(layer), stroke: 'none', rule: 'evenodd' as const }
        : this.strokeStyle(layer, width, 1);
      this.push(leaf, pathItem(art.filled ? closedPath(art.geometry, m) : openPath(art.geometry, m), style));
      out.push(leaf);
    }
    if (this.opts.texts) art.texts.forEach((text, i) => this.emitText(text, m, { page: 0, id: `${id}:text:${i}`, type: 'text', part: 'label', layer, component, name: text.text, sourceLine: text.line }, out, flip));
  }

  private emitText(text: GenCADText, parentM: VectorMatrix, info: GenCADPenInfo, out: GenCADUnit[], flip = false) {
    const layer = this.flipLayer(text.layer, flip);
    if (!text.text || !this.opts.texts || !this.visible(layer)) return;
    const m = multiplyMatrix(parentM, localMatrix(text.x, text.y, text.rotation, text.mirror));
    const scale = matrixScale(m);
    const [x, y] = applyMatrix(m, 0, 0);
    const h = text.size * scale;
    if (!(h > 0)) return;
    let r = Math.atan2(m[1], m[0]);
    if (m[0] * m[3] - m[1] * m[2] < 0) r += Math.PI;
    r = normalizeAngle(r);
    const width = (text.rect.width > 0 ? text.rect.width * scale : estimateTextWidth(text.text, h) * 1.08 + h * 0.2) || h;
    const height = (text.rect.height > 0 ? text.rect.height * scale : h * 1.25) || h * 1.25;
    if (text.rect.x || text.rect.y) this.count('text:rectangleOffset');
    const leaf = this.leaf({ ...info, layer }, info.name || text.text);
    const box: GenCADTextBox = { x: x - width / 2, y: y - height / 2, width, height, lineHeight: 1.25, align: 'center', valign: 'middle', wrap: false };
    Math.abs(r) > 1e-8 && (box.rotate = (r * 180) / Math.PI);
    this.push(leaf, { t: 't', text: text.text, x, y, h, r, a: 'center', b: 'middle', lh: 1.25, fill: this.color(layer) }, box);
    out.push(leaf);
  }

  private emitHole(hole: GenCADDocumentSource['holes'][number], index: number, out: GenCADUnit[]) {
    if (!this.opts.drills || !(hole.diameter > 0) || !this.visible('DRILL')) return;
    const leaf = this.leaf({ page: 0, id: `hole:${index}`, type: 'hole', part: 'drill', layer: 'DRILL', name: `Hole ${index + 1}`, sourceLine: hole.line }, `Hole ${index + 1}`);
    const m = multiplyMatrix(this.pageM, localMatrix(hole.x, hole.y, 0, '0'));
    this.push(leaf, pathItem(closedPath([], m, hole.diameter), { fill: '$bg', stroke: this.color('BOARD'), px: 0.75 }));
    out.push(leaf);
  }

  private emitProbe(probe: GenCADDocumentSource['probes'][number], index: number, out: GenCADUnit[]) {
    if (!this.visible(probe.layer)) return;
    const diameter = 0.02 / genCADUnitToInches(this.doc.header);
    const leaf = this.leaf({ page: 0, id: `${probe.kind}:${index}`, type: 'pin', part: 'copper', layer: probe.layer, net: probe.signal, name: probe.name, sourceLine: probe.line }, probe.name);
    const m = multiplyMatrix(this.pageM, localMatrix(probe.x, probe.y, 0, '0'));
    this.push(leaf, pathItem(closedPath([], m, diameter), { fill: this.padColor(probe.layer), stroke: 'none' }));
    const [x, y] = applyMatrix(m, 0, 0);
    leaf.anchors = [{ id: `${leaf.info.id}:center`, x, y }];
    out.push(leaf);
  }

  private collectHosts() {
    if (!this.opts.components) return;
    this.doc.components.forEach((component, componentIndex) => {
      const shape = component.shape && this.doc.shapes.get(component.shape);
      if (!shape) return;
      const m = this.componentMatrix(component);
      const net = (pin: GenCADPin) => this.doc.signals.get(genCADNodeKey(component.name, pin.name));
      shape.pins.forEach((pin, pinIndex) => {
        const [x, y] = applyMatrix(m, pin.x, pin.y);
        this.addHost({ id: pinId(componentIndex, pinIndex), net: net(pin), x, y });
      });
    });
    this.doc.routes.forEach((route, routeIndex) => route.vias.forEach((via, viaIndex) => {
      const [x, y] = applyMatrix(this.pageM, via.x, via.y);
      this.addHost({ id: viaId(routeIndex, viaIndex), net: route.name, x, y });
    }));
  }

  private addHost(host: HostPoint) {
    if (!host.net) return;
    const key = hostKey(host.net, host.x, host.y);
    if (!this.hosts.has(key)) this.hosts.set(key, host);
  }

  private findHost(net: string, x: number, y: number) {
    const [px, py] = applyMatrix(this.pageM, x, y);
    return this.hosts.get(hostKey(net, px, py))?.id;
  }

  private componentMatrix(component: GenCADComponent) {
    return multiplyMatrix(this.pageM, localMatrix(component.x, component.y, component.rotation, component.mirror));
  }

  private strokeStyle(layer: string, width?: number, pixelWidth = 1): VectorStyle {
    const style: VectorStyle = { stroke: this.color(layer), cap: 'round', join: 'round' };
    if (width && width > 0) style.lw = width;
    else style.px = pixelWidth;
    return style;
  }

  private trackWidth(track?: string) {
    return track ? this.doc.tracks.get(track) || 0 : 0;
  }

  private color(layer: string) {
    const normalized = normalizeLayer(layer);
    const custom = this.opts.layerColors[normalized] || this.opts.layerColors[layerKey(normalized)];
    if (custom) return custom;
    if (/^INNER/.test(normalized)) return DEFAULT_COLORS.INNER;
    return DEFAULT_COLORS[normalized] || DEFAULT_COLORS[layerKey(normalized)] || DEFAULT_COLORS.DEFAULT;
  }

  private padColor(layer: string) {
    const normalized = normalizeLayer(layer);
    const custom = this.opts.layerColors[`PAD_${normalized}`];
    if (custom) return custom;
    if (!/^(TOP|BOTTOM|ALL|INNER|POWER|GROUND|LAYER)/.test(normalized)) return this.color(normalized);
    return normalized.includes('BOTTOM') ? this.color('PAD_BOTTOM') : this.color('PAD_TOP');
  }

  private visible(layer: string) {
    const normalized = normalizeLayer(layer);
    if (this.layerFilter && !this.layerFilter.has(layerKey(normalized))) return false;
    if (this.opts.side === 'top' && normalized.includes('BOTTOM')) return false;
    if (this.opts.side === 'bottom' && normalized.includes('TOP')) return false;
    return true;
  }

  private flipLayer(layer: string, flip: boolean) {
    if (!flip) return normalizeLayer(layer);
    const normalized = normalizeLayer(layer);
    if (normalized === 'TOP') return 'BOTTOM';
    if (normalized === 'BOTTOM') return 'TOP';
    if (normalized.endsWith('_TOP')) return `${normalized.slice(0, -4)}_BOTTOM`;
    if (normalized.endsWith('_BOTTOM')) return `${normalized.slice(0, -7)}_TOP`;
    if (/^INNER/.test(normalized)) this.count('flip:innerLayer');
    return normalized;
  }

  private leaf(info: GenCADPenInfo, name?: string): GenCADLeaf {
    this.stats.nodes++;
    return { kind: 'leaf', info, name, items: [], boxes: [] };
  }

  private push(leaf: GenCADLeaf, item: VectorItem, box?: GenCADTextBox) {
    leaf.items.push(item);
    leaf.boxes.push(box);
  }

  private mergeUnits(units: GenCADUnit[], page: boolean) {
    const leaves = units.flatMap(flattenUnit);
    const merged = new Map<string, GenCADLeaf>();
    for (const source of leaves) {
      const layer = page ? 'PAGE' : normalizeLayer(source.info.layer || source.info.type || 'DEFAULT');
      let target = merged.get(layer);
      if (!target) {
        target = this.leaf({ page: 0, id: page ? 'page' : `layer:${layer}`, type: page ? 'page' : 'layer', layer, name: page ? 'GenCAD PCB' : layer }, page ? 'GenCAD PCB' : layer);
        merged.set(layer, target);
      }
      const items = source.edge ? [...source.items, edgeItem(source.edge)] : source.items;
      items.forEach((item, i) => this.push(target!, item, source.edge && i === source.items.length ? undefined : source.boxes[i]));
    }
    return [...merged.values()];
  }

  private count(key: string) {
    this.stats.unsupported[key] = (this.stats.unsupported[key] || 0) + 1;
  }

  private guard(id: string, fn: () => void) {
    try {
      fn();
    } catch (e: any) {
      this.stats.errors.push(`${id}: ${e?.message || e}`);
    }
  }
}

function localMatrix(x: number, y: number, rotation: number, mirror: string) {
  const r = (rotation * Math.PI) / 180;
  const rotate: VectorMatrix = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
  const mx = mirror === 'MIRRORY' ? -1 : 1;
  const my = mirror === 'MIRRORX' ? -1 : 1;
  return composeMatrix(rotate, [mx, 0, 0, my, 0, 0], [1, 0, 0, 1, x, y]);
}

function openPath(geometry: GenCADGeometry[], m: VectorMatrix) {
  const b = new VectorPathBuilder(m);
  for (const g of geometry) drawGeometry(b, g, true, false);
  return b.d;
}

function closedPath(geometry: GenCADGeometry[], m: VectorMatrix, drill = 0, closeOpen = true) {
  const b = new VectorPathBuilder(m);
  const { chains, standalone } = geometryChains(geometry);
  for (const chain of chains) {
    chain.forEach(({ geometry: g, forward }, i) => drawGeometry(b, g, forward, i > 0));
    if (chain.length && (closeOpen || samePoint(segmentStart(chain[0]), segmentEnd(chain[chain.length - 1])))) b.close();
  }
  for (const g of standalone) drawGeometry(b, g, true, false);
  if (drill > 0) {
    b.ellipse(0, 0, drill / 2, drill / 2, 0, 0, Math.PI * 2, false, false).close();
  }
  return b.d;
}

type ChainSegment = { geometry: GenCADLineGeometry | GenCADArcGeometry; forward: boolean };

function geometryChains(geometry: GenCADGeometry[]) {
  const chains: ChainSegment[][] = [];
  const segments = geometry.filter((g): g is GenCADLineGeometry | GenCADArcGeometry => g.kind === 'LINE' || g.kind === 'ARC');
  const used = new Set<number>();
  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const chain: ChainSegment[] = [{ geometry: segments[i], forward: true }];
    let extended = true;
    while (extended) {
      extended = false;
      const tail = segmentEnd(chain[chain.length - 1]);
      const head = segmentStart(chain[0]);
      for (let j = 0; j < segments.length; j++) {
        if (used.has(j)) continue;
        const g = segments[j];
        const start = geometryStart(g);
        const end = geometryEnd(g);
        if (samePoint(tail, start)) chain.push({ geometry: g, forward: true });
        else if (samePoint(tail, end)) chain.push({ geometry: g, forward: false });
        else if (samePoint(head, end)) chain.unshift({ geometry: g, forward: true });
        else if (samePoint(head, start)) chain.unshift({ geometry: g, forward: false });
        else continue;
        used.add(j);
        extended = true;
        break;
      }
    }
    chains.push(chain);
  }
  const standalone = geometry.filter((g) => g.kind === 'CIRCLE' || g.kind === 'RECTANGLE');
  return { chains, standalone };
}

function drawGeometry(b: VectorPathBuilder, g: GenCADGeometry, forward: boolean, connect: boolean) {
  switch (g.kind) {
    case 'LINE': {
      const start = forward ? [g.x1, g.y1] : [g.x2, g.y2];
      const end = forward ? [g.x2, g.y2] : [g.x1, g.y1];
      if (!connect) b.moveTo(start[0], start[1]);
      b.lineTo(end[0], end[1]);
      break;
    }
    case 'ARC': {
      const r = Math.hypot(g.x1 - g.cx, g.y1 - g.cy);
      if (!(r > 0)) break;
      const a1 = Math.atan2(g.y1 - g.cy, g.x1 - g.cx);
      const a2 = Math.atan2(g.y2 - g.cy, g.x2 - g.cx);
      const start = forward ? a1 : a2;
      let end = forward ? a2 : a1;
      if (forward) {
        if (end <= start + 1e-10) end += Math.PI * 2;
      } else if (end >= start - 1e-10) end -= Math.PI * 2;
      b.ellipse(g.cx, g.cy, r, r, 0, start, end, !forward, connect);
      break;
    }
    case 'CIRCLE':
      b.ellipse(g.cx, g.cy, g.r, g.r, 0, 0, Math.PI * 2, false, false).close();
      break;
    case 'RECTANGLE':
      b.moveTo(g.x, g.y).lineTo(g.x + g.width, g.y).lineTo(g.x + g.width, g.y + g.height).lineTo(g.x, g.y + g.height).close();
      break;
  }
}

function geometryStart(g: GenCADLineGeometry | GenCADArcGeometry) {
  return { x: g.x1, y: g.y1 };
}

function geometryEnd(g: GenCADLineGeometry | GenCADArcGeometry) {
  return { x: g.x2, y: g.y2 };
}

function segmentStart(s: ChainSegment) {
  return s.forward ? geometryStart(s.geometry) : geometryEnd(s.geometry);
}

function segmentEnd(s: ChainSegment) {
  return s.forward ? geometryEnd(s.geometry) : geometryStart(s.geometry);
}

function samePoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return near(a.x, b.x, 1e-6) && near(a.y, b.y, 1e-6);
}

function edgeItem(edge: GenCADEdge): VectorItem {
  const b = new VectorPathBuilder(IDENTITY);
  edge.points.forEach((p, i) => i ? b.lineTo(p.x, p.y) : b.moveTo(p.x, p.y));
  const style: VectorStyle = { stroke: edge.color, cap: 'round', join: 'round' };
  if (edge.pixelWidth) style.px = edge.lineWidth;
  else style.lw = edge.lineWidth;
  return pathItem(b.d, style);
}

function flattenUnit(u: GenCADUnit): GenCADLeaf[] {
  return u.kind === 'leaf' ? [u] : u.children.flatMap(flattenUnit);
}

function hasContent(leaf: GenCADLeaf) {
  return leaf.items.length > 0 || !!leaf.edge;
}

function unitsBox(units: GenCADUnit[]) {
  const acc = new BoxAccumulator();
  const walk = (u: GenCADUnit) => {
    if (u.kind === 'group') return u.children.forEach(walk);
    if (u.items.length) acc.addBox(createGeom(u.items).bbox);
    u.edge?.points.forEach((p) => acc.add(p.x, p.y));
  };
  units.forEach(walk);
  return acc.empty ? { x: 0, y: 0, width: 0, height: 0 } : acc.box();
}

function transformUnit(u: GenCADUnit, m: VectorMatrix) {
  if (u.kind === 'group') return u.children.forEach((c) => transformUnit(c, m));
  const k = matrixScale(m);
  const map = (x: number, y: number) => ({ x: m[0] * x + m[4], y: m[3] * y + m[5] });
  u.items = u.items.map((item) => transformItem(item, m, k));
  u.boxes = u.boxes.map((box) => box && { ...box, ...map(box.x, box.y), width: box.width * k, height: box.height * k });
  u.anchors = u.anchors?.map((a) => ({ ...a, ...map(a.x, a.y) }));
  if (u.edge) {
    u.edge.points = u.edge.points.map((p) => map(p.x, p.y));
    if (!u.edge.pixelWidth) u.edge.lineWidth *= k;
  }
}

function point(m: VectorMatrix, x: number, y: number) {
  const [px, py] = applyMatrix(m, x, y);
  return { x: px, y: py };
}

function pinId(component: number, pin: number) {
  return `pin:${component}:${pin}`;
}

function viaId(route: number, via: number) {
  return `via:${route}:${via}`;
}

function hostKey(net: string, x: number, y: number) {
  return `${net}\u0000${Math.round(x * 1e6)}\u0000${Math.round(y * 1e6)}`;
}

function layerKey(layer: string) {
  return normalizeLayer(layer).replace(/_/g, '');
}

function layerOrder(layer: string) {
  const key = normalizeLayer(layer);
  if (key.includes('BOTTOM')) return 0;
  if (key === 'TOP') return 2;
  if (key.includes('TOP')) return 2;
  return 1;
}

function normalizeAngle(r: number) {
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
