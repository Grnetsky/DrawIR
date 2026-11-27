import type { Section } from './sheet';

/**
 * 识别能用 meta2d 原生图元表达的 Visio 形状。
 *
 * 不按名字（NameU）判断：同名母版可能被用户改过几何，名字为「Process」的形状也可能是圆角矩形或异形。
 * 这里直接看几何本身：把几何点归一化到形状宽高（0~1），与原生图元的轮廓逐点比对，完全吻合才映射，
 * 否则保留为矢量图元（同样可改颜色、线宽、尺寸、文字）。
 */
export type NativeShape = { type: string; borderRadius?: number };

const EPS = 0.02;

/** 原生图元的轮廓点（归一化，Y 向下，起点任意、方向任意） */
const OUTLINES: Record<string, [number, number][]> = {
  rectangle: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
  diamond: [
    [0.5, 0],
    [1, 0.5],
    [0.5, 1],
    [0, 0.5],
  ],
  triangle: [
    [0.5, 0],
    [1, 1],
    [0, 1],
  ],
  hexagon: [
    [0.25, 0],
    [0.75, 0],
    [1, 0.5],
    [0.75, 1],
    [0.25, 1],
    [0, 0.5],
  ],
  pentagon: [
    [0.5, 0],
    [1, 0.4],
    [0.8, 1],
    [0.2, 1],
    [0, 0.4],
  ],
};

const num = (v: string | undefined) => (v === undefined || v === '' ? NaN : parseFloat(v));

function samePolygon(a: [number, number][], b: [number, number][]) {
  if (a.length !== b.length) return false;
  const n = a.length;
  const near = (p: [number, number], q: [number, number]) => Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS;
  for (const dir of [1, -1]) {
    for (let s = 0; s < n; s++) {
      let ok = true;
      for (let i = 0; i < n && ok; i++) ok = near(a[i], b[(s + dir * i + n * 2) % n]);
      if (ok) return true;
    }
  }
  return false;
}

/**
 * @param sections 合并后的 Geometry 段（已排除 NoShow）
 * @param w,h 形状宽高（英寸）
 */
export function detectNativeShape(sections: Section[], w: number, h: number): NativeShape | undefined {
  if (sections.length !== 1 || !(w > 0) || !(h > 0)) return undefined;
  const sec = sections[0];
  if (sec.cells.NoFill?.V === '1' || sec.cells.NoLine?.V === '1') return undefined;
  const rows = sec.rows.filter((r) => r.Del !== '1');
  if (!rows.length) return undefined;

  // 整椭圆
  if (rows.length === 1 && rows[0].T === 'Ellipse') {
    const c = rows[0].cells;
    const [x, y, a, b, cc, d] = ['X', 'Y', 'A', 'B', 'C', 'D'].map((k) => num(c[k]?.V));
    const rx = Math.hypot(a - x, b - y);
    const ry = Math.hypot(cc - x, d - y);
    const axisAligned = Math.abs(b - y) < 1e-6 * h || Math.abs(a - x) < 1e-6 * w;
    if (axisAligned && Math.abs(x - w / 2) < EPS * w && Math.abs(y - h / 2) < EPS * h) {
      const rw = Math.abs(b - y) < 1e-6 * h ? rx : ry;
      const rh = Math.abs(b - y) < 1e-6 * h ? ry : rx;
      if (Math.abs(rw * 2 - w) < EPS * w && Math.abs(rh * 2 - h) < EPS * h) return { type: 'circle' };
    }
    return undefined;
  }

  // 折线多边形：MoveTo + LineTo…，首尾闭合
  if (rows[0].T !== 'MoveTo' && rows[0].T !== 'RelMoveTo') return undefined;
  const pts: [number, number][] = [];
  for (const r of rows) {
    if (!['MoveTo', 'LineTo', 'RelMoveTo', 'RelLineTo'].includes(r.T || '')) return undefined;
    const rel = r.T!.startsWith('Rel');
    const x = num(r.cells.X?.V);
    const y = num(r.cells.Y?.V);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    // 归一化，Y 翻转成向下
    pts.push([rel ? x : x / w, 1 - (rel ? y : y / h)]);
  }
  if (pts.length < 4) return undefined;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.abs(first[0] - last[0]) > 1e-6 || Math.abs(first[1] - last[1]) > 1e-6) return undefined;
  pts.pop();
  for (const [type, outline] of Object.entries(OUTLINES)) {
    if (samePolygon(pts, outline)) return { type };
  }
  return undefined;
}
