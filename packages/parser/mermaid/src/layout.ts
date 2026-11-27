import type { FlowEdge, FlowNode, FlowchartModel, MermaidStyles } from './decode';
import { mermaidText, textSize } from './text';

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

export interface FlowLayout {
  nodes: Record<string, Rect>;
  subgraphs: Record<string, Rect>;
  width: number;
  height: number;
  ranks: Record<string, number>;
}

export interface FlowLayoutOptions {
  fontSize: number;
  fontFamily: string;
  nodeSpacing: number;
  rankSpacing: number;
  padding: number;
}

export function flowNodeStyles(model: FlowchartModel, node: FlowNode): MermaidStyles {
  return Object.assign({}, ...node.classes.map((name) => model.classDefs[name] || {}), node.style);
}

export function layoutFlowchart(model: FlowchartModel, opts: FlowLayoutOptions): FlowLayout {
  const nodes: Record<string, Rect> = {};
  for (const id of model.nodeOrder) {
    const node = model.nodes[id];
    const style = flowNodeStyles(model, node);
    const fontSize = cssNumber(style['font-size'], opts.fontSize);
    const size = textSize(mermaidText(node.label ?? node.id), fontSize, 1.5, style['font-family'] || opts.fontFamily);
    let width = Math.max(60, size.width + 30);
    let height = Math.max(40, size.height + 16);
    if (node.shape === 'circle' || node.shape === 'doublecircle') width = height = Math.max(width, height) * 1.15;
    else if (node.shape === 'diamond') { width *= 1.55; height *= 1.35; }
    else if (node.shape === 'hexagon') width += 20;
    else if (node.shape === 'cylinder') height += 12;
    nodes[id] = { x: 0, y: 0, width, height };
  }

  const incoming: Record<string, string[]> = {};
  for (const e of model.edges) (incoming[e.target] ||= []).push(e.source);
  const ranks: Record<string, number> = {};
  const visiting = new Set<string>();
  const rank = (id: string): number => {
    if (ranks[id] !== undefined) return ranks[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let r = 0;
    for (const source of incoming[id] || []) if (source !== id && model.nodes[source]) r = Math.max(r, rank(source) + 1);
    visiting.delete(id);
    return ranks[id] = r;
  };
  model.nodeOrder.forEach(rank);

  const horizontal = model.direction === 'LR' || model.direction === 'RL';
  const rankCount = Math.max(0, ...Object.values(ranks)) + 1;
  const layers: string[][] = Array.from({ length: rankCount }, () => []);
  for (const id of model.nodeOrder) layers[ranks[id]].push(id);
  const neighborOrder = (id: string, other: Record<string, number>) => {
    const values = model.edges.filter((e) => e.source === id || e.target === id).map((e) => other[e.source === id ? e.target : e.source]).filter((v) => v !== undefined);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.MAX_SAFE_INTEGER;
  };
  for (let iteration = 0; iteration < 4; iteration++) {
    for (let r = 1; r < layers.length; r++) {
      const previous: Record<string, number> = {};
      layers[r - 1].forEach((id, i) => previous[id] = i);
      layers[r].sort((a, b) => neighborOrder(a, previous) - neighborOrder(b, previous) || model.nodeOrder.indexOf(a) - model.nodeOrder.indexOf(b));
    }
    for (let r = layers.length - 2; r >= 0; r--) {
      const next: Record<string, number> = {};
      layers[r + 1].forEach((id, i) => next[id] = i);
      layers[r].sort((a, b) => neighborOrder(a, next) - neighborOrder(b, next) || model.nodeOrder.indexOf(a) - model.nodeOrder.indexOf(b));
    }
  }

  const mainSize = (id: string) => horizontal ? nodes[id].width : nodes[id].height;
  const crossSize = (id: string) => horizontal ? nodes[id].height : nodes[id].width;
  const mainOffsets: number[] = [];
  let main = opts.padding;
  for (const layer of layers) {
    mainOffsets.push(main);
    main += Math.max(0, ...layer.map(mainSize)) + opts.rankSpacing;
  }
  const totalMain = main - opts.rankSpacing + opts.padding;
  const crossSizes = layers.map((layer) => layer.reduce((sum, id, i) => sum + crossSize(id) + (i ? opts.nodeSpacing : 0), 0));
  const totalCross = Math.max(0, ...crossSizes) + opts.padding * 2;
  layers.forEach((layer, r) => {
    let cross = (totalCross - crossSizes[r]) / 2;
    for (const id of layer) {
      const node = nodes[id];
      const m = model.direction === 'BT' || model.direction === 'RL' ? totalMain - mainOffsets[r] - mainSize(id) : mainOffsets[r];
      if (horizontal) { node.x = m; node.y = cross; }
      else { node.x = cross; node.y = m; }
      cross += crossSize(id) + opts.nodeSpacing;
    }
  });

  const subgraphs: Record<string, Rect> = {};
  for (let pass = 0; pass < model.subgraphOrder.length; pass++) {
    for (const id of [...model.subgraphOrder].reverse()) {
      const sg = model.subgraphs[id];
      const boxes = sg.children.map((child) => nodes[child] || subgraphs[child]).filter(Boolean);
      if (!boxes.length) continue;
      const x0 = Math.min(...boxes.map((b) => b.x)) - 16;
      const y0 = Math.min(...boxes.map((b) => b.y)) - 34;
      const x1 = Math.max(...boxes.map((b) => b.x + b.width)) + 16;
      const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + 16;
      subgraphs[id] = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
  }
  for (const sid of model.subgraphOrder) {
    const frame = subgraphs[sid];
    if (!frame) continue;
    for (const id of model.nodeOrder) {
      const node = model.nodes[id];
      if (node.subgraph) continue;
      const rect = nodes[id];
      const overlap = rect.x < frame.x + frame.width && rect.x + rect.width > frame.x && rect.y < frame.y + frame.height && rect.y + rect.height > frame.y;
      if (overlap) rect.y = frame.y + frame.height + opts.nodeSpacing;
    }
  }
  const all = [...Object.values(nodes), ...Object.values(subgraphs)];
  return {
    nodes, subgraphs, ranks,
    width: Math.max(totalCross, ...all.map((r) => r.x + r.width + opts.padding)),
    height: Math.max(totalMain, ...all.map((r) => r.y + r.height + opts.padding)),
  };
}

export function routeFlowEdge(edge: FlowEdge, source: Rect, target: Rect, direction: string, sourceRank: number, targetRank: number): Point[] {
  if (source === target) {
    const x = source.x + source.width, y = source.y + source.height / 2;
    return [{ x, y }, { x: x + 36, y }, { x: x + 36, y: y + 34 }, { x: source.x + source.width / 2, y: source.y + source.height + 34 }, { x: source.x + source.width / 2, y: source.y + source.height }];
  }
  const horizontal = direction === 'LR' || direction === 'RL';
  const forward = targetRank > sourceRank;
  if (sourceRank === targetRank) return straight(source, target);
  if (forward) {
    if (horizontal) {
      const a = { x: source.x + source.width, y: source.y + source.height / 2 };
      const b = { x: target.x, y: target.y + target.height / 2 };
      const x = (a.x + b.x) / 2;
      return Math.abs(a.y - b.y) < 0.5 ? [a, b] : [a, { x, y: a.y }, { x, y: b.y }, b];
    }
    const a = { x: source.x + source.width / 2, y: source.y + source.height };
    const b = { x: target.x, y: target.y + target.height };
    const y = (a.y + b.y) / 2;
    return Math.abs(a.x - b.x) < 0.5 ? [a, b] : [a, { x: a.x, y }, { x: b.x, y }, b];
  }
  const a = horizontal
    ? { x: source.x + source.width / 2, y: source.y + source.height }
    : { x: source.x + source.width, y: source.y + source.height / 2 };
  const b = horizontal
    ? { x: target.x + target.width / 2, y: target.y + target.height }
    : { x: target.x + target.width, y: target.y + target.height / 2 };
  const offset = 24;
  return horizontal
    ? [a, { x: a.x, y: a.y + offset }, { x: b.x, y: a.y + offset }, { x: b.x, y: b.y + offset }, b]
    : [a, { x: a.x + offset, y: a.y }, { x: a.x + offset, y: b.y }, { x: b.x + offset, y: b.y }, b];
}

function straight(a: Rect, b: Rect): Point[] {
  const ac = center(a), bc = center(b);
  return [boundary(a, bc), boundary(b, ac)];
}

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function boundary(r: Rect, toward: Point): Point {
  const c = center(r), dx = toward.x - c.x, dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const k = Math.min(dx ? r.width / 2 / Math.abs(dx) : Infinity, dy ? r.height / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * k, y: c.y + dy * k };
}

export function labelOnPolyline(points: Point[], width: number, height: number): Rect {
  let best = 0, length = 0;
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (l > length) { best = i - 1; length = l; }
  }
  const a = points[best] || { x: 0, y: 0 }, b = points[best + 1] || a;
  return { x: (a.x + b.x) / 2 - width / 2, y: (a.y + b.y) / 2 - height / 2 - 4, width, height };
}

export function cssNumber(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
