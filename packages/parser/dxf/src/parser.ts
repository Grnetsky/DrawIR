import {
  applyMatrix,
  BoxAccumulator,
  catmullRomToCubics,
  composeMatrix,
  IDENTITY,
  matrixScale,
  multiplyMatrix,
  rotateMatrix,
  sampleNurbs,
  scaleMatrix,
  translateMatrix,
  computeItemsBox,
  createGeom,
  pathItem,
  transformItem,
  VectorBox,
  VectorGeom,
  VectorHatchLine,
  VectorItem,
  VectorMatrix,
  VectorPathBuilder,
  VectorStyle,
  VectorTextItem,
} from '@drawir/core';
import { aciToHex, isContrastColor, trueColorToHex } from './colors';
import { parseMText, parseSingleLineText } from './text';
import { applyDrawOrder, readSortEntsTables } from './sortents';
import type { DxfDocument, DxfEntityInfo, DxfParseOptions, DxfParseStats } from './types';

const DEG = Math.PI / 180;
/** 坐标存储在 OCS 中的实体（DXF 规范「Object Coordinate Systems」一节） */
const OCS_ENTITIES = new Set([
  'ARC',
  'CIRCLE',
  'LWPOLYLINE',
  'POLYLINE',
  'SOLID',
  'TRACE',
  'TEXT',
  'ATTRIB',
  'ATTDEF',
  'INSERT',
  'HATCH',
]);
/** 颜色：块内「随块」(ByBlock) */
const BYBLOCK = '$fg';

type Entity = Record<string, any>;

interface Layer {
  name: string;
  color?: string;
  lineType?: string;
  lineweight?: number;
  visible: boolean;
}

interface LineType {
  /** 正数画、负数空、0 点（CAD 单位，未乘 ltscale） */
  pattern: number[];
}

/** 实体在当前上下文（模型空间或块定义）中的输出 */
interface Output {
  items: VectorItem[];
}

/**
 * DXF → Vector IR。
 *
 * 坐标：解析时统一换算到「画布坐标」——CAD 坐标 × scale，Y 轴翻转（CAD Y 向上，画布 Y 向下）。
 * 块定义按块自身坐标（未缩放、未翻转）保存为共享几何，引用处只记录一个矩阵，块内的翻转、缩放
 * 全部在引用矩阵里，块定义只解析一次、只存一份。
 *
 * 与 V1 的差异（V1 问题见 README）：
 * - 不读取 window / DrawIR 全局状态，无单例，结果只取决于输入，可在 Worker 中运行；
 * - INSERT 引用共享定义，不再深拷贝展开；支持 MINSERT 阵列、负缩放镜像、OCS 镜像（extrusion z<0）；
 * - HATCH 矢量绘制（实体填充 + 图案线族裁剪），不再栅格化成 base64 图片；圆弧、椭圆、样条边界都支持；
 * - 颜色正确处理 ByLayer / ByBlock / 真彩色 / 图层关闭；线型按 $LTSCALE × 实体线型比例换算；
 * - MTEXT 剥离全部格式码，支持对齐、旋转、换行；TEXT 支持对齐点和宽度因子。
 */
export class DxfToVector {
  private opts: Required<Omit<DxfParseOptions, 'scale' | 'layers' | 'encoding' | 'origin' | 'backdrop' | 'space'>> &
    Pick<DxfParseOptions, 'scale' | 'layers' | 'encoding' | 'origin' | 'backdrop' | 'space'>;
  private dxf: any;
  private layers = new Map<string, Layer>();
  private lineTypes = new Map<string, LineType>();
  private ltScale = 1;
  private scale = 1;
  private nextId = 0;
  /** 世界矩阵：CAD 坐标 → 输出坐标 */
  private world: VectorMatrix = IDENTITY;
  private blockIds = new Map<string, string | null>();
  private vectors: Record<string, VectorGeom> = {};
  private layerFilter?: Set<string>;
  private drawOrder = new Map<string, Map<string, number>>();
  stats: DxfParseStats;

  constructor(options: DxfParseOptions = {}) {
    this.opts = {
      fitWidth: 1920,
      fitHeight: 1080,
      granularity: 'entity',
      hatch: true,
      text: true,
      contrastColor: true,
      minLineWidth: 0,
      ...options,
    };
    this.layerFilter = options.layers?.length ? new Set(options.layers) : undefined;
  }

  private id() {
    return (++this.nextId).toString(36);
  }

  /** @param text DXF 原文，用于读取绘制次序表。 */
  convert(dxf: any, text?: string): DxfDocument {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.dxf = dxf;
    this.drawOrder = text ? readSortEntsTables(text) : new Map();
    this.stats = {
      entities: {},
      unsupported: {},
      blocks: 0,
      errors: [],
      scale: 1,
      extents: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      ms: 0,
    };
    this.readTables();
    this.ltScale = +dxf.header?.$LTSCALE || 1;
    const entities: Entity[] = this.ordered(this.selectSpace(dxf.entities || []));
    this.world = IDENTITY;
    const fragments = this.opts.granularity === 'layer' ? this.convertByLayer(entities) : this.convertByEntity(entities);
    const extents = this.contentExtents(fragments);
    this.stats.extents = extents;
    this.sendBackdropsBack(fragments, extents);
    const w = extents.maxX - extents.minX || 1;
    const h = extents.maxY - extents.minY || 1;
    this.scale = this.opts.scale || Math.min(this.opts.fitWidth / w, this.opts.fitHeight / h) || 1;
    this.stats.scale = this.scale;
    const ox = this.opts.origin?.x || 0;
    const oy = this.opts.origin?.y || 0;
    this.world = [this.scale, 0, 0, -this.scale, ox - extents.minX * this.scale, oy + extents.maxY * this.scale];
    this.placePens(fragments);
    const items = fragments.flatMap((fragment) => fragment.vector.items as VectorItem[]);
    const geom = createGeom(items, (id) => this.vectors[id]);
    const layers: DxfDocument['layers'] = {};
    this.layers.forEach((l) => (layers[l.name] = { color: l.color, visible: l.visible }));
    this.stats.blocks = Object.keys(this.vectors).length;
    this.stats.ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    return {
      ...geom,
      vectors: this.vectors,
      width: Math.round(w * this.scale),
      height: Math.round(h * this.scale),
      layers,
      stats: this.stats,
    };
  }

  // -------------------------------------------------------------------------
  // 表
  // -------------------------------------------------------------------------

  private readTables() {
    for (const lt of this.dxf.tables?.LTYPE?.entries || []) {
      const pattern = (lt.pattern || []).map((p: any) => +p.elementLength || 0);
      this.lineTypes.set(String(lt.name).toUpperCase(), { pattern });
    }
    for (const l of this.dxf.tables?.LAYER?.entries || []) {
      const ci = l.colorIndex;
      this.layers.set(l.name, {
        name: l.name,
        color: l.trueColor != null ? trueColorToHex(l.trueColor) : ci != null ? aciToHex(ci) : undefined,
        lineType: l.lineType,
        lineweight: l.lineweight,
        // 颜色索引为负表示图层关闭；标志位 1 = 冻结
        visible: !(ci < 0) && !((l.standardFlag || 0) & 1),
      });
    }
  }

  private layerOf(e: Entity): Layer | undefined {
    return this.layers.get(e.layer);
  }

  private isVisible(e: Entity) {
    // 组码 60：0 = 可见，1 = 不可见。dxf-json 解析成 `isVisible = !!value`，含义正好反了：
    // isVisible === true 表示「不可见」（已与 ezdxf 的 dxf.invisible 逐个比对：暖通图 4 个、PID 图 4 个完全一致）。
    // 这里直接按组码语义判断，不依赖它的命名
    if (e.isVisible === true) return false;
    // 属性（ATTRIB / ATTDEF）标志位 1 = 不可见属性
    if ((e.type === 'ATTRIB' || e.type === 'ATTDEF') && (e.attributeFlag ?? e.attributeFlags ?? 0) & 1) return false;
    const layer = this.layerOf(e);
    if (layer && !layer.visible) return false;
    if (this.layerFilter && !this.layerFilter.has(e.layer)) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // 样式
  // -------------------------------------------------------------------------

  /**
   * 实体颜色。返回 '$fg' 表示「随块」——在块内由引用处决定，在顶层由图元颜色决定。
   * 顶层实体返回具体颜色，交给 pen.color，这样悬停/选中高亮能整体换色。
   */
  private colorOf(e: Entity, inBlock: boolean): string {
    let c: string | undefined;
    if (e.color != null && typeof e.color === 'number') {
      c = trueColorToHex(e.color);
    } else if (e.colorIndex === 0) {
      // ByBlock：块内随引用，顶层按白/黑处理
      return BYBLOCK;
    } else if (e.colorIndex != null && e.colorIndex !== 256) {
      c = aciToHex(e.colorIndex);
    }
    if (!c) {
      // ByLayer。块内「0 图层」上的 ByLayer 实体同样随引用的图层
      const layer = this.layerOf(e);
      if (inBlock && (e.layer === '0' || !layer)) return BYBLOCK;
      c = layer?.color;
    }
    if (!c) return BYBLOCK;
    if (this.opts.contrastColor && isContrastColor(c)) return BYBLOCK;
    return c;
  }

  /**
   * 线宽（屏幕像素，不随缩放变化）。lineweight 以 1/100 mm 记录，-1 ByLayer、-2 ByBlock、-3 默认。
   *
   * CAD 的线宽是**打印**宽度，屏幕上 AutoCAD 按像素显示（0.25mm 以下 1 像素，粗线 2~3 像素），
   * 不随图纸缩放变粗。按图纸单位换算会出错：毫米图纸里 0.7mm 线宽 = 0.7 个图纸单位，放大后就是一条粗带。
   * 所以这里只返回「显示像素」，由 IR 的 lw 以世界坐标表达后，在解析结束时按 scale 换算。
   */
  private linePxOf(e: Entity): number | undefined {
    if (!this.dxf.header?.$LWDISPLAY) return undefined;
    let lw = e.lineweight;
    if (lw == null || lw === -1) lw = this.layerOf(e)?.lineweight;
    if (lw == null || lw < 0) return undefined;
    return lw >= 50 ? 2.5 : lw >= 30 ? 1.6 : undefined;
  }

  /** 虚线（CAD 单位） */
  private dashOf(e: Entity): number[] | undefined {
    let name = e.lineType;
    if (!name || /^bylayer$/i.test(name)) name = this.layerOf(e)?.lineType;
    if (!name || /^(byblock|continuous)$/i.test(name)) return undefined;
    const lt = this.lineTypes.get(String(name).toUpperCase());
    if (!lt?.pattern.length) return undefined;
    const k = this.ltScale * (+e.lineTypeScale || 1);
    // Canvas 虚线不支持负数和 0：画段取绝对值，点（0）用很短的画段
    const out = lt.pattern.map((v) => Math.max(Math.abs(v) * k, v === 0 ? 1e-6 : 0));
    // 首段为空（负数）时补一个长度 0 的画段
    lt.pattern[0] < 0 && out.unshift(0);
    out.length % 2 && out.push(0);
    return out.some((v) => v > 0) ? out : undefined;
  }

  /**
   * @param width 多段线全局宽度（CAD 单位，真实几何宽度，随缩放）
   */
  private strokeStyle(e: Entity, inBlock: boolean, m: VectorMatrix, width?: number): VectorStyle {
    const k = matrixScale(m);
    const color = this.colorOf(e, inBlock);
    const dash = this.dashOf(e);
    const style: VectorStyle = {
      stroke: color === BYBLOCK ? undefined : color,
      dash: dash?.map((v) => v * k),
    };
    if (width > 0) {
      style.lw = width * k;
    } else {
      const px = this.linePxOf(e);
      px && (style.px = px);
    }
    return style;
  }

  // -------------------------------------------------------------------------
  // 实体 → IR
  // -------------------------------------------------------------------------

  /**
   * OCS（对象坐标系）：extrusion z<0 时 OCS 的 X 轴与 WCS 相反（镜像过的实体）。
   * 只有「平面实体」的坐标存在 OCS 中；LINE、ELLIPSE、SPLINE、LEADER、3DFACE、POINT 的坐标本来就是
   * WCS，不能再镜像（实测：镜像后这些实体会被甩到图纸外，见 README 的验证记录）。
   */
  private ocs(e: Entity, m: VectorMatrix): VectorMatrix {
    return e.extrusionDirection?.z < 0 && OCS_ENTITIES.has(e.type) ? multiplyMatrix(m, scaleMatrix(-1, 1)) : m;
  }

  /**
   * 将实体写入 out。m：实体坐标 → 输出坐标（顶层为世界矩阵，块内为单位矩阵）。
   * inBlock：是否在块定义中（决定 ByBlock 颜色和 INSERT 引用方式）。
   */
  private emit(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const type = e.type;
    this.stats.entities[type] = (this.stats.entities[type] || 0) + 1;
    if (!this.isVisible(e)) return;
    switch (type) {
      case 'LINE':
        return this.line(e, m, inBlock, out);
      case 'XLINE':
      case 'RAY':
        return;
      case 'CIRCLE':
        return this.circle(e, m, inBlock, out);
      case 'ARC':
        return this.arc(e, m, inBlock, out);
      case 'ELLIPSE':
        return this.ellipse(e, m, inBlock, out);
      case 'LWPOLYLINE':
      case 'POLYLINE':
        return this.polyline(e, m, inBlock, out);
      case 'SPLINE':
        return this.spline(e, m, inBlock, out);
      case 'SOLID':
      case 'TRACE':
      case '3DFACE':
        return this.solid(e, m, inBlock, out);
      case 'HATCH':
        return this.opts.hatch ? this.hatch(e, m, inBlock, out) : undefined;
      case 'TEXT':
      case 'ATTRIB':
        return this.opts.text ? this.text(e, m, inBlock, out) : undefined;
      case 'ATTDEF':
        // 属性定义是模板，显示的是 INSERT 上的 ATTRIB；只有常量属性需要显示
        return this.opts.text && e.attributeFlag & 2 ? this.text(e, m, inBlock, out) : undefined;
      case 'MTEXT':
        return this.opts.text ? this.mtext(e, m, inBlock, out) : undefined;
      case 'INSERT':
        return this.insert(e, m, inBlock, out);
      case 'DIMENSION':
        // 标注的图形在匿名块 *Dn 中，按块引用绘制
        return e.name ? this.insert({ ...e, insertionPoint: { x: 0, y: 0 }, type: 'DIMENSION' }, m, inBlock, out) : undefined;
      case 'LEADER':
        return this.leader(e, m, inBlock, out);
      case 'POINT':
        return this.point(e, m, inBlock, out);
      case 'WIPEOUT':
        return this.wipeout(e, m, out);
      default:
        this.stats.unsupported[type] = (this.stats.unsupported[type] || 0) + 1;
    }
  }

  private pushPath(out: Output, b: VectorPathBuilder, style: VectorStyle) {
    !b.empty && out.items.push(pathItem(b.d, style));
  }

  private line(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const mm = this.ocs(e, m);
    const b = new VectorPathBuilder(mm);
    b.moveTo(e.startPoint.x, e.startPoint.y).lineTo(e.endPoint.x, e.endPoint.y);
    this.pushPath(out, b, this.strokeStyle(e, inBlock, mm));
  }

  private circle(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const mm = this.ocs(e, m);
    const b = new VectorPathBuilder(mm);
    b.ellipse(e.center.x, e.center.y, e.radius, e.radius, 0, 0, Math.PI * 2);
    b.close();
    this.pushPath(out, b, this.strokeStyle(e, inBlock, mm));
  }

  private arc(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const mm = this.ocs(e, m);
    const b = new VectorPathBuilder(mm);
    // DXF 圆弧总是从起始角逆时针（角度递增）到终止角
    let end = e.endAngle * DEG;
    const start = e.startAngle * DEG;
    end <= start && (end += Math.PI * 2);
    b.ellipse(e.center.x, e.center.y, e.radius, e.radius, 0, start, end, false);
    this.pushPath(out, b, this.strokeStyle(e, inBlock, mm));
  }

  private ellipse(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const mm = this.ocs(e, m);
    const { x: mx, y: my } = e.majorAxisEndPoint;
    const a = Math.hypot(mx, my);
    const bAxis = a * (e.axisRatio || 1);
    const rot = Math.atan2(my, mx);
    let start = e.startAngle ?? 0;
    let end = e.endAngle ?? Math.PI * 2;
    // 法向朝下（extrusion z<0，镜像过的椭圆）：中心、长轴是世界坐标，但短轴方向 = 法向 × 长轴，
    // 在 XY 平面里与正常椭圆相反，即参数 t 处的点等于正常椭圆 -t 处的点。
    // 所以从 start 到 end 的弧 = 正常椭圆从 -end 到 -start 的弧（已与 ezdxf 逐点比对）
    if (e.extrusionDirection?.z < 0) {
      [start, end] = [-end, -start];
    }
    end <= start && (end += Math.PI * 2);
    const b = new VectorPathBuilder(mm);
    b.ellipse(e.center.x, e.center.y, a, bAxis, rot, start, end, false);
    this.pushPath(out, b, this.strokeStyle(e, inBlock, mm));
  }

  private polyline(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const flag = e.flag || 0;
    // 3D 多边形网格 / 多面网格：只画边
    if (flag & (16 | 64)) {
      return this.meshEdges(e, m, inBlock, out);
    }
    const verts: any[] = (e.vertices || []).filter((v: any) => !(v.flag & 16)); // 跳过样条控制点
    if (verts.length < 2) return;
    const mm = this.ocs(e, m);
    const closed = !!(flag & 1);

    // 等宽多段线：用线宽表示。变宽线段：转成填充多边形
    const constW = e.constantWidth ?? (e.type === 'POLYLINE' ? e.startWidth : undefined);
    const varying = verts.some(
      (v) => (v.startWidth ?? constW ?? 0) !== (constW ?? 0) || (v.endWidth ?? constW ?? 0) !== (constW ?? 0),
    );
    if (varying) {
      return this.widePolyline(e, verts, closed, mm, inBlock, out);
    }

    const b = new VectorPathBuilder(mm);
    const n = verts.length;
    const segs = closed ? n : n - 1;
    b.moveTo(verts[0].x, verts[0].y);
    for (let i = 0; i < segs; i++) {
      const p = verts[i];
      const q = verts[(i + 1) % n];
      b.bulgeTo(q.x, q.y, p.bulge || 0, [p.x, p.y]);
    }
    closed && b.close();
    const style = this.strokeStyle(e, inBlock, mm, constW);
    if (constW > 0) {
      style.cap = 'butt';
      style.join = 'miter';
    }
    this.pushPath(out, b, style);
  }

  /** 变宽多段线：每段生成梯形（直线段）或环形扇区（圆弧段）填充 */
  private widePolyline(e: Entity, verts: any[], closed: boolean, m: VectorMatrix, inBlock: boolean, out: Output) {
    const n = verts.length;
    const segs = closed ? n : n - 1;
    const constW = e.constantWidth ?? 0;
    const b = new VectorPathBuilder(m);
    for (let i = 0; i < segs; i++) {
      const p = verts[i];
      const q = verts[(i + 1) % n];
      const w0 = (p.startWidth ?? constW) / 2;
      const w1 = (p.endWidth ?? constW) / 2;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.hypot(dx, dy);
      if (!len) continue;
      if (!p.bulge) {
        const nx = -dy / len;
        const ny = dx / len;
        b.moveTo(p.x + nx * w0, p.y + ny * w0)
          .lineTo(q.x + nx * w1, q.y + ny * w1)
          .lineTo(q.x - nx * w1, q.y - ny * w1)
          .lineTo(p.x - nx * w0, p.y - ny * w0)
          .close();
      } else {
        // 圆弧段：内外两条同心圆弧（半径线性变化近似为端点宽度平均）
        const theta = 4 * Math.atan(p.bulge);
        const r = Math.abs(len / (2 * Math.sin(theta / 2)));
        const kk = (1 - p.bulge * p.bulge) / (4 * p.bulge);
        const cx = (p.x + q.x) / 2 - kk * dy;
        const cy = (p.y + q.y) / 2 + kk * dx;
        const a0 = Math.atan2(p.y - cy, p.x - cx);
        const a1 = Math.atan2(q.y - cy, q.x - cx);
        const ccw = p.bulge > 0;
        const wm = (w0 + w1) / 2;
        b.ellipse(cx, cy, r + wm, r + wm, 0, a0, a1, !ccw);
        b.ellipse(cx, cy, Math.max(r - wm, 0), Math.max(r - wm, 0), 0, a1, a0, ccw, true);
        b.close();
      }
    }
    const color = this.colorOf(e, inBlock);
    out.items.push(pathItem(b.d, { fill: color, stroke: 'none' }));
  }

  private meshEdges(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const verts: any[] = e.vertices || [];
    const b = new VectorPathBuilder(m);
    const pts = verts.filter((v) => !(v.flag & 128) || v.flag & 64);
    const faces = verts.filter((v) => v.flag & 128 && !(v.flag & 64));
    if (faces.length) {
      for (const f of faces) {
        const idx = [f.polyfaceIndex0, f.polyfaceIndex1, f.polyfaceIndex2, f.polyfaceIndex3]
          .filter((i) => i)
          .map((i) => pts[Math.abs(i) - 1])
          .filter(Boolean);
        idx.length > 1 && b.polyline(idx.map((p) => [p.x, p.y]), true);
      }
    } else {
      b.polyline(
        pts.map((p) => [p.x, p.y]),
        false,
      );
    }
    this.pushPath(out, b, this.strokeStyle(e, inBlock, m));
  }

  private spline(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const mm = this.ocs(e, m);
    const b = new VectorPathBuilder(mm);
    const closed = !!((e.flag || 0) & 1);
    if (e.controlPoints?.length >= 2) {
      const pts = sampleNurbs(
        { degree: e.degree, controlPoints: e.controlPoints, knots: e.knots, weights: e.weights },
        Math.max(4, Math.min(16, Math.ceil(200 / e.controlPoints.length))),
      );
      b.polyline(pts, closed);
    } else if (e.fitPoints?.length >= 2) {
      const pts: [number, number][] = e.fitPoints.map((p: any) => [p.x, p.y]);
      b.moveTo(pts[0][0], pts[0][1]);
      for (const c of catmullRomToCubics(pts, closed)) b.cubicTo(c[0], c[1], c[2], c[3], c[4], c[5]);
    }
    this.pushPath(out, b, this.strokeStyle(e, inBlock, mm));
  }

  private solid(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const pts: any[] = e.points || e.vertices || [];
    if (pts.length < 3) return;
    const mm = this.ocs(e, m);
    const b = new VectorPathBuilder(mm);
    if (e.type === '3DFACE') {
      // 三维面在平面图里只画边框
      b.polyline(
        pts.map((p) => [p.x, p.y]),
        true,
      );
      return this.pushPath(out, b, this.strokeStyle(e, inBlock, mm));
    }
    // SOLID 角点按「之」字形存储：1-2-4-3
    const order = pts.length >= 4 ? [pts[0], pts[1], pts[3], pts[2]] : pts;
    b.polyline(
      order.map((p) => [p.x, p.y]),
      true,
    );
    const color = this.colorOf(e, inBlock);
    out.items.push(pathItem(b.d, { fill: color, stroke: 'none' }));
  }

  private wipeout(e: Entity, m: VectorMatrix, out: Output) {
    // 遮罩：解析不到边界顶点时忽略。有顶点时用画布背景色无法得知，这里不绘制（避免黑块）
    void e;
    void m;
    void out;
  }

  private point(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    // $PDMODE 0/1 的点在图纸上几乎不可见，不画；其他样式画小十字
    const mode = +this.dxf.header?.$PDMODE || 0;
    if (mode === 0 || mode === 1) return;
    const size = +this.dxf.header?.$PDSIZE > 0 ? +this.dxf.header.$PDSIZE : 2 / this.scale;
    const { x, y } = e.position;
    const b = new VectorPathBuilder(m);
    b.moveTo(x - size / 2, y).lineTo(x + size / 2, y).moveTo(x, y - size / 2).lineTo(x, y + size / 2);
    this.pushPath(out, b, this.strokeStyle(e, inBlock, m));
  }

  private leader(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const v: any[] = e.vertices || [];
    if (v.length < 2) return;
    const mm = this.ocs(e, m);
    const b = new VectorPathBuilder(mm);
    b.polyline(v.map((p) => [p.x, p.y]));
    const style = this.strokeStyle(e, inBlock, mm);
    this.pushPath(out, b, style);
    if (e.isArrowheadEnabled !== false) {
      // 箭头：沿首段方向的实心三角，长度取标注文字高度或首段长度的 1/4
      const [p0, p1] = v;
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const size = Math.min(e.textHeight || len / 4, len / 2) || len / 4;
      if (size > 0) {
        const ux = (p1.x - p0.x) / len;
        const uy = (p1.y - p0.y) / len;
        const w = size / 6;
        const a = new VectorPathBuilder(mm);
        a.moveTo(p0.x, p0.y)
          .lineTo(p0.x + ux * size - uy * w, p0.y + uy * size + ux * w)
          .lineTo(p0.x + ux * size + uy * w, p0.y + uy * size - ux * w)
          .close();
        out.items.push(pathItem(a.d, { fill: style.stroke || BYBLOCK, stroke: 'none' }));
      }
    }
  }

  // -------------------------------------------------------------------------
  // 文字
  // -------------------------------------------------------------------------

  /** 在矩阵 m 下放置一段文字：源坐标锚点 (x, y)、源字高 h、源旋转 rot（CAD 逆时针为正） */
  private placeText(
    m: VectorMatrix,
    x: number,
    y: number,
    h: number,
    rot: number,
    base: Omit<VectorTextItem, 't' | 'x' | 'y' | 'h' | 'r'>,
  ): VectorTextItem | undefined {
    if (!(h > 0)) return undefined;
    const [px, py] = applyMatrix(m, x, y);
    // 文字方向向量和字高方向向量经过矩阵后的长度、角度
    const ux = Math.cos(rot);
    const uy = Math.sin(rot);
    const dx = m[0] * ux + m[2] * uy;
    const dy = m[1] * ux + m[3] * uy;
    const vx = m[0] * -uy + m[2] * ux;
    const vy = m[1] * -uy + m[3] * ux;
    const angle = Math.atan2(dy, dx);
    const heightScale = Math.hypot(vx, vy);
    const widthScale = Math.hypot(dx, dy);
    // 文字项的约定：m=1 表示「相对当前坐标系镜像」。CAD 坐标系 Y 向上、画布 Y 向下，两者互为镜像，
    // 所以在 CAD 坐标系中「正常」的文字要标 m=1，由最终的世界矩阵（含 Y 翻转，行列式为负）再翻一次变回正常。
    // 负缩放块 / OCS 镜像会让行列式变负，此时字形在 AutoCAD 中确实是镜像的，m 取反后如实绘制。
    const det = m[0] * m[3] - m[1] * m[2];
    const item: VectorTextItem = { t: 't', ...base, x: px, y: py, h: h * heightScale, r: angle || undefined };
    det > 0 && (item.m = 1);
    // 定宽文字的框宽（源坐标，沿文字方向）同样经过矩阵缩放
    base.bw > 0 ? (item.bw = base.bw * widthScale) : delete item.bw;
    const wf = (base.w || 1) * (heightScale ? widthScale / heightScale : 1);
    Math.abs(wf - 1) > 1e-3 ? (item.w = wf) : delete item.w;
    return item;
  }

  private textColor(e: Entity, inBlock: boolean, aci?: number, rgb?: number) {
    let c: string | undefined;
    if (rgb != null && !isNaN(rgb)) c = trueColorToHex(rgb);
    else if (aci != null && !isNaN(aci) && aci > 0 && aci < 256) c = aciToHex(aci);
    if (c && this.opts.contrastColor && isContrastColor(c)) return undefined;
    if (c) return c;
    const ec = this.colorOf(e, inBlock);
    return ec === BYBLOCK ? undefined : ec;
  }

  private text(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const str = parseSingleLineText(e.text);
    if (!str.trim()) return;
    const mm = this.ocs(e, m);
    const h = e.textHeight || 1;
    const ha = e.halign ?? e.horizontalJustification ?? 0;
    const va = e.valign ?? e.verticalJustification ?? 0;
    // 非左下对齐时，对齐点在 endPoint / alignmentPoint
    const p = (ha || va) && (e.endPoint || e.alignmentPoint) ? e.endPoint || e.alignmentPoint : e.startPoint;
    if (!p) return;
    const a: CanvasTextAlign = ha === 1 || ha === 4 ? 'center' : ha === 2 ? 'right' : 'left';
    const b: CanvasTextBaseline = ha === 4 ? 'middle' : va === 1 ? 'bottom' : va === 2 ? 'middle' : va === 3 ? 'top' : 'alphabetic';
    const item = this.placeText(mm, p.x, p.y, h, (e.rotation || 0) * DEG, {
      text: str,
      a,
      b,
      w: e.xScale || e.scale || 1,
      font: this.fontOf(e),
      fill: this.textColor(e, inBlock),
    });
    item && out.items.push(item);
  }

  private mtext(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const parsed = parseMText(e.text);
    if (!parsed.text.trim()) return;
    const mm = this.ocs(e, m);
    let h = e.height || e.textHeight || 1;
    if (parsed.height) h = parsed.heightIsFactor ? h * parsed.height : parsed.height;
    const ap = e.attachmentPoint || 1;
    const col = (ap - 1) % 3;
    const row = Math.floor((ap - 1) / 3);
    // 文字方向：dxf-json 在缺省时把 direction 填成 (0,1)，与 rotation=0 矛盾。
    // 只在 rotation 为 0 且 direction 不是这个缺省值时使用 direction
    let rot = (e.rotation || 0) * DEG;
    const d = e.direction;
    if (!rot && d && !(Math.abs(d.x) < 1e-9 && Math.abs(d.y - 1) < 1e-9)) {
      rot = Math.atan2(d.y, d.x);
    }
    const item = this.placeText(mm, e.insertionPoint.x, e.insertionPoint.y, h, rot, {
      text: parsed.text,
      a: col === 0 ? 'left' : col === 1 ? 'center' : 'right',
      b: row === 0 ? 'top' : row === 1 ? 'middle' : 'bottom',
      lh: (e.lineSpacing || 1) * 1.6,
      w: parsed.widthFactor,
      // 参考框宽度（组码 41）：大于 0 时 AutoCAD 在框内自动换行（窄框里的中文看起来是竖排的）
      bw: e.width > 0 ? e.width : undefined,
      font: parsed.font || this.fontOf(e),
      bold: parsed.bold,
      italic: parsed.italic,
      fill: this.textColor(e, inBlock, parsed.aci, parsed.rgb),
    });
    item && out.items.push(item);
  }

  private fontCache = new Map<string, string | undefined>();
  /** 文字样式 → CSS 字体。SHX 字体浏览器无法使用，回退到通用字体 */
  private fontOf(e: Entity) {
    const name = e.styleName || e.textStyle;
    if (!name) return undefined;
    if (this.fontCache.has(name)) return this.fontCache.get(name);
    const style = (this.dxf.tables?.STYLE?.entries || []).find((s: any) => s.name === name);
    let font: string | undefined;
    const f = String(style?.font || '');
    if (f && !/\.shx$/i.test(f) && !/^(simplex|txt|romans|complex|isocp)$/i.test(f)) {
      font = f.replace(/\.(ttf|ttc|otf)$/i, '');
    }
    this.fontCache.set(name, font);
    return font;
  }

  // -------------------------------------------------------------------------
  // 填充
  // -------------------------------------------------------------------------

  private hatchBoundary(e: Entity, b: VectorPathBuilder) {
    for (const path of e.boundaryPaths || []) {
      if (path.vertices) {
        const vs: any[] = path.vertices;
        if (vs.length < 2) continue;
        b.moveTo(vs[0].x, vs[0].y);
        for (let i = 0; i < vs.length; i++) {
          const p = vs[i];
          const q = vs[(i + 1) % vs.length];
          if (i === vs.length - 1 && path.isClosed === false) break;
          b.bulgeTo(q.x, q.y, p.bulge || 0, [p.x, p.y]);
        }
        b.close();
      } else if (path.edges) {
        let started = false;
        for (const edge of path.edges) {
          switch (edge.type) {
            case 1:
              started ? b.lineTo(edge.start.x, edge.start.y) : b.moveTo(edge.start.x, edge.start.y);
              b.lineTo(edge.end.x, edge.end.y);
              break;
            case 2: {
              // 圆弧边：逆时针时角度原样；顺时针时 DXF 存的是取反后的角度（实测验证，见 README）
              const ccw = edge.isCCW !== false;
              const s = (ccw ? edge.startAngle : -edge.startAngle) * DEG;
              const en = (ccw ? edge.endAngle : -edge.endAngle) * DEG;
              b.ellipse(edge.center.x, edge.center.y, edge.radius, edge.radius, 0, s, en, !ccw, started);
              break;
            }
            case 3: {
              const a = Math.hypot(edge.end.x, edge.end.y);
              const rot = Math.atan2(edge.end.y, edge.end.x);
              const ccw = edge.isCCW !== false;
              const s = (ccw ? edge.startAngle : -edge.startAngle) * DEG;
              const en = (ccw ? edge.endAngle : -edge.endAngle) * DEG;
              b.ellipse(edge.center.x, edge.center.y, a, a * edge.lengthOfMinorAxis, rot, s, en, !ccw, started);
              break;
            }
            case 4: {
              const pts = edge.controlPoints?.length
                ? sampleNurbs({ degree: edge.degree, controlPoints: edge.controlPoints, knots: edge.knots })
                : (edge.fitDatum || []).map((p: any) => [p.x, p.y]);
              pts.forEach(([x, y]: [number, number], i: number) =>
                i || started ? b.lineTo(x, y) : b.moveTo(x, y),
              );
              break;
            }
          }
          started = true;
        }
        started && b.close();
      }
    }
  }

  private hatch(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const mm = this.ocs(e, m);
    const b = new VectorPathBuilder(mm);
    this.hatchBoundary(e, b);
    if (b.empty) return;
    const color = this.colorOf(e, inBlock);
    if (e.solidFill === 1 || !e.definitionLines?.length) {
      // 实体填充 / 渐变填充（渐变用首色近似）
      out.items.push(pathItem(b.d, { fill: color, stroke: 'none', rule: 'evenodd' }));
      return;
    }
    // 图案填充：定义线在 CAD 坐标中，随矩阵变换
    const lines: VectorHatchLine[] = e.definitionLines.map((l: any) => {
      const a = (l.angle || 0) * DEG;
      const [x, y] = applyMatrix(mm, l.base?.x || 0, l.base?.y || 0);
      const dx = mm[0] * (l.offset?.x || 0) + mm[2] * (l.offset?.y || 0);
      const dy = mm[1] * (l.offset?.x || 0) + mm[3] * (l.offset?.y || 0);
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const k = matrixScale(mm);
      const line: VectorHatchLine = {
        a: Math.atan2(mm[1] * ux + mm[3] * uy, mm[0] * ux + mm[2] * uy),
        x,
        y,
        dx,
        dy,
      };
      l.dashLengths?.length && (line.dash = l.dashLengths.map((v: number) => v * k));
      return line;
    });
    out.items.push({ t: 'h', d: b.d, lines, stroke: color === BYBLOCK ? undefined : color });
  }

  // -------------------------------------------------------------------------
  // 块
  // -------------------------------------------------------------------------

  /** 解析块定义为共享几何，返回 id；空块或循环引用返回 undefined */
  private blockGeom(name: string): string | undefined {
    if (this.blockIds.has(name)) {
      return this.blockIds.get(name) ?? undefined;
    }
    const block = this.dxf.blocks?.[name];
    if (!block) return undefined;
    this.blockIds.set(name, null);
    const out: Output = { items: [] };
    // 块基点：块内坐标 - 基点
    const base = block.position || { x: 0, y: 0 };
    const m: VectorMatrix = base.x || base.y ? translateMatrix(-base.x, -base.y) : IDENTITY;
    for (const ent of this.ordered(block.entities || [])) {
      try {
        this.emit(ent, m, true, out);
      } catch (err: any) {
        this.stats.errors.push(`${ent.type}#${ent.handle}: ${err?.message || err}`);
      }
    }
    if (!out.items.length) {
      this.blockIds.set(name, undefined);
      return undefined;
    }
    const geom = createGeom(out.items, (id) => this.vectors[id]);
    const id = `dxf-${this.id()}`;
    this.vectors[id] = geom;
    this.blockIds.set(name, id);
    return id;
  }

  /** INSERT 引用矩阵（块坐标 → INSERT 所在坐标），不含外层 m */
  private insertMatrix(e: Entity, col = 0, row = 0): VectorMatrix {
    const p = e.insertionPoint || { x: 0, y: 0 };
    const rot = (e.rotation || 0) * DEG;
    const sx = e.xScale ?? 1;
    const sy = e.yScale ?? 1;
    let local = composeMatrix(
      scaleMatrix(sx, sy),
      translateMatrix((e.columnSpacing || 0) * col, (e.rowSpacing || 0) * row),
      rotateMatrix(rot),
      translateMatrix(p.x, p.y),
    );
    if (e.type === 'INSERT' && e.extrusionDirection?.z < 0) local = multiplyMatrix(scaleMatrix(-1, 1), local);
    return local;
  }

  private insert(e: Entity, m: VectorMatrix, inBlock: boolean, out: Output) {
    const id = this.blockGeom(e.name);
    const cols = Math.max(1, e.columnCount || 1);
    const rows = Math.max(1, e.rowCount || 1);
    const color = this.colorOf(e, inBlock);
    if (id) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ref: VectorItem = { t: 'r', id, m: multiplyMatrix(m, this.insertMatrix(e, c, r)) };
          color !== BYBLOCK && (ref.c = color);
          out.items.push(ref);
        }
      }
    }
    // 属性值：dxf-json 把 ATTRIB 作为顶层实体放在 INSERT 之后，坐标已是世界坐标，由 convertByEntity 归并
  }

  // -------------------------------------------------------------------------
  // 输出
  // -------------------------------------------------------------------------

  /**
   * 选择要绘制的空间。
   * - 'model'：模型空间；'paper'：图纸空间（布局）
   * - 'auto'（默认）：优先模型空间；模型空间没有可绘制的实体时用图纸空间。
   *   有些图纸只在布局里画（模型空间为空），只取模型空间会得到 0 个图元。
   *
   * VIEWPORT 是布局里「看向模型空间的窗口」边框，本身不绘制（模型内容另行显示），统一跳过。
   */
  private selectSpace(all: Entity[]) {
    const drawable = (e: Entity) => e.type !== 'VIEWPORT';
    const model = all.filter((e) => !e.isInPaperSpace && drawable(e));
    const paper = all.filter((e) => e.isInPaperSpace && drawable(e));
    const space = this.opts.space;
    let pick = model;
    if (space === 'paper' || (space !== 'model' && !model.length && paper.length)) {
      pick = paper;
      this.stats.space = 'paper';
    } else {
      this.stats.space = 'model';
    }
    if (!pick.length && all.length) {
      this.stats.errors.push(`没有可绘制的实体（模型空间 ${model.length}，图纸空间 ${paper.length}）`);
    }
    return pick;
  }

  /** 按绘制次序表排序（同一块记录内的实体共用一张表） */
  private ordered(entities: Entity[]) {
    if (!this.drawOrder.size || !entities.length) return entities;
    const owner = entities.find((e) => e.ownerBlockRecordSoftId)?.ownerBlockRecordSoftId;
    return applyDrawOrder(entities, owner ? this.drawOrder.get(String(owner).toUpperCase()) : undefined);
  }

  /**
   * 底板：只有填充、没有描边，且覆盖图纸大半面积的图元（白色底板、图框底色）。
   *
   * 画布是「后画的盖住先画的」。没有绘制次序表的 DXF 里，底板常常按创建顺序排在图形之后，
   * 直接绘制会把整张图盖住，看起来像「解析不出图形」。AutoCAD 里用户看得到图形，说明底板实际在下面，
   * 所以这里把底板移到最底层。可用 backdrop: 'keep' 关闭，'remove' 直接去掉。
   */
  private sendBackdropsBack(pens: any[], ext: { minX: number; minY: number; maxX: number; maxY: number }) {
    const mode = this.opts.backdrop;
    if (mode === 'keep' || pens.length < 2) return;
    const area = (ext.maxX - ext.minX) * (ext.maxY - ext.minY);
    if (!(area > 0)) return;
    const isFillOnly = (it: any) =>
      (it.t === 'p' && it.s?.fill && it.s.fill !== 'none' && it.s.stroke === 'none') || it.t === 'h';
    const backdrops: any[] = [];
    const rest: any[] = [];
    for (const pen of pens) {
      const b = pen.vector.bbox;
      const items = pen.vector.items;
      const big = b.width * b.height >= area * 0.3;
      (big && items.length && items.every(isFillOnly) ? backdrops : rest).push(pen);
    }
    if (!backdrops.length) return;
    this.stats.backdrops = backdrops.length;
    pens.length = 0;
    if (mode === 'remove') {
      pens.push(...rest);
      return;
    }
    // 底板不参与交互（不被点中、拖动），否则一点图纸就选中了整块底板
    backdrops.forEach((p) => {
      p.locked = true;
      p.dxf = { ...p.dxf, backdrop: true };
    });
    pens.push(...backdrops, ...rest);
  }

  /**
   * CAD 坐标下的内容范围（图元已在单位矩阵下生成），用于自动缩放和定位。
   *
   * 剔除离群的孤立图元：真实图纸里常有远离主图的残留（误操作留下的一小块填充、坐标原点的点等），
   * 按全部图元算范围会让主图只占画面一角（实测暖通图纸：一个 3 像素的填充让主图缩小一半）。
   * 做法：按图元中心坐标取 0.2% ~ 99.8% 分位，再向外放宽一倍跨度，范围外的图元不参与范围计算
   * （它们仍然保留、照常绘制，只是不撑大图纸范围）。图元很少时不剔除。
   */
  private contentExtents(pens: any[]) {
    const boxes = pens.map((p) => p.vector.bbox as VectorBox).filter((b) => Number.isFinite(b.x));
    if (!boxes.length) {
      const h = this.dxf.header || {};
      const min = h.$EXTMIN;
      const max = h.$EXTMAX;
      if (min && max && max.x > min.x && max.y > min.y) {
        return { minX: min.x, minY: min.y, maxX: max.x, maxY: max.y };
      }
      return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    }
    let keep = boxes;
    if (boxes.length >= 200) {
      const cx = boxes.map((b) => b.x + b.width / 2).sort((a, b) => a - b);
      const cy = boxes.map((b) => b.y + b.height / 2).sort((a, b) => a - b);
      const q = (arr: number[], t: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * t)))];
      const x0 = q(cx, 0.002);
      const x1 = q(cx, 0.998);
      const y0 = q(cy, 0.002);
      const y1 = q(cy, 0.998);
      const mx = (x1 - x0) || 1;
      const my = (y1 - y0) || 1;
      keep = boxes.filter((b) => {
        const x = b.x + b.width / 2;
        const y = b.y + b.height / 2;
        return x >= x0 - mx && x <= x1 + mx && y >= y0 - my && y <= y1 + my;
      });
      this.stats.outliers = boxes.length - keep.length;
    }
    const acc = new BoxAccumulator();
    for (const b of keep) acc.addBox(b);
    const b = acc.box();
    return { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
  }

  /** 将内部几何片段统一变换到输出坐标。 */
  private placePens(fragments: any[]) {
    const m = this.world;
    const k = matrixScale(m);
    for (const fragment of fragments) {
      fragment.vector.items = fragment.vector.items.map((it: VectorItem) => transformItem(it, m, k));
      fragment.vector = createGeom(fragment.vector.items, (id) => this.vectors[id]);
      Object.assign(fragment, fragment.vector.bbox);
    }
  }

  private dxfInfo(e: Entity): DxfEntityInfo {
    const info: DxfEntityInfo = { type: e.type, layer: e.layer };
    e.handle != null && (info.handle = String(e.handle));
    e.type === 'INSERT' && e.name && (info.block = e.name);
    return info;
  }

  private makePen(items: VectorItem[], extra: Record<string, any>) {
    const geom = createGeom(items, (id) => this.vectors[id]);
    const { bbox } = geom;
    if (!Number.isFinite(bbox.x) || !Number.isFinite(bbox.y)) return undefined;
    return { id: this.id(), ...bbox, vector: geom, ...extra };
  }

  private convertByEntity(entities: Entity[]) {
    const pens: any[] = [];
    let lastInsert: { pen: any; e: Entity } | undefined;
    for (const e of entities) {
      // ATTRIB 紧跟在所属 INSERT 之后（到 SEQEND 为止）：并入该 INSERT 的图元，一起选中、一起移动。
      // 按先后关系判断，不比对句柄：dxf-json 把 ATTRIB 的 330 组码解析成模型空间的块记录，
      // ownerBlockRecordSoftId 不等于 INSERT 句柄（实测 ezdxf 生成的图纸），按句柄比对永远匹配不上
      if (e.type !== 'ATTRIB' && e.type !== 'SEQEND') {
        // 其它实体打断归属；INSERT 自己没有生成图元时，它的属性也不能并到上一个块上
        lastInsert = undefined;
      }
      if (e.type === 'ATTRIB' && lastInsert) {
        try {
          const out: Output = { items: [] };
          this.emit(e, this.world, false, out);
          if (out.items.length) {
            const prev = lastInsert.pen;
            const merged = this.makePen([...this.denormalize(prev), ...out.items], {
              name: prev.name,
              color: prev.color,
              dxf: prev.dxf,
            });
            if (merged) {
              merged.id = prev.id;
              pens[pens.length - 1] = merged;
              lastInsert.pen = merged;
            }
          }
        } catch (err: any) {
          this.stats.errors.push(`${e.type}#${e.handle}: ${err?.message || err}`);
        }
        continue;
      }
      try {
        const out: Output = { items: [] };
        this.emit(e, this.world, false, out);
        if (!out.items.length) continue;
        // 顶层实体颜色交给 pen.color，item 用 $fg，这样悬停 / 选中能整体换色
        const color = this.liftColor(out.items, e);
        const pen = this.makePen(out.items, {
          name: e.type === 'INSERT' ? e.name : e.type,
          color,
          dxf: this.dxfInfo(e),
        });
        if (!pen) continue;
        pens.push(pen);
        lastInsert = e.type === 'INSERT' ? { pen, e } : undefined;
      } catch (err: any) {
        this.stats.errors.push(`${e.type}#${e.handle}: ${err?.message || err}`);
      }
    }
    return pens;
  }

  /** 图元的几何是归一化后的，合并属性前取回原 items（它们本来就是绝对坐标，bbox 只是包围盒） */
  private denormalize(pen: any): VectorItem[] {
    return pen.vector.items;
  }

  /**
   * 顶层实体：若所有描边/文字都是同一个具体颜色，提升为 pen.color，items 改为跟随前景色，
   * 使悬停、选中、属性面板改色都能生效。返回提升的颜色。
   */
  private liftColor(items: VectorItem[], e: Entity): string | undefined {
    if (e.type === 'INSERT' || e.type === 'DIMENSION') {
      const ref = items.find((i) => i.t === 'r') as any;
      if (ref?.c) {
        const c = ref.c;
        items.forEach((i: any) => i.t === 'r' && i.c === c && delete i.c);
        return c;
      }
      return undefined;
    }
    let color: string | undefined;
    for (const it of items as any[]) {
      const c = it.t === 'p' ? it.s?.stroke ?? it.s?.fill : it.t === 't' ? it.fill : it.t === 'h' ? it.stroke : undefined;
      if (!c || c === 'none') continue;
      if (color && color !== c) return undefined;
      color = c;
    }
    if (!color) return undefined;
    for (const it of items as any[]) {
      if (it.t === 'p' && it.s) {
        it.s.stroke === color && delete it.s.stroke;
        it.s.fill === color && (it.s.fill = '$fg');
        it.s.stroke === undefined && it.s.fill === undefined && delete it.s.stroke;
        Object.keys(it.s).length || delete it.s;
      } else if (it.t === 't' && it.fill === color) {
        delete it.fill;
      } else if (it.t === 'h' && it.stroke === color) {
        delete it.stroke;
      }
    }
    return color;
  }

  private convertByLayer(entities: Entity[]) {
    const groups = new Map<string, VectorItem[]>();
    for (const e of entities) {
      try {
        const out: Output = { items: [] };
        this.emit(e, this.world, false, out);
        if (!out.items.length) continue;
        let list = groups.get(e.layer);
        list || groups.set(e.layer, (list = []));
        list.push(...out.items);
      } catch (err: any) {
        this.stats.errors.push(`${e.type}#${e.handle}: ${err?.message || err}`);
      }
    }
    const pens: any[] = [];
    groups.forEach((items, layer) => {
      const pen = this.makePen(items, { name: layer, color: this.layers.get(layer)?.color, dxf: { layer } });
      pen && pens.push(pen);
    });
    return pens;
  }
}

export type { VectorBox };
