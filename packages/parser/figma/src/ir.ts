import {
  applyMatrix,
  computeItemsBox,
  IDENTITY,
  invertMatrix,
  isIdentity,
  matrixScale,
  multiplyMatrix,
  pathItem,
  scaleMatrix,
  transformItem,
  transformBox,
  translateMatrix,
  VectorPathBuilder,
  type VectorBox,
  type VectorClipItem,
  type VectorGradient,
  type VectorGradientStop,
  type VectorImageItem,
  type VectorItem,
  type VectorMatrix,
  type VectorStyle,
  type VectorTextItem,
} from '@drawir/core';
import { bytesToDataURL, imageHash, readFig, type FigArchive } from './archive';
import type { FigmaPageInfo, FigmaParseOptions, FigmaParseStats, FigmaPenInfo } from './types';
import { rgbaCss } from './util';
import { vectorNetworkToShapes } from './vector';

/** kiwi 解码出的 NodeChange（字段随 schema 变化，这里按需访问） */
type FigNode = Record<string, any>;
interface Guid {
  sessionID: number;
  localID: number;
}

const gkey = (g: Guid | undefined) => (g ? `${g.sessionID}:${g.localID}` : '');
/** 实例覆盖用的键：overrideKey 优先（新版文件），否则为 guid */
const okey = (n: FigNode) => gkey(n.overrideKey ?? n.guid);
/** 组件实例引用的组件 id（实例替换优先） */
const symbolIdOf = (n: FigNode) => gkey(n.overriddenSymbolID ?? n.symbolData?.symbolID);
const figMatrix = (t: any): VectorMatrix => [t.m00, t.m10, t.m01, t.m11, t.m02, t.m12];

/** 直接绘制自身几何并递归子节点的常规类型；其余类型若带几何也会绘制，但计入 unsupported */
const KNOWN = new Set([
  'FRAME', 'GROUP', 'SECTION', 'SYMBOL', 'INSTANCE', 'BOOLEAN_OPERATION', 'VECTOR', 'STAR', 'LINE', 'ELLIPSE',
  'RECTANGLE', 'ROUNDED_RECTANGLE', 'REGULAR_POLYGON', 'TEXT', 'BRUSH', 'SLICE', 'TABLE', 'TABLE_CELL',
  'STICKY', 'SHAPE_WITH_TEXT', 'CONNECTOR', 'TEXT_PATH',
]);
/** 不参与渲染的非图层节点 */
const NON_VISUAL = new Set(['VARIABLE', 'VARIABLE_SET', 'VARIABLE_OVERRIDE', 'SLICE', 'MANAGED_STRING', 'KEYFRAME', 'KEYFRAME_TRACK']);
/** 'node' 粒度下拆成子图元（并可组合）的容器类型 */
const CONTAINERS = new Set(['FRAME', 'GROUP', 'SECTION', 'SYMBOL', 'INSTANCE']);

/** RGBA 0~1 */
export type Rgba = [number, number, number, number];

/**
 * 渐变（画布坐标）。线性：p0 → p1；径向：p0 为圆心，p1 / p2 为两个半轴的端点。
 * 适配层按图元框换算成各版本 meta2d 的渐变格式
 */
export interface FigmaGradient {
  type: 'linear' | 'radial';
  p0: [number, number];
  p1: [number, number];
  p2?: [number, number];
  stops: { i: number; c: Rgba }[];
}

/** 单一样式文字节点的文字框（画布坐标），用于生成与 Figma 文字框一致的原生文字图元 */
export interface FigmaTextBox {
  /** 文字框局部坐标 → 画布 */
  m: VectorMatrix;
  w: number;
  h: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  /** 行高倍数（行距 / 字号） */
  lh: number;
  /** 字重 100~900 */
  weight?: number;
  /** 字间距（像素） */
  spacing?: number;
}

/**
 * 裁剪区域（画布坐标）：蒙版层（mask）或 Frame 的内容裁剪（clip content）。
 * 内容完全在区域内时不用裁剪（仍可拆成原生图元），完全在区域外时丢弃，跨边界的才包进 IR 裁剪项
 */
export interface FigmaClip {
  /** 裁剪路径，为空表示什么都不显示（没有几何的蒙版） */
  d: number[];
  rule?: 'evenodd';
  /** 裁剪路径的包围盒 */
  box: VectorBox;
  /** 裁剪区域是轴对齐的（圆角）矩形：可以精确判断内容是否在区域内 */
  rect?: boolean;
  /** 矩形的圆角半径 */
  r?: number;
}

export interface FigmaShadow {
  color: string;
  x: number;
  y: number;
  blur: number;
}

/** 一个图元的内容：Vector IR 项（含图片项）+ 每项的附加信息（渐变、文字框、图片 hash） */
export interface FigmaLeaf {
  kind: 'leaf';
  info: FigmaPenInfo;
  items: VectorItem[];
  /** 与 items 一一对应 */
  grads: (FigmaGradient | undefined)[];
  boxes: (FigmaTextBox | undefined)[];
  /** 与 items 一一对应：图片项的 SHA-1 */
  hashes: (string | undefined)[];
  shadow?: FigmaShadow;
}

export interface FigmaGroup {
  kind: 'group';
  info: FigmaPenInfo;
  children: FigmaUnit[];
}

export type FigmaUnit = FigmaLeaf | FigmaGroup;

/** 图层树节点（readFigLayers） */
export interface FigmaLayer {
  /** 节点 id，与 FigmaPenInfo.id、FigmaParseOptions.skipNodes 一致；组件实例内的节点为实例路径 */
  id: string;
  name: string;
  /** CANVAS（页面）/ FRAME / GROUP / INSTANCE / TEXT / VECTOR … */
  type: string;
  /** 在 Figma 中隐藏（不会导入） */
  hidden?: boolean;
  /** 蒙版层 */
  mask?: boolean;
  /** 组件实例（INSTANCE）引用的组件节点 id */
  componentId?: string;
  /** 子图层，上层在前（与 Figma 图层面板一致） */
  children?: FigmaLayer[];
}

export interface FigmaTree {
  pages: FigmaUnit[][];
  pageList: FigmaPageInfo[];
  stats: FigmaParseStats;
  archive: FigArchive;
}

/**
 * 实例展开作用域：
 * - overrides：guidPath（以 / 连接）→ 合并后的覆盖字段（symbolOverrides + derivedSymbolData）
 * - props：组件属性 defID → 取值（组件默认值 + 实例赋值），供子节点的 componentPropRefs 使用
 */
interface Scope {
  overrides: Map<string, FigNode>;
  props: Map<string, any>;
  /** 实例路径前缀，用于生成唯一的节点 id */
  path: string;
}

interface Prepared {
  node: FigNode;
  m: VectorMatrix;
  a: number;
}

type OptionalKeys = 'pages' | 'imageUrls' | 'origin' | 'skipImages' | 'skipNodes';
export type ResolvedOptions = Required<Omit<FigmaParseOptions, OptionalKeys>> & Pick<FigmaParseOptions, OptionalKeys>;

export function resolveOptions(options: FigmaParseOptions = {}): ResolvedOptions {
  return {
    pageGap: 80,
    scale: 1,
    pageBorder: false,
    text: 'text',
    granularity: 'node',
    group: true,
    groupArtboards: false,
    editable: true,
    images: true,
    ...options,
  };
}

/**
 * Figma .fig → 图元树。组件实例在转换期按覆盖和派生数据展开；
 * 叶子是若干 Vector IR 项（Y 向下的画布坐标），附带 IR 表达不了的渐变、图片、阴影、文字框，交给适配层生成 meta2d 图元。
 */
export class FigmaToIR {
  private opts: ResolvedOptions;
  private byId = new Map<string, FigNode>();
  private children = new Map<string, FigNode[]>();
  private blobs: Uint8Array[] = [];
  private symbolStack: string[] = [];
  private page = 0;
  private imageBytes = new Map<string, Uint8Array>();
  private dataUrls = new Map<string, string>();
  /** 不导入的节点 id（FigmaPenInfo.id），连同子树跳过 */
  private skip = new Set<string>();
  stats!: FigmaParseStats;

  constructor(options: FigmaParseOptions = {}) {
    this.opts = resolveOptions(options);
  }

  build(data: Uint8Array): FigmaTree {
    const t0 = now();
    const fig = readFig(data, { images: this.opts.images });
    this.imageBytes = fig.images;
    this.dataUrls = new Map();
    this.skip = new Set(this.opts.skipNodes || []);
    const canvases = this.load(fig);
    if (!canvases.length) throw new Error('Figma 文件中没有任何页面');

    const k = this.opts.scale > 0 ? this.opts.scale : 1;
    const ox0 = this.opts.origin?.x || 0;
    const oy0 = this.opts.origin?.y || 0;
    const pages: FigmaUnit[][] = [];
    const pageList: FigmaPageInfo[] = [];
    let ox = ox0;
    canvases.forEach((canvas, index) => {
      if (this.opts.pages && !this.opts.pages.includes(index)) return;
      this.page = index;
      const units: FigmaUnit[] = [];
      if (this.opts.granularity === 'page') {
        const leaf = this.leaf({ guid: canvas.guid, type: 'CANVAS', name: canvas.name });
        const masks: Masks = [];
        for (const c of this.kids(canvas)) {
          const clip = this.collect(c, IDENTITY, 1, undefined, 0, leaf);
          clip && masks.push([leaf.items.length, clip]);
        }
        this.clipLeafMasks(leaf, masks);
        hasContent(leaf) && units.push(leaf);
      } else {
        const masks: Masks = [];
        for (const c of this.kids(canvas)) {
          const clip = this.visit(c, IDENTITY, 1, undefined, 0, 0, units);
          clip && masks.push([units.length, clip]);
        }
        units.splice(0, units.length, ...this.clipUnits(units, 0, masks));
      }
      const box = unitsBox(units);
      const m: VectorMatrix = [k, 0, 0, k, ox - box.x * k, oy0 - box.y * k];
      const info: FigmaPageInfo = { name: canvas.name || `Page ${index + 1}`, x: ox, y: oy0, width: box.width * k, height: box.height * k };
      if (canvas.backgroundColor && canvas.backgroundEnabled !== false) {
        const c = canvas.backgroundColor;
        info.background = rgbaCss(c.r, c.g, c.b, (c.a ?? 1) * (canvas.backgroundOpacity ?? 1));
      }
      if (!isIdentity(m)) for (const u of units) transformUnit(u, m, k);
      if (this.opts.pageBorder) units.unshift(this.pageBorder(info));
      pageList.push(info);
      pages.push(units);
      ox += info.width + this.opts.pageGap;
      this.stats.pages++;
    });
    this.stats.ms = Math.round(now() - t0);
    return { pages, pageList, stats: this.stats, archive: fig };
  }

  /**
   * 图层树（不计算几何）：与 Figma 图层面板一致，组件实例展开为组件的子图层（按覆盖、组件属性取名称和可见性）。
   * 节点 id 与 FigmaPenInfo.id、FigmaParseOptions.skipNodes 一致
   */
  layers(data: Uint8Array): FigmaLayer[] {
    const canvases = this.load(readFig(data, { images: false }));
    const walk = (raw: FigNode, scope: Scope | undefined, depth: number): FigmaLayer | undefined => {
      if (depth > 128 || NON_VISUAL.has(raw.type)) return undefined;
      const ov = scope?.overrides.get(okey(raw));
      const node = ov ? { ...raw, ...ov } : { ...raw };
      if (scope && node.componentPropRefs?.length) this.applyPropRefs(node, scope, !!ov?.derivedTextData);
      const layer: FigmaLayer = { id: (scope?.path || '') + gkey(raw.guid), name: node.name || node.type, type: node.type };
      node.visible === false && (layer.hidden = true);
      if (node.type === 'INSTANCE') {
        const sym = symbolIdOf(node);
        sym && (layer.componentId = sym);
      }
      node.mask && (layer.mask = true);
      // 布尔运算的子图层只是运算输入（结果几何已缓存），不单独列出
      if (node.type !== 'BOOLEAN_OPERATION' || !(node.fillGeometry?.length || node.strokeGeometry?.length)) {
        const children: FigmaLayer[] = [];
        this.eachChild(node, raw, scope, (c, s) => {
          const l = walk(c, s, depth + 1);
          l && children.push(l);
        });
        // 图层面板顺序：上层在前
        children.length && (layer.children = children.reverse());
      }
      return layer;
    };
    return canvases.map((c, index) => ({
      id: gkey(c.guid),
      name: c.name || `Page ${index + 1}`,
      type: 'CANVAS',
      children: this.kids(c)
        .map((n) => walk(n, undefined, 0))
        .filter(Boolean)
        .reverse(),
    }));
  }

  /** 建立节点索引、父子关系，返回页面（CANVAS）列表 */
  private load(fig: FigArchive): FigNode[] {
    this.stats = {
      version: fig.version,
      pages: 0,
      nodes: 0,
      instances: 0,
      texts: 0,
      images: 0,
      gradients: 0,
      clips: 0,
      pens: 0,
      unsupported: {},
      errors: [],
      ms: 0,
    };
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
    return (doc ? this.kids(doc) : nodes).filter((n) => n.type === 'CANVAS' && !n.internalOnly);
  }

  private kids(n: FigNode): FigNode[] {
    return this.children.get(gkey(n.guid)) ?? [];
  }

  private leaf(node: FigNode, scope?: Scope, part?: FigmaPenInfo['part']): FigmaLeaf {
    return { kind: 'leaf', info: this.info(node, scope, part), items: [], grads: [], boxes: [], hashes: [] };
  }

  private info(node: FigNode, scope?: Scope, part?: FigmaPenInfo['part']): FigmaPenInfo {
    const info: FigmaPenInfo = { page: this.page, id: (scope?.path || '') + gkey(node.guid), type: node.type };
    node.name && (info.name = node.name);
    if (node.type === 'INSTANCE' && !part) {
      const sym = symbolIdOf(node);
      sym && (info.componentId = sym);
    }
    part && (info.part = part);
    return info;
  }

  // -------------------------------------------------------------------------
  // 节点遍历
  // -------------------------------------------------------------------------

  /** 合并覆盖、组件属性，计算矩阵和不透明度；不可见时返回 undefined */
  private prepare(raw: FigNode, parentM: VectorMatrix, alpha: number, scope: Scope | undefined, depth: number): Prepared | undefined {
    if (depth > 128) return undefined;
    if (this.skip.size && this.skip.has((scope?.path || '') + gkey(raw.guid))) return undefined;
    const ov = scope?.overrides.get(okey(raw));
    const node = ov ? { ...raw, ...ov } : { ...raw };
    if (scope && node.componentPropRefs?.length) this.applyPropRefs(node, scope, !!ov?.derivedTextData);
    if (node.visible === false || NON_VISUAL.has(node.type)) return undefined;
    const m = node.transform ? multiplyMatrix(parentM, figMatrix(node.transform)) : parentM;
    const a = alpha * (node.opacity ?? 1);
    if (!(a > 0)) return undefined;
    this.stats.nodes++;
    // 蒙版层本身不绘制，由调用方生成裁剪区域（maskClip）
    if (node.mask) return { node, m, a };
    for (const e of node.effects || []) if (e.visible !== false && e.type !== 'DROP_SHADOW') this.count(`effect:${e.type}`);
    if (!KNOWN.has(node.type)) this.count(`type:${node.type}`);
    return { node, m, a };
  }

  /**
   * 拆分遍历：容器按粒度拆成子图元（'node' 粒度下生成组合），其余节点连同子树合并为一个图元
   * @param level 相对页面的层级，0 = 页面顶层
   * @returns 节点是蒙版层时返回裁剪区域（裁剪其后的兄弟节点），不输出图元
   */
  private visit(
    raw: FigNode,
    parentM: VectorMatrix,
    alpha: number,
    scope: Scope | undefined,
    depth: number,
    level: number,
    out: FigmaUnit[],
  ): FigmaClip | undefined {
    const r = this.prepare(raw, parentM, alpha, scope, depth);
    if (!r) return undefined;
    if (r.node.mask) return this.maskClip(r, raw, scope, depth);
    const { node, m, a } = r;
    if (!this.splits(node, level)) {
      const leaf = this.leaf(node, scope);
      this.drawTree(r, raw, scope, depth, leaf);
      hasContent(leaf) && out.push(leaf);
      return;
    }
    let children: FigmaUnit[] = [];
    // 容器自身的背景、描边：最底层的一个图元
    const self = this.leaf(node, scope, 'fill');
    this.drawSelf(r, self);
    hasContent(self) && children.push(self);
    const start = children.length;
    const masks: Masks = [];
    this.eachChild(node, raw, scope, (c, s) => {
      const clip = this.visit(c, m, a, s, depth + 1, level + 1, children);
      clip && masks.push([children.length, clip]);
    });
    children = this.clipUnits(children, start, masks, this.contentClip(node, m));
    if (!children.length) return;
    // 页面顶层的画板（Frame / Section）不组合：大屏通常整页一个画板，组合后里面的图元无法直接选中。
    // groupArtboards 时画板总是组合（单个子图元也组合），保留「图元属于哪个画板」
    const artboard = level === 0 && (node.type === 'FRAME' || node.type === 'SECTION');
    const keep = artboard && this.opts.groupArtboards;
    if (this.opts.granularity === 'node' && this.opts.group && (keep || (!artboard && children.length > 1))) {
      out.push({ kind: 'group', info: this.info(node, scope), children });
    } else {
      out.push(...children);
    }
    return undefined;
  }

  private splits(node: FigNode, level: number) {
    if (!CONTAINERS.has(node.type)) return false;
    if (this.opts.granularity === 'layer') return level === 0;
    return this.opts.granularity === 'node';
  }

  /** 合并遍历：节点及其子树全部画进 leaf；节点是蒙版层时返回裁剪区域 */
  private collect(raw: FigNode, parentM: VectorMatrix, alpha: number, scope: Scope | undefined, depth: number, leaf: FigmaLeaf): FigmaClip | undefined {
    const r = this.prepare(raw, parentM, alpha, scope, depth);
    if (!r) return undefined;
    if (r.node.mask) return this.maskClip(r, raw, scope, depth);
    this.drawTree(r, raw, scope, depth, leaf);
    return undefined;
  }

  private drawTree(r: Prepared, raw: FigNode, scope: Scope | undefined, depth: number, leaf: FigmaLeaf) {
    if (!this.drawSelf(r, leaf)) return;
    const start = leaf.items.length;
    const masks: Masks = [];
    this.eachChild(r.node, raw, scope, (c, s) => {
      const clip = this.collect(c, r.m, r.a, s, depth + 1, leaf);
      clip && masks.push([leaf.items.length, clip]);
    });
    this.clipLeafMasks(leaf, masks);
    const content = this.contentClip(r.node, r.m);
    content && this.clipLeaf(leaf, start, content);
  }

  // -------------------------------------------------------------------------
  // 裁剪：蒙版、Frame 的内容裁剪
  // -------------------------------------------------------------------------

  /**
   * 蒙版层的裁剪区域：裁剪同一父节点中排在它之上的兄弟节点（多个蒙版叠加时取交集）。
   * 按轮廓裁剪；ALPHA 蒙版只有不透明纯色时与轮廓一致，渐变 / 图片 / 半透明蒙版、LUMINANCE 蒙版按轮廓近似
   */
  private maskClip({ node, m }: Prepared, raw: FigNode, scope: Scope | undefined, depth: number): FigmaClip {
    if (node.maskType === 'LUMINANCE') this.count('mask:luminance');
    else if (node.maskType !== 'VECTOR' && softMask(node)) this.count('mask:alpha');
    const paths: Shape[] = [];
    this.maskShape(node, raw, scope, m, depth, paths);
    if (!paths.length) return { d: [], box: { x: 0, y: 0, width: 0, height: 0 } };
    const clip = makeClip(paths);
    // 单个轴对齐（圆角）矩形
    if (paths.length === 1 && paths[0].rect !== undefined && axisAligned(m)) {
      clip.rect = true;
      paths[0].rect > 0 && (clip.r = paths[0].rect);
    }
    return clip;
  }

  /** 蒙版的形状：自身的填充 + 描边几何；没有几何的组合（Group / Frame / 实例）取子节点形状的并集 */
  private maskShape(node: FigNode, raw: FigNode, scope: Scope | undefined, m: VectorMatrix, depth: number, out: Shape[]) {
    const n0 = out.length;
    let fills = this.geometry(node.fillGeometry, m);
    if (!fills.length) fills = this.vectorGeometry(node, m);
    const strokes = (node.strokePaints || []).some(visiblePaint) ? this.geometry(node.strokeGeometry, m) : [];
    out.push(...fills, ...strokes);
    if (out.length > n0) {
      // 矩形类节点的填充几何就是（圆角）矩形
      if (!strokes.length && fills.length === 1 && RECT_TYPES.has(node.type) && !node.cornerSmoothing) out[n0].rect = cornerRadius(node) * matrixScale(m);
      else if (out.length === n0 + 1 && isRectPath(out[n0].d)) out[n0].rect = 0;
      return;
    }
    if (CONTAINERS.has(node.type) || node.type === 'BOOLEAN_OPERATION') {
      this.eachChild(node, raw, scope, (c, s) => {
        const r = this.prepare(c, m, 1, s, depth + 1);
        r && this.maskShape(r.node, c, s, r.m, depth + 1, out);
      });
      return;
    }
    const d = this.fallbackShape(node, m);
    if (d) out.push({ d, rule: 'nonzero', rect: RECT_TYPES.has(node.type) ? cornerRadius(node) * matrixScale(m) : undefined });
  }

  /** Frame / 组件 / 实例开启了 Clip content：子节点裁剪到 Frame 的（圆角）矩形 */
  private contentClip(node: FigNode, m: VectorMatrix): FigmaClip | undefined {
    if (node.frameMaskDisabled !== false || !(node.type === 'FRAME' || node.type === 'SYMBOL' || node.type === 'INSTANCE')) return undefined;
    const d = this.fallbackShape(node, m);
    const paths: Shape[] = d ? [{ d, rule: 'nonzero' }] : this.geometry(node.fillGeometry, m);
    if (!paths.length) return undefined;
    const clip = makeClip(paths);
    if (d && axisAligned(m)) {
      clip.rect = true;
      const r = cornerRadius(node) * matrixScale(m);
      r > 0 && (clip.r = r);
    }
    return clip;
  }

  /** 依次（从上往下）套用各蒙版，再套用内容裁剪；返回去掉空图元后的列表 */
  private clipUnits(units: FigmaUnit[], start: number, masks: Masks, content?: FigmaClip): FigmaUnit[] {
    if (!masks.length && !content) return units;
    for (let i = masks.length - 1; i >= 0; i--) {
      const [from, clip] = masks[i];
      for (let j = from; j < units.length; j++) this.clipUnit(units[j], clip);
    }
    if (content) for (let j = start; j < units.length; j++) this.clipUnit(units[j], content);
    return prune(units);
  }

  private clipUnit(u: FigmaUnit, clip: FigmaClip) {
    if (u.kind === 'leaf') this.clipLeaf(u, 0, clip);
    else for (const c of u.children) this.clipUnit(c, clip);
  }

  private clipLeafMasks(leaf: FigmaLeaf, masks: Masks) {
    for (let i = masks.length - 1; i >= 0; i--) this.clipLeaf(leaf, masks[i][0], masks[i][1]);
  }

  /**
   * 裁剪 leaf 中从 from 开始的项：完全在区域内的保留（文字、图片仍可拆成原生图元），完全在区域外的丢弃，
   * 跨边界的（相邻的合并）包进一个 IR 裁剪项
   */
  private clipLeaf(leaf: FigmaLeaf, from: number, clip: FigmaClip) {
    const items: VectorItem[] = [];
    const grads: FigmaLeaf['grads'] = [];
    const boxes: FigmaLeaf['boxes'] = [];
    const hashes: FigmaLeaf['hashes'] = [];
    const keep = (i: number) => {
      items.push(leaf.items[i]);
      grads.push(leaf.grads[i]);
      boxes.push(leaf.boxes[i]);
      hashes.push(leaf.hashes[i]);
    };
    let run: VectorItem[] = [];
    const flush = () => {
      if (!run.length) return;
      const item: VectorClipItem = { t: 'c', d: clip.d, items: run };
      clip.rule && (item.rule = clip.rule);
      items.push(item);
      grads.push(undefined);
      boxes.push(undefined);
      hashes.push(undefined);
      this.stats.clips++;
      run = [];
    };
    for (let i = 0; i < leaf.items.length; i++) {
      if (i < from) {
        keep(i);
        continue;
      }
      const tb = leaf.boxes[i];
      const box = tb ? transformBox(tb.m, { x: 0, y: 0, width: tb.w, height: tb.h }) : computeItemsBox([leaf.items[i]]);
      const rel = clipRelation(box, clip);
      if (rel === 'out') continue;
      if (rel === 'in') {
        flush();
        keep(i);
      } else {
        run.push(leaf.items[i]);
      }
    }
    flush();
    leaf.items = items;
    leaf.grads = grads;
    leaf.boxes = boxes;
    leaf.hashes = hashes;
  }

  /** 绘制节点自身；返回是否还需要绘制子节点 */
  private drawSelf({ node, m, a }: Prepared, leaf: FigmaLeaf): boolean {
    let recurse = true;
    const n0 = leaf.items.length;
    try {
      switch (node.type) {
        case 'TEXT':
          this.drawText(node, m, a, leaf);
          break;
        case 'BOOLEAN_OPERATION':
          // 布尔运算的结果几何已缓存在 fillGeometry 中，子节点只是运算输入
          if (node.fillGeometry?.length || node.strokeGeometry?.length) {
            this.drawGeometry(node, m, a, leaf);
            recurse = false;
          }
          break;
        default:
          this.drawGeometry(node, m, a, leaf);
      }
    } catch (e: any) {
      this.stats.errors.push(`${node.type} ${node.name ?? gkey(node.guid)}: ${e?.message || e}`);
    }
    // 阴影只对单独成图元的节点有意义（合并的图元无法逐项设置）
    if (!leaf.shadow && n0 === 0 && leaf.items.length > 0) {
      const sh = (node.effects || []).find((e: any) => e.visible !== false && e.type === 'DROP_SHADOW' && e.color);
      if (sh) {
        const k = matrixScale(m);
        leaf.shadow = {
          color: rgbaCss(sh.color.r, sh.color.g, sh.color.b, (sh.color.a ?? 1) * a),
          x: (sh.offset?.x ?? 0) * k,
          y: (sh.offset?.y ?? 0) * k,
          blur: (sh.radius ?? 0) * k,
        };
      }
    }
    return recurse;
  }

  /** 遍历子节点；组件实例展开为组件的子节点（带覆盖作用域） */
  private eachChild(node: FigNode, raw: FigNode, outer: Scope | undefined, fn: (child: FigNode, scope: Scope | undefined) => void) {
    if (node.type !== 'INSTANCE') {
      for (const c of this.kids(raw)) fn(c, outer);
      return;
    }
    this.stats.instances++;
    const symId = symbolIdOf(node);
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
    const scope: Scope = { overrides, props, path: (outer?.path || '') + gkey(node.guid) + '/' };
    this.symbolStack.push(symId);
    try {
      for (const c of this.kids(sym)) fn(c, scope);
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

  private push(leaf: FigmaLeaf, item: VectorItem, grad?: FigmaGradient, box?: FigmaTextBox, hash?: string) {
    leaf.items.push(item);
    leaf.grads.push(grad);
    leaf.boxes.push(box);
    leaf.hashes.push(hash);
  }

  private drawGeometry(node: FigNode, m: VectorMatrix, a: number, leaf: FigmaLeaf) {
    const fills = this.blendable(node.fillPaints);
    const strokes = this.blendable(node.strokePaints);
    if (!fills.length && !strokes.length) return;

    const colorFills = fills.filter((p) => p.type !== 'IMAGE');
    let fillPaths = this.geometry(node.fillGeometry, m);
    if (!fillPaths.length && (colorFills.length || (strokes.length && !node.strokeGeometry?.length))) {
      fillPaths = this.vectorGeometry(node, m);
      if (!fillPaths.length) {
        const d = this.fallbackShape(node, m);
        d && (fillPaths = [{ d, rule: 'nonzero' }]);
      }
    }
    // 填充按图层面板的顺序从下往上画；图片填充为 IR 图片项（按节点框放置）
    for (const p of fills) {
      if (p.type === 'IMAGE') {
        this.imageFill(node, p, m, a, leaf);
        continue;
      }
      const c = this.paintColor(p, a);
      if (!c) continue;
      const g = this.gradient(p, node, m, a);
      const paint = this.irGradient(p, node, m, a) ?? c;
      for (const f of fillPaths) this.push(leaf, pathItem(f.d, { fill: paint, stroke: 'none', rule: f.rule === 'evenodd' ? 'evenodd' : undefined }), g);
    }
    if (!strokes.length) return;
    const strokePaths = this.geometry(node.strokeGeometry, m);
    if (strokePaths.length) {
      // strokeGeometry 是描边展开后的轮廓（已包含对齐方式、虚线、端点），直接填充
      for (const p of strokes) {
        const c = this.paintColor(p, a);
        if (!c) continue;
        const g = this.gradient(p, node, m, a);
        const paint = this.irGradient(p, node, m, a) ?? c;
        for (const f of strokePaths) this.push(leaf, pathItem(f.d, { fill: paint, stroke: 'none', rule: f.rule === 'evenodd' ? 'evenodd' : undefined }), g);
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
      const paint = this.irGradient(p, node, m, a) ?? c;
      for (const f of fillPaths) this.push(leaf, pathItem(f.d, { ...style, stroke: paint }));
    }
  }

  private imageFill(node: FigNode, p: any, m: VectorMatrix, a: number, leaf: FigmaLeaf) {
    const w = node.size?.x ?? 0;
    const h = node.size?.y ?? 0;
    const hash = imageHash(p.image?.hash);
    if (!this.opts.images || !hash || !(w > 0 && h > 0)) {
      this.count('image');
      return;
    }
    const op = (p.opacity ?? 1) * a;
    if (!(op > 0)) return;
    if (this.opts.skipImages?.includes(hash)) {
      this.count('skippedImage');
      return;
    }
    const src = this.imageSrc(hash);
    if (!src) {
      this.count('missingImage');
      return;
    }
    this.stats.images++;
    const mode = p.imageScaleMode || 'FILL';
    const item: VectorImageItem = { t: 'i', src, m: multiplyMatrix(m, scaleMatrix(w, h)) };
    op < 0.999 && (item.alpha = op);
    // FILL = 等比铺满裁剪，FIT = 等比完整显示；STRETCH / CROP（已按裁剪框拉伸）/ TILE 按拉伸处理
    const iw = p.originalImageWidth;
    const ih = p.originalImageHeight;
    // 图片与框同比例时铺满裁剪 = 拉伸
    const same = iw > 0 && ih > 0 && Math.abs(iw / ih / (w / h) - 1) < 0.01;
    if (mode === 'FILL' && !same) item.fit = 'cover';
    else if (mode === 'FIT') item.fit = 'contain';
    else if (mode === 'TILE') this.count('image:tile');
    const r = node.cornerRadius ?? (node.rectangleCornerRadiiIndependent ? node.rectangleTopLeftCornerRadius : 0);
    r > 0 && (item.radius = Math.min(r, w / 2, h / 2));
    // 圆角在单位正方形 → 节点框的缩放之前，换算到局部（节点父级）坐标
    item.radius && (item.radius *= matrixScale(m));
    this.push(leaf, item, undefined, undefined, hash);
  }

  /** 图片地址：调用方提供的 URL 优先，否则内嵌为 data URL */
  private imageSrc(hash: string): string | undefined {
    const url = this.opts.imageUrls?.[hash];
    if (url) return url;
    let src = this.dataUrls.get(hash);
    if (src === undefined) {
      const bytes = this.imageBytes.get(hash);
      src = bytes ? bytesToDataURL(bytes) : '';
      this.dataUrls.set(hash, src);
    }
    return src || undefined;
  }

  /**
   * 没有混合模式：同一组填充中有普通填充时，跳过特殊混合层（OVERLAY、COLOR_DODGE 等通常是质感叠加），
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
  private geometry(paths: any[] | undefined, m: VectorMatrix): Shape[] {
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

  /** 只有可编辑矢量网络、没有渲染缓存时，从顶点、线段和区域恢复填充路径 */
  private vectorGeometry(node: FigNode, m: VectorMatrix): Shape[] {
    const data = node.vectorData;
    const blob = data && this.blobs[data.vectorNetworkBlob];
    if (!blob) return [];
    const w = node.size?.x ?? data.normalizedSize?.x ?? 0;
    const h = node.size?.y ?? data.normalizedSize?.y ?? 0;
    const nw = data.normalizedSize?.x ?? w;
    const nh = data.normalizedSize?.y ?? h;
    if (!(w > 0 && h > 0 && nw > 0 && nh > 0)) return [];
    return vectorNetworkToShapes(blob, multiplyMatrix(m, scaleMatrix(w / nw, h / nh)));
  }

  /** resizeToFit 的画板以直接子内容为准；旧版文件中的 size 可能仍是创建画板时的默认值 */
  private nodeBox(node: FigNode, depth = 0): VectorBox {
    const base = { x: 0, y: 0, width: node.size?.x ?? 0, height: node.size?.y ?? 0 };
    if (!node.resizeToFit || depth > 128) return base;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const child of this.kids(node)) {
      if (child.visible === false || NON_VISUAL.has(child.type)) continue;
      const box = this.nodeBox(child, depth + 1);
      if (!(box.width > 0 || box.height > 0)) continue;
      const b = transformBox(child.transform ? figMatrix(child.transform) : IDENTITY, box);
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    }
    return x1 >= x0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : base;
  }

  /** 没有缓存几何时，按类型和尺寸重建（矩形含圆角、椭圆） */
  private fallbackShape(node: FigNode, m: VectorMatrix): number[] | undefined {
    const { x, y, width: w, height: h } = this.nodeBox(node);
    if (!(w > 0) && !(h > 0)) return undefined;
    const b = new VectorPathBuilder(m);
    if (node.type === 'ELLIPSE') return b.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2).close().d;
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
    b.moveTo(x + tl, y).lineTo(x + w - tr, y);
    tr > 0 && b.ellipse(x + w - tr, y + tr, tr, tr, 0, -H, 0, false, true);
    b.lineTo(x + w, y + h - br);
    br > 0 && b.ellipse(x + w - br, y + h - br, br, br, 0, 0, H, false, true);
    b.lineTo(x + bl, y + h);
    bl > 0 && b.ellipse(x + bl, y + h - bl, bl, bl, 0, H, Math.PI, false, true);
    b.lineTo(x, y + tl);
    tl > 0 && b.ellipse(x + tl, y + tl, tl, tl, 0, Math.PI, Math.PI + H, false, true);
    return b.close().d;
  }

  /** 纯色；渐变返回各色标的平均色（Vector IR 的颜色，以及不能绑定渐变时的退化颜色） */
  private paintColor(p: any, alpha: number): string | undefined {
    const op = (p.opacity ?? 1) * alpha;
    if (!(op > 0)) return undefined;
    switch (p.type) {
      case 'SOLID':
        return p.color ? rgbaCss(p.color.r, p.color.g, p.color.b, (p.color.a ?? 1) * op) : undefined;
      case 'GRADIENT_LINEAR':
      case 'GRADIENT_RADIAL':
      case 'GRADIENT_ANGULAR':
      case 'GRADIENT_DIAMOND': {
        const stops = (p.stops || []).filter((s: any) => s.color);
        if (!stops.length) return undefined;
        const avg = { r: 0, g: 0, b: 0, a: 0 };
        for (const s of stops) {
          avg.r += s.color.r / stops.length;
          avg.g += s.color.g / stops.length;
          avg.b += s.color.b / stops.length;
          avg.a += (s.color.a ?? 1) / stops.length;
        }
        return rgbaCss(avg.r, avg.g, avg.b, avg.a * op);
      }
      case 'IMAGE':
      case 'VIDEO':
        this.count('image');
        return undefined;
      default:
        this.count(`paint:${p.type}`);
        return undefined;
    }
  }

  /**
   * 渐变的几何：paint.transform 把节点归一化坐标（0~1）映射到渐变空间，
   * 渐变空间中线性渐变沿 (0, 0.5) → (1, 0.5)，径向渐变圆心 (0.5, 0.5)、半径 0.5。
   */
  private gradient(p: any, node: FigNode, m: VectorMatrix, a: number): FigmaGradient | undefined {
    if (!/^GRADIENT_/.test(p.type)) return undefined;
    this.stats.gradients++;
    const w = node.size?.x ?? 0;
    const h = node.size?.y ?? 0;
    const stops = (p.stops || [])
      .filter((s: any) => s.color)
      .map((s: any) => ({ i: s.position ?? 0, c: [s.color.r, s.color.g, s.color.b, (s.color.a ?? 1) * (p.opacity ?? 1) * a] as Rgba }));
    if (stops.length < 2 || !(w > 0 || h > 0)) return undefined;
    const inv = (p.transform && invertMatrix(figMatrix(p.transform))) || IDENTITY;
    const nm = multiplyMatrix(m, multiplyMatrix(scaleMatrix(w, h), inv));
    const at = (x: number, y: number) => applyMatrix(nm, x, y) as [number, number];
    if (p.type === 'GRADIENT_LINEAR') return { type: 'linear', p0: at(0, 0.5), p1: at(1, 0.5), stops };
    if (p.type === 'GRADIENT_ANGULAR') this.count('gradient:angular');
    return { type: 'radial', p0: at(0.5, 0.5), p1: at(1, 0.5), p2: at(0.5, 1), stops };
  }

  /**
   * IR 渐变：直接使用 Figma 的渐变空间（节点归一化坐标经 paint.transform 映射后的空间），
   * 线性渐变 (0, 0.5) → (1, 0.5)，径向渐变圆心 (0.5, 0.5)、半径 0.5；
   * m = 节点矩阵 × 节点尺寸 × paint.transform⁻¹，可表达椭圆、斜切等任意仿射后的渐变
   */
  private irGradient(p: any, node: FigNode, m: VectorMatrix, a: number): VectorGradient | undefined {
    if (!/^GRADIENT_/.test(p.type)) return undefined;
    const w = node.size?.x ?? 0;
    const h = node.size?.y ?? 0;
    const op = (p.opacity ?? 1) * a;
    const stops = (p.stops || [])
      .filter((s: any) => s.color)
      .map((s: any) => ({ o: s.position ?? 0, c: rgbaCss(s.color.r, s.color.g, s.color.b, (s.color.a ?? 1) * op) }))
      .sort((x: VectorGradientStop, y: VectorGradientStop) => x.o - y.o);
    if (stops.length < 2 || !(w > 0 && h > 0)) return undefined;
    const inv = (p.transform && invertMatrix(figMatrix(p.transform))) || IDENTITY;
    const gm = multiplyMatrix(m, multiplyMatrix(scaleMatrix(w, h), inv));
    if (!gm.every(Number.isFinite)) return undefined;
    if (p.type === 'GRADIENT_LINEAR') return { type: 'linear', x0: 0, y0: 0.5, x1: 1, y1: 0.5, m: gm, stops };
    return { type: 'radial', x0: 0.5, y0: 0.5, r0: 0, x1: 0.5, y1: 0.5, r1: 0.5, m: gm, stops };
  }

  // -------------------------------------------------------------------------
  // 文字
  // -------------------------------------------------------------------------

  private drawText(node: FigNode, m: VectorMatrix, a: number, leaf: FigmaLeaf) {
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
      this.drawGlyphs(node, dt.glyphs, styleOf, m, a, leaf);
      return;
    }

    const w = node.size?.x ?? 0;
    const h = node.size?.y ?? 0;
    const hAlign = node.textAlignHorizontal;
    const align: FigmaTextBox['align'] = hAlign === 'CENTER' ? 'center' : hAlign === 'RIGHT' ? 'right' : 'left';
    const baselines: any[] = dt?.baselines || [];
    let single = true;
    for (let i = 0; i < chars.length && single; i++) (ids[i] ?? 0) !== (ids[0] ?? 0) && (single = false);

    // 单一样式：整个节点一个文字项（多行用 \n 连接，按 Figma 的折行结果），附带文字框
    if (single) {
      const st = styleOf(ids[0] ?? 0);
      const fs = st.fontSize ?? 12;
      let lines: string[];
      let firstY: number;
      let lh: number;
      let left = 0;
      if (baselines.length) {
        lines = baselines.map((bl) => chars.slice(bl.firstCharacter ?? 0, Math.min(bl.endCharacter ?? chars.length, chars.length)).replace(/[\s\u2028]+$/, ''));
        firstY = baselines[0].position.y;
        lh = baselines.length > 1 ? (baselines[baselines.length - 1].position.y - firstY) / (baselines.length - 1) : baselines[0].lineHeight || fs * 1.2;
        left = Math.min(...baselines.map((bl) => bl.position.x));
      } else {
        lines = chars.split(/\r?\n|\u2028/);
        lh = lineHeightPx(st, fs);
        firstY = fs;
      }
      const text = applyCase(lines.join('\n'), st.textCase).replace(/\s+$/, '');
      if (!text) return;
      const x = align === 'center' ? w / 2 : align === 'right' ? w : left;
      const item = this.textItem(text, st, a, x, firstY);
      if (!item) return;
      item.a = align;
      item.lh = lh / fs;
      const v = node.textAlignVertical;
      const box: FigmaTextBox = {
        m,
        w,
        h,
        align,
        valign: v === 'CENTER' ? 'middle' : v === 'BOTTOM' ? 'bottom' : 'top',
        lh: lh / fs,
        weight: fontWeight(st.fontName?.style),
      };
      const sp = letterSpacing(st, fs);
      sp && (box.spacing = sp);
      this.pushText(leaf, item, m, this.textGradient(st, node, m, a), box);
      return;
    }

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
          const st = styleOf(sid);
          const text = applyCase(chars.slice(s, j), st.textCase).replace(/\s+$/, '');
          if (text) {
            const whole = i === first && j === end;
            const g = glyphAt.get(s);
            const item = this.textItem(text, st, a, g ? g.position.x : bl.position.x, bl.position.y);
            if (item) {
              // 整行单一样式时按对齐方式锚定，减小替代字体造成的宽度误差
              if (whole && bl.width > 0) {
                if (align === 'center') {
                  item.x = bl.position.x + bl.width / 2;
                  item.a = 'center';
                } else if (align === 'right') {
                  item.x = bl.position.x + bl.width;
                  item.a = 'right';
                }
              }
              this.pushText(leaf, item, m, this.textGradient(st, node, m, a));
            }
          }
          i = j;
        }
      }
    } else {
      // 没有排版缓存：按行从顶部排布
      const fs = node.fontSize ?? 12;
      const lh = lineHeightPx(node, fs);
      chars.split(/\r?\n|\u2028/).forEach((line, n) => {
        const text = applyCase(line, node.textCase);
        if (!text.trim()) return;
        const x = align === 'center' ? w / 2 : align === 'right' ? w : 0;
        const item = this.textItem(text, node, a, x, n * lh + fs);
        if (item) {
          item.a = align;
          this.pushText(leaf, item, m, this.textGradient(node, node, m, a));
        }
      });
    }
  }

  private pushText(leaf: FigmaLeaf, item: VectorTextItem, m: VectorMatrix, grad?: FigmaGradient, box?: FigmaTextBox) {
    this.push(leaf, isIdentity(m) ? item : transformItem(item, m), grad, box);
  }

  private textGradient(st: FigNode, node: FigNode, m: VectorMatrix, a: number) {
    const paint = (st.fillPaints || []).filter(visiblePaint).pop();
    return paint ? this.gradient(paint, node, m, a) : undefined;
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
    (fontWeight(style) ?? 400) >= 600 && (item.bold = true);
    /italic|oblique/i.test(style) && (item.italic = true);
    return item;
  }

  /** 使用缓存的字形轮廓（em 单位，Y 向上）绘制文字 */
  private drawGlyphs(node: FigNode, glyphs: any[], styleOf: (id: number) => FigNode, m: VectorMatrix, a: number, leaf: FigmaLeaf) {
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
    for (const [c, d] of byColor) this.push(leaf, pathItem(d, { fill: c, stroke: 'none' }));
  }

  // -------------------------------------------------------------------------

  private pageBorder(p: FigmaPageInfo): FigmaLeaf {
    const b = new VectorPathBuilder().polyline(
      [
        [p.x, p.y],
        [p.x + p.width, p.y],
        [p.x + p.width, p.y + p.height],
        [p.x, p.y + p.height],
      ],
      true,
    );
    const leaf: FigmaLeaf = { kind: 'leaf', info: { page: this.page, name: p.name, part: 'page' }, items: [], grads: [], boxes: [], hashes: [] };
    this.push(leaf, pathItem(b.d, { stroke: '#9aa4b2', dash: [6, 4] }));
    return leaf;
  }

  private count(key: string) {
    this.stats.unsupported[key] = (this.stats.unsupported[key] || 0) + 1;
  }
}

// ---------------------------------------------------------------------------

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function hasContent(leaf: FigmaLeaf) {
  return leaf.items.length > 0;
}

/** 蒙版之后的兄弟节点：[第一个被裁剪的图元 / 项的下标, 裁剪区域] */
type Masks = [number, FigmaClip][];

/** 一组同填充规则的路径；rect 为轴对齐（圆角）矩形的圆角半径（不是矩形时为 undefined） */
interface Shape {
  d: number[];
  rule: 'nonzero' | 'evenodd';
  rect?: number;
}

const RECT_TYPES = new Set(['RECTANGLE', 'ROUNDED_RECTANGLE', 'FRAME', 'SYMBOL', 'INSTANCE']);

function makeClip(paths: Shape[]): FigmaClip {
  const d = paths.length === 1 ? paths[0].d : paths.flatMap((p) => p.d);
  const clip: FigmaClip = { d, box: computeItemsBox([{ t: 'p', d }]) };
  // 混合填充规则时按 nonzero（并集）
  paths.every((p) => p.rule === 'evenodd') && (clip.rule = 'evenodd');
  return clip;
}

/** 矩形四角的圆角半径取最大值（判断「在区域内」时偏保守） */
function cornerRadius(node: FigNode) {
  const w = node.size?.x ?? 0;
  const h = node.size?.y ?? 0;
  const r = node.rectangleCornerRadiiIndependent
    ? Math.max(
        node.rectangleTopLeftCornerRadius ?? 0,
        node.rectangleTopRightCornerRadius ?? 0,
        node.rectangleBottomRightCornerRadius ?? 0,
        node.rectangleBottomLeftCornerRadius ?? 0,
      )
    : node.cornerRadius ?? 0;
  return Math.max(0, Math.min(r, w / 2, h / 2));
}

/** 无旋转（或旋转 90° 的倍数）、无斜切 */
function axisAligned(m: VectorMatrix) {
  const e = 1e-9;
  return (Math.abs(m[1]) < e && Math.abs(m[2]) < e) || (Math.abs(m[0]) < e && Math.abs(m[3]) < e);
}

/** 只有直线、所有顶点都在包围盒四角上的单个闭合路径（轴对齐矩形） */
function isRectPath(d: number[]) {
  const box = computeItemsBox([{ t: 'p', d }]);
  const e = 1e-3;
  let subpaths = 0;
  for (let i = 0; i < d.length; ) {
    const op = d[i];
    if (op === 4) {
      i += 1;
      continue;
    }
    if (op !== 0 && op !== 1) return false;
    op === 0 && subpaths++;
    const x = d[i + 1];
    const y = d[i + 2];
    const onX = Math.abs(x - box.x) < e || Math.abs(x - box.x - box.width) < e;
    const onY = Math.abs(y - box.y) < e || Math.abs(y - box.y - box.height) < e;
    if (!onX || !onY) return false;
    i += 3;
  }
  return subpaths === 1 && box.width > 0 && box.height > 0;
}

/** 蒙版是否需要按透明度（而不是轮廓）处理：半透明、渐变、图片填充 */
function softMask(node: FigNode) {
  if ((node.opacity ?? 1) < 1) return true;
  return [...(node.fillPaints || []), ...(node.strokePaints || [])]
    .filter(visiblePaint)
    .some((p) => p.type !== 'SOLID' || (p.opacity ?? 1) < 1 || (p.color?.a ?? 1) < 1);
}

/** 内容框与裁剪区域的关系：in 完全在内（不用裁剪），out 完全在外，cross 跨边界 */
function clipRelation(b: VectorBox, clip: FigmaClip): 'in' | 'out' | 'cross' {
  if (!clip.d.length) return 'out';
  const c = clip.box;
  const e = 0.5;
  const bx1 = b.x + b.width;
  const by1 = b.y + b.height;
  const cx1 = c.x + c.width;
  const cy1 = c.y + c.height;
  if (b.x >= cx1 - 1e-6 || bx1 <= c.x + 1e-6 || b.y >= cy1 - 1e-6 || by1 <= c.y + 1e-6) {
    // 零宽 / 零高的内容（水平线、竖线）恰好在边上时不算在外
    if (!(b.width === 0 || b.height === 0) || b.x > cx1 || bx1 < c.x || b.y > cy1 || by1 < c.y) return 'out';
  }
  if (!clip.rect || b.x < c.x - e || b.y < c.y - e || bx1 > cx1 + e || by1 > cy1 + e) return 'cross';
  const r = clip.r || 0;
  if (r > 0) {
    // 四个角点都在圆角矩形内
    const inside = (x: number, y: number) => {
      const qx = x < c.x + r ? c.x + r : x > cx1 - r ? cx1 - r : x;
      const qy = y < c.y + r ? c.y + r : y > cy1 - r ? cy1 - r : y;
      return Math.hypot(x - qx, y - qy) <= r + e;
    };
    if (!inside(b.x, b.y) || !inside(bx1, b.y) || !inside(bx1, by1) || !inside(b.x, by1)) return 'cross';
  }
  return 'in';
}

/** 去掉裁剪后没有内容的图元、组合 */
function prune(units: FigmaUnit[]): FigmaUnit[] {
  return units.filter((u) => {
    if (u.kind === 'leaf') return hasContent(u);
    u.children = prune(u.children);
    return u.children.length > 0;
  });
}

function visiblePaint(p: any) {
  return p && p.visible !== false && (p.opacity ?? 1) > 0;
}

function rotation(rad: number): VectorMatrix {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

export function leafBox(leaf: FigmaLeaf): VectorBox {
  return computeItemsBox(leaf.items);
}

function forEachLeaf(units: FigmaUnit[], fn: (leaf: FigmaLeaf) => void) {
  for (const u of units) u.kind === 'leaf' ? fn(u) : forEachLeaf(u.children, fn);
}

function unitsBox(units: FigmaUnit[]): VectorBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  forEachLeaf(units, (leaf) => {
    const b = leafBox(leaf);
    if (!(b.width > 0 || b.height > 0)) return;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  });
  return x1 >= x0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 0, height: 0 };
}

function transformUnit(u: FigmaUnit, m: VectorMatrix, k: number) {
  if (u.kind === 'group') {
    for (const c of u.children) transformUnit(c, m, k);
    return;
  }
  const pt = (p: [number, number]) => applyMatrix(m, p[0], p[1]) as [number, number];
  u.items = u.items.map((it) => transformItem(it, m, k));
  u.grads = u.grads.map((g) => g && { ...g, p0: pt(g.p0), p1: pt(g.p1), p2: g.p2 && pt(g.p2) });
  u.boxes = u.boxes.map((b) => b && { ...b, m: multiplyMatrix(m, b.m) });
  if (u.shadow) {
    u.shadow.x *= k;
    u.shadow.y *= k;
    u.shadow.blur *= k;
  }
}

/** 没有排版缓存时的行距（像素） */
function lineHeightPx(st: FigNode, fs: number) {
  const lh = st.lineHeight;
  if (lh?.units === 'PIXELS' && lh.value > 0) return lh.value;
  if (lh?.units === 'PERCENT' && lh.value > 0) return (fs * 1.2 * lh.value) / 100;
  if (lh?.units === 'RAW' && lh.value > 0) return fs * lh.value;
  return fs * 1.2;
}

function letterSpacing(st: FigNode, fs: number) {
  const ls = st.letterSpacing;
  if (!ls?.value) return 0;
  return ls.units === 'PERCENT' ? (fs * ls.value) / 100 : ls.value;
}

/** Figma 字体样式名 → CSS 字重 */
export function fontWeight(style: string | undefined): number | undefined {
  if (!style) return undefined;
  const s = style.toLowerCase().replace(/[\s_-]/g, '');
  if (/thin|hairline/.test(s)) return 100;
  if (/extralight|ultralight/.test(s)) return 200;
  if (/semibold|demibold/.test(s)) return 600;
  if (/extrabold|ultrabold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  if (/medium/.test(s)) return 500;
  if (/light/.test(s)) return 300;
  return 400;
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

/** 图元树 → 纯 Vector IR */
export function treeToItems(units: FigmaUnit[]): VectorItem[] {
  const out: VectorItem[] = [];
  forEachLeaf(units, (leaf) => out.push(...leaf.items));
  return out;
}
