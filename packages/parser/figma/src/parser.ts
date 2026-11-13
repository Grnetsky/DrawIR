import {
  createGeom,
  IDENTITY,
  isIdentity,
  matrixScale,
  multiplyMatrix,
  pathItem,
  scaleMatrix,
  transformItem,
  translateMatrix,
  VectorPathBuilder,
  type VectorItem,
  type VectorMatrix,
  type VectorStyle,
  type VectorTextItem,
} from '@drawir/core';
import { readFig } from './archive';
import type { FigmaDocument, FigmaPageInfo, FigmaParseOptions, FigmaParseStats } from './types';

/** kiwi 解码出的 NodeChange（字段随 schema 变化，这里按需访问） */
type FigNode = Record<string, any>;
interface Guid {
  sessionID: number;
  localID: number;
}

const gkey = (g: Guid | undefined) => (g ? `${g.sessionID}:${g.localID}` : '');
/** 实例覆盖用的键：overrideKey 优先（新版文件），否则为 guid */
const okey = (n: FigNode) => gkey(n.overrideKey ?? n.guid);
const figMatrix = (t: any): VectorMatrix => [t.m00, t.m10, t.m01, t.m11, t.m02, t.m12];

/** 直接绘制自身几何并递归子节点的常规类型；其余类型若带几何也会绘制，但计入 unsupported */
const KNOWN = new Set([
  'FRAME', 'GROUP', 'SECTION', 'SYMBOL', 'INSTANCE', 'BOOLEAN_OPERATION', 'VECTOR', 'STAR', 'LINE', 'ELLIPSE',
  'RECTANGLE', 'ROUNDED_RECTANGLE', 'REGULAR_POLYGON', 'TEXT', 'BRUSH', 'SLICE', 'TABLE', 'TABLE_CELL',
  'STICKY', 'SHAPE_WITH_TEXT', 'CONNECTOR', 'TEXT_PATH',
]);
/** 不参与渲染的非图层节点 */
const NON_VISUAL = new Set(['VARIABLE', 'VARIABLE_SET', 'VARIABLE_OVERRIDE', 'SLICE', 'MANAGED_STRING', 'KEYFRAME', 'KEYFRAME_TRACK']);

/**
 * 实例展开作用域：
 * - overrides：guidPath（以 / 连接）→ 合并后的覆盖字段（symbolOverrides + derivedSymbolData）
 * - props：组件属性 defID → 取值（组件默认值 + 实例赋值），供子节点的 componentPropRefs 使用
 */
interface Scope {
  overrides: Map<string, FigNode>;
  props: Map<string, any>;
}

/** Figma .fig → 纯 Vector IR。组件实例在转换期按覆盖和派生数据展开。 */
export class FigmaToIR {
  private opts: Required<Omit<FigmaParseOptions, 'pages'>> & Pick<FigmaParseOptions, 'pages'>;
  private byId = new Map<string, FigNode>();
  private children = new Map<string, FigNode[]>();
  private blobs: Uint8Array[] = [];
  private symbolStack: string[] = [];
  stats!: FigmaParseStats;

  constructor(options: FigmaParseOptions = {}) {
    this.opts = { pageGap: 80, scale: 1, pageBorder: false, text: 'text', ...options };
  }

  convert(data: Uint8Array): FigmaDocument {
    const t0 = now();
    const fig = readFig(data);
    this.stats = { version: fig.version, pages: 0, nodes: 0, instances: 0, texts: 0, images: 0, unsupported: {}, errors: [], ms: 0 };
    const nodes: FigNode[] = (fig.message.nodeChanges || []).filter((n: FigNode) => n.guid && n.phase !== 'REMOVED');
    this.blobs = (fig.message.blobs || []).map((b: any) => b.bytes as Uint8Array);
    this.byId = new Map(nodes.map((n) => [gkey(n.guid), n]));
    this.children = new Map();
    for (const n of nodes) {
      const p = gkey(n.parentIndex?.guid);
      if (!p || p === gkey(n.guid)) continue;
      let list = this.children.get(p);
      if (!list) this.children.set(p, (list = []));
      list.push(n);
    }
    // 兄弟顺序由分数索引字符串决定：升序 = 从底到顶
    for (const list of this.children.values()) {
      list.sort((a, b) => {
        const pa = a.parentIndex?.position ?? '';
        const pb = b.parentIndex?.position ?? '';
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      });
    }

    const doc = nodes.find((n) => n.type === 'DOCUMENT');
    const canvases = (doc ? this.kids(doc) : nodes).filter((n) => n.type === 'CANVAS' && !n.internalOnly);
    if (!canvases.length) throw new Error('Figma 文件中没有任何页面');

    const k = this.opts.scale > 0 ? this.opts.scale : 1;
    const items: VectorItem[] = [];
    const pageList: FigmaPageInfo[] = [];
    let ox = 0;
    canvases.forEach((canvas, index) => {
      if (this.opts.pages && !this.opts.pages.includes(index)) return;
      const pageItems: VectorItem[] = [];
      for (const c of this.kids(canvas)) this.render(c, IDENTITY, 1, undefined, pageItems, 0);
      const box = pageItems.length ? createGeom(pageItems).bbox : { x: 0, y: 0, width: 0, height: 0 };
      const m: VectorMatrix = [k, 0, 0, k, ox - box.x * k, -box.y * k];
      const info: FigmaPageInfo = { name: canvas.name || `Page ${index + 1}`, x: ox, y: 0, width: box.width * k, height: box.height * k };
      if (canvas.backgroundColor && canvas.backgroundEnabled !== false) info.background = css(canvas.backgroundColor, canvas.backgroundOpacity ?? 1);
      pageList.push(info);
      if (this.opts.pageBorder) items.push(this.pageBorder(info));
      for (const it of pageItems) items.push(isIdentity(m) ? it : transformItem(it, m, k));
      ox += info.width + this.opts.pageGap;
      this.stats.pages++;
    });

    this.stats.ms = Math.round(now() - t0);
    const last = pageList[pageList.length - 1];
    const out: FigmaDocument = {
      ...createGeom(items),
      vectors: {},
      width: last ? last.x + last.width : 0,
      height: Math.max(0, ...pageList.map((p) => p.height)),
      pageList,
      stats: this.stats,
    };
    const bg = pageList.find((p) => p.background)?.background;
    bg && (out.background = bg);
    return out;
  }

  private kids(n: FigNode): FigNode[] {
    return this.children.get(gkey(n.guid)) ?? [];
  }

  // -------------------------------------------------------------------------
  // 节点遍历
  // -------------------------------------------------------------------------

  private render(raw: FigNode, parentM: VectorMatrix, alpha: number, scope: Scope | undefined, out: VectorItem[], depth: number) {
    if (depth > 128) return;
    const ov = scope?.overrides.get(okey(raw));
    const node = ov ? { ...raw, ...ov } : { ...raw };
    if (scope && node.componentPropRefs?.length) this.applyPropRefs(node, scope, !!ov?.derivedTextData);
    if (node.visible === false || NON_VISUAL.has(node.type)) return;
    const m = node.transform ? multiplyMatrix(parentM, figMatrix(node.transform)) : parentM;
    const a = alpha * (node.opacity ?? 1);
    if (!(a > 0)) return;
    this.stats.nodes++;
    if (node.mask) {
      // IR 没有裁剪：遮罩层本身不可见，被遮罩内容按未裁剪绘制
      this.count('mask');
      return;
    }
    for (const e of node.effects || []) if (e.visible !== false) this.count(`effect:${e.type}`);
    if (!KNOWN.has(node.type)) this.count(`type:${node.type}`);

    let recurse = true;
    try {
      switch (node.type) {
        case 'TEXT':
          this.drawText(node, m, a, out);
          break;
        case 'INSTANCE':
          this.drawGeometry(node, m, a, out);
          this.drawInstance(node, m, a, scope, out, depth);
          recurse = false;
          break;
        case 'BOOLEAN_OPERATION':
          // 布尔运算的结果几何已缓存在 fillGeometry 中，子节点只是运算输入
          if (node.fillGeometry?.length || node.strokeGeometry?.length) {
            this.drawGeometry(node, m, a, out);
            recurse = false;
          }
          break;
        default:
          this.drawGeometry(node, m, a, out);
      }
    } catch (e: any) {
      this.stats.errors.push(`${node.type} ${node.name ?? gkey(node.guid)}: ${e?.message || e}`);
    }
    if (!recurse) return;
    const kids = this.kids(raw);
    if (kids.length && node.frameMaskDisabled === false && (node.type === 'FRAME' || node.type === 'SYMBOL')) this.count('clipContent');
    for (const c of kids) this.render(c, m, a, scope, out, depth + 1);
  }

  /** 展开组件实例：组件子树 + 覆盖（symbolOverrides）+ 派生布局（derivedSymbolData） */
  private drawInstance(node: FigNode, m: VectorMatrix, a: number, outer: Scope | undefined, out: VectorItem[], depth: number) {
    this.stats.instances++;
    const symId = gkey(node.overriddenSymbolID ?? node.symbolData?.symbolID);
    const sym = this.byId.get(symId);
    if (!sym) {
      this.count('missingComponent');
      return;
    }
    if (this.symbolStack.includes(symId)) {
      this.stats.errors.push(`组件循环引用：${sym.name ?? symId}`);
      return;
    }
    const overrides = new Map<string, FigNode>();
    const put = (path: string, fields: FigNode) => {
      const { guidPath: _g, ...rest } = fields;
      overrides.set(path, { ...overrides.get(path), ...rest });
    };
    const pathOf = (o: FigNode) => (o.guidPath?.guids || []).map(gkey).join('/');
    for (const o of node.symbolData?.symbolOverrides || []) put(pathOf(o), o);
    for (const o of node.derivedSymbolData || []) put(pathOf(o), o);
    // 外层实例对本实例内部的覆盖：路径以本实例的键开头
    if (outer) {
      const prefix = okey(node) + '/';
      for (const [p, o] of outer.overrides) if (p.startsWith(prefix)) put(p.slice(prefix.length), o);
    }
    // 组件属性：组件（及其所在变体组）上的默认值，再叠加实例赋值
    const props = new Map<string, any>();
    const parent = this.byId.get(gkey(sym.parentIndex?.guid));
    for (const owner of [parent, sym]) {
      for (const def of owner?.componentPropDefs || []) if (!def.isDeleted && def.initialValue) props.set(gkey(def.id), def.initialValue);
    }
    for (const asg of node.componentPropAssignments || []) if (asg.value) props.set(gkey(asg.defID), asg.value);
    const scope: Scope = { overrides, props };
    this.symbolStack.push(symId);
    try {
      for (const c of this.kids(sym)) this.render(c, m, a, scope, out, depth + 1);
    } finally {
      this.symbolStack.pop();
    }
  }

  /** 把组件属性写回绑定它的节点字段（可见性、文字、实例替换） */
  private applyPropRefs(node: FigNode, scope: Scope, hasDerivedText: boolean) {
    for (const ref of node.componentPropRefs) {
      if (ref.isDeleted) continue;
      const v = scope.props.get(gkey(ref.defID));
      if (!v) continue;
      switch (ref.componentPropNodeField) {
        case 'VISIBLE':
          if (typeof v.boolValue === 'boolean') node.visible = v.boolValue;
          break;
        case 'TEXT_DATA':
          if (v.textValue && v.textValue.characters !== node.textData?.characters) {
            node.textData = { ...v.textValue };
            // 文字变了但没有对应的派生排版：旧的行/字形数据已失效，改用简单排版
            if (!hasDerivedText) delete node.derivedTextData;
          }
          break;
        case 'OVERRIDDEN_SYMBOL_ID':
          if (v.guidValue) node.overriddenSymbolID = v.guidValue;
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 几何与填充
  // -------------------------------------------------------------------------

  private drawGeometry(node: FigNode, m: VectorMatrix, a: number, out: VectorItem[]) {
    const fills = this.blendable(node.fillPaints);
    const strokes = this.blendable(node.strokePaints);
    if (!fills.length && !strokes.length) return;

    let fillPaths = this.geometry(node.fillGeometry, m);
    if (!fillPaths.length && (fills.length || (strokes.length && !node.strokeGeometry?.length))) {
      const d = this.fallbackShape(node, m);
      d && (fillPaths = [{ d, rule: 'nonzero' }]);
    }
    for (const p of fills) {
      const c = this.paintColor(p, a);
      if (!c) continue;
      for (const g of fillPaths) out.push(pathItem(g.d, { fill: c, stroke: 'none', rule: g.rule === 'evenodd' ? 'evenodd' : undefined }));
    }
    if (!strokes.length) return;
    const strokePaths = this.geometry(node.strokeGeometry, m);
    if (strokePaths.length) {
      // strokeGeometry 是描边展开后的轮廓（已包含对齐方式、虚线、端点），直接填充
      for (const p of strokes) {
        const c = this.paintColor(p, a);
        if (!c) continue;
        for (const g of strokePaths) out.push(pathItem(g.d, { fill: c, stroke: 'none', rule: g.rule === 'evenodd' ? 'evenodd' : undefined }));
      }
      return;
    }
    const sw = node.strokeWeight ?? 1;
    if (!(sw > 0) || !fillPaths.length) return;
    const k = matrixScale(m);
    const style: VectorStyle = { lw: sw * k };
    node.dashPattern?.length && (style.dash = node.dashPattern.map((v: number) => Math.max(v * k, 0.01)));
    if (node.strokeCap === 'ROUND') style.cap = 'round';
    else if (node.strokeCap === 'SQUARE') style.cap = 'square';
    if (node.strokeJoin === 'ROUND') style.join = 'round';
    else if (node.strokeJoin === 'BEVEL') style.join = 'bevel';
    for (const p of strokes) {
      const c = this.paintColor(p, a);
      if (!c) continue;
      for (const g of fillPaths) out.push(pathItem(g.d, { ...style, stroke: c }));
    }
  }

  /**
   * IR 没有混合模式：同一组填充中有普通填充时，跳过特殊混合层（OVERLAY、COLOR_DODGE 等通常是质感叠加），
   * 只有特殊混合层时按普通填充绘制。
   */
  private blendable(paints: any[] | undefined): any[] {
    const vis = (paints || []).filter(visiblePaint);
    const isNormal = (p: any) => !p.blendMode || p.blendMode === 'NORMAL' || p.blendMode === 'PASS_THROUGH';
    const special = vis.filter((p) => !isNormal(p));
    if (!special.length) return vis;
    for (const p of special) this.count(`blend:${p.blendMode}`);
    return special.length < vis.length ? vis.filter(isNormal) : vis;
  }

  /** Path[]（commandsBlob 引用）→ 按填充规则合并的 IR 路径 */
  private geometry(paths: any[] | undefined, m: VectorMatrix): { d: number[]; rule: 'nonzero' | 'evenodd' }[] {
    if (!paths?.length) return [];
    const groups = new Map<string, number[]>();
    for (const p of paths) {
      const blob = this.blobs[p.commandsBlob];
      if (!blob) continue;
      const rule = p.windingRule === 'ODD' || p.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero';
      const d = commandsToPath(blob, m);
      if (!d.length) continue;
      const acc = groups.get(rule);
      acc ? acc.push(...d) : groups.set(rule, d);
    }
    return [...groups].map(([rule, d]) => ({ d, rule: rule as 'nonzero' | 'evenodd' }));
  }

  /** 没有缓存几何时，按类型和尺寸重建（矩形含圆角、椭圆） */
  private fallbackShape(node: FigNode, m: VectorMatrix): number[] | undefined {
    const w = node.size?.x ?? 0;
    const h = node.size?.y ?? 0;
    if (!(w > 0) && !(h > 0)) return undefined;
    const b = new VectorPathBuilder(m);
    if (node.type === 'ELLIPSE') return b.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2).close().d;
    if (node.vectorData && !['ROUNDED_RECTANGLE', 'RECTANGLE', 'FRAME'].includes(node.type)) {
      this.count('vectorNetwork');
      return undefined;
    }
    const r0 = node.cornerRadius ?? 0;
    const ind = node.rectangleCornerRadiiIndependent;
    const lim = Math.min(w, h) / 2;
    const tl = Math.min(lim, ind ? node.rectangleTopLeftCornerRadius ?? r0 : r0);
    const tr = Math.min(lim, ind ? node.rectangleTopRightCornerRadius ?? r0 : r0);
    const br = Math.min(lim, ind ? node.rectangleBottomRightCornerRadius ?? r0 : r0);
    const bl = Math.min(lim, ind ? node.rectangleBottomLeftCornerRadius ?? r0 : r0);
    const H = Math.PI / 2;
    b.moveTo(tl, 0).lineTo(w - tr, 0);
    tr > 0 && b.ellipse(w - tr, tr, tr, tr, 0, -H, 0, false, true);
    b.lineTo(w, h - br);
    br > 0 && b.ellipse(w - br, h - br, br, br, 0, 0, H, false, true);
    b.lineTo(bl, h);
    bl > 0 && b.ellipse(bl, h - bl, bl, bl, 0, H, Math.PI, false, true);
    b.lineTo(0, tl);
    tl > 0 && b.ellipse(tl, tl, tl, tl, 0, Math.PI, Math.PI + H, false, true);
    return b.close().d;
  }

  private paintColor(p: any, alpha: number): string | undefined {
    const op = (p.opacity ?? 1) * alpha;
    if (!(op > 0)) return undefined;
    switch (p.type) {
      case 'SOLID':
        return p.color ? css(p.color, op) : undefined;
      case 'GRADIENT_LINEAR':
      case 'GRADIENT_RADIAL':
      case 'GRADIENT_ANGULAR':
      case 'GRADIENT_DIAMOND': {
        // IR 不支持渐变：退化为各色标的平均色
        this.count('gradient');
        const stops = (p.stops || []).filter((s: any) => s.color);
        if (!stops.length) return undefined;
        const avg = { r: 0, g: 0, b: 0, a: 0 };
        for (const s of stops) {
          avg.r += s.color.r / stops.length;
          avg.g += s.color.g / stops.length;
          avg.b += s.color.b / stops.length;
          avg.a += (s.color.a ?? 1) / stops.length;
        }
        return css(avg, op);
      }
      case 'IMAGE':
      case 'VIDEO':
        this.stats.images++;
        return undefined;
      default:
        this.count(`paint:${p.type}`);
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // 文字
  // -------------------------------------------------------------------------

  private drawText(node: FigNode, m: VectorMatrix, a: number, out: VectorItem[]) {
    this.stats.texts++;
    const td = node.textData;
    const chars: string = td?.characters ?? '';
    if (!chars) return;
    const dt = node.derivedTextData;
    const ids: number[] = td.characterStyleIDs || [];
    const table = new Map<number, FigNode>((td.styleOverrideTable || []).map((o: FigNode) => [o.styleID, o]));
    const styleOf = (id: number): FigNode => {
      const o = id ? table.get(id) : undefined;
      return o ? { ...node, ...o } : node;
    };

    if (this.opts.text === 'path' && dt?.glyphs?.length) {
      this.drawGlyphs(node, dt.glyphs, styleOf, m, a, out);
      return;
    }

    const items: VectorTextItem[] = [];
    const baselines: any[] = dt?.baselines || [];
    if (baselines.length) {
      const glyphAt = new Map<number, any>();
      for (const g of dt.glyphs || []) glyphAt.has(g.firstCharacter) || glyphAt.set(g.firstCharacter, g);
      for (const bl of baselines) {
        const first = bl.firstCharacter ?? 0;
        const end = Math.min(bl.endCharacter ?? chars.length, chars.length);
        let i = first;
        while (i < end) {
          const sid = ids[i] ?? 0;
          let j = i + 1;
          while (j < end && (ids[j] ?? 0) === sid) j++;
          // 跳过段首空白，用首个可见字符的字形位置定位
          let s = i;
          while (s < j && /\s/.test(chars[s])) s++;
          const text = applyCase(chars.slice(s, j), styleOf(sid).textCase).replace(/\s+$/, '');
          if (text) {
            const whole = i === first && j === end;
            const g = glyphAt.get(s);
            const item = this.textItem(text, styleOf(sid), a, g ? g.position.x : bl.position.x, bl.position.y);
            if (item) {
              // 整行单一样式时按对齐方式锚定，减小替代字体造成的宽度误差
              if (whole && bl.width > 0) {
                const align = node.textAlignHorizontal;
                if (align === 'CENTER') {
                  item.x = bl.position.x + bl.width / 2;
                  item.a = 'center';
                } else if (align === 'RIGHT') {
                  item.x = bl.position.x + bl.width;
                  item.a = 'right';
                }
              }
              items.push(item);
            }
          }
          i = j;
        }
      }
    } else {
      // 没有排版缓存：按行从顶部排布
      const fs = node.fontSize ?? 12;
      const lh = fs * 1.2;
      const w = node.size?.x ?? 0;
      chars.split(/\r?\n|\u2028/).forEach((line, n) => {
        const text = applyCase(line, node.textCase);
        if (!text.trim()) return;
        const align = node.textAlignHorizontal;
        const x = align === 'CENTER' ? w / 2 : align === 'RIGHT' ? w : 0;
        const item = this.textItem(text, node, a, x, n * lh + fs);
        if (item) {
          item.a = align === 'CENTER' ? 'center' : align === 'RIGHT' ? 'right' : 'left';
          items.push(item);
        }
      });
    }
    for (const it of items) out.push(isIdentity(m) ? it : transformItem(it, m));
  }

  private textItem(text: string, st: FigNode, a: number, x: number, y: number): VectorTextItem | undefined {
    const paint = (st.fillPaints || []).filter(visiblePaint).pop();
    const fill = paint ? this.paintColor(paint, a) : undefined;
    if (!fill) return undefined;
    const fs = st.fontSize ?? 12;
    if (!(fs > 0)) return undefined;
    const item: VectorTextItem = { t: 't', text, x, y, h: fs, a: 'left', b: 'alphabetic', fill };
    const fam = st.fontName?.family;
    item.font = fam ? `"${fam}", sans-serif` : 'sans-serif';
    const style: string = st.fontName?.style || '';
    /bold|black|heavy/i.test(style) && (item.bold = true);
    /italic|oblique/i.test(style) && (item.italic = true);
    return item;
  }

  /** 使用缓存的字形轮廓（em 单位，Y 向上）绘制文字 */
  private drawGlyphs(node: FigNode, glyphs: any[], styleOf: (id: number) => FigNode, m: VectorMatrix, a: number, out: VectorItem[]) {
    const byColor = new Map<string, number[]>();
    for (const g of glyphs) {
      const blob = this.blobs[g.commandsBlob];
      if (!blob || !g.position) continue;
      if (g.emojiCodePoints) this.count('emoji');
      const st = styleOf(g.styleID ?? 0);
      const paint = (st.fillPaints || []).filter(visiblePaint).pop();
      const c = paint ? this.paintColor(paint, a) : undefined;
      if (!c) continue;
      const fs = g.fontSize ?? st.fontSize ?? node.fontSize ?? 12;
      let gm = multiplyMatrix(translateMatrix(g.position.x, g.position.y), scaleMatrix(fs, -fs));
      if (g.rotation) gm = multiplyMatrix(gm, rotation(g.rotation));
      const d = commandsToPath(blob, multiplyMatrix(m, gm));
      if (!d.length) continue;
      const acc = byColor.get(c);
      acc ? acc.push(...d) : byColor.set(c, d);
    }
    for (const [c, d] of byColor) out.push(pathItem(d, { fill: c, stroke: 'none' }));
  }

  // -------------------------------------------------------------------------

  private pageBorder(p: FigmaPageInfo): VectorItem {
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

function visiblePaint(p: any) {
  return p && p.visible !== false && (p.opacity ?? 1) > 0;
}

function rotation(rad: number): VectorMatrix {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');

/** Figma 颜色（0~1 浮点）→ CSS */
export function css(c: { r: number; g: number; b: number; a?: number }, alpha = 1): string {
  const a = (c.a ?? 1) * alpha;
  if (a >= 0.999) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  const ch = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${ch(c.r)},${ch(c.g)},${ch(c.b)},${+a.toFixed(3)})`;
}

function applyCase(s: string, mode: string | undefined) {
  switch (mode) {
    case 'UPPER':
      return s.toUpperCase();
    case 'LOWER':
      return s.toLowerCase();
    case 'TITLE':
      return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    default:
      return s;
  }
}

/**
 * 路径命令 blob → IR 路径。格式：1 字节命令 + float32 LE 参数，
 * 0 = close，1 = moveTo(x, y)，2 = lineTo(x, y)，3 = quadTo(x1, y1, x, y)，4 = cubicTo(x1, y1, x2, y2, x, y)。
 */
export function commandsToPath(blob: Uint8Array, m: VectorMatrix): number[] {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const b = new VectorPathBuilder(m);
  let i = 0;
  const f = () => {
    const v = dv.getFloat32(i, true);
    i += 4;
    return v;
  };
  while (i < blob.length) {
    const cmd = blob[i++];
    if (cmd === 0) b.close();
    else if (cmd === 1 && i + 8 <= blob.length) b.moveTo(f(), f());
    else if (cmd === 2 && i + 8 <= blob.length) b.lineTo(f(), f());
    else if (cmd === 3 && i + 16 <= blob.length) b.quadTo(f(), f(), f(), f());
    else if (cmd === 4 && i + 24 <= blob.length) b.cubicTo(f(), f(), f(), f(), f(), f());
    else break;
  }
  return b.d;
}
