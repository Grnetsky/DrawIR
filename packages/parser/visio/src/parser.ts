import {
  applyMatrix,
  composeMatrix,
  IDENTITY,
  multiplyMatrix,
  rotateMatrix,
  scaleMatrix,
  translateMatrix,
  createGeom,
  pathItem,
  VectorItem,
  VectorMatrix,
  VectorStyle,
  VectorTextItem,
} from '@drawir/core';
import { buildGeometry } from './geometry';
import { VsdxPackage } from './package';
import { RawShape, Sheet, StyleSheet, toRawShape } from './sheet';
import { evalColor, matrixIndex, quickStyleColor, readTheme, resolveColor, Theme, withAlpha } from './theme';
import type { VisioDocument, VisioPageInfo, VisioParseOptions, VisioParseStats } from './types';

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

/** Visio 箭头编号 → DrawIR 箭头 */
interface PageCtx {
  height: number;
  ox: number;
  oy: number;
}

/** VSDX → 纯 Vector IR；组合、母版和连接线都在转换期解析为矢量指令。 */
export class VisioToIR {
  private opts: Required<Omit<VisioParseOptions, 'pages'>> & Pick<VisioParseOptions, 'pages'>;
  private pkg: VsdxPackage;
  private theme: Theme;
  private styles = new Map<string, StyleSheet>();
  private masters = new Map<string, { top?: Sheet; byId: Map<string, Sheet> }>();
  private geomK = 96;
  private paperK = 96;
  stats: VisioParseStats;

  constructor(options: VisioParseOptions = {}) {
    this.opts = { dpi: 96, pageGap: 40, pageBorder: false, ...options };
  }

  convert(data: Uint8Array): VisioDocument {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.stats = { pages: 0, shapes: 0, lines: 0, images: 0, masters: 0, unsupported: {}, errors: [], ms: 0 };
    this.pkg = new VsdxPackage(data);
    if (!this.pkg.has('visio/document.xml')) {
      throw new Error('不是有效的 VSDX 文件（缺少 visio/document.xml）。注意：旧版 .vsd 二进制格式不支持，请在 Visio 中另存为 .vsdx');
    }
    this.theme = readTheme(this.pkg);
    this.readStyles();

    const fragments: any[] = [];
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
      const ratio = (+sheet.PageScale?.V || 1) / (+sheet.DrawingScale?.V || 1);
      this.paperK = this.opts.dpi;
      this.geomK = this.opts.dpi * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
      const k = this.geomK;
      const ctx: PageCtx = { height: ph, ox, oy: 0 };
      try {
        this.convertPage(path, ctx, fragments);
      } catch (e: any) {
        this.stats.errors.push(`页面 ${page.Name || index}：${e?.message || e}`);
      }
      pageList.push({ name: page.NameU || page.Name || `Page-${index + 1}`, x: ox, y: 0, width: pw * k, height: ph * k });
      if (this.opts.pageBorder) fragments.unshift(this.pageBorder(ox, pw * k, ph * k));
      ox += pw * k + this.opts.pageGap;
      this.stats.pages++;
    });

    this.stats.ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    const last = pageList[pageList.length - 1];
    const items = fragments.flatMap((fragment) => fragment.items as VectorItem[]);
    return {
      ...createGeom(items),
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

  private convertPage(path: string, ctx: PageCtx, fragments: any[]) {
    const xml = this.pkg.xml(path)?.PageContents;
    const shapes: RawShape[] = (xml?.Shapes?.Shape || []).map(toRawShape);
    const k = this.geomK;
    const pageToOutput: VectorMatrix = [k, 0, 0, -k, ctx.ox, ctx.oy + ctx.height * k];

    const walk = (
      raw: RawShape,
      parentMatrix: VectorMatrix,
      parentMaster: { top?: Sheet; byId: Map<string, Sheet> } | undefined,
    ) => {
      if (raw.Del === '1') return;
      const masterEntry = raw.Master !== undefined ? this.master(raw.Master) : parentMaster;
      let masterSheet: Sheet | undefined;
      if (raw.MasterShape !== undefined && masterEntry) masterSheet = masterEntry.byId.get(raw.MasterShape);
      else if (raw.Master !== undefined) masterSheet = masterEntry?.top;
      const sheet = new Sheet(raw, masterSheet, this.styles);
      const toPage = multiplyMatrix(parentMatrix, this.localMatrix(sheet));
      const toOutput = multiplyMatrix(pageToOutput, toPage);
      this.stats.shapes++;
      if (this.isConnector(sheet)) this.stats.lines++;
      if (sheet.type === 'Foreign' && raw.rel) this.stats.images++;
      try {
        const geometry = this.vector(sheet, toOutput);
        if (geometry) fragments.push(geometry);
      } catch (e: any) {
        this.stats.errors.push(`形状 ${raw.ID}：${e?.message || e}`);
      }
      const childMaster = raw.Master !== undefined ? masterEntry : parentMaster;
      raw.children.forEach((child) => walk(child, toPage, childMaster));
    };

    shapes.forEach((shape) => walk(shape, IDENTITY, undefined));
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

  private vector(s: Sheet, toOutput: VectorMatrix) {
    const items = [...this.geometryItems(s, toOutput), ...this.textItems(s, toOutput)];
    return items.length ? { items } : undefined;
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

  private pageBorder(ox: number, w: number, h: number) {
    const items: VectorItem[] = [
      pathItem([0, ox, 0, 1, ox + w, 0, 1, ox + w, h, 1, ox, h, 4], {
        stroke: '#BBBBBB',
        fill: this.theme.background || '#FFFFFF',
      }),
    ];
    return { items };
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

/** 提取 Visio 混合内容 Text 元素中的纯文本。 */
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
