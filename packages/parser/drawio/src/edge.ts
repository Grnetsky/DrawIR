import { VectorPathBuilder, catmullRomToCubics } from '@drawir/core';

/**
 * 连线几何：端点周界求交、正交/肘形/ER 路由、圆角/曲线路径和箭头。
 * 全部在页面绝对坐标（draw.io 像素）中计算。
 */

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Dir = 'L' | 'R' | 'U' | 'D';
export type Perimeter = 'rect' | 'ellipse' | 'rhombus' | 'triangle';

/** 连线端点：所连接的形状（可选）+ 固定连接点（可选） */
export interface Terminal {
  box?: Rect;
  /** 形状旋转（弧度），绕中心 */
  rot: number;
  perimeter: Perimeter;
  /** 固定连接点（exitX/exitY、entryX/entryY 或悬空端点），绝对坐标 */
  fixed?: Pt;
  /** 固定连接点所在的边（指向形状外） */
  dir?: Dir;
}

const VEC: Record<Dir, Pt> = { L: { x: -1, y: 0 }, R: { x: 1, y: 0 }, U: { x: 0, y: -1 }, D: { x: 0, y: 1 } };
const horiz = (d: Dir) => d === 'L' || d === 'R';
export const center = (b: Rect): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

function rotateAround(p: Pt, c: Pt, a: number): Pt {
  if (!a) return p;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** 固定连接点所在边：离哪条边最近 */
export function sideOf(fx: number, fy: number): Dir {
  const d = [fx, 1 - fx, fy, 1 - fy];
  const i = d.indexOf(Math.min(...d));
  return (['L', 'R', 'U', 'D'] as Dir[])[i];
}

/** 形状边界上的固定点（考虑旋转），比例坐标 + 像素偏移 */
export function fixedPoint(box: Rect, rot: number, fx: number, fy: number, dx = 0, dy = 0): Pt {
  const p = { x: box.x + fx * box.w + dx, y: box.y + fy * box.h + dy };
  return rotateAround(p, center(box), rot);
}

/** 从形状中心指向 `toward` 的射线与周界的交点 */
export function perimeterPoint(t: Terminal, toward: Pt): Pt {
  const b = t.box!;
  const c = center(b);
  const q = rotateAround(toward, c, -t.rot);
  let dx = q.x - c.x;
  let dy = q.y - c.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) dx = 1;
  const hw = b.w / 2;
  const hh = b.h / 2;
  let k: number;
  switch (t.perimeter) {
    case 'ellipse':
      k = hw && hh ? 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh)) : 0;
      break;
    case 'rhombus':
      k = hw && hh ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh) : 0;
      break;
    case 'triangle': {
      // 默认朝东的三角形（以中心为原点）：左边 x = -hw；斜边 |y|/hh + x/(2hw) = 1/2
      const kl = dx < 0 ? -hw / dx : Infinity;
      const den = hw && hh ? Math.abs(dy) / hh + dx / (2 * hw) : 0;
      const ks = den > 0 ? 0.5 / den : Infinity;
      k = Math.min(kl, ks);
      break;
    }
    default: {
      const kx = dx ? hw / Math.abs(dx) : Infinity;
      const ky = dy ? hh / Math.abs(dy) : Infinity;
      k = Math.min(kx, ky);
    }
  }
  if (!Number.isFinite(k)) k = 0;
  return rotateAround({ x: c.x + dx * k, y: c.y + dy * k }, c, t.rot);
}

/** 端点参考位置：固定点 > 形状中心 */
function anchor(t: Terminal): Pt | undefined {
  return t.fixed ?? (t.box ? center(t.box) : undefined);
}

/** 直线连线：两端投影到周界 */
export function straightRoute(s: Terminal, e: Terminal, wps: Pt[]): Pt[] | undefined {
  const sa = anchor(s);
  const ea = anchor(e);
  if (!sa || !ea) return undefined;
  const p0 = s.fixed ?? perimeterPoint(s, wps[0] ?? ea);
  const pn = e.fixed ?? perimeterPoint(e, wps[wps.length - 1] ?? sa);
  return [p0, ...wps, pn];
}

function gap(a: Rect, b: Rect) {
  return {
    gx: Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)),
    gy: Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)),
  };
}

const pointBox = (p: Pt): Rect => ({ x: p.x, y: p.y, w: 0, h: 0 });

/** 端点所在的边与端口位置，`axis` 强制水平/竖直 */
function autoPort(t: Terminal, other: Rect, axis?: 'h' | 'v'): { p: Pt; d: Dir } {
  if (t.fixed) return { p: t.fixed, d: t.dir ?? 'R' };
  const b = t.box!;
  const c = center(b);
  const oc = center(other);
  const { gx, gy } = gap(b, other);
  const useH = axis ? axis === 'h' : gx >= gy;
  if (useH) {
    const d: Dir = oc.x >= c.x ? 'R' : 'L';
    return { p: { x: d === 'R' ? b.x + b.w : b.x, y: c.y }, d };
  }
  const d: Dir = oc.y >= c.y ? 'D' : 'U';
  return { p: { x: c.x, y: d === 'D' ? b.y + b.h : b.y }, d };
}

/** 两个带方向端口之间的正交连线 */
function connect(p1: Pt, d1: Dir, p2: Pt, d2: Dir, jetty = 20): Pt[] {
  const v1 = VEC[d1];
  const v2 = VEC[d2];
  const h1 = horiz(d1);
  const h2 = horiz(d2);
  if (h1 && h2 && v1.x === -v2.x && (p2.x - p1.x) * v1.x > 0) {
    const mx = (p1.x + p2.x) / 2;
    return [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2];
  }
  if (!h1 && !h2 && v1.y === -v2.y && (p2.y - p1.y) * v1.y > 0) {
    const my = (p1.y + p2.y) / 2;
    return [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2];
  }
  if (h1 && !h2) {
    const c = { x: p2.x, y: p1.y };
    if ((c.x - p1.x) * v1.x > 0 && (c.y - p2.y) * v2.y > 0) return [p1, c, p2];
  }
  if (!h1 && h2) {
    const c = { x: p1.x, y: p2.y };
    if ((c.y - p1.y) * v1.y > 0 && (c.x - p2.x) * v2.x > 0) return [p1, c, p2];
  }
  // 兜底：两端各伸出一段，再用一个拐角连接
  const a = { x: p1.x + v1.x * jetty, y: p1.y + v1.y * jetty };
  const b = { x: p2.x + v2.x * jetty, y: p2.y + v2.y * jetty };
  const x = h1 ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
  return [p1, a, x, b, p2];
}

/**
 * 正交路由（orthogonalEdgeStyle / elbowEdgeStyle / segmentEdgeStyle 等）。
 * 没有途经点时按两形状的相对位置自动选边；有途经点时依次经过途经点，必要时插入拐角。
 */
export function orthogonalRoute(s: Terminal, e: Terminal, wps: Pt[], axis?: 'h' | 'v'): Pt[] | undefined {
  const sa = anchor(s);
  const ea = anchor(e);
  if (!sa || !ea) return undefined;
  const sBox = s.box ?? pointBox(sa);
  const eBox = e.box ?? pointBox(ea);

  if (!wps.length) {
    // 两个形状都未固定连接点、且在一个方向上有重叠：直接一条水平/竖直线
    if (!s.fixed && !e.fixed && s.box && e.box) {
      const { gx, gy } = gap(sBox, eBox);
      const top = Math.max(sBox.y, eBox.y);
      const bottom = Math.min(sBox.y + sBox.h, eBox.y + eBox.h);
      const left = Math.max(sBox.x, eBox.x);
      const right = Math.min(sBox.x + sBox.w, eBox.x + eBox.w);
      if (gx > 0 && bottom >= top && axis !== 'v') {
        const y = (top + bottom) / 2;
        const toRight = eBox.x > sBox.x;
        return [
          { x: toRight ? sBox.x + sBox.w : sBox.x, y },
          { x: toRight ? eBox.x : eBox.x + eBox.w, y },
        ];
      }
      if (gy > 0 && right >= left && axis !== 'h') {
        const x = (left + right) / 2;
        const down = eBox.y > sBox.y;
        return [
          { x, y: down ? sBox.y + sBox.h : sBox.y },
          { x, y: down ? eBox.y : eBox.y + eBox.h },
        ];
      }
      if (gx <= 0 && gy <= 0) return straightRoute(s, e, wps);
    }
    const a = s.box ? autoPort(s, e.fixed ? pointBox(e.fixed) : eBox, axis) : { p: sa, d: autoDir(sa, ea, axis) };
    const b = e.box ? autoPort(e, s.fixed ? pointBox(s.fixed) : sBox, axis) : { p: ea, d: autoDir(ea, sa, axis) };
    return simplify(connect(a.p, a.d, b.p, b.d));
  }

  const first = wps[0];
  const last = wps[wps.length - 1];
  const a = s.box ? portToward(s, first) : { p: sa, d: autoDir(sa, first) };
  const b = e.box ? portToward(e, last) : { p: ea, d: autoDir(ea, last) };
  const out: Pt[] = [a.p];
  let h = horiz(a.d);
  for (const q of wps) {
    const cur = out[out.length - 1];
    if (Math.abs(cur.x - q.x) > 1e-6 && Math.abs(cur.y - q.y) > 1e-6) {
      out.push(h ? { x: q.x, y: cur.y } : { x: cur.x, y: q.y });
    } else {
      h = Math.abs(cur.y - q.y) <= 1e-6;
    }
    out.push(q);
    h = !h;
  }
  // 最后一段沿目标端口方向进入
  const cur = out[out.length - 1];
  if (Math.abs(cur.x - b.p.x) > 1e-6 && Math.abs(cur.y - b.p.y) > 1e-6) {
    out.push(horiz(b.d) ? { x: cur.x, y: b.p.y } : { x: b.p.x, y: cur.y });
  }
  out.push(b.p);
  return simplify(out);
}

function autoDir(p: Pt, toward: Pt, axis?: 'h' | 'v'): Dir {
  const dx = toward.x - p.x;
  const dy = toward.y - p.y;
  const useH = axis ? axis === 'h' : Math.abs(dx) >= Math.abs(dy);
  return useH ? (dx >= 0 ? 'R' : 'L') : dy >= 0 ? 'D' : 'U';
}

/** 朝向途经点的端口：途经点在形状的水平/竖直投影内时，端口与之对齐 */
function portToward(t: Terminal, q: Pt): { p: Pt; d: Dir } {
  if (t.fixed) return { p: t.fixed, d: t.dir ?? autoDir(t.fixed, q) };
  const b = t.box!;
  if (q.x >= b.x && q.x <= b.x + b.w && (q.y < b.y || q.y > b.y + b.h)) {
    const d: Dir = q.y < b.y ? 'U' : 'D';
    return { p: { x: q.x, y: d === 'U' ? b.y : b.y + b.h }, d };
  }
  if (q.y >= b.y && q.y <= b.y + b.h && (q.x < b.x || q.x > b.x + b.w)) {
    const d: Dir = q.x < b.x ? 'L' : 'R';
    return { p: { x: d === 'L' ? b.x : b.x + b.w, y: q.y }, d };
  }
  return autoPort(t, pointBox(q));
}

const contains = (b: Rect, x: number, y: number) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

/**
 * 肘形连线（elbowEdgeStyle / sideToSideEdgeStyle / topToBottomEdgeStyle），
 * 与 mxGraph 的 ElbowConnector / SideToSide / TopToBottom 规则一致：
 * 至多一个途经点作为肘部位置；拐点落在形状内部时省略（此时可能退化为直线）。
 * `mode`：'elbow-h' / 'elbow-v' 按 elbow 样式自动判断，'h' / 'v' 强制方向。
 */
export function elbowRoute(s: Terminal, e: Terminal, wps: Pt[], mode: 'elbow-h' | 'elbow-v' | 'h' | 'v'): Pt[] | undefined {
  const sa = anchor(s);
  const ea = anchor(e);
  if (!sa || !ea) return undefined;
  const sb = s.fixed || !s.box ? pointBox(sa) : s.box;
  const tb = e.fixed || !e.box ? pointBox(ea) : e.box;
  const pt = wps[0];
  let vertical = mode === 'v';
  if (mode === 'elbow-h' || mode === 'elbow-v') {
    let forceV = false;
    let forceH = false;
    if (pt) {
      const left = Math.min(sb.x, tb.x);
      const right = Math.max(sb.x + sb.w, tb.x + tb.w);
      const top = Math.min(sb.y, tb.y);
      const bottom = Math.max(sb.y + sb.h, tb.y + tb.h);
      forceV = pt.y < top || pt.y > bottom;
      forceH = pt.x < left || pt.x > right;
    } else {
      const left = Math.max(sb.x, tb.x);
      const right = Math.min(sb.x + sb.w, tb.x + tb.w);
      forceV = right === left;
      if (!forceV) forceH = Math.min(sb.y + sb.h, tb.y + tb.h) === Math.max(sb.y, tb.y);
    }
    vertical = !forceH && (forceV || mode === 'elbow-v');
  }
  const out: Pt[] = [];
  const push = (x: number, y: number) => {
    if (!contains(sb, x, y) && !contains(tb, x, y)) out.push({ x, y });
  };
  const sc = center(sb);
  const tc = center(tb);
  if (vertical) {
    const t = Math.max(sb.y, tb.y);
    const b = Math.min(sb.y + sb.h, tb.y + tb.h);
    let x = pt && pt.x >= sb.x && pt.x <= sb.x + sb.w ? pt.x : sc.x;
    const y = pt ? pt.y : Math.round(b + (t - b) / 2);
    push(x, y);
    x = pt && pt.x >= tb.x && pt.x <= tb.x + tb.w ? pt.x : tc.x;
    push(x, y);
    if (out.length === 1) {
      if (pt) push(x, pt.y);
      else {
        const l = Math.max(sb.x, tb.x);
        const r = Math.min(sb.x + sb.w, tb.x + tb.w);
        out.push({ x: l + (r - l) / 2, y });
      }
    }
  } else {
    const l = Math.max(sb.x, tb.x);
    const r = Math.min(sb.x + sb.w, tb.x + tb.w);
    const x = pt ? pt.x : Math.round(r + (l - r) / 2);
    let y1 = sc.y;
    let y2 = tc.y;
    if (pt) {
      if (pt.y >= sb.y && pt.y <= sb.y + sb.h) y1 = pt.y;
      if (pt.y >= tb.y && pt.y <= tb.y + tb.h) y2 = pt.y;
    }
    push(x, y1);
    push(x, y2);
    if (out.length === 1) {
      if (pt) push(pt.x, y2);
      else {
        const t = Math.max(sb.y, tb.y);
        const b = Math.min(sb.y + sb.h, tb.y + tb.h);
        out.push({ x, y: t + (b - t) / 2 });
      }
    }
  }
  const p0 = s.fixed ?? perimeterPoint(s, out[0] ?? ea);
  const pn = e.fixed ?? perimeterPoint(e, out[out.length - 1] ?? sa);
  return simplify([p0, ...out, pn]);
}

/** 实体关系连线：两端水平伸出 segment 后直连 */
export function entityRelationRoute(s: Terminal, e: Terminal, segment: number): Pt[] | undefined {
  const sa = anchor(s);
  const ea = anchor(e);
  if (!sa || !ea) return undefined;
  const side = (t: Terminal, other: Pt): { p: Pt; d: Dir } => {
    if (t.fixed) return { p: t.fixed, d: t.dir && horiz(t.dir) ? t.dir : other.x >= t.fixed.x ? 'R' : 'L' };
    const b = t.box!;
    const c = center(b);
    const d: Dir = other.x >= c.x ? 'R' : 'L';
    return { p: { x: d === 'R' ? b.x + b.w : b.x, y: c.y }, d };
  };
  const a = side(s, ea);
  const b = side(e, sa);
  const va = VEC[a.d];
  const vb = VEC[b.d];
  return simplify([a.p, { x: a.p.x + va.x * segment, y: a.p.y }, { x: b.p.x + vb.x * segment, y: b.p.y }, b.p]);
}

/** 自环：从右侧伸出再绕回 */
export function loopRoute(t: Terminal, size = 20): Pt[] | undefined {
  if (!t.box) return undefined;
  const b = t.box;
  const c = center(b);
  const dy = Math.min(b.h / 4, size / 2);
  const x = b.x + b.w;
  return [
    { x, y: c.y - dy },
    { x: x + size, y: c.y - dy },
    { x: x + size, y: c.y + dy },
    { x, y: c.y + dy },
  ];
}

/** 去掉重复点和共线中间点 */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const cross = (last.x - a.x) * (p.y - a.y) - (last.y - a.y) * (p.x - a.x);
      const dot = (last.x - a.x) * (p.x - last.x) + (last.y - a.y) * (p.y - last.y);
      if (Math.abs(cross) < 1e-6 && dot >= 0) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** 连线路径：直线折线 / 圆角折线 / 平滑曲线 */
export function edgePath(pts: Pt[], mode: 'line' | 'rounded' | 'curved', radius: number): number[] {
  const b = new VectorPathBuilder();
  b.moveTo(pts[0].x, pts[0].y);
  if (mode === 'curved' && pts.length > 2) {
    for (const c of catmullRomToCubics(pts.map((p) => [p.x, p.y] as [number, number]))) {
      b.cubicTo(c[0], c[1], c[2], c[3], c[4], c[5]);
    }
    return b.d;
  }
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (mode === 'rounded' && i < pts.length - 1) {
      const a = pts[i - 1];
      const n = pts[i + 1];
      const l1 = Math.hypot(p.x - a.x, p.y - a.y);
      const l2 = Math.hypot(n.x - p.x, n.y - p.y);
      const r = Math.min(radius, l1 / 2, l2 / 2);
      if (r > 0) {
        b.lineTo(p.x - ((p.x - a.x) / l1) * r, p.y - ((p.y - a.y) / l1) * r);
        b.quadTo(p.x, p.y, p.x + ((n.x - p.x) / l2) * r, p.y + ((n.y - p.y) / l2) * r);
        continue;
      }
    }
    b.lineTo(p.x, p.y);
  }
  return b.d;
}

/** 折线上按比例取点（t ∈ [0, 1]），并返回该处的单位方向 */
export function pointAlong(pts: Pt[], t: number): { p: Pt; ux: number; uy: number } {
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    lens.push(l);
    total += l;
  }
  let dist = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < lens.length; i++) {
    const l = lens[i];
    if (dist <= l || i === lens.length - 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const f = l ? Math.min(1, dist / l) : 0;
      return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, ux: l ? (b.x - a.x) / l : 1, uy: l ? (b.y - a.y) / l : 0 };
    }
    dist -= l;
  }
  return { p: pts[0], ux: 1, uy: 0 };
}

// ---------------------------------------------------------------------------
// 箭头
// ---------------------------------------------------------------------------

export interface Marker {
  d: number[];
  filled: boolean;
  /** 填充色用背景色（空心圆等需要遮住连线的标记） */
  bgFill?: boolean;
}

export interface MarkerResult {
  markers: Marker[];
  /** 连线端点需要后退的距离（箭头底部） */
  back: number;
  known: boolean;
}

/**
 * 在端点 `tip` 处绘制箭头。(ux, uy) 是指向 tip 的单位方向，size 为 draw.io 的 startSize/endSize。
 */
export function marker(type: string, tip: Pt, ux: number, uy: number, size: number, sw: number, fill: boolean): MarkerResult {
  const s = size + sw;
  const nx = -uy;
  const ny = ux;
  const P = (along: number, side: number): [number, number] => [tip.x - ux * along + nx * side, tip.y - uy * along + ny * side];
  const T: [number, number] = [tip.x, tip.y];
  const b = () => new VectorPathBuilder();
  const res = (markers: Marker[], back: number): MarkerResult => ({ markers, back, known: true });
  const bar = (along: number, half = s / 2) => {
    const [x1, y1] = P(along, half);
    const [x2, y2] = P(along, -half);
    return { d: b().moveTo(x1, y1).lineTo(x2, y2).d, filled: false };
  };
  const foot = () => ({ d: b().polyline([P(0, s / 2), P(s, 0), P(0, -s / 2)]).d, filled: false });
  const circle = (along: number, r: number): Marker => {
    const [cx, cy] = P(along, 0);
    return { d: b().ellipse(cx, cy, r, r, 0, 0, Math.PI * 2).close().d, filled: true, bgFill: true };
  };
  switch (type) {
    case 'classic':
    case 'classicThin': {
      const f = type === 'classic' ? 2 : 3;
      return res([{ d: b().polyline([T, P(s, s / f), P((s * 3) / 4, 0), P(s, -s / f)], true).d, filled: fill }], (s * 3) / 4);
    }
    case 'block':
    case 'blockThin': {
      const f = type === 'block' ? 2 : 3;
      return res([{ d: b().polyline([T, P(s, s / f), P(s, -s / f)], true).d, filled: fill }], s);
    }
    case 'open':
    case 'openThin': {
      const f = type === 'open' ? 2 : 3;
      return res([{ d: b().polyline([P(s, s / f), T, P(s, -s / f)]).d, filled: false }], sw / 2);
    }
    case 'async':
      return res([{ d: b().polyline([T, P(s, s / 2), P(s, 0)], true).d, filled: fill }], s);
    case 'oval': {
      const [cx, cy] = P(s / 2, 0);
      return res([{ d: b().ellipse(cx, cy, s / 2, s / 2, 0, 0, Math.PI * 2).close().d, filled: fill }], s);
    }
    case 'diamond':
    case 'diamondThin': {
      const f = type === 'diamond' ? 2 : 3;
      return res([{ d: b().polyline([T, P(s / 2, s / f), P(s, 0), P(s / 2, -s / f)], true).d, filled: fill }], s);
    }
    case 'box':
      return res([{ d: b().polyline([P(0, s / 2), P(s, s / 2), P(s, -s / 2), P(0, -s / 2)], true).d, filled: fill }], s);
    case 'dash':
      return res([{ d: b().moveTo(...P(s / 2, s / 2)).lineTo(...P(-s / 2, -s / 2)).d, filled: false }], 0);
    case 'cross': {
      const h = s / 2;
      const m = b().moveTo(...P(0, h)).lineTo(...P(s, -h)).moveTo(...P(0, -h)).lineTo(...P(s, h));
      return res([{ d: m.d, filled: false }], 0);
    }
    case 'halfCircle': {
      const [cx, cy] = P(s / 2, 0);
      const a = Math.atan2(uy, ux);
      return res([{ d: b().ellipse(cx, cy, s / 2, s / 2, 0, a - Math.PI / 2, a + Math.PI / 2).d, filled: false }], 0);
    }
    case 'ERone':
      return res([bar(s / 2)], 0);
    case 'ERmandOne':
      return res([bar(s / 2), bar((s * 3) / 4)], 0);
    case 'ERmany':
      return res([foot()], 0);
    case 'ERoneToMany':
      return res([foot(), bar(s * 1.25)], 0);
    case 'ERzeroToMany':
      return res([foot(), circle(s * 1.5, s / 3)], 0);
    case 'ERzeroToOne':
      return res([bar(s / 2), circle(s * 1.25, s / 3)], 0);
    default: {
      const r = marker('classic', tip, ux, uy, size, sw, fill);
      return { ...r, known: false };
    }
  }
}
