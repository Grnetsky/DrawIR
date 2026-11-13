import {
  composeMatrix,
  createGeom,
  IDENTITY,
  isIdentity,
  pathItem,
  rotateMatrix,
  textItemBox,
  transformItem,
  translateMatrix,
  VectorPathBuilder,
  type VectorItem,
  type VectorMatrix,
  type VectorStyle,
  type VectorTextItem,
} from '@drawir/core';
import { readPages } from './decode';
import {
  center,
  edgePath,
  elbowRoute,
  entityRelationRoute,
  fixedPoint,
  loopRoute,
  marker,
  orthogonalRoute,
  pointAlong,
  Pt,
  Rect,
  sideOf,
  straightRoute,
  Terminal,
} from './edge';
import { buildShape, isShapeName, perimeterOf, resolveShapeName } from './shapes';
import { color, flag, num, parseStyle, Style, withAlpha } from './style';
import { fillPlaceholders, htmlToText } from './text';
import type { DrawioDocument, DrawioPageInfo, DrawioParseOptions, DrawioParseStats } from './types';
import { child, XmlNode } from './xml';

const DEG = Math.PI / 180;
const DEFAULT_FONT = 'Helvetica, Arial, sans-serif';

interface Geo {
  x: number;
  y: number;
  w: number;
  h: number;
  relative: boolean;
  points: Pt[];
  sourcePoint?: Pt;
  targetPoint?: Pt;
  offset?: Pt;
}

interface Cell {
  id: string;
  parent?: string;
  value: string;
  /** UserObject / object 上的自定义属性（占位符用） */
  attrs?: Record<string, string>;
  style: Style;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  geo?: Geo;
  visible: boolean;
  collapsed: boolean;
  children: Cell[];
}

const EMPTY_GEO: Geo = { x: 0, y: 0, w: 0, h: 0, relative: false, points: [] };

/** draw.io（diagrams.net）→ 纯 Vector IR。连线路由、母版式样式和 HTML 标签都在转换期解析。 */
export class DrawioToIR {
  private opts: Required<Omit<DrawioParseOptions, 'pages'>> & Pick<DrawioParseOptions, 'pages'>;
  private cells = new Map<string, Cell>();
  private boundsCache = new Map<string, Rect | undefined>();
  private edgeCache = new Map<string, Pt[] | undefined>();
  private busy = new Set<string>();
  stats!: DrawioParseStats;

  constructor(options: DrawioParseOptions = {}) {
    this.opts = { pageGap: 40, scale: 1, pageBorder: false, ...options };
  }

  convert(data: string | Uint8Array): DrawioDocument {
    const t0 = now();
    this.stats = { pages: 0, cells: 0, vertices: 0, edges: 0, images: 0, unsupported: {}, errors: [], ms: 0 };
    const pages = readPages(data);
    if (!pages.length) throw new Error('draw.io 文件中没有任何页面');

    const k = this.opts.scale > 0 ? this.opts.scale : 1;
    const items: VectorItem[] = [];
    const pageList: DrawioPageInfo[] = [];
    let background: string | undefined;
    let ox = 0;
    pages.forEach((page, index) => {
      if (this.opts.pages && !this.opts.pages.includes(index)) return;
      const pageItems: VectorItem[] = [];
      try {
        this.convertPage(page.model, pageItems);
      } catch (e: any) {
        this.stats.errors.push(`页面 ${page.name}：${e?.message || e}`);
      }
      const bg = page.model.attrs.background;
      if (background === undefined && bg && bg !== 'none') background = color(bg, undefined, 'bg');

      const box = pageItems.length ? createGeom(pageItems).bbox : { x: 0, y: 0, width: 0, height: 0 };
      const m: VectorMatrix = [k, 0, 0, k, ox - box.x * k, -box.y * k];
      const placed = isIdentity(m) ? pageItems : pageItems.map((it) => transformItem(it, m, k));
      const info: DrawioPageInfo = { name: page.name, x: ox, y: 0, width: box.width * k, height: box.height * k };
      page.id && (info.id = page.id);
      pageList.push(info);
      if (this.opts.pageBorder) items.push(this.pageBorder(info));
      items.push(...placed);
      ox += info.width + this.opts.pageGap;
      this.stats.pages++;
    });

    this.stats.ms = Math.round(now() - t0);
    const last = pageList[pageList.length - 1];
    const doc: DrawioDocument = {
      ...createGeom(items),
      vectors: {},
      width: last ? last.x + last.width : 0,
      height: Math.max(0, ...pageList.map((p) => p.height)),
      pageList,
      stats: this.stats,
    };
    background && background[0] !== '$' && (doc.background = background);
    return doc;
  }

  // -------------------------------------------------------------------------
  // 单元格读取
  // -------------------------------------------------------------------------

  private convertPage(model: XmlNode, out: VectorItem[]) {
    this.cells.clear();
    this.boundsCache.clear();
    this.edgeCache.clear();
    this.busy.clear();
    const root = child(model, 'root');
    if (!root) return;
    const order: Cell[] = [];
    for (const node of root.children) {
      const cell = readCell(node);
      if (!cell) continue;
      if (this.cells.has(cell.id)) cell.id = `${cell.id}#${order.length}`;
      this.cells.set(cell.id, cell);
      order.push(cell);
    }
    this.stats.cells += order.length;
    const roots: Cell[] = [];
    for (const cell of order) {
      const parent = cell.parent !== undefined ? this.cells.get(cell.parent) : undefined;
      if (parent && parent !== cell) parent.children.push(cell);
      else roots.push(cell);
    }
    const visit = (cell: Cell, depth: number) => {
      if (!cell.visible || depth > 64) return;
      try {
        if (cell.vertex) this.drawVertex(cell, out);
        else if (cell.edge) this.drawEdge(cell, out);
      } catch (e: any) {
        this.stats.errors.push(`${cell.edge ? 'edge' : 'vertex'}#${cell.id}: ${e?.message || e}`);
      }
      if (!cell.collapsed) for (const c of cell.children) visit(c, depth + 1);
    };
    roots.forEach((r) => visit(r, 0));
  }

  /** 单元格及其所有祖先都可见，且没有被折叠的祖先 */
  private shown(cell: Cell): boolean {
    if (!cell.visible) return false;
    let p = cell.parent !== undefined ? this.cells.get(cell.parent) : undefined;
    for (let i = 0; p && i < 64; i++) {
      if (!p.visible || p.collapsed) return false;
      p = p.parent !== undefined ? this.cells.get(p.parent) : undefined;
    }
    return true;
  }

  private parentOf(cell: Cell) {
    return cell.parent !== undefined ? this.cells.get(cell.parent) : undefined;
  }

  /** 顶点的页面绝对范围（未旋转） */
  private bounds(cell: Cell): Rect | undefined {
    if (this.boundsCache.has(cell.id)) return this.boundsCache.get(cell.id);
    if (this.busy.has(cell.id)) return undefined;
    this.busy.add(cell.id);
    let r: Rect | undefined;
    const geo = cell.geo;
    if (geo) {
      const parent = this.parentOf(cell);
      const off = geo.offset ?? { x: 0, y: 0 };
      if (parent?.edge && geo.relative) {
        // 连线上的标签：x ∈ [-1, 1] 为沿线位置，y 为法向偏移
        const pts = this.edgePoints(parent);
        if (pts && pts.length > 1) {
          const p = pointOnEdge(pts, geo.x, geo.y);
          r = { x: p.x + off.x - geo.w / 2, y: p.y + off.y - geo.h / 2, w: geo.w, h: geo.h };
        }
      } else {
        const pb = parent?.vertex ? this.bounds(parent) : undefined;
        if (geo.relative && pb) {
          r = { x: pb.x + geo.x * pb.w + off.x, y: pb.y + geo.y * pb.h + off.y, w: geo.w, h: geo.h };
        } else {
          r = { x: (pb?.x ?? 0) + geo.x, y: (pb?.y ?? 0) + geo.y, w: geo.w, h: geo.h };
        }
      }
    }
    this.busy.delete(cell.id);
    this.boundsCache.set(cell.id, r);
    return r;
  }

  /** 连线控制点所在坐标系的原点（父顶点的左上角） */
  private origin(cell: Cell): Pt {
    const p = this.parentOf(cell);
    const b = p?.vertex ? this.bounds(p) : undefined;
    return b ? { x: b.x, y: b.y } : { x: 0, y: 0 };
  }

  // -------------------------------------------------------------------------
  // 顶点
  // -------------------------------------------------------------------------

  private drawVertex(cell: Cell, out: VectorItem[]) {
    const box = this.bounds(cell);
    if (!box) return;
    const st = cell.style;
    this.stats.vertices++;
    let shape = resolveShapeName(st.shape);
    if (shape === 'image' || (st.image && shape !== 'label')) {
      this.stats.images++;
      shape = 'none';
    } else if (st.image) this.stats.images++;

    const rot = num(st.rotation, 0) * DEG;
    const c = center(box);
    const rotM = rot ? composeMatrix(translateMatrix(-c.x, -c.y), rotateMatrix(rot), translateMatrix(c.x, c.y)) : IDENTITY;

    if (shape !== 'none' && box.w >= 0 && box.h >= 0) {
      // 局部绘制坐标 → 形状框：direction → 翻转 → 平移 → 绕中心旋转
      let dw = box.w;
      let dh = box.h;
      let dirM: VectorMatrix = IDENTITY;
      switch (st.direction) {
        case 'south':
          dirM = [0, 1, -1, 0, box.w, 0];
          [dw, dh] = [box.h, box.w];
          break;
        case 'north':
          dirM = [0, -1, 1, 0, 0, box.h];
          [dw, dh] = [box.h, box.w];
          break;
        case 'west':
          dirM = [-1, 0, 0, -1, box.w, box.h];
          break;
      }
      const flips: VectorMatrix[] = [];
      flag(st.flipH) && flips.push([-1, 0, 0, 1, box.w, 0]);
      flag(st.flipV) && flips.push([1, 0, 0, -1, 0, box.h]);
      const m = composeMatrix(dirM, ...flips, translateMatrix(box.x, box.y), rotM);

      let parts = buildShape(shape, dw, dh, st, m);
      if (!parts) {
        this.count(`shape:${shape}`);
        parts = buildShape('rect', dw, dh, st, m)!;
      }
      const sw = num(st.strokeWidth, 1);
      const opacity = num(st.opacity, 100) / 100;
      const fill = withAlpha(color(st.fillColor, '$bg', 'bg'), num(st.fillOpacity, 100) / 100);
      const stroke = withAlpha(color(st.strokeColor, '$fg', 'fg'), num(st.strokeOpacity, 100) / 100);
      const alt = color(st.swimlaneFillColor, undefined, 'bg');
      if (st.gradientColor && st.gradientColor !== 'none') this.count('gradient');
      const base: VectorStyle = { lw: sw, dash: dashOf(st, sw), alpha: opacity < 1 ? opacity : undefined };
      flag(st.rounded) && (base.join = 'round');
      for (const part of parts) {
        if (part.d.length < 3) continue;
        const s: VectorStyle = { ...base };
        s.stroke = part.fill === 'fillOnly' ? 'none' : stroke;
        if (part.fill === 'main' || part.fill === 'fillOnly') s.fill = fill;
        else if (part.fill === 'alt') s.fill = alt;
        const noFill = !s.fill || s.fill === 'none';
        if (s.stroke === 'none' && noFill) continue;
        if (noFill) delete s.fill;
        out.push(pathItem(part.d, s));
      }
    }

    // 标签框：泳道为标题栏，其余为形状框
    let lb: Rect = box;
    if (shape === 'swimlane') {
      const ss = num(st.startSize, 23);
      lb = st.horizontal === '0' ? { ...box, w: Math.min(ss, box.w) } : { ...box, h: Math.min(ss, box.h) };
    }
    this.drawLabel(cell, lb, st, rotM, out, false);
  }

  // -------------------------------------------------------------------------
  // 连线
  // -------------------------------------------------------------------------

  private terminal(cell: Cell, which: 'source' | 'target'): Terminal {
    const st = cell.style;
    const geo = cell.geo ?? EMPTY_GEO;
    const o = this.origin(cell);
    const raw = which === 'source' ? geo.sourcePoint : geo.targetPoint;
    const pt = raw ? { x: raw.x + o.x, y: raw.y + o.y } : undefined;
    const dangling: Terminal = { rot: 0, perimeter: 'rect', fixed: pt };
    const id = which === 'source' ? cell.source : cell.target;
    const tc = id !== undefined ? this.cells.get(id) : undefined;
    if (!tc || !this.shown(tc)) return dangling;

    if (tc.edge) {
      // 连到另一条连线：取其中点
      const pts = tc !== cell ? this.edgePoints(tc) : undefined;
      return pts && pts.length > 1 ? { rot: 0, perimeter: 'rect', fixed: pointAlong(pts, 0.5).p } : dangling;
    }
    const box = this.bounds(tc);
    if (!box) return dangling;
    const tst = tc.style;
    const rot = num(tst.rotation, 0) * DEG;
    const shape = resolveShapeName(tst.shape);
    let perimeter = perimeterOf(shape, tst);
    if (perimeter === 'triangle' && tst.direction && tst.direction !== 'east') perimeter = 'rect';
    const t: Terminal = { box, rot, perimeter };
    const key = which === 'source' ? 'exit' : 'entry';
    const fx = st[`${key}X`];
    const fy = st[`${key}Y`];
    if (fx !== undefined && fy !== undefined && fx !== '' && fy !== '') {
      const x = num(fx, 0.5);
      const y = num(fy, 0.5);
      t.fixed = fixedPoint(box, rot, x, y, num(st[`${key}Dx`], 0), num(st[`${key}Dy`], 0));
      t.dir = sideOf(x, y);
    }
    return t;
  }

  /** 连线的折线点（页面绝对坐标），带缓存 */
  private edgePoints(cell: Cell): Pt[] | undefined {
    if (this.edgeCache.has(cell.id)) return this.edgeCache.get(cell.id);
    if (this.busy.has(cell.id)) return undefined;
    this.busy.add(cell.id);
    let pts: Pt[] | undefined;
    try {
      const st = cell.style;
      const o = this.origin(cell);
      const wps = (cell.geo?.points ?? []).map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
      const s = this.terminal(cell, 'source');
      const e = this.terminal(cell, 'target');
      const es = st.edgeStyle;
      if (cell.source !== undefined && cell.source === cell.target && !wps.length && !s.fixed && !e.fixed) {
        pts = loopRoute(s);
      } else {
        switch (es) {
          case 'orthogonalEdgeStyle':
          case 'segmentEdgeStyle':
          case 'isometricEdgeStyle':
            pts = orthogonalRoute(s, e, wps);
            break;
          case 'elbowEdgeStyle':
            pts = elbowRoute(s, e, wps, st.elbow === 'vertical' ? 'elbow-v' : 'elbow-h');
            break;
          case 'sideToSideEdgeStyle':
            pts = elbowRoute(s, e, wps, 'h');
            break;
          case 'topToBottomEdgeStyle':
            pts = elbowRoute(s, e, wps, 'v');
            break;
          case 'entityRelationEdgeStyle':
            pts = entityRelationRoute(s, e, num(st.segment, 30));
            break;
          case 'loopEdgeStyle':
            pts = loopRoute(s) ?? straightRoute(s, e, wps);
            break;
          default:
            if (es && es !== 'none') this.count(`edgeStyle:${es}`);
            pts = straightRoute(s, e, wps);
        }
      }
    } finally {
      this.busy.delete(cell.id);
    }
    this.edgeCache.set(cell.id, pts);
    return pts;
  }

  private drawEdge(cell: Cell, out: VectorItem[]) {
    const pts = this.edgePoints(cell);
    if (!pts || pts.length < 2) {
      this.stats.errors.push(`edge#${cell.id}: 无法确定端点`);
      return;
    }
    this.stats.edges++;
    const st = cell.style;
    if (st.shape && st.shape !== 'connector') this.count(`edgeShape:${st.shape}`);
    const sw = st.shape === 'flexArrow' ? num(st.width, 10) : num(st.strokeWidth, 1);
    const opacity = num(st.opacity, 100) / 100;
    const alpha = opacity < 1 ? opacity : undefined;
    const stroke = withAlpha(color(st.strokeColor, '$fg', 'fg'), num(st.strokeOpacity, 100) / 100)!;

    if (stroke !== 'none') {
      const line = pts.map((p) => ({ ...p }));
      const markerItems: VectorItem[] = [];
      const end = (type: string | undefined, atEnd: boolean, size: number, fill: boolean) => {
        if (!type || type === 'none') return;
        const n = pts.length;
        const tip = atEnd ? pts[n - 1] : pts[0];
        // 找到与端点不重合的相邻点确定方向
        let prev: Pt | undefined;
        for (let i = 1; i < n && !prev; i++) {
          const q = atEnd ? pts[n - 1 - i] : pts[i];
          if (Math.hypot(q.x - tip.x, q.y - tip.y) > 1e-6) prev = q;
        }
        if (!prev) return;
        const len = Math.hypot(tip.x - prev.x, tip.y - prev.y);
        const ux = (tip.x - prev.x) / len;
        const uy = (tip.y - prev.y) / len;
        const r = marker(type, tip, ux, uy, size, sw, fill);
        if (!r.known) this.count(`arrow:${type}`);
        const back = Math.min(r.back, len * 0.9);
        const target = atEnd ? line[n - 1] : line[0];
        target.x = tip.x - ux * back;
        target.y = tip.y - uy * back;
        for (const mk of r.markers) {
          const filled = mk.filled ? (mk.bgFill ? '$bg' : stroke) : undefined;
          markerItems.push(pathItem(mk.d, { stroke, fill: filled, lw: sw, alpha }));
        }
      };
      end(st.endArrow ?? 'classic', true, num(st.endSize, 6), st.endFill !== '0');
      end(st.startArrow, false, num(st.startSize, 6), st.startFill !== '0');
      const mode = flag(st.curved) ? 'curved' : flag(st.rounded) ? 'rounded' : 'line';
      const s: VectorStyle = { stroke, lw: sw, dash: dashOf(st, sw), alpha };
      mode !== 'line' && (s.join = 'round');
      out.push(pathItem(edgePath(line, mode, num(st.arcSize, 20) / 2), s));
      out.push(...markerItems);
    }

    // 连线自身的标签：geometry.x 为沿线相对位置，y 为法向偏移，offset 为绝对偏移
    const geo = cell.geo ?? EMPTY_GEO;
    const p = pointOnEdge(pts, geo.x, geo.y);
    const off = geo.offset ?? { x: 0, y: 0 };
    const est: Style = { labelBackgroundColor: 'default', ...st };
    this.drawLabel(cell, { x: p.x + off.x, y: p.y + off.y, w: 0, h: 0 }, est, IDENTITY, out, true);
  }

  // -------------------------------------------------------------------------
  // 标签
  // -------------------------------------------------------------------------

  private labelText(cell: Cell): string {
    const st = cell.style;
    let v = cell.value;
    if (cell.attrs && (flag(cell.attrs.placeholders) || flag(st.placeholders))) v = fillPlaceholders(v, cell.attrs);
    if (!v) return '';
    return flag(st.html) ? htmlToText(v) : v.replace(/\r\n?/g, '\n');
  }

  private drawLabel(cell: Cell, box: Rect, st: Style, rotM: VectorMatrix, out: VectorItem[], isEdge: boolean) {
    if (flag(st.noLabel)) return;
    const text = this.labelText(cell);
    if (!text.trim()) return;
    const fill = withAlpha(color(st.fontColor, '$fg', 'fg'), num(st.textOpacity, 100) / 100);
    if (fill === 'none') return;

    let { x, y, w, h } = box;
    if (!isEdge) {
      if (st.labelPosition === 'left') x -= w;
      else if (st.labelPosition === 'right') x += w;
      if (st.verticalLabelPosition === 'top') y -= h;
      else if (st.verticalLabelPosition === 'bottom') y += h;
    }
    const horizontal = st.horizontal !== '0';
    const lc = { x: x + w / 2, y: y + h / 2 };
    if (!horizontal) {
      [w, h] = [h, w];
      x = lc.x - w / 2;
      y = lc.y - h / 2;
    }
    const sp = num(st.spacing, 2);
    const sl = num(st.spacingLeft, 0);
    const sr = num(st.spacingRight, 0);
    const stp = num(st.spacingTop, 0);
    const sb = num(st.spacingBottom, 0);
    const align = isEdge && !st.align ? 'center' : st.align || 'center';
    const valign = isEdge && !st.verticalAlign ? 'middle' : st.verticalAlign || 'middle';

    const fontStyle = num(st.fontStyle, 0) | 0;
    const ff = st.fontFamily;
    const item: VectorTextItem = {
      t: 't',
      text,
      x: align === 'left' ? x + sp + sl : align === 'right' ? x + w - sp - sr : x + w / 2 + (sl - sr) / 2,
      y: valign === 'top' ? y + sp + stp : valign === 'bottom' ? y + h - sp - sb : y + h / 2 + (stp - sb) / 2,
      h: num(st.fontSize, 11),
      a: align === 'left' ? 'left' : align === 'right' ? 'right' : 'center',
      b: valign === 'top' ? 'top' : valign === 'bottom' ? 'bottom' : 'middle',
      lh: 1.2,
      font: ff ? `${ff.includes(',') ? ff : `"${ff}"`}, ${DEFAULT_FONT}` : DEFAULT_FONT,
      fill,
    };
    if (!(item.h > 0)) return;
    fontStyle & 1 && (item.bold = true);
    fontStyle & 2 && (item.italic = true);
    if (!isEdge && st.whiteSpace === 'wrap' && w > 0) {
      const bw = w - 2 * sp - sl - sr;
      bw > 0 && (item.bw = bw);
    }

    const items: VectorItem[] = [];
    const bg = color(st.labelBackgroundColor, undefined, 'bg');
    const border = color(st.labelBorderColor, 'none', 'fg');
    if ((bg && bg !== 'none') || border !== 'none') {
      const tb = textItemBox(item);
      const pad = 2;
      const b = new VectorPathBuilder().polyline(
        [
          [tb.x - pad, tb.y - pad],
          [tb.x + tb.width + pad, tb.y - pad],
          [tb.x + tb.width + pad, tb.y + tb.height + pad],
          [tb.x - pad, tb.y + tb.height + pad],
        ],
        true,
      );
      const s: VectorStyle = { stroke: border };
      bg && bg !== 'none' && (s.fill = bg);
      items.push(pathItem(b.d, s));
    }
    items.push(item);

    // 竖排标签先绕标签框中心转 -90°，再随形状旋转
    let m = rotM;
    if (!horizontal) {
      m = composeMatrix(translateMatrix(-lc.x, -lc.y), rotateMatrix(-Math.PI / 2), translateMatrix(lc.x, lc.y), rotM);
    }
    for (const it of items) out.push(isIdentity(m) ? it : transformItem(it, m));
  }

  // -------------------------------------------------------------------------

  private pageBorder(p: DrawioPageInfo): VectorItem {
    const b = new VectorPathBuilder().polyline(
      [
        [p.x, p.y],
        [p.x + p.width, p.y],
        [p.x + p.width, p.y + p.height],
        [p.x, p.y + p.height],
      ],
      true,
    );
    return pathItem(b.d, { stroke: '#9aa4b2', dash: [6, 4] });
  }

  private count(key: string) {
    this.stats.unsupported[key] = (this.stats.unsupported[key] || 0) + 1;
  }
}

// ---------------------------------------------------------------------------

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function readPoint(n: XmlNode | undefined): Pt | undefined {
  if (!n) return undefined;
  return { x: num(n.attrs.x, 0), y: num(n.attrs.y, 0) };
}

function readGeo(n: XmlNode | undefined): Geo | undefined {
  if (!n) return undefined;
  const a = n.attrs;
  const geo: Geo = {
    x: num(a.x, 0),
    y: num(a.y, 0),
    w: num(a.width, 0),
    h: num(a.height, 0),
    relative: a.relative === '1',
    points: [],
  };
  for (const c of n.children) {
    const as = c.attrs.as;
    if (c.tag === 'mxPoint') {
      if (as === 'sourcePoint') geo.sourcePoint = readPoint(c);
      else if (as === 'targetPoint') geo.targetPoint = readPoint(c);
      else if (as === 'offset') geo.offset = readPoint(c);
    } else if (c.tag === 'Array' && as === 'points') {
      for (const p of c.children) if (p.tag === 'mxPoint') geo.points.push(readPoint(p)!);
    }
  }
  return geo;
}

function readCell(node: XmlNode): Cell | undefined {
  let mx: XmlNode | undefined;
  let attrs: Record<string, string> | undefined;
  let value: string | undefined;
  let id: string | undefined;
  if (node.tag === 'mxCell') {
    mx = node;
    id = node.attrs.id;
    value = node.attrs.value;
  } else if (node.tag === 'UserObject' || node.tag === 'object') {
    mx = child(node, 'mxCell');
    attrs = node.attrs;
    id = node.attrs.id;
    value = node.attrs.label;
  }
  if (!mx || id === undefined) return undefined;
  const a = mx.attrs;
  const cell: Cell = {
    id,
    parent: a.parent,
    value: value ?? '',
    style: parseStyle(a.style, isShapeName),
    vertex: a.vertex === '1',
    edge: a.edge === '1',
    source: a.source,
    target: a.target,
    geo: readGeo(child(mx, 'mxGeometry')),
    visible: a.visible !== '0',
    collapsed: a.collapsed === '1',
    children: [],
  };
  attrs && (cell.attrs = attrs);
  return cell;
}

/** 连线上的点：gx ∈ [-1, 1] 为相对位置（0 = 中点），gy 为法向偏移 */
function pointOnEdge(pts: Pt[], gx: number, gy: number): Pt {
  const { p, ux, uy } = pointAlong(pts, (Math.max(-1, Math.min(1, gx)) + 1) / 2);
  return { x: p.x - uy * gy, y: p.y + ux * gy };
}

function dashOf(st: Style, sw: number): number[] | undefined {
  if (!flag(st.dashed)) return undefined;
  const pat = (st.dashPattern || '3 3')
    .split(/[\s,]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v) && v >= 0);
  if (!pat.length || pat.every((v) => v === 0)) return undefined;
  const k = flag(st.fixDash) ? 1 : sw;
  return pat.map((v) => Math.max(v * k, 0.01));
}
