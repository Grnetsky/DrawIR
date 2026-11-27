import {
  applyMatrix,
  BoxAccumulator,
  composeMatrix,
  computeItemsBox,
  createGeom,
  IDENTITY,
  multiplyMatrix,
  pathItem,
  rotateMatrix,
  scaleMatrix,
  translateMatrix,
  VectorGeom,
  VectorItem,
  VectorMatrix,
  VectorStyle,
  VectorTextItem,
} from '@drawir/core';
import { penRectOfGeom, s8 } from './util';
import { buildGeometry } from './geometry';
import { detectNativeShape } from './native';
import { VsdxPackage } from './package';
import { RawShape, Sheet, StyleSheet, toRawShape } from './sheet';
import { evalColor, matrixIndex, quickStyleColor, readTheme, resolveColor, Theme, withAlpha } from './theme';
import type { VisioDocument, VisioPageInfo, VisioParseOptions, VisioParseStats, VisioPenInfo } from './types';

const PT = 1 / 72; // 1 磅 = 1/72 英寸

/** 线型（LinePattern）→ 虚线（以线宽为单位） */
const DASH: Record<number, number[]> = {
  2: [4, 3],
  3: [1, 3],
  4: [4, 3, 1, 3],
  5: [4, 3, 1, 3, 1, 3],
  6: [8, 3, 4, 3],
  7: [12, 6],
  8: [12, 6, 3, 6],
  9: [2, 2],
  10: [1, 1],
  11: [6, 2, 1, 2],
  12: [6, 2, 1, 2, 1, 2],
  13: [8, 2],
  14: [16, 4],
  15: [16, 4, 4, 4],
  16: [6, 3],
  23: [1, 2],
};

/** Visio 箭头编号 → 箭头形状，适配层换成各版本的箭头名 */
export type VisioArrow = 'line' | 'circle' | 'diamond' | 'triangle';
function arrowOf(v: number): VisioArrow | undefined {
  if (!v) return undefined;
  if ([1, 2, 3, 6, 7, 8].includes(v)) return 'line';
  if ([10, 11, 12, 21].includes(v)) return 'circle';
  if ([22, 23, 24].includes(v)) return 'diamond';
  return 'triangle';
}

/**
 * 把通用图元转成某个 meta2d 版本的图元格式。
 * 通用图元用绝对坐标，kind 标明图形类别：vector / native（type 为原生图形名）/ image / group / line / text
 */
export interface VisioPenAdapter {
  /** 补上图形类型、名称；locked 为 true 时换成该版本的锁定值 */
  pen(pen: any, kind: 'vector' | 'native' | 'image' | 'group', label: string | undefined, nativeType?: string): void;
  text(item: VectorTextItem, opts: { id: string; label?: string; color?: string }): any;
  line(pen: any, route: 'line' | 'curve', label: string | undefined, arrows: { from?: VisioArrow; to?: VisioArrow }): void;
  isLine(pen: any): boolean;
  isGroup(pen: any): boolean;
  /** 连线上的文字：返回独立的文字图元，或并入连线后返回 undefined */
  lineLabel(line: any, t: VectorTextItem): any;
  connect(line: any, lineAnchor: any, node: any, anchor: any): void;
  /** 解析结束后的统一处理（如 1.0 换算相对坐标） */
  finish?(pens: any[]): void;
}

interface PageCtx {
  pageIndex: number;
  /** 页面高度（英寸），Y 翻转用 */
  height: number;
  /** 页面在画布中的偏移（像素） */
  ox: number;
  oy: number;
  /** 形状 ID → 生成的图元（连接用） */
  penOfShape: Map<string, any>;
  /** 形状 ID → 连接点（局部英寸坐标） */
  connPoints: Map<string, { ix: string; x: number; y: number }[]>;
  /** 形状 ID → 局部坐标 → 页面坐标（英寸）矩阵 */
  shapeToPage: Map<string, VectorMatrix>;
}

/**
 * VSDX → meta2d 图元。
 *
 * 普通形状 → 矢量图元（几何、填充、线型、文字全部进 IR）；
 * 连接线（有 BeginX/EndX 的一维形状）→ meta2d 原生连线，并按 Connects 建立连接关系，拖动图形时连线跟随；
 * 组合 → 组合图元，子形状各自成为图元；
 * 图片（Foreign Bitmap）→ image 图元，图片转为 data URL。
 *
 * 与旧版（1.0.x，drawCommand）的差异：
 * - 不依赖 window / meta2d 全局（V1 用 window.innerHeight 翻转 Y，结果随窗口大小变化），无单例，ID 前缀不再是全局可变状态；
 * - 母版与形状的几何按 IX 合并后只画一份（V1 两份都画，形状改过的行会重叠）；
 * - 属性按 形状 → 母版 → 样式（含样式继承）完整求值，主题色兜底；
 * - 弧、椭圆弧、NURBS、折线在解析期求解，不再依赖渲染器里的 Visio 专用代码；
 * - 旋转、翻转、组合嵌套用矩阵统一处理，组合内子形状的位置不再出错。
 */
export class VisioConverter {
  private opts: Required<Omit<VisioParseOptions, 'pages'>> & Pick<VisioParseOptions, 'pages'>;
  private pkg: VsdxPackage;
  private theme: Theme;
  private styles = new Map<string, StyleSheet>();
  /** 母版 ID → 母版形状（MasterShape ID → Sheet） */
  private masters = new Map<string, { top?: Sheet; byId: Map<string, Sheet> }>();
  private imageCache = new Map<string, string>();
  /**
   * 当前页：页面坐标 1 英寸 → 画布像素（几何）。比例图纸（建筑平面 1:50 等）的页面坐标是实际尺寸，
   * 需要乘 PageScale / DrawingScale 才是纸面尺寸。
   */
  private geomK = 96;
  /** 当前页：纸面 1 英寸 → 画布像素（线宽、字号是纸面量，不随绘图比例缩放） */
  private paperK = 96;
  stats: VisioParseStats;

  /** 图元 → 显示名称 */
  private labels = new WeakMap<any, string | undefined>();

  constructor(options: VisioParseOptions = {}, private adapter: VisioPenAdapter) {
    this.opts = { dpi: 96, pageGap: 40, nativeLines: true, pageBorder: false, editable: true, ...options };
  }

  convert(data: Uint8Array): VisioDocument {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.stats = { pages: 0, shapes: 0, lines: 0, connections: 0, images: 0, masters: 0, unsupported: {}, errors: [], ms: 0 };
    this.pkg = new VsdxPackage(data);
    if (!this.pkg.has('visio/document.xml')) {
      throw new Error('不是有效的 VSDX 文件（缺少 visio/document.xml）。注意：旧版 .vsd 二进制格式不支持，请在 Visio 中另存为 .vsdx');
    }
    this.theme = readTheme(this.pkg);
    this.readStyles();

    const pens: any[] = [];
    const pageList: VisioPageInfo[] = [];
    const pagesXml = this.pkg.xml('visio/pages/pages.xml');
    const rels = this.pkg.rels('visio/pages/pages.xml');
    const pages = (pagesXml?.Pages?.Page || []).filter((p: any) => p.Background !== '1');
    let ox = 0;
    pages.forEach((page: any, index: number) => {
      if (this.opts.pages && !this.opts.pages.includes(index)) return;
      const path = rels[page.Rel?.['r:id']];
      if (!path) return;
      const sheet = toCells(page.PageSheet?.Cell);
      const pw = +sheet.PageWidth?.V || 8.5;
      const ph = +sheet.PageHeight?.V || 11;
      // 绘图比例：页面坐标（实际尺寸）× PageScale / DrawingScale = 纸面尺寸
      const ratio = (+sheet.PageScale?.V || 1) / (+sheet.DrawingScale?.V || 1);
      this.paperK = this.opts.dpi;
      this.geomK = this.opts.dpi * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
      const k = this.geomK;
      const ctx: PageCtx = {
        pageIndex: index,
        height: ph,
        ox,
        oy: 0,
        penOfShape: new Map(),
        connPoints: new Map(),
        shapeToPage: new Map(),
      };
      try {
        this.convertPage(path, ctx, pens);
      } catch (e: any) {
        this.stats.errors.push(`页面 ${page.Name || index}：${e?.message || e}`);
      }
      pageList.push({ name: page.NameU || page.Name || `Page-${index + 1}`, x: ox, y: 0, width: pw * k, height: ph * k });
      if (this.opts.pageBorder) {
        pens.unshift(Object.assign(this.pageBorderPen(ox, pw * k, ph * k), { vsdx: { page: index, part: 'page' } }));
      }
      ox += pw * k + this.opts.pageGap;
      this.stats.pages++;
    });

    this.adapter.finish?.(pens);
    this.stats.ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    const last = pageList[pageList.length - 1];
    return {
      pens,
      vectors: {},
      width: last ? last.x + last.width : 0,
      height: Math.max(0, ...pageList.map((p) => p.height)),
      pageList,
      background: this.theme.background,
      stats: this.stats,
    };
  }

  // -------------------------------------------------------------------------
  // 文档、母版、样式
  // -------------------------------------------------------------------------

  private readStyles() {
    const doc = this.pkg.xml('visio/document.xml');
    for (const s of doc?.VisioDocument?.StyleSheets?.StyleSheet || []) {
      this.styles.set(s.ID, new StyleSheet(s, this.styles));
    }
  }

  private master(id: string | undefined) {
    if (id === undefined) return undefined;
    if (this.masters.has(id)) return this.masters.get(id);
    const entry = { top: undefined as Sheet | undefined, byId: new Map<string, Sheet>() };
    this.masters.set(id, entry);
    const list = this.pkg.xml('visio/masters/masters.xml');
    const m = (list?.Masters?.Master || []).find((x: any) => x.ID === id);
    const path = m && this.pkg.rels('visio/masters/masters.xml')[m.Rel?.['r:id']];
    const xml = path && this.pkg.xml(path);
    const shapes: any[] = xml?.MasterContents?.Shapes?.Shape || [];
    const add = (raw: RawShape) => {
      const s = new Sheet(raw, undefined, this.styles);
      entry.byId.set(raw.ID, s);
      raw.children.forEach(add);
      return s;
    };
    const tops = shapes.map((x) => add(toRawShape(x)));
    // 母版只有一个顶层形状时，页面形状直接继承它；有多个时页面形状是一个组合，子形状按 MasterShape 继承
    entry.top = tops.length === 1 ? tops[0] : undefined;
    if (entry.top && !entry.top.nameU && m?.NameU) entry.top.raw.NameU = m.NameU;
    this.stats.masters++;
    return entry;
  }

  // -------------------------------------------------------------------------
  // 页面
  // -------------------------------------------------------------------------

  private convertPage(path: string, ctx: PageCtx, pens: any[]) {
    const xml = this.pkg.xml(path)?.PageContents;
    const shapes: RawShape[] = (xml?.Shapes?.Shape || []).map(toRawShape);
    const k = this.geomK;
    // 页面坐标（英寸，Y 向上）→ 画布像素
    const pageToCanvas: VectorMatrix = [k, 0, 0, -k, ctx.ox, ctx.oy + ctx.height * k];
    const connectors: { sheet: Sheet; pen: any; raw: RawShape }[] = [];

    const walk = (raw: RawShape, parentMatrix: VectorMatrix, parentMaster: { top?: Sheet; byId: Map<string, Sheet> } | undefined, parentPen?: any) => {
      if (raw.Del === '1') return;
      // 母版：页面上的顶层形状用 Master；组合里的子形状用 MasterShape 引用父级母版里的形状
      let masterEntry = raw.Master !== undefined ? this.master(raw.Master) : parentMaster;
      let masterSheet: Sheet | undefined;
      if (raw.MasterShape !== undefined && masterEntry) masterSheet = masterEntry.byId.get(raw.MasterShape);
      else if (raw.Master !== undefined) masterSheet = masterEntry?.top;
      const sheet = new Sheet(raw, masterSheet, this.styles);

      const local = this.localMatrix(sheet);
      const toPage = multiplyMatrix(parentMatrix, local);
      ctx.shapeToPage.set(raw.ID, toPage);
      const toCanvas = multiplyMatrix(pageToCanvas, toPage);
      this.stats.shapes++;

      // 连接点（连接线的端点吸附用）
      const conns = sheet
        .sections('Connection')
        .flatMap((s) => s.rows)
        .map((r) => ({ ix: r.IX ?? '0', x: +(r.cells.X?.V ?? 0), y: +(r.cells.Y?.V ?? 0) }));
      conns.length && ctx.connPoints.set(raw.ID, conns);

      const isLine = this.isConnector(sheet);
      const info = this.vsdxInfo(sheet, ctx);
      let pen: any;
      try {
        if (isLine && this.opts.nativeLines) {
          pen = this.linePen(sheet, toCanvas, pageToCanvas, parentMatrix);
          // 曲线连接线会退化成矢量图元（见 linePen），它不是连线，不能登记连接关系：
          // 否则会在它的锚点上写连接信息、往图形的 connectedLines 里登记它，拖动图形时 core 会把它当连线去更新
          pen && this.adapter.isLine(pen) && connectors.push({ sheet, pen, raw });
        } else if (sheet.type === 'Foreign') {
          pen = this.imagePen(sheet, toCanvas, path);
        } else {
          pen = this.vectorPen(sheet, toCanvas);
        }
      } catch (e: any) {
        this.stats.errors.push(`形状 ${raw.ID}：${e?.message || e}`);
      }
      pen && (pen.vsdx = info);

      const isGroup = sheet.type === 'Group' && raw.children.length > 0;
      if (isGroup) {
        // 组合：自身几何（若有）作为一个图元放在最下面，然后是子形状；外面套一个 group 图元
        const group = this.groupPen(sheet);
        group.vsdx = { ...info };
        pens.push(group);
        parentPen && attach(parentPen, group);
        ctx.penOfShape.set(raw.ID, group);
        if (pen) {
          pens.push(pen);
          attach(group, pen);
          this.flushTexts(pen, pens, group);
        }
        const childMaster = raw.Master !== undefined ? masterEntry : parentMaster;
        raw.children.forEach((c) => walk(c, toPage, childMaster, group));
        fitGroup(group, pens);
        return;
      }
      if (pen) {
        pens.push(pen);
        parentPen && attach(parentPen, pen);
        ctx.penOfShape.set(raw.ID, pen);
        this.flushTexts(pen, pens, parentPen);
        if (pen._label) {
          const label = this.lineLabel(pen, pen._label);
          delete pen._label;
          label && pens.push(Object.assign(label, { vsdx: { ...pen.vsdx, part: 'text' } }));
        }
      }
    };

    shapes.forEach((s) => walk(s, IDENTITY, undefined));

    // 连接关系
    const connects: any[] = xml?.Connects?.Connect || [];
    this.applyConnects(connects, connectors, ctx, pageToCanvas);
  }

  /** 形状局部坐标 → 父坐标：平移到 Pin、旋转、翻转、减去 LocPin */
  private localMatrix(s: Sheet): VectorMatrix {
    const w = s.num('Width');
    const h = s.num('Height');
    const flipX = s.num('FlipX') ? -1 : 1;
    const flipY = s.num('FlipY') ? -1 : 1;
    return composeMatrix(
      translateMatrix(-s.num('LocPinX', w / 2), -s.num('LocPinY', h / 2)),
      scaleMatrix(flipX, flipY),
      rotateMatrix(s.num('Angle')),
      translateMatrix(s.num('PinX'), s.num('PinY')),
    );
  }

  private mark(pen: any, kind: 'vector' | 'native' | 'image' | 'group', label: string | undefined, nativeType?: string) {
    this.labels.set(pen, label);
    this.adapter.pen(pen, kind, label, nativeType);
  }

  private isConnector(s: Sheet) {
    const hasEnds = s.cell('BeginX')?.V !== undefined && s.cell('EndX')?.V !== undefined;
    if (!hasEnds) return false;
    // 一维形状（有起止点）且不是组合里的装饰：ObjType 2 = 连接线；没有 ObjType 时按名字判断
    const obj = s.num('ObjType', -1);
    if (obj === 2) return true;
    return /connector|连接线|Line|直线|Arc|弧/i.test(s.nameU || '') || obj === -1 || obj === 0;
  }

  // -------------------------------------------------------------------------
  // 样式
  // -------------------------------------------------------------------------

  private color(s: Sheet, name: string, kind: 'line' | 'fill' | 'text') {
    const c = s.cell(name, kind);
    return resolveColor(c?.V, c?.F, this.theme);
  }

  /**
   * 主题颜色解析（规则与 LibreOffice libvisio 一致）：
   * 先按 QuickStyle 颜色 / 矩阵取主题色，再用单元格里**显式**的颜色覆盖；值为 'Themed' 的单元格不算显式颜色。
   */
  private explicitColor(s: Sheet, name: string, kind: 'line' | 'fill' | 'text') {
    const c = s.cell(name, kind);
    // 'Themed' 与「整个公式就是 THEMEVAL(...)」都表示跟随主题，V 只是兜底值（常见 V='1' 即白色），不算显式颜色。
    // THEMEGUARD(...) 是用户在主题色基础上自定义并锁定的颜色（如 MSOTINT(THEMEVAL("AccentColor4"),40)），
    // Visio 已把结果算好存在 V 里，必须用 V
    if (!c || c.V === undefined || c.V === 'Themed') return undefined;
    if (/^\s*THEMEVAL\(/i.test(c.F || '')) return undefined;
    return resolveColor(c.V, c.F, this.theme);
  }

  /**
   * 变体配色序号。libvisio 一律取第一组（getThemeColour 的 variationIndex 缺省 0），文档里也没有记录当前选用哪组，
   * 这里保持一致；参数保留，便于以后从 document.xml 的设置里读出来
   */
  private variation(_s: Sheet) {
    return 0;
  }

  private lineColor(s: Sheet) {
    const explicit = this.explicitColor(s, 'LineColor', 'line');
    if (explicit) return explicit;
    const qs = s.cell('QuickStyleLineColor')?.V;
    return (qs !== undefined && quickStyleColor(this.theme, +qs, this.variation(s))) || this.theme.colors.dk1;
  }

  private lineStyle(s: Sheet, k: number): VectorStyle & { none?: boolean } {
    const pattern = s.num('LinePattern', 1, 'line');
    if (pattern === 0) return { stroke: 'none', none: true };
    const color = withAlpha(this.lineColor(s), s.num('LineColorTrans', 0, 'line'));
    // 线宽：英寸 → 像素（随缩放）
    const lwIn = s.num('LineWeight', PT * 0.75, 'line');
    const lw = Math.max(lwIn * k, 0.5);
    const style: VectorStyle = { stroke: color, lw };
    const dash = DASH[pattern];
    dash && (style.dash = dash.map((v) => v * Math.max(lw, 1)));
    const cap = s.num('LineCap', 0, 'line');
    style.cap = cap === 1 ? 'square' : cap === 2 ? 'butt' : 'round';
    style.join = 'round';
    return style;
  }

  private fillColor(s: Sheet): string | undefined {
    const pattern = s.num('FillPattern', 1, 'fill');
    if (pattern === 0) return undefined;
    // 主题色：QuickStyleFillColor（缺省 100）→ 变体色；QuickStyleFillMatrix → 主题填充样式；最后显式 FillForegnd 覆盖
    const qsColor = s.cell('QuickStyleFillColor')?.V;
    const qsMatrix = s.cell('QuickStyleFillMatrix')?.V;
    let fg = quickStyleColor(this.theme, qsColor !== undefined ? +qsColor : 100, this.variation(s));
    // 矩阵：样式表里的颜色表达式（可引用占位色 phClr = QuickStyle 颜色，并带 tint / shade）
    const idx = qsMatrix !== undefined ? matrixIndex(this.theme, +qsMatrix, 'fill', this.variation(s)) : undefined;
    if (idx) {
      fg = evalColor(this.theme.fillExprs[idx - 1], this.theme, fg) || this.theme.fillStyles[idx - 1] || fg;
    }
    fg = this.explicitColor(s, 'FillForegnd', 'fill') || fg;
    if (s.num('FillGradientEnabled', 0, 'fill')) {
      const stop = s.row('FillGradient', { IX: '0' });
      const c = stop && resolveColor(stop.cells.GradientStopColor?.V, stop.cells.GradientStopColor?.F, this.theme);
      c && (fg = c);
    }
    return withAlpha(fg || '#FFFFFF', s.num('FillForegndTrans', 0, 'fill'));
  }

  // -------------------------------------------------------------------------
  // 图元
  // -------------------------------------------------------------------------

  private geometryItems(s: Sheet, toCanvas: VectorMatrix): VectorItem[] {
    const items: VectorItem[] = [];
    const w = s.num('Width');
    const h = s.num('Height');
    const line = this.lineStyle(s, this.paperK);
    const fill = this.fillColor(s);
    for (const sec of s.sections('Geometry')) {
      if (sec.cells.NoShow?.V === '1') continue;
      for (const r of sec.rows) {
        r.T && !KNOWN_ROWS.has(r.T) && (this.stats.unsupported[r.T] = (this.stats.unsupported[r.T] || 0) + 1);
      }
      const g = buildGeometry(sec, w, h, toCanvas);
      if (!g.d.length) continue;
      const style: VectorStyle = {};
      // 只填充、不描边（NoLine=1）的几何即使首尾没有显式闭合也要填充（Visio 按隐式闭合填充，Canvas fill 同样隐式闭合）。
      // 例：电气模具的 IEC 电阻本体是一条首尾不相接的「回」字形路径，只有填充
      if (!g.noFill && (g.closed || g.noLine) && fill) {
        style.fill = fill;
        style.rule = 'evenodd';
      }
      if (!g.noLine && !line.none) Object.assign(style, line);
      else style.stroke = 'none';
      delete (style as any).none;
      if (style.stroke === 'none' && !style.fill) continue;
      items.push(pathItem(g.d, style));
    }
    return items;
  }

  private textItems(s: Sheet, toCanvas: VectorMatrix): VectorTextItem[] {
    const text = extractText(s.raw.text ?? s.master?.raw.text);
    if (!text || s.num('HideText')) return [];
    // 字号是纸面尺寸（磅），不随绘图比例缩放
    const k = this.paperK;
    const w = s.num('Width');
    const h = s.num('Height');
    // 文本块：TxtPin（形状局部）+ TxtWidth/TxtHeight + TxtLocPin + TxtAngle
    const tw = s.num('TxtWidth', w);
    const th = s.num('TxtHeight', h);
    const tpx = s.num('TxtPinX', w / 2);
    const tpy = s.num('TxtPinY', h / 2);
    const tlx = s.num('TxtLocPinX', tw / 2);
    const tly = s.num('TxtLocPinY', th / 2);
    const tAngle = s.num('TxtAngle');
    const ch = s.row('Character', { IX: '0' });
    const size = (ch?.cells.Size?.V ? +ch.cells.Size.V : 0) || s.num('Size', 12 * PT, 'text') || 12 * PT;
    const color = this.textColor(s, ch);
    const style = +(ch?.cells.Style?.V ?? s.num('Style', 0, 'text'));
    const para = s.row('Paragraph', { IX: '0' });
    const halign = +(para?.cells.HorzAlign?.V ?? s.num('HorzAlign', 1, 'text'));
    const valign = s.num('VerticalAlign', 1, 'text');
    const margin = (n: string) => s.num(n, 0, 'text');
    // 文本块局部坐标（英寸，Y 向上）里的锚点
    let ax = halign === 0 ? margin('LeftMargin') : halign === 2 ? tw - margin('RightMargin') : tw / 2;
    let ay = valign === 0 ? th - margin('TopMargin') : valign === 2 ? margin('BottomMargin') : th / 2;
    // 文本块 → 形状局部
    const textToShape = composeMatrix(translateMatrix(-tlx, -tly), rotateMatrix(tAngle), translateMatrix(tpx, tpy));
    const [lx, ly] = applyMatrix(textToShape, ax, ay);
    // 文字方向：文本块的 X 轴
    const ux = applyMatrix(multiplyMatrix(toCanvas, textToShape), ax + 1, ay);
    const [px, py] = applyMatrix(toCanvas, lx, ly);
    const font = (ch?.cells.Font?.V && ch.cells.Font.V !== 'Themed' && !/^\d+$/.test(ch.cells.Font.V) ? ch.cells.Font.V : undefined) as string | undefined;
    const item: VectorTextItem = {
      t: 't',
      text,
      x: px,
      y: py,
      h: size * k,
      a: halign === 0 ? 'left' : halign === 2 ? 'right' : 'center',
      b: valign === 0 ? 'top' : valign === 2 ? 'bottom' : 'middle',
      lh: 1.2,
      fill: color,
    };
    const r = Math.atan2(ux[1] - py, ux[0] - px);
    // 文字不随形状翻转镜像（Visio 里翻转后的文字仍可读），只保留旋转；接近 0 时省略
    if (Math.abs(r) > 1e-6) item.r = r;
    style & 1 && (item.bold = true);
    style & 2 && (item.italic = true);
    font && (item.font = `"${font}", sans-serif`);
    return [item];
  }

  private vectorPen(s: Sheet, toCanvas: VectorMatrix) {
    const texts = this.textItems(s, toCanvas);
    if (!this.opts.editable) {
      const items = [...this.geometryItems(s, toCanvas), ...texts];
      if (!items.length) return undefined;
      const geom = createGeom(items);
      const pen: any = {
        id: s8(),
        ...penRectOfGeom(geom.bbox),
        vector: geom,
        anchors: this.anchorsOf(s, toCanvas, geom),
      };
      this.mark(pen, 'vector', s.raw.Name || s.nameU || 'Visio');
      return pen;
    }

    // 可编辑：标准形状 → 原生图元；其余 → 矢量图元（颜色 / 线宽绑定到图元属性）；文字 → 原生文字图元
    const pen = this.nativePen(s, toCanvas) || this.boundVectorPen(s, toCanvas);
    const textPens = texts.map((t) =>
      this.adapter.text(t, { id: s8(), label: (s.raw.Name || s.nameU || 'Visio') + '-文字', color: this.theme.colors.dk1 }),
    );
    if (!pen) {
      // 纯文本形状：直接就是文字图元（锚点留给连线）
      if (textPens.length === 1) {
        textPens[0].anchors = this.anchorsOf(s, toCanvas);
        delete textPens[0].disableAnchor;
        return textPens[0];
      }
      return undefined;
    }
    textPens.length && (pen._texts = textPens);
    return pen;
  }

  /**
   * 形状的文字图元放在形状之后（层级在上）。
   * 有父组合时直接挂到组合里；没有时形状 + 文字组成一个组合，拖动形状时文字跟着走，双击文字可改内容。
   */
  private flushTexts(pen: any, pens: any[], parent: any) {
    const texts: any[] = pen._texts;
    if (!texts?.length) return;
    delete pen._texts;
    if (parent) {
      texts.forEach((t) => {
        t.vsdx = { ...pen.vsdx, part: 'text' };
        pens.push(t);
        attach(parent, t);
      });
      return;
    }
    // 形状与文字组成组合。连线的 connectedPen 仍指向形状本身（锚点在形状上），组合只负责一起移动
    const group: any = { id: s8(), vsdx: { ...pen.vsdx }, children: [] };
    this.mark(group, 'group', this.labels.get(pen));
    const i = pens.indexOf(pen);
    pens.splice(i, 0, group);
    attach(group, pen);
    texts.forEach((t) => {
      t.vsdx = { ...pen.vsdx, part: 'text' };
      pens.push(t);
      attach(group, t);
    });
    fitGroup(group, pens);
  }

  /** 标准形状（矩形、圆、菱形、三角形…）→ meta2d 原生图元，属性面板的圆角、背景、边框等全部可用 */
  private nativePen(s: Sheet, toCanvas: VectorMatrix) {
    const w = s.num('Width');
    const h = s.num('Height');
    const geoms = s.sections('Geometry').filter((g) => g.cells.NoShow?.V !== '1');
    const native = detectNativeShape(geoms, w, h);
    if (!native) return undefined;
    // 原生图元不支持翻转 + 任意仿射；只接受「旋转 + 等比缩放」的形状，翻转用 flipX / flipY
    const [x0, y0] = applyMatrix(toCanvas, 0, h);
    const [x1, y1] = applyMatrix(toCanvas, w, h);
    const [x2, y2] = applyMatrix(toCanvas, 0, 0);
    const pw = Math.hypot(x1 - x0, y1 - y0);
    const ph = Math.hypot(x2 - x0, y2 - y0);
    // 局部 X 轴方向 → 旋转角；行列式符号 → 是否镜像
    const ux = (x1 - x0) / (pw || 1);
    const uy = (y1 - y0) / (pw || 1);
    const vx = (x2 - x0) / (ph || 1);
    const vy = (y2 - y0) / (ph || 1);
    const det = ux * vy - uy * vx;
    const [cx, cy] = applyMatrix(toCanvas, w / 2, h / 2);
    const line = this.lineStyle(s, this.paperK);
    const fill = this.fillColor(s);
    const pen: any = {
      id: s8(),
      x: cx - pw / 2,
      y: cy - ph / 2,
      width: pw,
      height: ph,
      color: line.none ? undefined : line.stroke,
      lineWidth: line.none ? 0 : line.lw,
      // 'none'（全透明）不是合法的 Canvas 颜色，写进 background 会被画成黑色
      background: fill && fill !== 'none' ? fill : undefined,
      anchors: this.anchorsOf(s, toCanvas),
    };
    line.dash && (pen.lineDash = line.dash);
    let rotate = (Math.atan2(uy, ux) * 180) / Math.PI;
    if (det < 0) {
      // 镜像：Y 方向翻转，再按 X 轴角度旋转
      pen.flipY = true;
    }
    Math.abs(rotate) > 1e-6 ? (pen.rotate = rotate) : (rotate = 0);
    // 圆角矩形：Rounding（英寸）→ borderRadius（像素）
    const rounding = s.num('Rounding', 0, 'line');
    native.type === 'rectangle' && rounding > 0 && (pen.borderRadius = rounding * this.geomK);
    this.mark(pen, 'native', s.raw.Name || s.nameU || native.type, native.type);
    return pen;
  }

  /**
   * 文字颜色：形状 / 母版字符行里的显式颜色 → QuickStyle（字体矩阵的颜色表达式，phClr = QuickStyleFontColor）→ 样式里的颜色 → 主题深色
   */
  private textColor(s: Sheet, ch: any) {
    const cc = ch?.cells.Color;
    if (cc?.V && cc.V !== 'Themed' && !/^\s*THEMEVAL\(/i.test(cc.F || '')) {
      const c = resolveColor(cc.V, cc.F, this.theme);
      if (c) return c;
    }
    const qsColor = s.cell('QuickStyleFontColor')?.V;
    const qsMatrix = s.cell('QuickStyleFontMatrix')?.V;
    if (qsColor !== undefined || qsMatrix !== undefined) {
      const ph = quickStyleColor(this.theme, qsColor !== undefined ? +qsColor : 100, this.variation(s));
      const idx = qsMatrix !== undefined ? matrixIndex(this.theme, +qsMatrix, 'font', this.variation(s)) : undefined;
      const c = idx ? evalColor(this.theme.fontExprs[idx - 1], this.theme, ph) : undefined;
      if (c) return c;
    }
    return this.explicitColor(s, 'Color', 'text') || this.theme.colors.dk1;
  }

  /** 非标准形状：矢量图元，只有一条路径时把颜色、线宽交给图元属性 */
  private boundVectorPen(s: Sheet, toCanvas: VectorMatrix) {
    const items = this.geometryItems(s, toCanvas);
    if (!items.length) return undefined;
    const pen: any = {
      id: s8(),
      anchors: this.anchorsOf(s, toCanvas),
    };
    // 所有路径共用的描边 / 填充色提升为图元属性（多段几何的形状通常配色一致，如圆柱体、文档形状）
    const strokes = new Set(items.map((i: any) => i.s?.stroke).filter((c) => c && c !== 'none'));
    const fills = new Set(items.map((i: any) => i.s?.fill).filter((c) => c && c !== 'none'));
    const lws = new Set(items.map((i: any) => i.s?.lw).filter((v) => typeof v === 'number'));
    if (strokes.size === 1) {
      pen.color = [...strokes][0];
      items.forEach((i: any) => i.s?.stroke === pen.color && delete i.s.stroke);
    }
    if (fills.size === 1) {
      pen.background = [...fills][0];
      items.forEach((i: any) => i.s?.fill === pen.background && (i.s.fill = '$bg'));
    }
    if (lws.size === 1 && strokes.size <= 1) {
      pen.lineWidth = [...lws][0];
      items.forEach((i: any) => typeof i.s?.lw === 'number' && (i.s.lw = '$lw'));
    }
    const geom = createGeom(items);
    Object.assign(pen, penRectOfGeom(geom.bbox), { vector: geom });
    this.mark(pen, 'vector', s.raw.Name || s.nameU || 'Visio');
    return pen;
  }

  /** 连接点 → 图元锚点（绝对坐标），id 用连接点行号，连接线按它吸附 */
  private anchorsOf(s: Sheet, toCanvas: VectorMatrix, _geom?: VectorGeom) {
    const rows = s.sections('Connection').flatMap((sec) => sec.rows);
    return rows.map((r, i) => {
      const [x, y] = applyMatrix(toCanvas, +(r.cells.X?.V ?? 0), +(r.cells.Y?.V ?? 0));
      return { id: `c${r.IX ?? i}`, x, y };
    });
  }

  /** 形状的 Visio 源信息，统一收在 pen.vsdx 下，不占用 core 图元的属性 */
  private vsdxInfo(s: Sheet, ctx: PageCtx): VisioPenInfo {
    const info: VisioPenInfo = { page: ctx.pageIndex, id: s.id, type: s.type };
    s.raw.Name && (info.name = s.raw.Name);
    s.nameU && (info.nameU = s.nameU);
    return info;
  }

  private groupPen(s: Sheet): any {
    const pen: any = { id: s8(), x: 0, y: 0, width: 0, height: 0, children: [] as string[] };
    this.mark(pen, 'group', s.raw.Name || s.nameU || 'Group');
    return pen;
  }

  private imagePen(s: Sheet, toCanvas: VectorMatrix, pagePath: string) {
    const relId = s.raw.rel;
    let url: string | undefined;
    if (relId) {
      const target = this.pkg.rels(pagePath)[relId];
      url = target ? this.dataUrl(target) : undefined;
    }
    const w = s.num('Width');
    const h = s.num('Height');
    if (!url) {
      return this.vectorPen(s, toCanvas);
    }
    this.stats.images++;
    // 旋转角：局部 X 轴方向
    const [x0, y0] = applyMatrix(toCanvas, 0, 0);
    const [x1, y1] = applyMatrix(toCanvas, 1, 0);
    const rotate = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
    const cw = Math.hypot(x1 - x0, y1 - y0) * w;
    const [hx, hy] = applyMatrix(toCanvas, 0, 1);
    const chh = Math.hypot(hx - x0, hy - y0) * h;
    const [cx, cy] = applyMatrix(toCanvas, w / 2, h / 2);
    const pen: any = {
      id: s8(),
      image: url,
      x: cx - cw / 2,
      y: cy - chh / 2,
      width: cw,
      height: chh,
      rotate: Math.abs(rotate) > 1e-6 ? rotate : 0,
    };
    this.mark(pen, 'image', s.raw.Name || 'image');
    return pen;
  }

  private dataUrl(path: string) {
    if (this.imageCache.has(path)) return this.imageCache.get(path);
    const bytes = this.pkg.bytes(path);
    if (!bytes) return undefined;
    const ext = path.split('.').pop()!.toLowerCase();
    const mime =
      ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : ext === 'svg' ? 'image/svg+xml' : undefined;
    if (!mime) return undefined; // EMF / WMF 浏览器无法显示
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const url = `data:${mime};base64,${btoa(bin)}`;
    this.imageCache.set(path, url);
    return url;
  }

  /**
   * 连接线 → 原生连线。路径取自几何（动态连接线的折点），端点用 BeginX/EndX（页面坐标）。
   */
  private linePen(s: Sheet, toCanvas: VectorMatrix, pageToCanvas: VectorMatrix, parentMatrix: VectorMatrix) {
    const k = this.paperK;
    const pts: { x: number; y: number }[] = [];
    let curved = false;
    // 几何里的点（局部坐标）→ 画布
    for (const sec of s.sections('Geometry')) {
      if (sec.cells.NoShow?.V === '1') continue;
      for (const r of sec.rows) {
        if (r.Del === '1' || r.cells.X?.V === undefined) continue;
        if (r.T !== 'MoveTo' && r.T !== 'LineTo' && r.T !== 'RelMoveTo' && r.T !== 'RelLineTo') curved = true;
        const rel = r.T?.startsWith('Rel');
        const x = +r.cells.X.V * (rel ? s.num('Width') : 1);
        const y = +(r.cells.Y?.V ?? 0) * (rel ? s.num('Height') : 1);
        const [cx, cy] = applyMatrix(toCanvas, x, y);
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(last.x - cx, last.y - cy) > 1e-6) pts.push({ x: cx, y: cy });
      }
      break;
    }
    // 端点以 BeginX/EndX 为准（父坐标 → 画布）
    const toCanvasParent = multiplyMatrix(pageToCanvas, parentMatrix);
    const [bx, by] = applyMatrix(toCanvasParent, s.num('BeginX'), s.num('BeginY'));
    const [ex, ey] = applyMatrix(toCanvasParent, s.num('EndX'), s.num('EndY'));
    if (pts.length < 2) {
      pts.length = 0;
      pts.push({ x: bx, y: by }, { x: ex, y: ey });
    } else {
      pts[0] = { x: bx, y: by };
      pts[pts.length - 1] = { x: ex, y: ey };
    }
    if (curved || pts.length < 2) {
      // 曲线连接线：几何较复杂，画成矢量图元更准确（不作为可编辑连线）
      return this.vectorPen(s, toCanvas);
    }
    const line = this.lineStyle(s, k);
    const routeStyle = s.num('ConLineRouteExt', 0) === 2 || s.num('ShapeRouteStyle', 0) === 16 ? 'curve' : 'line';
    const anchors = pts.map((p) => ({ id: s8(), x: p.x, y: p.y }));
    const pen: any = {
      id: s8(),
      anchors,
      color: line.none ? 'transparent' : line.stroke,
      lineWidth: line.lw,
    };
    this.adapter.line(pen, routeStyle, s.raw.Name || s.nameU || 'line', {
      from: arrowOf(s.num('BeginArrow', 0, 'line')),
      to: arrowOf(s.num('EndArrow', 0, 'line')),
    });
    line.dash && (pen.lineDash = line.dash);
    const asz = (n: string) => [0.6, 0.8, 1, 1.2, 1.6, 2.2, 3][Math.max(0, Math.min(6, s.num(n, 2, 'line')))] * 8;
    pen.fromArrow && (pen.fromArrowSize = asz('BeginArrowSize'));
    pen.toArrow && (pen.toArrowSize = asz('EndArrowSize'));
    const text = this.textItems(s, toCanvas)[0];
    if (text) pen._label = text;
    const acc = new BoxAccumulator();
    anchors.forEach((a) => acc.add(a.x, a.y));
    const b = acc.box();
    Object.assign(pen, { x: b.x, y: b.y, width: Math.max(b.width, 1), height: Math.max(b.height, 1) });
    this.stats.lines++;
    return pen;
  }

  private lineLabel(line: any, t: VectorTextItem) {
    return this.adapter.lineLabel(line, t);
  }

  private applyConnects(connects: any[], connectors: { sheet: Sheet; pen: any; raw: RawShape }[], ctx: PageCtx, pageToCanvas: VectorMatrix) {
    const lineById = new Map(connectors.map((c) => [c.raw.ID, c.pen]));
    for (const c of connects) {
      const line = lineById.get(c.FromSheet);
      const node = ctx.penOfShape.get(c.ToSheet);
      if (!line || !node || node === line || this.adapter.isGroup(node)) continue;
      const isBegin = /^Begin/.test(c.FromCell || '');
      const lineAnchor = isBegin ? line.anchors[0] : line.anchors[line.anchors.length - 1];
      if (!lineAnchor) continue;
      // 目标锚点：Connections.X<n> → 第 n 个连接点；PinX（整体粘附）→ 离端点最近的锚点，没有锚点时新建一个
      let anchor: any;
      const m = /Connections\.(?:X)?(\w+?)(?:\.X)?$/.exec(c.ToCell || '');
      if (m && node.anchors?.length) {
        const n = /^\d+$/.test(m[1]) ? +m[1] - 1 : undefined;
        anchor = n !== undefined ? node.anchors[n] : undefined;
      }
      if (!anchor) {
        node.anchors = node.anchors || [];
        anchor = nearest(node.anchors, lineAnchor);
        if (!anchor || Math.hypot(anchor.x - lineAnchor.x, anchor.y - lineAnchor.y) > 2) {
          anchor = { id: s8(), x: lineAnchor.x, y: lineAnchor.y };
          node.anchors.push(anchor);
        }
      }
      this.adapter.connect(line, lineAnchor, node, anchor);
      this.stats.connections++;
    }
    void pageToCanvas;
  }

  private pageBorderPen(ox: number, w: number, h: number) {
    const items: VectorItem[] = [pathItem([0, ox, 0, 1, ox + w, 0, 1, ox + w, h, 1, ox, h, 4], { stroke: '#BBBBBB', fill: this.theme.background || '#FFFFFF' })];
    const pen: any = { id: s8(), locked: true, ...penRectOfGeom(computeItemsBox(items)), vector: createGeom(items) };
    this.mark(pen, 'vector', 'page');
    return pen;
  }
}

const KNOWN_ROWS = new Set([
  'MoveTo',
  'RelMoveTo',
  'LineTo',
  'RelLineTo',
  'ArcTo',
  'EllipticalArcTo',
  'RelEllipticalArcTo',
  'Ellipse',
  'RelCubBezTo',
  'RelQuadBezTo',
  'PolylineTo',
  'NURBSTo',
  'SplineStart',
  'SplineKnot',
  'InfiniteLine',
]);

function toCells(list: any[] | undefined) {
  const out: Record<string, { V?: string }> = {};
  for (const c of list || []) c?.N && (out[c.N] = c);
  return out;
}

function nearest(anchors: any[], p: { x: number; y: number }) {
  let best: any;
  let d = Infinity;
  for (const a of anchors) {
    const dd = Math.hypot(a.x - p.x, a.y - p.y);
    if (dd < d) {
      d = dd;
      best = a;
    }
  }
  return best;
}

function attach(parent: any, child: any) {
  parent.children = parent.children || [];
  parent.children.push(child.id);
  child.parentId = parent.id;
}

/** 组合图元的框 = 子图元外接盒 */
function fitGroup(group: any, pens: any[]) {
  const ids = new Set(group.children);
  const acc = new BoxAccumulator();
  for (const p of pens) {
    if (!ids.has(p.id)) continue;
    acc.add(p.x, p.y);
    acc.add(p.x + p.width, p.y + p.height);
  }
  const b = acc.box();
  Object.assign(group, { x: b.x, y: b.y, width: Math.max(b.width, 1), height: Math.max(b.height, 1) });
}

/**
 * Text 元素是混合内容：文字与 <cp IX/>、<pp IX/>、<fld IX/>、<tp/> 交错。
 * 取出纯文本（fld 是字段占位，其显示值就在后面的文字里）。
 */
export function extractText(xml: string | undefined) {
  if (!xml) return '';
  return xml
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&')
    .replace(/\u2028|\r\n?/g, '\n')
    .replace(/\n+$/, '');
}

export function estimateWidth(text: string, size: number) {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0) > 0x2e80 ? 1 : ch === ' ' ? 0.35 : 0.6;
  return w * size;
}
