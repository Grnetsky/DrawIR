import { VectorPathBuilder, type VectorMatrix } from '@drawir/core';
import { flag, num, Style } from './style';

/**
 * 顶点形状 → 路径。所有形状都在局部框 (0, 0, w, h) 内绘制，
 * 方向（direction）、翻转、旋转和页面位置都由调用方通过矩阵 `m` 给出。
 *
 * 每个形状返回若干部分：
 * - `fill: 'main'`：用 fillColor 填充并描边
 * - `fill: 'alt'`：用备用填充色（如泳道主体 swimlaneFillColor）
 * - `fill: 'none'`：只描边（装饰线、折角等）
 * - `fill: 'fillOnly'`：只填充不描边（如 partialRectangle 的底色）
 */
export interface ShapePart {
  d: number[];
  fill: 'main' | 'alt' | 'none' | 'fillOnly';
}

type Pt = [number, number];
type ShapeFn = (b: () => VectorPathBuilder, w: number, h: number, st: Style) => ShapePart[];

const main = (b: VectorPathBuilder): ShapePart => ({ d: b.d, fill: 'main' });
const deco = (b: VectorPathBuilder): ShapePart => ({ d: b.d, fill: 'none' });
const poly = (nb: () => VectorPathBuilder, pts: Pt[]) => [main(nb().polyline(pts, true))];

/** 尺寸参数：fixedSize=1 时为像素，否则为比例 */
function size(st: Style, def: number, total: number, defFixed = def * total) {
  const v = num(st.size, NaN);
  if (flag(st.fixedSize)) return Math.min(Number.isFinite(v) ? v : defFixed, total);
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : def)) * total;
}

export function roundRect(b: VectorPathBuilder, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return b.polyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
  return b
    .moveTo(x + r, y)
    .lineTo(x + w - r, y)
    .quadTo(x + w, y, x + w, y + r)
    .lineTo(x + w, y + h - r)
    .quadTo(x + w, y + h, x + w - r, y + h)
    .lineTo(x + r, y + h)
    .quadTo(x, y + h, x, y + h - r)
    .lineTo(x, y + r)
    .quadTo(x, y, x + r, y)
    .close();
}

/** draw.io 圆角半径：arcSize 默认 15（%），absoluteArcSize=1 时为像素直径 */
export function arcRadius(st: Style, w: number, h: number, defArc = 15) {
  const arc = num(st.arcSize, defArc);
  if (flag(st.absoluteArcSize)) return Math.min(w / 2, h / 2, arc / 2);
  return Math.min(w, h) * (arc / 100);
}

function rect(nb: () => VectorPathBuilder, w: number, h: number, st: Style): ShapePart[] {
  return [main(roundRect(nb(), 0, 0, w, h, flag(st.rounded) ? arcRadius(st, w, h) : 0))];
}

function ellipse(b: VectorPathBuilder, cx: number, cy: number, rx: number, ry: number) {
  return b.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2).close();
}

const SHAPES: Record<string, ShapeFn> = {
  rect,
  rectangle: rect,
  label: rect,
  ellipse: (nb, w, h) => [main(ellipse(nb(), w / 2, h / 2, w / 2, h / 2))],
  doubleEllipse: (nb, w, h, st) => {
    const sw = num(st.strokeWidth, 1);
    const inset = Math.min(4 + sw, w / 5, h / 5);
    return [main(ellipse(nb(), w / 2, h / 2, w / 2, h / 2)), deco(ellipse(nb(), w / 2, h / 2, w / 2 - inset, h / 2 - inset))];
  },
  rhombus: (nb, w, h) => poly(nb, [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]),
  triangle: (nb, w, h) => poly(nb, [[0, 0], [w, h / 2], [0, h]]),
  hexagon: (nb, w, h, st) => {
    const s = size(st, 0.25, w, 20);
    return poly(nb, [[s, 0], [w - s, 0], [w, h / 2], [w - s, h], [s, h], [0, h / 2]]);
  },
  parallelogram: (nb, w, h, st) => {
    const s = size(st, 0.2, w, 20);
    return poly(nb, [[0, h], [s, 0], [w, 0], [w - s, h]]);
  },
  trapezoid: (nb, w, h, st) => {
    const s = size(st, 0.2, w, 20);
    return poly(nb, [[0, h], [s, 0], [w - s, 0], [w, h]]);
  },
  step: (nb, w, h, st) => {
    const s = size(st, 0.2, w, 20);
    return poly(nb, [[0, 0], [w - s, 0], [w, h / 2], [w - s, h], [0, h], [s, h / 2]]);
  },
  process: (nb, w, h, st) => {
    const s = size(st, 0.1, w, 20);
    const lines = nb().moveTo(s, 0).lineTo(s, h).moveTo(w - s, 0).lineTo(w - s, h);
    return [...rect(nb, w, h, st), deco(lines)];
  },
  note: (nb, w, h, st) => {
    const s = Math.min(num(st.size, 30), w, h);
    return [main(nb().polyline([[0, 0], [w - s, 0], [w, s], [w, h], [0, h]], true)), deco(nb().polyline([[w - s, 0], [w - s, s], [w, s]]))];
  },
  card: (nb, w, h, st) => {
    const s = Math.min(num(st.size, 30), w, h);
    return poly(nb, [[s, 0], [w, 0], [w, h], [0, h], [0, s]]);
  },
  document: (nb, w, h, st) => {
    const dy = h * Math.max(0, Math.min(1, num(st.size, 0.3)));
    const fy = 1.4;
    const b = nb()
      .moveTo(0, 0)
      .lineTo(w, 0)
      .lineTo(w, h - dy / 2)
      .quadTo((w * 3) / 4, h - dy * fy, w / 2, h - dy / 2)
      .quadTo(w / 4, h - dy * (1 - fy), 0, h - dy / 2)
      .close();
    return [main(b)];
  },
  cylinder: (nb, w, h, st) => cylinder(nb, w, h, Math.min(40, Math.round(h / 5)), st),
  cylinder3: (nb, w, h, st) => cylinder(nb, w, h, Math.min(num(st.size, 15), h / 2), st),
  datastore: (nb, w, h, st) => cylinder(nb, w, h, Math.min(h / 6, 30), st),
  cloud: (nb, w, h) => {
    const b = nb()
      .moveTo(0.25 * w, 0.25 * h)
      .cubicTo(0.05 * w, 0.25 * h, 0, 0.5 * h, 0.16 * w, 0.55 * h)
      .cubicTo(0, 0.66 * h, 0.18 * w, 0.9 * h, 0.31 * w, 0.8 * h)
      .cubicTo(0.4 * w, h, 0.7 * w, h, 0.8 * w, 0.8 * h)
      .cubicTo(w, 0.8 * h, w, 0.6 * h, 0.875 * w, 0.5 * h)
      .cubicTo(w, 0.3 * h, 0.8 * w, 0.1 * h, 0.625 * w, 0.2 * h)
      .cubicTo(0.5 * w, 0.05 * h, 0.3 * w, 0.05 * h, 0.25 * w, 0.25 * h)
      .close();
    return [main(b)];
  },
  actor: (nb, w, h) => {
    const k = w / 3;
    const b = nb()
      .moveTo(0, h)
      .cubicTo(0, (3 * h) / 5, 0, (2 * h) / 5, w / 2, (2 * h) / 5)
      .cubicTo(w / 2 - k, (2 * h) / 5, w / 2 - k, 0, w / 2, 0)
      .cubicTo(w / 2 + k, 0, w / 2 + k, (2 * h) / 5, w / 2, (2 * h) / 5)
      .cubicTo(w, (2 * h) / 5, w, (3 * h) / 5, w, h)
      .close();
    return [main(b)];
  },
  umlActor: (nb, w, h) => {
    const head = ellipse(nb(), w / 2, h / 8, w / 4, h / 8);
    const body = nb()
      .moveTo(w / 2, h / 4)
      .lineTo(w / 2, (2 * h) / 3)
      .moveTo(0, h / 3)
      .lineTo(w, h / 3)
      .moveTo(0, h)
      .lineTo(w / 2, (2 * h) / 3)
      .lineTo(w, h);
    return [main(head), deco(body)];
  },
  line: (nb, w, h) => [deco(nb().moveTo(0, h / 2).lineTo(w, h / 2))],
  callout: (nb, w, h, st) => {
    const s = Math.min(num(st.size, 30), h);
    const base = num(st.base, 20);
    const dx = w * Math.max(0, Math.min(1, num(st.position, 0.5)));
    const dx2 = w * Math.max(0, Math.min(1, num(st.position2, 0.5)));
    return poly(nb, [[0, 0], [w, 0], [w, h - s], [Math.min(w, dx + base), h - s], [dx2, h], [Math.max(0, dx), h - s], [0, h - s]]);
  },
  singleArrow: (nb, w, h, st) => {
    const aw = h * num(st.arrowWidth, 0.3);
    const as = w * num(st.arrowSize, 0.2);
    const y1 = (h - aw) / 2;
    const y2 = (h + aw) / 2;
    return poly(nb, [[0, y1], [w - as, y1], [w - as, 0], [w, h / 2], [w - as, h], [w - as, y2], [0, y2]]);
  },
  doubleArrow: (nb, w, h, st) => {
    const aw = h * num(st.arrowWidth, 0.3);
    const as = w * num(st.arrowSize, 0.2);
    const y1 = (h - aw) / 2;
    const y2 = (h + aw) / 2;
    return poly(nb, [[0, h / 2], [as, 0], [as, y1], [w - as, y1], [w - as, 0], [w, h / 2], [w - as, h], [w - as, y2], [as, y2], [as, h]]);
  },
  cross: (nb, w, h, st) => {
    const s = Math.min(w, h) * Math.max(0, Math.min(1, num(st.size, 0.2)));
    const x1 = (w - s) / 2;
    const x2 = (w + s) / 2;
    const y1 = (h - s) / 2;
    const y2 = (h + s) / 2;
    return poly(nb, [[x1, 0], [x2, 0], [x2, y1], [w, y1], [w, y2], [x2, y2], [x2, h], [x1, h], [x1, y2], [0, y2], [0, y1], [x1, y1]]);
  },
  terminator: (nb, w, h) => [main(roundRect(nb(), 0, 0, w, h, Math.min(w, h) / 2))],
  internalStorage: (nb, w, h, st) => {
    const dx = Math.min(num(st.dx, 20), w);
    const dy = Math.min(num(st.dy, 20), h);
    return [...rect(nb, w, h, st), deco(nb().moveTo(dx, 0).lineTo(dx, h).moveTo(0, dy).lineTo(w, dy))];
  },
  manualInput: (nb, w, h, st) => {
    const s = Math.min(num(st.size, 30), h);
    return poly(nb, [[0, s], [w, 0], [w, h], [0, h]]);
  },
  offPageConnector: (nb, w, h, st) => {
    const s = h * Math.max(0, Math.min(1, num(st.size, 3 / 8)));
    return poly(nb, [[0, 0], [w, 0], [w, h - s], [w / 2, h], [0, h - s]]);
  },
  loopLimit: (nb, w, h, st) => {
    const s = Math.min(num(st.size, 20), w / 2, h);
    return poly(nb, [[s, 0], [w - s, 0], [w, s], [w, h], [0, h], [0, s]]);
  },
  delay: (nb, w, h) => {
    const r = Math.min(w / 2, h / 2);
    const b = nb().moveTo(0, 0).lineTo(w - r, 0).ellipse(w - r, h / 2, r, h / 2, 0, -Math.PI / 2, Math.PI / 2, false, true).lineTo(0, h).close();
    return [main(b)];
  },
  or: (nb, w, h) => [main(nb().moveTo(0, 0).quadTo(w, 0, w, h / 2).quadTo(w, h, 0, h).close())],
  xor: (nb, w, h) => [main(nb().moveTo(0, 0).quadTo(w, 0, w, h / 2).quadTo(w, h, 0, h).quadTo(w / 2, h / 2, 0, 0).close())],
  swimlane: (nb, w, h, st) => {
    const horizontal = st.horizontal !== '0';
    const ss = Math.max(0, num(st.startSize, 23));
    const r = flag(st.rounded) ? arcRadius(st, w, h) : 0;
    const parts: ShapePart[] = [];
    if (horizontal) {
      const hh = Math.min(ss, h);
      parts.push({ d: roundRect(nb(), 0, 0, w, hh, Math.min(r, hh)).d, fill: 'main' });
      if (h > hh) parts.push({ d: nb().polyline([[0, hh], [w, hh], [w, h], [0, h]], true).d, fill: 'alt' });
      if (st.swimlaneLine === '0') return parts;
    } else {
      const ww = Math.min(ss, w);
      parts.push({ d: roundRect(nb(), 0, 0, ww, h, Math.min(r, ww)).d, fill: 'main' });
      if (w > ww) parts.push({ d: nb().polyline([[ww, 0], [w, 0], [w, h], [ww, h]], true).d, fill: 'alt' });
    }
    return parts;
  },
  partialRectangle: (nb, w, h, st) => {
    const fill = nb().polyline([[0, 0], [w, 0], [w, h], [0, h]], true);
    const on = [st.top !== '0', st.right !== '0', st.bottom !== '0', st.left !== '0'];
    const corners: Pt[] = [[0, 0], [w, 0], [w, h], [0, h]];
    const lines = nb();
    for (let i = 0; i < 4; i++) {
      if (!on[i]) continue;
      const a = corners[i];
      const c = corners[(i + 1) % 4];
      if (lines.empty || !on[(i + 3) % 4]) lines.moveTo(a[0], a[1]);
      lines.lineTo(c[0], c[1]);
    }
    const parts: ShapePart[] = [{ d: fill.d, fill: 'fillOnly' }];
    if (!lines.empty) parts.push(deco(lines));
    return parts;
  },
};

function cylinder(nb: () => VectorPathBuilder, w: number, h: number, dy: number, _st: Style): ShapePart[] {
  dy = Math.max(0, Math.min(dy, h / 2));
  const rx = w / 2;
  const body = nb()
    .moveTo(0, dy)
    .lineTo(0, h - dy)
    .ellipse(rx, h - dy, rx, dy, 0, Math.PI, 0, true, true)
    .lineTo(w, dy)
    .ellipse(rx, dy, rx, dy, 0, 0, Math.PI, true, true)
    .close();
  const front = nb().ellipse(rx, dy, rx, dy, 0, Math.PI, 0, true);
  return [main(body), deco(front)];
}

/** 常见扩展形状库的别名 */
const ALIAS: Record<string, string> = {
  'mxgraph.flowchart.process': 'rect',
  'mxgraph.flowchart.decision': 'rhombus',
  'mxgraph.flowchart.terminator': 'terminator',
  'mxgraph.flowchart.start_1': 'ellipse',
  'mxgraph.flowchart.start_2': 'ellipse',
  'mxgraph.flowchart.on-page_reference': 'ellipse',
  'mxgraph.flowchart.document': 'document',
  'mxgraph.flowchart.data': 'parallelogram',
  'mxgraph.flowchart.database': 'cylinder',
  'mxgraph.flowchart.direct_data': 'cylinder',
  'mxgraph.flowchart.stored_data': 'cylinder',
  'mxgraph.flowchart.predefined_process': 'process',
  'mxgraph.flowchart.manual_input': 'manualInput',
  'mxgraph.flowchart.preparation': 'hexagon',
  'mxgraph.flowchart.off-page_reference': 'offPageConnector',
  'mxgraph.flowchart.delay': 'delay',
  'mxgraph.flowchart.extract_or_measurement': 'triangle',
  'mxgraph.flowchart.merge_or_storage': 'triangle',
  'mxgraph.flowchart.internal_storage': 'internalStorage',
  'mxgraph.flowchart.loop_limit': 'loopLimit',
  'mxgraph.basic.rect': 'rect',
  'mxgraph.basic.ellipse': 'ellipse',
  'mxgraph.basic.triangle_acute': 'triangle',
  table: 'rect',
  tableRow: 'partialRectangle',
  cylinder2: 'cylinder3',
  waypoint: 'ellipse',
  // 只用文字、不画形状
  text: 'none',
  edgeLabel: 'none',
};

/** 是否为能识别的形状名（用于样式串中不带 `=` 的段） */
export function isShapeName(name: string) {
  return name in SHAPES || name in ALIAS;
}

export function resolveShapeName(name: string | undefined): string {
  if (!name) return 'rect';
  return ALIAS[name] ?? name;
}

/**
 * 构建形状路径；返回 undefined 表示不支持该形状（调用方退化为矩形）。
 * `w`、`h` 是绘制坐标系中的宽高（direction 为 north/south 时已交换）。
 */
export function buildShape(name: string, w: number, h: number, st: Style, m: VectorMatrix): ShapePart[] | undefined {
  const fn = SHAPES[name];
  if (!fn) return undefined;
  return fn(() => new VectorPathBuilder(m), w, h, st);
}

/** 形状在连线端点计算时使用的周界类型 */
export function perimeterOf(shape: string, st: Style): 'rect' | 'ellipse' | 'rhombus' | 'triangle' {
  const p = st.perimeter;
  if (p) {
    if (/ellipse/i.test(p)) return 'ellipse';
    if (/rhombus/i.test(p)) return 'rhombus';
    if (/triangle/i.test(p)) return 'triangle';
    return 'rect';
  }
  if (shape === 'ellipse' || shape === 'doubleEllipse') return 'ellipse';
  if (shape === 'rhombus') return 'rhombus';
  if (shape === 'triangle') return 'triangle';
  return 'rect';
}
