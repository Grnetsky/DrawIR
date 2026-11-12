import {
  circleFrom3Points,
  sampleNurbs,
  VectorMatrix,
  VectorPathBuilder,
} from '@drawir/core';
import type { Row, Section } from './sheet';

/**
 * Visio 几何段 → IR 路径。
 *
 * 坐标：几何行的 X/Y 是形状局部坐标（英寸，原点在形状左下角，Y 向上）；Rel* 行是相对宽高的比例。
 * 调用方传入矩阵 m：局部坐标 → 输出坐标（含 Y 翻转、旋转、翻转、页面位置），构建器统一换算。
 *
 * 与 V1 的差异：V1 把 ArcTo / EllipticalArcTo 留到渲染时，按「上一个点」临时求解，坐标还要乘 100 换算；
 * 这里在解析期把所有弧求成标准椭圆弧 / 贝塞尔，IR 只剩基础指令，渲染器不需要知道 Visio。
 */
export interface GeometryResult {
  d: number[];
  noFill: boolean;
  noLine: boolean;
  /** 是否有闭合子路径（决定能否填充） */
  closed: boolean;
}

const num = (r: Row, n: string, def = 0) => {
  const v = r.cells[n]?.V;
  if (v === undefined || v === '') return def;
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : def;
};

/** 解析 NURBS(knotLast, degree, xType, yType, x1,y1,knot1,weight1, ...) */
function parseNurbsFormula(s: string | undefined) {
  const m = /NURBS\(([^)]*)\)/i.exec(s || '');
  if (!m) return undefined;
  const v = m[1].split(',').map((x) => parseFloat(x));
  if (v.length < 4 || v.some((x) => !Number.isFinite(x))) return undefined;
  const [knotLast, degree, xType, yType] = v;
  const pts: { x: number; y: number; knot: number; w: number }[] = [];
  for (let i = 4; i + 3 < v.length; i += 4) {
    pts.push({ x: v[i], y: v[i + 1], knot: v[i + 2], w: v[i + 3] });
  }
  return { knotLast, degree: Math.round(degree), xType, yType, pts };
}

/** 解析 POLYLINE(xType, yType, x1,y1, x2,y2, ...) */
function parsePolylineFormula(s: string | undefined) {
  const m = /POLYLINE\(([^)]*)\)/i.exec(s || '');
  if (!m) return undefined;
  const v = m[1].split(',').map((x) => parseFloat(x));
  if (v.length < 2) return undefined;
  const [xType, yType] = v;
  const pts: [number, number][] = [];
  for (let i = 2; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
  return { xType, yType, pts };
}

/**
 * 由起点、终点、弧上一点（控制点）、长轴角度、长短轴比求椭圆弧。
 * 做法：先把坐标系旋转到长轴水平、再把 Y 乘以比例变成圆，三点定圆，最后变换回去。
 * 用于 EllipticalArcTo；ArcTo 是比例为 1 的特例（控制点取弦中垂线上弧高处）。
 */
function ellipseThrough(
  b: VectorPathBuilder,
  x0: number,
  y0: number,
  x: number,
  y: number,
  ax: number,
  ay: number,
  angle: number,
  ratio: number,
) {
  if (!(ratio > 0) || !Number.isFinite(ratio)) ratio = 1;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  // 旋转到长轴坐标系，再把 Y 拉伸成圆（ratio = 长轴 / 短轴）
  const to = (px: number, py: number): [number, number] => [px * cos - py * sin, (px * sin + py * cos) * ratio];
  const p0 = to(x0, y0);
  const p1 = to(ax, ay);
  const p2 = to(x, y);
  const c = circleFrom3Points(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1]);
  if (!c || !(c.r > 0) || c.r > 1e7) {
    b.lineTo(x, y);
    return;
  }
  const a0 = Math.atan2(p0[1] - c.cy, p0[0] - c.cx);
  const a1 = Math.atan2(p2[1] - c.cy, p2[0] - c.cx);
  const am = Math.atan2(p1[1] - c.cy, p1[0] - c.cx);
  // 方向：弧必须经过控制点。看控制点是否落在「角度递增」从 a0 扫到 a1 的那一段上
  const TAU = Math.PI * 2;
  const norm = (v: number) => ((v % TAU) + TAU) % TAU;
  const increasing = norm(am - a0) <= norm(a1 - a0);
  // 圆心变换回原坐标系
  const ccx = c.cx;
  const ccy = c.cy / ratio;
  const back = (px: number, py: number): [number, number] => [px * Math.cos(angle) - py * Math.sin(angle), px * Math.sin(angle) + py * Math.cos(angle)];
  const [cx, cy] = back(ccx, ccy);
  // 圆空间里的参数角就是椭圆的参数角（拉伸只改变 Y 比例，旋转由 rotation 表达）
  b.ellipse(cx, cy, c.r, c.r / ratio, angle, a0, a1, !increasing, true);
}

/** 解释一个几何段（行已合并、已按 IX 排序） */
export function buildGeometry(section: Section, width: number, height: number, m: VectorMatrix): GeometryResult {
  const b = new VectorPathBuilder(m);
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let closed = false;
  let hasStart = false;
  const W = width || 1e-9;
  const H = height || 1e-9;

  const moveTo = (x: number, y: number) => {
    b.moveTo(x, y);
    cx = startX = x;
    cy = startY = y;
    hasStart = true;
  };
  const lineTo = (x: number, y: number) => {
    hasStart ? b.lineTo(x, y) : b.moveTo(x, y);
    cx = x;
    cy = y;
    hasStart = true;
  };
  const finishPoint = (x: number, y: number) => {
    if (hasStart && Math.abs(x - startX) < 1e-9 && Math.abs(y - startY) < 1e-9) {
      closed = true;
    }
    cx = x;
    cy = y;
  };

  for (const r of section.rows) {
    if (r.Del === '1') continue;
    const X = num(r, 'X');
    const Y = num(r, 'Y');
    switch (r.T) {
      case 'MoveTo':
        moveTo(X, Y);
        break;
      case 'RelMoveTo':
        moveTo(X * W, Y * H);
        break;
      case 'LineTo':
        lineTo(X, Y);
        finishPoint(X, Y);
        break;
      case 'RelLineTo':
        lineTo(X * W, Y * H);
        finishPoint(X * W, Y * H);
        break;
      case 'ArcTo': {
        // A：弧高（弦中点到弧中点的距离）。正值时弧在行进方向的右侧（局部坐标 Y 向上）。
        // 依据：语料里 45 段闭合轮廓上的圆角，按「右侧」解释有 38 段外凸（圆角正常的样子），按「左侧」只有 11 段
        const a = num(r, 'A');
        const dx = X - cx;
        const dy = Y - cy;
        const len = Math.hypot(dx, dy);
        if (Math.abs(a) < 1e-9 || len < 1e-12) {
          lineTo(X, Y);
        } else {
          const mx = (cx + X) / 2 + (dy / len) * a;
          const my = (cy + Y) / 2 - (dx / len) * a;
          hasStart || moveTo(cx, cy);
          ellipseThrough(b, cx, cy, X, Y, mx, my, 0, 1);
        }
        finishPoint(X, Y);
        break;
      }
      case 'EllipticalArcTo':
      case 'RelEllipticalArcTo': {
        const rel = r.T === 'RelEllipticalArcTo';
        const ex = rel ? X * W : X;
        const ey = rel ? Y * H : Y;
        const ax = rel ? num(r, 'A') * W : num(r, 'A');
        const ay = rel ? num(r, 'B') * H : num(r, 'B');
        // C：长轴角度；D：长轴 / 短轴（Rel 形式下按宽高比修正）
        const angle = num(r, 'C');
        let ratio = num(r, 'D', 1);
        if (rel) ratio = ratio * (H / W);
        hasStart || moveTo(cx, cy);
        ellipseThrough(b, cx, cy, ex, ey, ax, ay, angle, ratio);
        finishPoint(ex, ey);
        break;
      }
      case 'Ellipse': {
        // X,Y 中心；A,B 长轴端点；C,D 短轴端点
        const A = num(r, 'A');
        const B = num(r, 'B');
        const C = num(r, 'C');
        const D = num(r, 'D');
        const rx = Math.hypot(A - X, B - Y);
        const ry = Math.hypot(C - X, D - Y);
        const rot = Math.atan2(B - Y, A - X);
        b.ellipse(X, Y, rx, ry, rot, 0, Math.PI * 2, false);
        b.close();
        closed = true;
        hasStart = false;
        break;
      }
      case 'RelCubBezTo': {
        hasStart || moveTo(cx, cy);
        b.cubicTo(num(r, 'A') * W, num(r, 'B') * H, num(r, 'C') * W, num(r, 'D') * H, X * W, Y * H);
        finishPoint(X * W, Y * H);
        break;
      }
      case 'RelQuadBezTo': {
        hasStart || moveTo(cx, cy);
        b.quadTo(num(r, 'A') * W, num(r, 'B') * H, X * W, Y * H);
        finishPoint(X * W, Y * H);
        break;
      }
      case 'PolylineTo': {
        const p = parsePolylineFormula(r.cells.A?.V);
        hasStart || moveTo(cx, cy);
        for (const [px, py] of p?.pts || []) {
          b.lineTo(p.xType === 0 ? px * W : px, p.yType === 0 ? py * H : py);
        }
        lineTo(X, Y);
        finishPoint(X, Y);
        break;
      }
      case 'NURBSTo': {
        // 控制点：前一个点（隐含）+ 公式中的点 + 终点；最后一个节点 A，前一个点的节点 C、权重 D，终点权重 B
        const f = parseNurbsFormula(r.cells.E?.V);
        hasStart || moveTo(cx, cy);
        if (f && f.pts.length) {
          const sx = (v: number) => (f.xType === 0 ? v * W : v);
          const sy = (v: number) => (f.yType === 0 ? v * H : v);
          const ctrl = [{ x: cx, y: cy, weight: num(r, 'D', 1) }];
          const knots = [num(r, 'C', 0)];
          for (const p of f.pts) {
            ctrl.push({ x: sx(p.x), y: sy(p.y), weight: p.w || 1 });
            knots.push(p.knot);
          }
          ctrl.push({ x: X, y: Y, weight: num(r, 'B', 1) });
          knots.push(num(r, 'A', f.knotLast));
          // Visio 的节点序列只列出每个控制点对应的一个节点，补齐成 clamped 节点向量
          const deg = Math.max(1, Math.min(f.degree, ctrl.length - 1));
          const full = [...Array(deg).fill(knots[0]), ...knots, ...Array(deg).fill(knots[knots.length - 1])];
          const pts = sampleNurbs({ degree: deg, controlPoints: ctrl, knots: full.length === ctrl.length + deg + 1 ? full : undefined });
          pts.slice(1).forEach(([px, py]) => b.lineTo(px, py));
        }
        lineTo(X, Y);
        finishPoint(X, Y);
        break;
      }
      case 'SplineStart':
      case 'SplineKnot':
        // 旧格式样条：按折线近似
        lineTo(X, Y);
        finishPoint(X, Y);
        break;
      case 'InfiniteLine':
        // 无限长参考线（几乎只出现在辅助参考里），画成两点之间的线段
        moveTo(X, Y);
        lineTo(num(r, 'A'), num(r, 'B'));
        break;
    }
  }
  const s = section.cells;
  return {
    d: b.d,
    noFill: s.NoFill?.V === '1',
    noLine: s.NoLine?.V === '1',
    closed,
  };
}
