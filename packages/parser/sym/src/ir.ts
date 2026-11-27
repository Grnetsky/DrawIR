import {
  applyMatrix,
  BoxAccumulator,
  createGeom,
  IDENTITY,
  matrixScale,
  multiplyMatrix,
  pathItem,
  transformItem,
  VectorPathBuilder,
  type VectorGeom,
  type VectorHatchLine,
  type VectorItem,
  type VectorMatrix,
  type VectorPathData,
  type VectorStyle,
} from '@drawir/core';
import { decodeSym } from './decode';
import type {
  SymLineCell,
  SymPageInfo,
  SymParseOptions,
  SymParseStats,
  SymPenInfo,
  SymPoint,
  SymPointCell,
  SymSymbol,
} from './types';
import { symColor } from './util';

/*
 * 格式结论（依据 EPGIS elesymbol-sym.js 与 allSymbol.sym 交叉验证）：
 * 1. 无压缩二进制；14 字节版本头 + 1 字节分隔符；记录为 LE uint32 长度 + 内容 + 可选 0。
 * 2. 每条记录是一个符号；本库将符号视作页面，按 pageGap 横排，pageList 保存代码和位置。
 * 3. 坐标和线宽单位为毫米，Y 向上，点符号原点为符号中心；scale 缺省 96/25.4。
 * 4. 点图元存绝对局部坐标；线上点图元使用“旋转后平移”的实例矩阵；页面只再做等比缩放和平移。
 * 5. 支持点、折线、多边形、二/三次贝塞尔、椭圆弧、扇形、弦、星形；所有曲线化为 IR 指令。
 * 6. 0xAABBGGRR 颜色，alpha 是 0~100 的透明度；填充 6=空、7=实心，0~5 转为 IR 图案线。
 * 7. GBK 单一样式文字；LOGFONT 高/宽为 1/100 毫米；文字中心、角度和基线偏移由 TextParam 给出。
 * 8. 线上点符号在 IR 阶段按模板展开，不使用共享 ref；文件本身没有覆盖式组件实例。
 * 9. 一个符号在 node 粒度下成为组合，每个源图元是子单元；layer/page 合并为单个 leaf。
 * 10. 文件是符号库而非图纸，没有连接两个形状的连线语义；线/面符号用示例路径预览。
 * 11. 类型 14 是图片点，但当前样例没有该记录；解码器遇到时会给出明确错误。
 * 12. 图片点、组合点、哈希线、文本符号及非普通星形尚不支持；下划线和删除线仅计 unsupported。
 */

export interface SymLeaf {
  kind: 'leaf';
  info: SymPenInfo;
  name?: string;
  items: VectorItem[];
}

export interface SymGroup {
  kind: 'group';
  info: SymPenInfo;
  name?: string;
  children: SymUnit[];
}

export type SymUnit = SymLeaf | SymGroup;

export interface SymTree {
  pages: SymUnit[][];
  pageList: SymPageInfo[];
  vectors: Record<string, VectorGeom>;
  stats: SymParseStats;
}

export const MM_TO_PX = 96 / 25.4;
const FLIP_Y: VectorMatrix = [1, 0, 0, -1, 0, 0];
const PREVIEW_LINE: SymPoint[] = [{ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }];
const PREVIEW_FILL: SymPoint[] = [{ x: -5, y: -4 }, { x: 5, y: -4 }, { x: 5, y: 4 }, { x: -5, y: 4 }];

export function resolveOptions(o: SymParseOptions = {}) {
  return {
    pageGap: 40,
    scale: MM_TO_PX,
    origin: { x: 0, y: 0 },
    granularity: 'node' as const,
    group: true,
    editable: true,
    ...o,
  };
}

export type ResolvedOptions = ReturnType<typeof resolveOptions>;

export function unitItems(u: SymUnit): VectorItem[] {
  return u.kind === 'leaf' ? u.items : u.children.flatMap(unitItems);
}

export class SymToIR {
  private opts: ResolvedOptions;
  private page = 0;
  private symbol!: SymSymbol;
  stats!: SymParseStats;

  constructor(options: SymParseOptions = {}) {
    this.opts = resolveOptions(options);
  }

  build(data: Uint8Array): SymTree {
    const t0 = now();
    this.stats = { pages: 0, nodes: 0, pens: 0, unsupported: {}, errors: [], ms: 0 };
    const doc = decodeSym(data);
    const pages: SymUnit[][] = [];
    const pageList: SymPageInfo[] = [];
    const k = this.opts.scale > 0 ? this.opts.scale : MM_TO_PX;
    let ox = this.opts.origin.x;
    const oy = this.opts.origin.y;
    doc.symbols.forEach((symbol, index) => {
      if (this.opts.pages && !this.opts.pages.includes(index)) return;
      if (this.opts.codes && !this.opts.codes.includes(symbol.code)) return;
      this.page = index;
      this.symbol = symbol;
      this.stats.nodes++;
      const children = this.symbolUnits(symbol);
      if (!children.length) {
        if (![1, 2, 3].includes(symbol.type)) this.count(`symbol:${symbol.type}`);
        return;
      }
      let units: SymUnit[];
      if (this.opts.granularity !== 'node') {
        units = [{ kind: 'leaf', info: this.symbolInfo(symbol), name: symbol.name, items: children.flatMap((c) => c.items) }];
      } else if (this.opts.group && children.length > 1) {
        units = [{ kind: 'group', info: this.symbolInfo(symbol), name: symbol.name, children }];
      } else {
        units = children;
      }
      const box = unitsBox(units);
      const m: VectorMatrix = [k, 0, 0, k, ox - box.x * k, oy - box.y * k];
      units.forEach((u) => transformUnit(u, m));
      const info: SymPageInfo = {
        name: symbol.name || `Symbol ${symbol.code}`,
        code: symbol.code,
        symbolType: symbol.type,
        x: ox,
        y: oy,
        width: box.width * k,
        height: box.height * k,
      };
      pageList.push(info);
      pages.push(units);
      ox += info.width + this.opts.pageGap;
      this.stats.pages++;
    });
    this.stats.ms = Math.round(now() - t0);
    return { pages, pageList, vectors: {}, stats: this.stats };
  }

  private symbolUnits(symbol: SymSymbol): SymLeaf[] {
    const out: SymLeaf[] = [];
    symbol.cells.forEach((cell, cellIndex) => {
      const leaf = this.leaf(cell.kind, cell.type, cellIndex, 'colorLocked' in cell ? cell.colorLocked : undefined);
      try {
        this.stats.nodes++;
        if (cell.kind === 'point') this.drawPointCell(cell, FLIP_Y, leaf);
        else if (cell.kind === 'line') this.drawLineCell(cell, leaf);
        else this.drawFillCell(cell, leaf);
        leaf.items.length && out.push(leaf);
      } catch (e: any) {
        this.stats.errors.push(`${symbol.code}:${cell.kind}#${cell.type}[${cellIndex}]: ${e?.message || e}`);
      }
    });
    return out;
  }

  private symbolInfo(symbol: SymSymbol): SymPenInfo {
    return { page: this.page, id: String(symbol.code), code: symbol.code, symbolType: symbol.type, name: symbol.name, part: 'page' };
  }

  private leaf(kind: string, cellType: number, index: number, colorLocked?: boolean): SymLeaf {
    return {
      kind: 'leaf',
      name: this.symbol.name,
      items: [],
      info: {
        page: this.page,
        id: `${this.symbol.code}:${index}`,
        code: this.symbol.code,
        symbolType: this.symbol.type,
        cellType,
        type: `${kind}:${cellType}`,
        name: this.symbol.name,
        colorLocked,
      },
    };
  }

  private pushPath(leaf: SymLeaf, b: VectorPathBuilder, style: VectorStyle) {
    if (!b.empty && (style.fill && style.fill !== 'none' || style.stroke && style.stroke !== 'none')) {
      leaf.items.push(pathItem(b.d, style));
    }
  }

  private pointStyle(cell: SymPointCell, m: VectorMatrix, filled = true): VectorStyle {
    const style: VectorStyle = {
      stroke: symColor(cell.color),
      lw: Math.max(0, cell.width || 0) * matrixScale(m),
      fill: 'none',
    };
    if (filled && cell.fillStyle === 7) style.fill = symColor(cell.fillColor);
    return style;
  }

  private pushSurfacePath(leaf: SymLeaf, b: VectorPathBuilder, cell: SymPointCell, m: VectorMatrix) {
    this.pushPath(leaf, b, this.pointStyle(cell, m));
    if (cell.fillStyle !== undefined && cell.fillStyle < 6) {
      leaf.items.push({ t: 'h', d: b.d.slice(), lines: hatchLines(b.d, cell.fillStyle), stroke: symColor(cell.fillColor) });
    }
  }

  private drawPointCell(cell: SymPointCell, m: VectorMatrix, leaf: SymLeaf) {
    const b = new VectorPathBuilder(m);
    switch (cell.type) {
      case 1:
        b.ellipse(cell.offsetX || 0, cell.offsetY || 0, cell.size || 0, cell.size || 0, 0, 0, Math.PI * 2, false, false).close();
        this.pushPath(leaf, b, { stroke: 'none', fill: symColor(cell.color) });
        return;
      case 2:
        b.moveTo(cell.startX || 0, cell.startY || 0).lineTo(cell.endX || 0, cell.endY || 0);
        this.pushPath(leaf, b, this.pointStyle(cell, m, false));
        return;
      case 3:
        polyline(b, cell.points || [], false);
        this.pushPath(leaf, b, this.pointStyle(cell, m, false));
        return;
      case 4:
      case 9:
        polyline(b, cell.points || [], true);
        this.pushSurfacePath(leaf, b, cell, m);
        return;
      case 5:
        cubicPath(b, cell.points || []);
        this.pushPath(leaf, b, this.pointStyle(cell, m, false));
        return;
      case 6:
        quadraticPath(b, cell.points || []);
        b.close();
        this.pushSurfacePath(leaf, b, cell, m);
        return;
      case 7:
        ellipseArc(b, cell, false);
        this.pushPath(leaf, b, this.pointStyle(cell, m, false));
        return;
      case 8:
        b.ellipse(cell.offsetX || 0, cell.offsetY || 0, cell.longAxis || 0, cell.shortAxis || 0, (cell.angle || 0) * Math.PI / 180, 0, Math.PI * 2, false, false).close();
        this.pushSurfacePath(leaf, b, cell, m);
        return;
      case 10:
        b.moveTo(cell.offsetX || 0, cell.offsetY || 0);
        ellipseArc(b, cell, true);
        b.close();
        this.pushSurfacePath(leaf, b, cell, m);
        return;
      case 11:
        ellipseArc(b, cell, false);
        b.close();
        this.pushSurfacePath(leaf, b, cell, m);
        return;
      case 12:
        asteriskPath(b, cell);
        this.pushSurfacePath(leaf, b, cell, m);
        cell.asteriskType !== 0 && this.count(`asterisk:${cell.asteriskType}`);
        return;
      case 13:
        this.drawText(cell, m, leaf);
        return;
      default:
        throw new Error(`未实现的点图元 ${cell.type}`);
    }
  }

  private drawText(cell: SymPointCell, m: VectorMatrix, leaf: SymLeaf) {
    const text = cell.textParam;
    const font = cell.fontParam;
    if (!text?.text || !font) return;
    const h = Math.abs(font.height) * 0.75 / 100 * matrixScale(m);
    if (!(h > 0)) return;
    const [x, y] = applyMatrix(m, text.centerX, text.centerY - text.shortAxis / 2);
    const sourceAngle = text.angle * Math.PI / 180;
    const ux = Math.cos(sourceAngle), uy = Math.sin(sourceAngle);
    const r = Math.atan2(m[1] * ux + m[3] * uy, m[0] * ux + m[2] * uy);
    leaf.items.push({
      t: 't',
      text: text.text,
      x,
      y,
      h,
      r,
      w: font.width ? Math.abs(font.width / font.height) || 1 : 1,
      a: 'center',
      b: 'alphabetic',
      font: font.faceName || 'sans-serif',
      bold: font.weight >= 700,
      italic: font.italic,
      fill: symColor(cell.color),
    });
    font.underline && this.count('text:underline');
    font.strikeOut && this.count('text:strikeOut');
  }

  private drawLineCell(cell: SymLineCell, leaf: SymLeaf) {
    if (cell.type === 4) {
      this.drawLocatePoints(cell, leaf);
      return;
    }
    const path = cell.type === 2 || cell.type === 3 ? offsetPath(PREVIEW_LINE, cell.offset || 0) : PREVIEW_LINE;
    if (cell.type === 0 || cell.type === 2) {
      const b = new VectorPathBuilder(FLIP_Y);
      polyline(b, path, false);
      this.pushPath(leaf, b, this.lineStyle(cell));
    }
    if (cell.type === 3) this.drawPatternPoints(cell, path, leaf);
  }

  private lineStyle(cell: SymLineCell): VectorStyle {
    const style: VectorStyle = { stroke: symColor(cell.color), lw: Math.max(0, cell.width), fill: 'none' };
    if (cell.type === 0) style.dash = simpleDash(cell.simpleLineStyle || 0);
    const patterns = cell.symbolTemplate?.patternElements;
    if (cell.type === 2 && cell.hasTemplate === 1 && patterns?.length) {
      const interval = cell.symbolTemplate!.interval;
      style.dash = normalizeDash(patterns.flatMap((p) => [p.mark * interval * 5, p.gap * interval * 5]));
    }
    if (cell.cap !== undefined) style.cap = cell.cap === 0 ? 'round' : cell.cap === 256 ? 'square' : 'butt';
    if (cell.join !== undefined) style.join = cell.join === 4096 ? 'bevel' : cell.join === 8192 ? 'miter' : 'round';
    return style;
  }

  private drawPatternPoints(cell: SymLineCell, path: SymPoint[], leaf: SymLeaf) {
    const patterns = cell.symbolTemplate?.patternElements || [{ mark: 1, gap: 1 }];
    const interval = cell.symbolTemplate?.interval || 1;
    const lengths = patterns.flatMap((p) => [p.mark * interval, p.gap * interval]);
    if (!lengths.some((v) => v > 0)) return;
    for (let segment = 0; segment < path.length - 1; segment++) {
      const a = path[segment], b = path[segment + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (!length) continue;
      const angle = Math.atan2(dy, dx);
      const repeatScale = Math.max(1, length / lengths.reduce((s, v) => s + v, 0) / 300);
      let t = 0, index = 0, guard = 0;
      while (guard++ < 600) {
        t += lengths[index % lengths.length] * repeatScale;
        if (t >= length) break;
        if (index % 2 === 0) {
          const m = multiplyMatrix(FLIP_Y, localMatrix(a.x + dx * t / length, a.y + dy * t / length, angle));
          for (const point of cell.pointCells || []) this.drawPointCell(point, m, leaf);
        }
        index++;
      }
    }
  }

  private drawLocatePoints(cell: SymLineCell, leaf: SymLeaf) {
    const start = PREVIEW_LINE[0], end = PREVIEW_LINE[PREVIEW_LINE.length - 1];
    const locations: { p: SymPoint; next: SymPoint }[] = [];
    if (cell.endType === 1 && cell.directionType !== 1) locations.push({ p: start, next: PREVIEW_LINE[1] });
    if (cell.endType === 2 && cell.directionType !== 2) locations.push({ p: end, next: PREVIEW_LINE[PREVIEW_LINE.length - 2] });
    if (cell.endType === 3) {
      if (cell.directionType === 1) locations.push({ p: end, next: PREVIEW_LINE[PREVIEW_LINE.length - 2] });
      else if (cell.directionType === 2) locations.push({ p: start, next: PREVIEW_LINE[1] });
      else locations.push({ p: start, next: PREVIEW_LINE[1] }, { p: end, next: PREVIEW_LINE[PREVIEW_LINE.length - 2] });
    }
    for (const { p, next } of locations) {
      let angle = Math.atan2(next.y - p.y, next.x - p.x);
      if (cell.directionType === 4) angle += Math.PI / 2;
      const m = multiplyMatrix(FLIP_Y, localMatrix(p.x, p.y, angle));
      for (const point of cell.pointCells || []) this.drawPointCell(point, m, leaf);
    }
  }

  private drawFillCell(cell: Extract<SymSymbol['cells'][number], { kind: 'fill' }>, leaf: SymLeaf) {
    const outline = cell.lineCells[0];
    const style: VectorStyle = {
      stroke: outline ? symColor(outline.color) : 'none',
      lw: outline ? Math.max(0, outline.width) : 0,
      fill: cell.simpleFillStyle === 7 ? symColor(cell.color) : 'none',
    };
    if (outline) style.dash = simpleDash(outline.simpleLineStyle || 0);
    const b = new VectorPathBuilder(FLIP_Y);
    polyline(b, PREVIEW_FILL, true);
    this.pushPath(leaf, b, style);
    if (cell.simpleFillStyle < 6) {
      leaf.items.push({ t: 'h', d: b.d.slice(), lines: hatchLines(b.d, cell.simpleFillStyle), stroke: symColor(cell.color) });
    }
  }

  private count(key: string) {
    this.stats.unsupported[key] = (this.stats.unsupported[key] || 0) + 1;
  }
}

function polyline(b: VectorPathBuilder, points: SymPoint[], close: boolean) {
  points.forEach((p, i) => i ? b.lineTo(p.x, p.y) : b.moveTo(p.x, p.y));
  close && points.length && b.close();
}

function cubicPath(b: VectorPathBuilder, points: SymPoint[]) {
  if (!points.length) return;
  b.moveTo(points[0].x, points[0].y);
  for (let i = 1; i + 2 < points.length; i += 3) {
    b.cubicTo(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, points[i + 2].x, points[i + 2].y);
  }
}

function quadraticPath(b: VectorPathBuilder, points: SymPoint[]) {
  if (!points.length) return;
  b.moveTo(points[0].x, points[0].y);
  for (let i = 1; i + 1 < points.length; i += 2) b.quadTo(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y);
}

function ellipseArc(b: VectorPathBuilder, cell: SymPointCell, connect: boolean) {
  const start = (cell.endAngle || 0) * Math.PI / 180;
  const end = (cell.startAngle || 0) * Math.PI / 180;
  b.ellipse(
    cell.offsetX || 0,
    cell.offsetY || 0,
    cell.longAxis || 0,
    cell.shortAxis || 0,
    (cell.angle || 0) * Math.PI / 180,
    start,
    end,
    true,
    connect,
  );
}

function asteriskPath(b: VectorPathBuilder, cell: SymPointCell) {
  const corners = Math.max(0, Math.floor(cell.corners || 0));
  if (corners < 2) return;
  const rx = cell.longAxis || 0, ry = cell.shortAxis || 0;
  const ratio = cell.ratio ?? 0.5;
  const rotation = (cell.angle || 0) * Math.PI / 180;
  const start = (cell.interAngle || 0) * Math.PI / 180 + rotation;
  for (let i = 0; i < corners * 2; i++) {
    const r = i % 2 ? ratio : 1;
    const a = start + i * Math.PI / corners;
    const x = rx * r * Math.cos(a), y = ry * r * Math.sin(a);
    i ? b.lineTo(x, y) : b.moveTo(x, y);
  }
  b.close();
}

function localMatrix(x: number, y: number, angle: number): VectorMatrix {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, s, -s, c, x, y];
}

function offsetPath(path: SymPoint[], offset: number): SymPoint[] {
  if (!offset || path.length < 2) return path;
  const segments = path.slice(0, -1).map((p, i) => {
    const next = path[i + 1];
    const dx = next.x - p.x, dy = next.y - p.y;
    const length = Math.hypot(dx, dy) || 1;
    const ox = dy / length * offset, oy = -dx / length * offset;
    return [{ x: p.x + ox, y: p.y + oy }, { x: next.x + ox, y: next.y + oy }];
  });
  const out = [segments[0][0]];
  for (let i = 1; i < segments.length; i++) {
    out.push(intersection(segments[i - 1][0], segments[i - 1][1], segments[i][0], segments[i][1]) || segments[i][0]);
  }
  out.push(segments[segments.length - 1][1]);
  return out;
}

function intersection(a: SymPoint, b: SymPoint, c: SymPoint, d: SymPoint): SymPoint | undefined {
  const abx = b.x - a.x, aby = b.y - a.y, cdx = d.x - c.x, cdy = d.y - c.y;
  const denominator = abx * cdy - aby * cdx;
  if (Math.abs(denominator) < 1e-12) return undefined;
  const t = ((c.x - a.x) * cdy - (c.y - a.y) * cdx) / denominator;
  return { x: a.x + abx * t, y: a.y + aby * t };
}

function simpleDash(style: number) {
  switch (style) {
    case 1: return [6, 6];
    case 2: return [0.01, 6];
    case 3: return [6, 4, 0.01, 4];
    case 4: return [6, 4, 0.01, 4, 0.01, 4];
    case 5: return [0.01, 0.01];
    default: return undefined;
  }
}

function normalizeDash(dash: number[]) {
  const result = dash.map((v) => Math.max(0.01, Math.abs(v)));
  result.length % 2 && result.push(0.01);
  return result;
}

function hatchLines(d: VectorPathData, fillStyle: number): VectorHatchLine[] {
  const box = createGeom([pathItem(d)]).bbox;
  const spacing = 10 / MM_TO_PX;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const family = (a: number): VectorHatchLine => ({ a, x, y, dx: -Math.sin(a) * spacing, dy: Math.cos(a) * spacing });
  switch (fillStyle) {
    case 0: return [family(0)];
    case 1: return [family(Math.PI / 2)];
    case 2: return [family(-Math.PI / 4)];
    case 3: return [family(Math.PI / 4)];
    case 4: return [family(0), family(Math.PI / 2)];
    case 5: return [family(-Math.PI / 4), family(Math.PI / 4)];
    default: return [];
  }
}

function unitsBox(units: SymUnit[]) {
  const acc = new BoxAccumulator();
  const walk = (u: SymUnit) => {
    if (u.kind === 'group') return u.children.forEach(walk);
    if (u.items.length) acc.addBox(createGeom(u.items).bbox);
  };
  units.forEach(walk);
  return acc.empty ? { x: 0, y: 0, width: 0, height: 0 } : acc.box();
}

function transformUnit(u: SymUnit, m: VectorMatrix) {
  if (u.kind === 'group') return u.children.forEach((c) => transformUnit(c, m));
  const k = matrixScale(m);
  u.items = u.items.map((it) => transformItem(it, m, k));
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
