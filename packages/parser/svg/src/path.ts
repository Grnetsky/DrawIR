/**
 * SVG 路径数据：解析 d / points 为绝对坐标的规范化指令（H/V → L，S → C，T → Q，相对 → 绝对），
 * 再写入 VectorPathBuilder（端点参数圆弧换成圆心参数，交给 IR 的 ellipse 指令）。
 * 同时提供标记（marker）需要的顶点与切线方向。
 */
import type { VectorPathBuilder } from '@drawir/core';

export type Seg =
  | { c: 'M'; x: number; y: number }
  | { c: 'L'; x: number; y: number }
  | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: 'Q'; x1: number; y1: number; x: number; y: number }
  | { c: 'A'; rx: number; ry: number; phi: number; large: boolean; sweep: boolean; x: number; y: number }
  | { c: 'Z' };

const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

class Scanner {
  i = 0;
  constructor(private s: string) {}
  private skip() {
    const s = this.s;
    while (this.i < s.length && (s[this.i] === ',' || s[this.i] === ' ' || s[this.i] === '\n' || s[this.i] === '\r' || s[this.i] === '\t' || s[this.i] === '\f')) this.i++;
  }
  get done() {
    this.skip();
    return this.i >= this.s.length;
  }
  peek() {
    this.skip();
    return this.s[this.i];
  }
  isNumber() {
    const c = this.peek();
    return c !== undefined && /[\d.+-]/.test(c);
  }
  number(): number {
    this.skip();
    const m = NUM.exec(this.s.slice(this.i, this.i + 40));
    if (!m) throw new Error(`invalid number at ${this.i}`);
    this.i += m[0].length;
    return parseFloat(m[0]);
  }
  /** 圆弧标志位只有一个字符，可以与后面的数字紧挨（a1 1 0 00 1 1） */
  flag(): boolean {
    this.skip();
    const c = this.s[this.i];
    if (c !== '0' && c !== '1') throw new Error(`invalid flag at ${this.i}`);
    this.i++;
    return c === '1';
  }
  command() {
    this.skip();
    return this.s[this.i++];
  }
}

/** 解析 path 的 d 属性。遇到错误时保留出错前的部分（与浏览器行为一致） */
export function parsePath(d: string | undefined): Seg[] {
  const out: Seg[] = [];
  if (!d) return out;
  const sc = new Scanner(d);
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  /** 上一条三次 / 二次曲线的第二控制点（用于 S / T 反射） */
  let cx = 0;
  let cy = 0;
  let prev = '';
  let cmd = '';
  try {
    while (!sc.done) {
      if (!sc.isNumber()) cmd = sc.command();
      else if (!cmd) throw new Error('path must start with a command');
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      switch (C) {
        case 'M': {
          x = ox + sc.number();
          y = oy + sc.number();
          out.push({ c: 'M', x, y });
          sx = x;
          sy = y;
          // 后续的隐式坐标对按 lineTo 处理
          cmd = rel ? 'l' : 'L';
          prev = 'M';
          continue;
        }
        case 'L':
          x = ox + sc.number();
          y = oy + sc.number();
          out.push({ c: 'L', x, y });
          break;
        case 'H':
          x = ox + sc.number();
          out.push({ c: 'L', x, y });
          break;
        case 'V':
          y = oy + sc.number();
          out.push({ c: 'L', x, y });
          break;
        case 'C': {
          const x1 = ox + sc.number();
          const y1 = oy + sc.number();
          const x2 = ox + sc.number();
          const y2 = oy + sc.number();
          x = ox + sc.number();
          y = oy + sc.number();
          out.push({ c: 'C', x1, y1, x2, y2, x, y });
          cx = x2;
          cy = y2;
          break;
        }
        case 'S': {
          const x1 = prev === 'C' ? 2 * x - cx : x;
          const y1 = prev === 'C' ? 2 * y - cy : y;
          const x2 = ox + sc.number();
          const y2 = oy + sc.number();
          x = ox + sc.number();
          y = oy + sc.number();
          out.push({ c: 'C', x1, y1, x2, y2, x, y });
          cx = x2;
          cy = y2;
          break;
        }
        case 'Q': {
          const x1 = ox + sc.number();
          const y1 = oy + sc.number();
          x = ox + sc.number();
          y = oy + sc.number();
          out.push({ c: 'Q', x1, y1, x, y });
          cx = x1;
          cy = y1;
          break;
        }
        case 'T': {
          const x1 = prev === 'Q' ? 2 * x - cx : x;
          const y1 = prev === 'Q' ? 2 * y - cy : y;
          x = ox + sc.number();
          y = oy + sc.number();
          out.push({ c: 'Q', x1, y1, x, y });
          cx = x1;
          cy = y1;
          break;
        }
        case 'A': {
          const rx = Math.abs(sc.number());
          const ry = Math.abs(sc.number());
          const phi = sc.number();
          const large = sc.flag();
          const sweep = sc.flag();
          x = ox + sc.number();
          y = oy + sc.number();
          out.push({ c: 'A', rx, ry, phi, large, sweep, x, y });
          break;
        }
        case 'Z':
          out.push({ c: 'Z' });
          x = sx;
          y = sy;
          prev = 'Z';
          // Z 不带参数：后面紧跟数字视为错误
          cmd = '';
          continue;
        default:
          throw new Error(`unknown command ${cmd}`);
      }
      // S/T 只反射同类曲线
      prev = C === 'C' || C === 'S' ? 'C' : C === 'Q' || C === 'T' ? 'Q' : C;
    }
  } catch {
    // 截断到出错位置
  }
  return out;
}

/** polyline / polygon 的 points；奇数个数字时丢弃最后一个 */
export function parsePoints(s: string | undefined): [number, number][] {
  const nums = (s || '').match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g)?.map(Number) || [];
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

export function pointsToSegs(pts: [number, number][], closed: boolean): Seg[] {
  if (!pts.length) return [];
  const segs: Seg[] = [{ c: 'M', x: pts[0][0], y: pts[0][1] }];
  for (let i = 1; i < pts.length; i++) segs.push({ c: 'L', x: pts[i][0], y: pts[i][1] });
  closed && segs.push({ c: 'Z' });
  return segs;
}

/** 矩形（含圆角），起点与浏览器一致：左上圆角结束处，顺时针 */
export function rectSegs(x: number, y: number, w: number, h: number, rx: number, ry: number): Seg[] {
  if (!(w > 0 && h > 0)) return [];
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  if (!(rx > 0 && ry > 0)) {
    return [{ c: 'M', x, y }, { c: 'L', x: x + w, y }, { c: 'L', x: x + w, y: y + h }, { c: 'L', x, y: y + h }, { c: 'Z' }];
  }
  const a = (x2: number, y2: number): Seg => ({ c: 'A', rx, ry, phi: 0, large: false, sweep: true, x: x2, y: y2 });
  return [
    { c: 'M', x: x + rx, y },
    { c: 'L', x: x + w - rx, y },
    a(x + w, y + ry),
    { c: 'L', x: x + w, y: y + h - ry },
    a(x + w - rx, y + h),
    { c: 'L', x: x + rx, y: y + h },
    a(x, y + h - ry),
    { c: 'L', x, y: y + ry },
    a(x + rx, y),
    { c: 'Z' },
  ];
}

export function ellipseSegs(cx: number, cy: number, rx: number, ry: number): Seg[] {
  if (!(rx > 0 && ry > 0)) return [];
  const a = (x: number, y: number): Seg => ({ c: 'A', rx, ry, phi: 0, large: false, sweep: true, x, y });
  return [{ c: 'M', x: cx + rx, y: cy }, a(cx, cy + ry), a(cx - rx, cy), a(cx, cy - ry), a(cx + rx, cy), { c: 'Z' }];
}

export interface CenterArc {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** 弧度 */
  phi: number;
  start: number;
  /** 扫过的角度，负数为逆时针（Y 向下的屏幕坐标中） */
  sweep: number;
}

/** SVG 端点参数圆弧 → 圆心参数（SVG 1.1 实现说明 F.6.5、F.6.6）；半径为 0 或端点重合时返回 undefined */
export function arcToCenter(x1: number, y1: number, a: Extract<Seg, { c: 'A' }>): CenterArc | undefined {
  const { x: x2, y: y2 } = a;
  if (x1 === x2 && y1 === y2) return undefined;
  let rx = a.rx;
  let ry = a.ry;
  if (!(rx > 0 && ry > 0)) return undefined;
  const phi = (a.phi * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    rx *= k;
    ry *= k;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = den > 0 ? Math.sqrt(Math.max(0, num / den)) : 0;
  a.large === a.sweep && (coef = -coef);
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const start = ang(1, 0, ux, uy);
  let sweep = ang(ux, uy, vx, vy);
  if (!a.sweep && sweep > 0) sweep -= Math.PI * 2;
  else if (a.sweep && sweep < 0) sweep += Math.PI * 2;
  return { cx, cy, rx, ry, phi, start, sweep };
}

/** 规范化指令 → IR 路径（坐标经 builder 的矩阵换算） */
export function emitSegs(segs: Seg[], b: VectorPathBuilder) {
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let open = false;
  for (const s of segs) {
    switch (s.c) {
      case 'M':
        b.moveTo(s.x, s.y);
        x = sx = s.x;
        y = sy = s.y;
        open = true;
        continue;
      case 'Z':
        open && b.close();
        x = sx;
        y = sy;
        // 闭合后再画需要回到子路径起点
        open = false;
        continue;
    }
    if (!open) {
      b.moveTo(x, y);
      sx = x;
      sy = y;
      open = true;
    }
    switch (s.c) {
      case 'L':
        b.lineTo(s.x, s.y);
        break;
      case 'C':
        b.cubicTo(s.x1, s.y1, s.x2, s.y2, s.x, s.y);
        break;
      case 'Q':
        b.quadTo(s.x1, s.y1, s.x, s.y);
        break;
      case 'A': {
        const arc = arcToCenter(x, y, s);
        if (!arc) {
          (x !== s.x || y !== s.y) && b.lineTo(s.x, s.y);
          break;
        }
        b.ellipse(arc.cx, arc.cy, arc.rx, arc.ry, arc.phi, arc.start, arc.start + arc.sweep, arc.sweep < 0, true);
        break;
      }
    }
    x = s.x;
    y = s.y;
  }
}

export interface Vertex {
  x: number;
  y: number;
  /** 进入、离开该顶点的方向（弧度） */
  dirIn?: number;
  dirOut?: number;
}

/** 标记用的顶点：每个子路径起点、每段终点；方向为线段在端点处的切线 */
export function pathVertices(segs: Seg[]): Vertex[] {
  const out: Vertex[] = [];
  let x = 0;
  let y = 0;
  let first: Vertex | undefined;
  const dir = (dx: number, dy: number) => (dx || dy ? Math.atan2(dy, dx) : undefined);
  const pick = (...ds: (number | undefined)[]) => ds.find((d) => d !== undefined);
  for (const s of segs) {
    const last = out[out.length - 1];
    if (s.c === 'M') {
      first = { x: s.x, y: s.y };
      out.push(first);
      x = s.x;
      y = s.y;
      continue;
    }
    if (s.c === 'Z') {
      if (!first) continue;
      const d = dir(first.x - x, first.y - y);
      if (d !== undefined) {
        last && (last.dirOut = d);
        out.push({ x: first.x, y: first.y, dirIn: d, dirOut: first.dirOut });
        first.dirIn = d;
      } else if (last) {
        last.dirOut = first.dirOut;
        first.dirIn = last.dirIn;
      }
      x = first.x;
      y = first.y;
      continue;
    }
    let d0: number | undefined;
    let d1: number | undefined;
    if (s.c === 'L') d0 = d1 = dir(s.x - x, s.y - y);
    else if (s.c === 'C') {
      d0 = pick(dir(s.x1 - x, s.y1 - y), dir(s.x2 - x, s.y2 - y), dir(s.x - x, s.y - y));
      d1 = pick(dir(s.x - s.x2, s.y - s.y2), dir(s.x - s.x1, s.y - s.y1), dir(s.x - x, s.y - y));
    } else if (s.c === 'Q') {
      d0 = pick(dir(s.x1 - x, s.y1 - y), dir(s.x - x, s.y - y));
      d1 = pick(dir(s.x - s.x1, s.y - s.y1), dir(s.x - x, s.y - y));
    } else {
      const arc = arcToCenter(x, y, s);
      if (arc) {
        const tangent = (t: number) => {
          const sign = arc.sweep < 0 ? -1 : 1;
          const c = Math.cos(arc.phi);
          const n = Math.sin(arc.phi);
          return dir(sign * (-arc.rx * Math.sin(t) * c - arc.ry * Math.cos(t) * n), sign * (-arc.rx * Math.sin(t) * n + arc.ry * Math.cos(t) * c));
        };
        d0 = tangent(arc.start);
        d1 = tangent(arc.start + arc.sweep);
      } else d0 = d1 = dir(s.x - x, s.y - y);
    }
    if (last && d0 !== undefined) last.dirOut = d0;
    out.push({ x: s.x, y: s.y, dirIn: d1 });
    x = s.x;
    y = s.y;
  }
  return out;
}

/** 两个方向的角平分线 */
export function bisect(a: number | undefined, b: number | undefined): number {
  if (a === undefined) return b ?? 0;
  if (b === undefined) return a;
  return Math.atan2(Math.sin(a) + Math.sin(b), Math.cos(a) + Math.cos(b));
}
