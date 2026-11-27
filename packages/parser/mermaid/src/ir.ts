import {
  IDENTITY,
  createGeom,
  matrixScale,
  pathItem,
  transformItem,
  VectorPathBuilder,
  type VectorItem,
  type VectorMatrix,
  type VectorStyle,
  type VectorTextItem,
} from '@drawir/core';
import {
  decodeMermaid,
  type FlowEdge,
  type FlowNode,
  type FlowSubgraph,
  type FlowchartModel,
  type MermaidModel,
  type MermaidStyles,
  type SequenceBlock,
  type SequenceEvent,
  type SequenceMessage,
  type SequenceModel,
  type SequenceNote,
  type SequenceParticipant,
} from './decode';
import { center, cssNumber, flowNodeStyles, labelOnPolyline, layoutFlowchart, routeFlowEdge, type FlowLayout, type Point, type Rect } from './layout';
import { mermaidText, textSize, wrapMermaidText } from './text';
import type { MermaidPageInfo, MermaidParseOptions, MermaidParseStats, MermaidPenInfo } from './types';

/**
 * Mermaid 格式约定：
 * 1. 容器：UTF-8 文本 DSL；接受字符串或字节，无压缩、无内嵌外层文件。
 * 2. 页面：每次输入一张图，pageList 只有一项，不引入多页排列。
 * 3. 坐标：源文件没有坐标；自动布局生成 px、Y 向下，最终只乘 scale 并平移到 origin。
 * 4. 变换：节点/连线没有源变换；rotation/flip 不适用于已支持的两种图。
 * 5. 几何：流程图预定义形状、正交/直线折线；时序图生命线、消息、注释和片段框。
 * 6. 样式：默认主题 → classDef → class → style；连线用 linkStyle，颜色/线宽/虚线映射 VectorStyle。
 * 7. 文字：普通单样式文字；<br> 与实体解码，备注定宽换行，字号用估算宽度参与布局。
 * 8. 复用：支持的格式语义中没有共享几何定义，不生成 vectors/ref。
 * 9. 层级：subgraph 和时序图片段成为组合；连线保持独立以便跟随节点。
 * 10. 连线：本层计算路由和形状周长端点；原生折线/箭头用 edge，叉号/异步箭头保留矢量。
 * 11. 图片：流程图和时序图没有必须解析的内嵌图片，不提供图片上传接口。
 * 12. 不支持：其它图表类型、扩展形状、点击链接和时序图动态创建等由 errors/unsupported 记录。
 */
export interface MermaidTextStyle {
  text: string;
  fontSize: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  wrap: boolean;
  color?: string;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  background?: string;
}

export interface MermaidLabel {
  style: MermaidTextStyle;
  x: number;
  y: number;
  width: number;
  height: number;
  item: VectorTextItem;
}

export interface MermaidArrow {
  type: 'triangle' | 'line' | 'circle' | 'diamond';
  filled: boolean;
  size: number;
}

export interface MermaidEdge {
  points: Point[];
  color?: string;
  lineWidth: number;
  dash?: number[];
  from?: MermaidArrow;
  to?: MermaidArrow;
  source?: string;
  target?: string;
  native: boolean;
  crossEnd?: boolean;
  background?: string;
}

export interface MermaidLeaf {
  kind: 'leaf';
  info: MermaidPenInfo;
  name?: string;
  items: VectorItem[];
  labels: MermaidLabel[];
  box?: { x: number; y: number; w: number; h: number };
  edge?: MermaidEdge;
}

export interface MermaidGroup {
  kind: 'group';
  info: MermaidPenInfo;
  name?: string;
  children: MermaidUnit[];
}

export type MermaidUnit = MermaidLeaf | MermaidGroup;

export interface MermaidTree {
  pages: MermaidUnit[][];
  pageList: MermaidPageInfo[];
  stats: MermaidParseStats;
  width: number;
  height: number;
}

export function resolveOptions(o: MermaidParseOptions = {}) {
  return {
    scale: 1,
    granularity: 'node' as const,
    group: true,
    editable: true,
    pageBorder: false,
    colors: 'mermaid' as const,
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 16,
    nodeSpacing: 50,
    rankSpacing: 70,
    padding: 20,
    ...o,
    origin: o.origin || { x: 0, y: 0 },
  };
}
export type ResolvedOptions = ReturnType<typeof resolveOptions>;

export function unitItems(unit: MermaidUnit): VectorItem[] {
  if (unit.kind === 'group') return unit.children.flatMap(unitItems);
  return [...unit.items, ...unit.labels.flatMap(labelItems)];
}

export function labelItems(label: MermaidLabel): VectorItem[] {
  const out: VectorItem[] = [];
  if (label.style.background && label.style.background !== 'none') {
    const b = new VectorPathBuilder();
    const { x, y, width: w, height: h } = label;
    b.moveTo(x, y).lineTo(x + w, y).lineTo(x + w, y + h).lineTo(x, y + h).close();
    out.push(pathItem(b.d, { fill: label.style.background, stroke: 'none' }));
  }
  out.push(label.item);
  return out;
}

interface Theme {
  fill: string;
  stroke: string;
  text: string;
  line: string;
  noteFill: string;
  noteStroke: string;
  fontFamily: string;
  fontSize: number;
}

export class MermaidToIR {
  private opts: ResolvedOptions;
  private theme: Theme;
  stats!: MermaidParseStats;

  constructor(options: MermaidParseOptions = {}) {
    this.opts = resolveOptions(options);
  }

  build(data: string | Uint8Array): MermaidTree {
    const t0 = now();
    this.stats = { pages: 0, nodes: 0, edges: 0, pens: 0, unsupported: {}, errors: [], ms: 0 };
    const source = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const model = decodeMermaid(source, this.stats);
    this.theme = this.makeTheme(model.config);
    const built = model.kind === 'flowchart' ? this.flowchart(model) : this.sequence(model);
    let units = built.units;
    if (this.opts.granularity !== 'node') units = [this.merge(units, model)];
    if (this.opts.pageBorder) units = [this.pageBorder(built.width, built.height, model), ...units];
    const k = this.opts.scale > 0 ? this.opts.scale : 1;
    const m: VectorMatrix = [k, 0, 0, k, this.opts.origin.x, this.opts.origin.y];
    units.forEach((unit) => transformUnit(unit, m));
    const pageList: MermaidPageInfo[] = [{ name: model.title || (model.kind === 'flowchart' ? 'Flowchart' : 'Sequence Diagram'), x: this.opts.origin.x, y: this.opts.origin.y, width: built.width * k, height: built.height * k }];
    this.stats.pages = 1;
    this.stats.ms = Math.round(now() - t0);
    return { pages: [units], pageList, stats: this.stats, width: built.width * k, height: built.height * k };
  }

  private makeTheme(config: MermaidStyles): Theme {
    const dynamic = this.opts.colors === 'meta2d';
    return {
      fill: dynamic ? '$bg' : config.primaryColor || '#ececff',
      stroke: dynamic ? '$fg' : config.primaryBorderColor || '#9370db',
      text: dynamic ? '$fg' : config.primaryTextColor || '#333333',
      line: dynamic ? '$fg' : config.lineColor || '#333333',
      noteFill: dynamic ? '$bg' : config.noteBkgColor || '#fff5ad',
      noteStroke: dynamic ? '$fg' : config.noteBorderColor || '#aaaa33',
      fontFamily: this.opts.fontFamily || config.fontFamily || 'Arial, Helvetica, sans-serif',
      fontSize: this.opts.fontSize || cssNumber(config.fontSize, 16),
    };
  }

  private flowchart(model: FlowchartModel) {
    const layout = layoutFlowchart(model, this.opts);
    this.stats.nodes = model.nodeOrder.length;
    this.stats.edges = model.edges.length;
    for (const id of model.subgraphOrder) if (model.subgraphs[id].direction && model.subgraphs[id].direction !== model.direction) this.count('flowchart:subgraphDirection');
    const nodeUnits: Record<string, MermaidUnit> = {};
    for (const id of model.nodeOrder) nodeUnits[id] = this.flowNode(model, model.nodes[id], layout.nodes[id]);
    const made = new Set<string>();
    const subgraphUnit = (id: string): MermaidUnit => {
      const sg = model.subgraphs[id];
      const self = this.subgraphSelf(sg, layout.subgraphs[id]);
      const children: MermaidUnit[] = [self];
      for (const child of sg.children) {
        if (model.nodes[child]) children.push(nodeUnits[child]);
        else if (model.subgraphs[child] && !made.has(child)) {
          made.add(child);
          children.push(subgraphUnit(child));
        }
      }
      return this.opts.group && children.length > 1 ? { kind: 'group', info: { ...self.info }, name: sg.label, children } : ({ kind: 'group', info: { ...self.info }, name: sg.label, children });
    };
    const units: MermaidUnit[] = [];
    for (const id of model.subgraphOrder) {
      const sg = model.subgraphs[id];
      if (!sg.parent && layout.subgraphs[id]) {
        made.add(id);
        units.push(subgraphUnit(id));
      }
    }
    for (const id of model.nodeOrder) if (!model.nodes[id].subgraph) units.push(nodeUnits[id]);
    for (const edge of model.edges) if (edge.line !== 'invisible') {
      const source = layout.nodes[edge.source], target = layout.nodes[edge.target];
      if (!source || !target) continue;
      const points = routeFlowEdge(edge, source, target, model.direction, layout.ranks[edge.source], layout.ranks[edge.target]);
      units.push(this.flowEdge(model, edge, points));
    }
    const bounds = unitsBounds(units);
    const dx = bounds.x < 0 ? -bounds.x + this.opts.padding : 0;
    const dy = bounds.y < 0 ? -bounds.y + this.opts.padding : 0;
    if (dx || dy) units.forEach((unit) => transformUnit(unit, [1, 0, 0, 1, dx, dy]));
    return { units, width: Math.max(layout.width + dx, bounds.x + bounds.width + dx + this.opts.padding), height: Math.max(layout.height + dy, bounds.y + bounds.height + dy + this.opts.padding) };
  }

  private flowNode(model: FlowchartModel, node: FlowNode, rect: Rect): MermaidLeaf {
    const styles = flowNodeStyles(model, node);
    const fontSize = cssNumber(styles['font-size'], this.theme.fontSize);
    const fontFamily = styles['font-family'] || this.theme.fontFamily;
    const text = mermaidText(node.label ?? node.id);
    const label = this.makeLabel(text, rect, { fontSize, fontFamily, ...labelStyle(styles, this.theme.text) });
    const style: VectorStyle = {
      fill: styles.fill || this.theme.fill,
      stroke: styles.stroke || this.theme.stroke,
      lw: cssNumber(styles['stroke-width'], 1),
      dash: cssDash(styles['stroke-dasharray']),
    };
    const leaf: MermaidLeaf = {
      kind: 'leaf',
      info: { page: 0, diagram: 'flowchart', id: node.id, type: 'node', shape: node.shape, name: text },
      name: text,
      items: [pathItem(shapePath(node.shape, rect), style)],
      labels: text ? [label] : [],
      box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    };
    this.countStyleFeatures(styles);
    return leaf;
  }

  private subgraphSelf(sg: FlowSubgraph, rect: Rect): MermaidLeaf {
    const r = rect || { x: 0, y: 0, width: 1, height: 1 };
    const b = new VectorPathBuilder();
    b.moveTo(r.x, r.y).lineTo(r.x + r.width, r.y).lineTo(r.x + r.width, r.y + r.height).lineTo(r.x, r.y + r.height).close();
    const label = this.makeLabel(sg.label, { x: r.x + 8, y: r.y + 4, width: Math.max(1, r.width - 16), height: 26 }, { bold: true });
    return { kind: 'leaf', info: { page: 0, diagram: 'flowchart', id: sg.id, type: 'subgraph', name: sg.label }, name: sg.label, items: [pathItem(b.d, { fill: this.opts.colors === 'meta2d' ? 'none' : '#f7f7fb', stroke: this.theme.stroke, lw: 1, dash: [5, 4] })], labels: [label], box: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }

  private flowEdge(model: FlowchartModel, edge: FlowEdge, points: Point[]): MermaidLeaf {
    const styles = edge.style;
    const color = styles.stroke || this.theme.line;
    const lineWidth = cssNumber(styles['stroke-width'], edge.line === 'thick' ? 3 : 1.5);
    const dash = cssDash(styles['stroke-dasharray']) || (edge.line === 'dotted' ? [4, 4] : undefined);
    const from = nativeArrow(edge.from), to = nativeArrow(edge.to);
    const native = edge.from !== 'cross' && edge.to !== 'cross';
    const irEdge: MermaidEdge = { points, color, lineWidth, dash, from, to, source: edge.source, target: edge.target, native, crossEnd: edge.to === 'cross', background: this.theme.fill };
    const labels: MermaidLabel[] = [];
    if (edge.label) {
      const fontSize = cssNumber(styles['font-size'], this.theme.fontSize);
      const text = mermaidText(edge.label);
      const size = textSize(text, fontSize, 1.5, this.theme.fontFamily);
      const rect = labelOnPolyline(points, size.width + 12, size.height + 4);
      labels.push(this.makeLabel(text, rect, { fontSize, ...labelStyle(styles, this.theme.text), background: this.opts.colors === 'meta2d' ? undefined : '#ffffff' }));
    }
    return { kind: 'leaf', info: { page: 0, diagram: 'flowchart', id: edge.id, type: 'edge', name: mermaidText(edge.label) }, name: mermaidText(edge.label), items: edgeItems(irEdge), labels, edge: irEdge };
  }

  private sequence(model: SequenceModel) {
    const participants = model.participantOrder.map((id) => model.participants[id]);
    this.stats.nodes = participants.length;
    this.stats.edges = countMessages(model.events);
    const titleSize = model.title ? textSize(model.title, this.theme.fontSize * 1.25, 1.5, this.theme.fontFamily) : { width: 0, height: 0 };
    const top = this.opts.padding + (model.title ? titleSize.height + 16 : 0);
    const rects: Record<string, Rect> = {};
    let x = this.opts.padding;
    for (const p of participants) {
      const size = textSize(mermaidText(p.label), this.theme.fontSize, 1.5, this.theme.fontFamily);
      const width = Math.max(p.kind === 'actor' ? 80 : 110, size.width + 28);
      const height = p.kind === 'actor' ? 72 : Math.max(44, size.height + 14);
      rects[p.id] = { x, y: top, width, height };
      x += width + 60;
    }
    const width = Math.max(x - 60 + this.opts.padding, titleSize.width + this.opts.padding * 2, 200);
    const units: MermaidUnit[] = [];
    if (model.title) units.push(this.standaloneText(model.title, { x: (width - titleSize.width) / 2, y: this.opts.padding, width: titleSize.width, height: titleSize.height }, { fontSize: this.theme.fontSize * 1.25, bold: true }, 'title'));
    const topPens = participants.map((p) => this.participant(p, rects[p.id], 'top'));
    let y = top + Math.max(0, ...participants.map((p) => rects[p.id].height)) + 36;
    const activations = new Map<string, number[]>();
    const activationUnits: MermaidUnit[] = [];
    const activate = (id: string, at: number) => (activations.get(id) || (activations.set(id, []), activations.get(id)!)).push(at);
    const deactivate = (id: string, at: number) => {
      const stack = activations.get(id);
      const start = stack?.pop();
      if (start !== undefined && rects[id]) activationUnits.push(this.activation(id, rects[id], start, at));
    };
    const body = this.sequenceEvents(model.events, rects, y, activate, deactivate);
    y = body.y + 24;
    for (const [id, stack] of activations) for (const start of stack) activationUnits.push(this.activation(id, rects[id], start, y));
    const bottom = participants.map((p) => this.participant(p, { ...rects[p.id], y }, 'bottom'));
    const lifelines = participants.map((p) => this.lifeline(p, rects[p.id], y));
    const height = y + Math.max(0, ...participants.map((p) => rects[p.id].height)) + this.opts.padding;
    const allUnits = [...units, ...topPens, ...lifelines, ...body.units, ...activationUnits, ...bottom];
    const bounds = unitsBounds(allUnits);
    const dx = bounds.x < 0 ? -bounds.x + this.opts.padding : 0;
    const dy = bounds.y < 0 ? -bounds.y + this.opts.padding : 0;
    if (dx || dy) allUnits.forEach((unit) => transformUnit(unit, [1, 0, 0, 1, dx, dy]));
    return { units: allUnits, width: Math.max(width + dx, bounds.x + bounds.width + dx + this.opts.padding), height: Math.max(height + dy, bounds.y + bounds.height + dy + this.opts.padding) };
  }

  private sequenceEvents(events: SequenceEvent[], participants: Record<string, Rect>, startY: number, activate: (id: string, y: number) => void, deactivate: (id: string, y: number) => void) {
    const units: MermaidUnit[] = [];
    let y = startY;
    for (const event of events) {
      if (event.kind === 'message') {
        const source = participants[event.source], target = participants[event.target];
        if (!source || !target) continue;
        const a = center(source).x, b = center(target).x;
        const points: Point[] = event.source === event.target
          ? [{ x: a, y }, { x: a + 44, y }, { x: a + 44, y: y + 28 }, { x: a, y: y + 28 }]
          : [{ x: a, y }, { x: b, y }];
        const labelText = mermaidText(event.text);
        const size = textSize(labelText, this.theme.fontSize, 1.5, this.theme.fontFamily);
        const labelRect = labelOnPolyline(points, size.width + 8, size.height + 2);
        labelRect.y = Math.min(labelRect.y, y - size.height - 7);
        const color = this.theme.line;
        const arrow = event.arrow === 'solid' ? { type: 'triangle' as const, filled: true, size: 10 } : event.arrow === 'open' || event.arrow === 'async' ? { type: 'line' as const, filled: false, size: 10 } : undefined;
        const native = event.arrow !== 'cross' && event.arrow !== 'async';
        if (event.arrow === 'async') this.count('sequence:asyncArrow');
        const edge: MermaidEdge = { points, color, lineWidth: 1.5, dash: event.line === 'dotted' ? [4, 4] : undefined, to: arrow, native, crossEnd: event.arrow === 'cross', background: this.theme.fill };
        const labels = labelText ? [this.makeLabel(labelText, labelRect, { background: this.opts.colors === 'meta2d' ? undefined : '#ffffff' })] : [];
        units.push({ kind: 'leaf', info: { page: 0, diagram: 'sequenceDiagram', id: `message-${this.stats.pens + units.length}`, type: 'edge', name: labelText }, name: labelText, items: edgeItems(edge), labels, edge });
        if (event.activate) activate(event.target, y - 8);
        if (event.deactivate) deactivate(event.source, y + 28);
        y += event.source === event.target ? 66 : 52;
      } else if (event.kind === 'note') {
        const rect = this.noteRect(event, participants);
        rect.y = y;
        units.push(this.note(event, rect));
        y += rect.height + 22;
      } else if (event.kind === 'activate') activate(event.participant, y - 12);
      else if (event.kind === 'deactivate') deactivate(event.participant, y);
      else if (event.kind === 'block') {
        const blockStart = y;
        y += 30;
        const childUnits: MermaidUnit[] = [];
        const separators: { y: number; label?: string }[] = [];
        for (let i = 0; i < event.sections.length; i++) {
          if (i) {
            separators.push({ y: y - 20, label: event.sections[i].label });
            y += 8;
          }
          const section = this.sequenceEvents(event.sections[i].events, participants, y, activate, deactivate);
          childUnits.push(...section.units);
          y = section.y;
        }
        y += 12;
        const xs = Object.values(participants);
        const rect: Rect = { x: Math.min(...xs.map((r) => r.x + r.width / 2)) - 28, y: blockStart, width: Math.max(...xs.map((r) => r.x + r.width / 2)) - Math.min(...xs.map((r) => r.x + r.width / 2)) + 56, height: y - blockStart };
        if (!xs.length) { rect.x = this.opts.padding; rect.width = 100; }
        units.push(this.block(event, rect, separators, childUnits));
      }
    }
    return { units, y };
  }

  private participant(p: SequenceParticipant, rect: Rect, part: 'top' | 'bottom'): MermaidLeaf {
    const text = mermaidText(p.label);
    const items: VectorItem[] = [];
    let labelRect = rect;
    if (p.kind === 'actor') {
      const cx = rect.x + rect.width / 2, cy = rect.y + 14;
      const head = new VectorPathBuilder();
      head.ellipse(cx, cy, 9, 9, 0, 0, Math.PI * 2, false, false);
      const body = new VectorPathBuilder();
      body.moveTo(cx, cy + 9).lineTo(cx, cy + 34).moveTo(cx - 16, cy + 20).lineTo(cx + 16, cy + 20).moveTo(cx, cy + 34).lineTo(cx - 14, cy + 52).moveTo(cx, cy + 34).lineTo(cx + 14, cy + 52);
      items.push(pathItem(head.d, { fill: this.theme.fill, stroke: this.theme.stroke, lw: 1.5 }), pathItem(body.d, { fill: 'none', stroke: this.theme.stroke, lw: 1.5 }));
      labelRect = { x: rect.x, y: rect.y + 52, width: rect.width, height: 20 };
    } else items.push(pathItem(roundedRect(rect, 5), { fill: this.theme.fill, stroke: this.theme.stroke, lw: 1.5 }));
    return { kind: 'leaf', info: { page: 0, diagram: 'sequenceDiagram', id: `${p.id}:${part}`, type: 'participant', shape: p.kind, name: text }, name: text, items, labels: [this.makeLabel(text, labelRect, {})], box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  }

  private lifeline(p: SequenceParticipant, rect: Rect, bottom: number): MermaidLeaf {
    const x = center(rect).x, y = rect.y + rect.height;
    const b = new VectorPathBuilder();
    b.moveTo(x, y).lineTo(x, bottom);
    return { kind: 'leaf', info: { page: 0, diagram: 'sequenceDiagram', id: `${p.id}:lifeline`, type: 'lifeline', name: p.label }, items: [pathItem(b.d, { stroke: this.theme.line, fill: 'none', lw: 1, dash: [5, 5] })], labels: [] };
  }

  private activation(id: string, participant: Rect, start: number, end: number): MermaidLeaf {
    const rect = { x: center(participant).x - 5, y: start, width: 10, height: Math.max(4, end - start) };
    const b = new VectorPathBuilder();
    b.moveTo(rect.x, rect.y).lineTo(rect.x + rect.width, rect.y).lineTo(rect.x + rect.width, rect.y + rect.height).lineTo(rect.x, rect.y + rect.height).close();
    return { kind: 'leaf', info: { page: 0, diagram: 'sequenceDiagram', id: `${id}:activation:${start}`, type: 'activation' }, items: [pathItem(b.d, { fill: this.theme.fill, stroke: this.theme.stroke, lw: 1 })], labels: [], box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  }

  private noteRect(note: SequenceNote, participants: Record<string, Rect>): Rect {
    const text = wrapMermaidText(note.text, 150, this.theme.fontSize, this.theme.fontFamily);
    const size = textSize(text, this.theme.fontSize, 1.5, this.theme.fontFamily);
    const width = size.width + 24, height = size.height + 18;
    const involved = note.participants.map((id) => participants[id]).filter(Boolean);
    const first = involved[0] || { x: this.opts.padding, y: 0, width: 100, height: 40 };
    let x = first.x;
    if (note.position === 'left') x = first.x - width - 12;
    else if (note.position === 'right') x = first.x + first.width + 12;
    else {
      const cx = involved.length > 1 ? (center(involved[0]).x + center(involved[involved.length - 1]).x) / 2 : center(first).x;
      x = cx - width / 2;
    }
    return { x, y: 0, width, height };
  }

  private note(note: SequenceNote, rect: Rect): MermaidLeaf {
    const text = wrapMermaidText(note.text, 150, this.theme.fontSize, this.theme.fontFamily);
    const fold = 10;
    const b = new VectorPathBuilder();
    b.moveTo(rect.x, rect.y).lineTo(rect.x + rect.width - fold, rect.y).lineTo(rect.x + rect.width, rect.y + fold).lineTo(rect.x + rect.width, rect.y + rect.height).lineTo(rect.x, rect.y + rect.height).close().moveTo(rect.x + rect.width - fold, rect.y).lineTo(rect.x + rect.width - fold, rect.y + fold).lineTo(rect.x + rect.width, rect.y + fold);
    return { kind: 'leaf', info: { page: 0, diagram: 'sequenceDiagram', type: 'note', name: text }, name: text, items: [pathItem(b.d, { fill: this.theme.noteFill, stroke: this.theme.noteStroke, lw: 1 })], labels: [this.makeLabel(text, rect, {})], box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  }

  private block(block: SequenceBlock, rect: Rect, separators: { y: number; label?: string }[], children: MermaidUnit[]): MermaidUnit {
    const b = new VectorPathBuilder();
    b.moveTo(rect.x, rect.y).lineTo(rect.x + rect.width, rect.y).lineTo(rect.x + rect.width, rect.y + rect.height).lineTo(rect.x, rect.y + rect.height).close();
    for (const s of separators) b.moveTo(rect.x, s.y).lineTo(rect.x + rect.width, s.y);
    const fill = block.blockType === 'rect' && this.opts.colors === 'mermaid' ? '#f5f5f5' : 'none';
    const labels = [this.makeLabel(`${block.blockType}${block.label ? ` ${block.label}` : ''}`, { x: rect.x + 8, y: rect.y + 3, width: rect.width - 16, height: 24 }, { align: 'left', bold: true })];
    for (const s of separators) if (s.label) labels.push(this.makeLabel(s.label, { x: rect.x + 8, y: s.y + 2, width: rect.width - 16, height: 22 }, { align: 'left' }));
    const self: MermaidLeaf = { kind: 'leaf', info: { page: 0, diagram: 'sequenceDiagram', type: 'fragment', name: block.label || block.blockType }, name: block.label || block.blockType, items: [pathItem(b.d, { fill, stroke: this.theme.line, lw: 1 })], labels, box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
    return { kind: 'group', info: { ...self.info }, name: self.name, children: [self, ...children] };
  }

  private standaloneText(text: string, rect: Rect, style: Partial<MermaidTextStyle>, type: MermaidPenInfo['type']): MermaidLeaf {
    return { kind: 'leaf', info: { page: 0, diagram: 'sequenceDiagram', type, name: text }, name: text, items: [], labels: [this.makeLabel(text, rect, style)] };
  }

  private makeLabel(text: string, rect: Rect, style: Partial<MermaidTextStyle>): MermaidLabel {
    const full: MermaidTextStyle = { text, fontSize: this.theme.fontSize, lineHeight: 1.5, align: 'center', valign: 'middle', wrap: false, color: this.theme.text, fontFamily: this.theme.fontFamily, ...style };
    const x = full.align === 'center' ? rect.x + rect.width / 2 : full.align === 'right' ? rect.x + rect.width : rect.x;
    const y = full.valign === 'middle' ? rect.y + rect.height / 2 : full.valign === 'bottom' ? rect.y + rect.height : rect.y;
    const item: VectorTextItem = { t: 't', text, x, y, h: full.fontSize, a: full.align, b: full.valign, lh: full.lineHeight, font: full.fontFamily, bold: full.bold, italic: full.italic, fill: full.color };
    full.wrap && (item.bw = rect.width);
    return { style: full, ...rect, item };
  }

  private pageBorder(width: number, height: number, model: MermaidModel): MermaidLeaf {
    const b = new VectorPathBuilder();
    b.moveTo(0, 0).lineTo(width, 0).lineTo(width, height).lineTo(0, height).close();
    return { kind: 'leaf', info: { page: 0, diagram: model.kind, type: 'page', part: 'page' }, items: [pathItem(b.d, { fill: 'none', stroke: this.theme.stroke, lw: 1, dash: [5, 4] })], labels: [] };
  }

  private merge(units: MermaidUnit[], model: MermaidModel): MermaidLeaf {
    const leaf: MermaidLeaf = { kind: 'leaf', info: { page: 0, diagram: model.kind, type: 'page' }, items: [], labels: [] };
    const visit = (unit: MermaidUnit) => {
      if (unit.kind === 'group') return unit.children.forEach(visit);
      leaf.items.push(...unit.items, ...unit.labels.flatMap(labelItems));
    };
    units.forEach(visit);
    return leaf;
  }

  private countStyleFeatures(styles: MermaidStyles) {
    for (const key of Object.keys(styles)) if (/^(?:filter|backdrop-filter|mix-blend-mode)$/.test(key)) this.count(`style:${key}`);
  }

  private count(key: string) {
    this.stats.unsupported[key] = (this.stats.unsupported[key] || 0) + 1;
  }
}

function nativeArrow(value: FlowEdge['from']): MermaidArrow | undefined {
  if (value === 'arrow') return { type: 'triangle', filled: true, size: 10 };
  if (value === 'circle') return { type: 'circle', filled: false, size: 10 };
  return undefined;
}

function labelStyle(styles: MermaidStyles, fallback: string): Partial<MermaidTextStyle> {
  return {
    color: styles.color || fallback,
    bold: /^(?:bold|[6-9]00)$/.test(styles['font-weight'] || ''),
    italic: styles['font-style'] === 'italic',
  };
}

function cssDash(value: string | undefined): number[] | undefined {
  if (!value || value === 'none') return undefined;
  const values = value.split(/[\s,]+/).map(parseFloat).filter((n) => Number.isFinite(n) && n > 0);
  if (!values.length) return undefined;
  return values.length % 2 ? [...values, ...values] : values;
}

function shapePath(shape: FlowNode['shape'], r: Rect) {
  const { x, y, width: w, height: h } = r;
  const b = new VectorPathBuilder();
  if (shape === 'rounded' || shape === 'stadium') return roundedRect(r, shape === 'stadium' ? h / 2 : 8);
  if (shape === 'circle' || shape === 'doublecircle') {
    b.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2, false, false);
    if (shape === 'doublecircle') b.ellipse(x + w / 2, y + h / 2, Math.max(0, w / 2 - 5), Math.max(0, h / 2 - 5), 0, 0, Math.PI * 2, false, false);
    return b.d;
  }
  if (shape === 'cylinder') {
    const ry = Math.min(10, h / 5);
    b.moveTo(x, y + ry).ellipse(x + w / 2, y + ry, w / 2, ry, 0, Math.PI, 0, false, true).lineTo(x + w, y + h - ry).ellipse(x + w / 2, y + h - ry, w / 2, ry, 0, 0, Math.PI, false, true).lineTo(x, y + ry).ellipse(x + w / 2, y + ry, w / 2, ry, 0, Math.PI, Math.PI * 2, false, true);
    return b.d;
  }
  if (shape === 'diamond') {
    b.moveTo(x + w / 2, y).lineTo(x + w, y + h / 2).lineTo(x + w / 2, y + h).lineTo(x, y + h / 2).close();
    return b.d;
  }
  if (shape === 'hexagon') {
    const d = Math.min(w / 5, 18);
    b.moveTo(x + d, y).lineTo(x + w - d, y).lineTo(x + w, y + h / 2).lineTo(x + w - d, y + h).lineTo(x + d, y + h).lineTo(x, y + h / 2).close();
    return b.d;
  }
  if (shape === 'asymmetric') {
    const d = Math.min(w / 5, 18);
    b.moveTo(x, y).lineTo(x + w - d, y).lineTo(x + w, y + h / 2).lineTo(x + w - d, y + h).lineTo(x, y + h).close();
    return b.d;
  }
  if (shape === 'parallelogram' || shape === 'parallelogramAlt' || shape === 'trapezoid' || shape === 'trapezoidAlt') {
    const d = Math.min(w / 4, 20);
    if (shape === 'parallelogram') b.moveTo(x + d, y).lineTo(x + w, y).lineTo(x + w - d, y + h).lineTo(x, y + h).close();
    else if (shape === 'parallelogramAlt') b.moveTo(x, y).lineTo(x + w - d, y).lineTo(x + w, y + h).lineTo(x + d, y + h).close();
    else if (shape === 'trapezoid') b.moveTo(x + d, y).lineTo(x + w - d, y).lineTo(x + w, y + h).lineTo(x, y + h).close();
    else b.moveTo(x, y).lineTo(x + w, y).lineTo(x + w - d, y + h).lineTo(x + d, y + h).close();
    return b.d;
  }
  b.moveTo(x, y).lineTo(x + w, y).lineTo(x + w, y + h).lineTo(x, y + h).close();
  if (shape === 'subroutine') { b.moveTo(x + 6, y).lineTo(x + 6, y + h).moveTo(x + w - 6, y).lineTo(x + w - 6, y + h); }
  return b.d;
}

function roundedRect(r: Rect, radius: number) {
  const { x, y, width: w, height: h } = r;
  const d = Math.min(radius, w / 2, h / 2), b = new VectorPathBuilder();
  b.moveTo(x + d, y).lineTo(x + w - d, y).quadTo(x + w, y, x + w, y + d).lineTo(x + w, y + h - d).quadTo(x + w, y + h, x + w - d, y + h).lineTo(x + d, y + h).quadTo(x, y + h, x, y + h - d).lineTo(x, y + d).quadTo(x, y, x + d, y).close();
  return b.d;
}

function edgeItems(edge: MermaidEdge): VectorItem[] {
  const b = new VectorPathBuilder();
  edge.points.forEach((p, i) => i ? b.lineTo(p.x, p.y) : b.moveTo(p.x, p.y));
  const style: VectorStyle = { stroke: edge.color || '$fg', fill: 'none', lw: edge.lineWidth, dash: edge.dash };
  const items: VectorItem[] = [pathItem(b.d, style)];
  edge.from && arrowItems(items, edge.points[1], edge.points[0], edge.from, edge.color || '$fg', edge.background);
  edge.to && arrowItems(items, edge.points[edge.points.length - 2], edge.points[edge.points.length - 1], edge.to, edge.color || '$fg', edge.background);
  if (edge.crossEnd) {
    const p = edge.points[edge.points.length - 1], q = edge.points[edge.points.length - 2];
    const angle = Math.atan2(p.y - q.y, p.x - q.x), size = 6;
    const c = new VectorPathBuilder();
    for (const offset of [Math.PI / 4, -Math.PI / 4]) {
      const a = angle + offset;
      c.moveTo(p.x - Math.cos(a) * size, p.y - Math.sin(a) * size).lineTo(p.x + Math.cos(a) * size, p.y + Math.sin(a) * size);
    }
    items.push(pathItem(c.d, style));
  }
  return items;
}

function arrowItems(items: VectorItem[], previous: Point, tip: Point, arrow: MermaidArrow, color: string, background?: string) {
  const angle = Math.atan2(tip.y - previous.y, tip.x - previous.x), size = arrow.size;
  const at = (length: number, side: number) => ({ x: tip.x - Math.cos(angle) * length - Math.sin(angle) * side, y: tip.y - Math.sin(angle) * length + Math.cos(angle) * side });
  const b = new VectorPathBuilder();
  if (arrow.type === 'triangle' || arrow.type === 'diamond') {
    const a = at(size, size * 0.45), c = at(size, -size * 0.45);
    b.moveTo(tip.x, tip.y).lineTo(a.x, a.y);
    if (arrow.type === 'diamond') { const back = at(size * 2, 0); b.lineTo(back.x, back.y); }
    b.lineTo(c.x, c.y).close();
    items.push(pathItem(b.d, { fill: arrow.filled ? color : background || 'none', stroke: color, lw: 1 }));
  } else if (arrow.type === 'circle') {
    const c = at(size / 2, 0);
    b.ellipse(c.x, c.y, size / 2, size / 2, 0, 0, Math.PI * 2, false, false);
    items.push(pathItem(b.d, { fill: arrow.filled ? color : background || 'none', stroke: color, lw: 1 }));
  } else {
    const a = at(size, size * 0.5), c = at(size, -size * 0.5);
    b.moveTo(a.x, a.y).lineTo(tip.x, tip.y).lineTo(c.x, c.y);
    items.push(pathItem(b.d, { fill: 'none', stroke: color, lw: 1.5 }));
  }
}

function transformUnit(unit: MermaidUnit, m: VectorMatrix) {
  if (unit.kind === 'group') return unit.children.forEach((child) => transformUnit(child, m));
  const k = matrixScale(m);
  const map = (x: number, y: number) => ({ x: m[0] * x + m[4], y: m[3] * y + m[5] });
  unit.items = unit.items.map((item) => transformItem(item, m, k));
  unit.labels = unit.labels.map((label) => ({
    ...label,
    ...map(label.x, label.y),
    width: label.width * k,
    height: label.height * k,
    style: { ...label.style, fontSize: label.style.fontSize * k },
    item: transformItem(label.item, m, k) as VectorTextItem,
  }));
  if (unit.box) unit.box = { ...map(unit.box.x, unit.box.y), w: unit.box.w * k, h: unit.box.h * k };
  if (unit.edge) {
    unit.edge.points = unit.edge.points.map((p) => map(p.x, p.y));
    unit.edge.lineWidth *= k;
    unit.edge.dash = unit.edge.dash?.map((v) => v * k);
    unit.edge.from && (unit.edge.from = { ...unit.edge.from, size: unit.edge.from.size * k });
    unit.edge.to && (unit.edge.to = { ...unit.edge.to, size: unit.edge.to.size * k });
  }
}

function unitsBounds(units: MermaidUnit[]): Rect {
  const items = units.flatMap(unitItems);
  if (!items.length) return { x: 0, y: 0, width: 1, height: 1 };
  const box = createGeom(items).bbox;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function countMessages(events: SequenceEvent[]): number {
  return events.reduce((sum, event) => sum + (event.kind === 'message' ? 1 : event.kind === 'block' ? countMessages(event.sections.flatMap((s) => s.events)) : 0), 0);
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
