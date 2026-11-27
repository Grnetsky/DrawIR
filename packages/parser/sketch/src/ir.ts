/**
 * Sketch (.sketch) → 图元树（Vector IR + 旁路信息）。
 *
 * 格式要点（阶段 0 调研结论，依据 Sketch 2026.1 / 格式版本 188 的样例和 @sketch-hq/sketch-file-format 规范）：
 *  1. 容器：ZIP 包，document.json + pages/<id>.json + images/；43 之前的 SQLite 格式不支持（archive.ts）。
 *  2. 页面：document.pages 顺序；每页的画板 / 图层按页面坐标排布，多页横向排布（pageGap）。
 *  3. 坐标系：点（pt = 1x 像素），Y 向下。图层 frame {x, y, width, height} 相对父图层原点；
 *     组件实例的内容相对实例；页面原点任意，按内容框对齐到 origin。
 *  4. 变换：local = T(x + w/2, y + h/2) · R(-rotation°) · S(flipX ? -1 : 1, flipY ? -1 : 1) · T(-w/2, -h/2)，
 *     rotation 为逆时针角度；节点矩阵沿父级链乘（parentM × local），旋转、翻转都烘进矩阵（同 Figma）。
 *  5. 几何：形状（rectangle / oval / polygon / star / triangle / shapePath）都有 points：
 *     curvePoint.point / curveFrom / curveTo 为相对 frame 的 0~1 比例坐标，i → i+1 段为三次贝塞尔
 *     (curveFrom_i, curveTo_{i+1}, point_{i+1})，hasCurveFrom / hasCurveTo 都为 false 时为直线；
 *     cornerRadius 为直角点的圆角。shapeGroup 是布尔组合：子形状按 booleanOperation（0 并、1 减、2 交、3 异或）合成，样式取组合的。
 *  6. 样式：fills / borders 数组从下往上画；fillType 0 纯色、1 渐变（from / to 为 frame 比例坐标，
 *     gradientType 0 线性、1 径向（elipseLength 为另一半轴比例）、2 角度）、4 图片（patternFillType 0 平铺、1 填充、2 拉伸、3 适应）；
 *     border.position 0 居中、1 内侧、2 外侧；borderOptions 虚线 / 端点 / 拐角；contextSettings.opacity 透明度（向下累乘）；
 *     startMarkerType / endMarkerType 开放路径的端点（0 无、1 开放箭头、2 实心箭头、3 竖线、4 空心圆、5 实心圆、6 空心方、7 实心方）。
 *  7. 文字：attributedString（string + 若干样式段：字体 PostScript 名、字号、颜色、段落对齐 / 行高、字距），
 *     文字框为 frame；定宽（旧 textBehaviour 1 / 2，新 horizontalSizing ≠ 1）时自动换行；文件不含排版结果。
 *  8. 复用：symbolMaster（本地页面上 + document.foreignSymbols 外部库）；symbolInstance 按 overrideValues
 *     （`<图层id>[/<图层id>…]_<属性>`：stringValue / symbolID / isVisible / image / layerStyle / textStyle / color:fill-N …）展开，
 *     实例尺寸不同于母版时按约束 / 自动布局重排（layout.ts）。实例带覆盖，不用共享几何 ref。
 *  9. 层级：group / artboard（旧）/ 带 groupBehavior 的 Frame（新）/ symbolMaster / symbolInstance → 'node' 粒度下的组合。
 *     页面顶层的画板不组合。画板、Frame、组件裁剪内容；hasClippingMask 的图层裁剪同组中其上方的兄弟图层（遇 shouldBreakMaskChain 结束）。
 * 10. 连线：没有连接语义；不带填充、单色描边的直线 / 折线（箭头可映射时）生成原生连线，便于在 meta2d 中继续编辑。
 * 11. 图片：images/ 下的文件（引用 `images/<sha1>.<ext>`），内嵌为 data URL 或用 imageUrls 替换；readSketchImages 供先上传。
 * 12. 不支持（计入 stats.unsupported）：模糊、内阴影、多重阴影 / 扩展、混合模式、噪点填充、平铺图片、布尔交集、
 *     颜色调整、多样式文字段（按段落主样式）、下划线 / 删除线、旧版存档文字。
 */
import {
  applyMatrix,
  computeItemsBox,
  estimateTextWidth,
  IDENTITY,
  isIdentity,
  matrixScale,
  multiplyMatrix,
  pathItem,
  scaleMatrix,
  transformBox,
  transformItem,
  translateMatrix,
  VectorPathBuilder,
  wrapTextLines,
  type VectorBox,
  type VectorClipItem,
  type VectorGradient,
  type VectorImageItem,
  type VectorItem,
  type VectorMatrix,
  type VectorStyle,
  type VectorTextItem,
} from '@drawir/core';
import { bytesToDataURL, imageSize, readSketch, type SketchArchive } from './archive';
import { resizeLayers, type LayoutContext } from './layout';
import type { SketchPageInfo, SketchParseOptions, SketchParseStats, SketchPenInfo } from './types';
import { rgbaCss } from './util';

type Layer = Record<string, any>;

/** RGBA 0~1 */
export type Rgba = [number, number, number, number];

/** 渐变（画布坐标）。线性：p0 → p1；径向：p0 为圆心，p1 / p2 为两个半轴的端点。适配层按图元框换算 */
export interface SketchGradient {
  type: 'linear' | 'radial';
  p0: [number, number];
  p1: [number, number];
  p2?: [number, number];
  stops: { i: number; c: Rgba }[];
}

/** 文字框（画布坐标），用于生成与 Sketch 文字框一致的原生文字图元 */
export interface SketchTextBox {
  /** 文字框局部坐标 → 画布 */
  m: VectorMatrix;
  w: number;
  h: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  /** 行高倍数（行距 / 字号） */
  lh: number;
  /** 定宽自动换行 */
  wrap: boolean;
  /** 字重 100~900 */
  weight?: number;
  /** 字间距（文字框局部单位） */
  spacing?: number;
}

/** 可以生成原生连线的直线 / 折线（画布坐标） */
export interface SketchEdge {
  points: { x: number; y: number }[];
  color?: string;
  lineWidth: number;
  dash?: number[];
  from?: { type: 'triangle' | 'line' | 'circle' | 'diamond'; filled: boolean; size: number };
  to?: SketchEdge['from'];
  native: boolean;
  /** 连线图层生成的 IR 项数：leaf 只含这些项时才能整体换成原生连线 */
  span?: number;
}

/**
 * 裁剪区域（画布坐标）：蒙版、画板 / Frame / 组件的内容裁剪。
 * 内容完全在区域内时不用裁剪，完全在区域外时丢弃，跨边界的才包进 IR 裁剪项
 */
export interface SketchClip {
  /** 为空表示什么都不显示 */
  d: number[];
  rule?: 'evenodd';
  box: VectorBox;
  /** 轴对齐（圆角）矩形：可以精确判断内容是否在区域内 */
  rect?: boolean;
  r?: number;
}

export interface SketchShadow {
  color: string;
  x: number;
  y: number;
  blur: number;
}

export interface SketchLeaf {
  kind: 'leaf';
  info: SketchPenInfo;
  /** 画布坐标（Y 向下） */
  items: VectorItem[];
  /** 与 items 一一对应 */
  grads: (SketchGradient | undefined)[];
  boxes: (SketchTextBox | undefined)[];
  edge?: SketchEdge;
  shadow?: SketchShadow;
}

export interface SketchGroup {
  kind: 'group';
  info: SketchPenInfo;
  children: SketchUnit[];
}

export type SketchUnit = SketchLeaf | SketchGroup;

export interface SketchTree {
  pages: SketchUnit[][];
  pageList: SketchPageInfo[];
  stats: SketchParseStats;
  archive: SketchArchive;
}

/** 图层树节点（readSketchLayers） */
export interface SketchLayer {
  /** 图层 id，与 SketchPenInfo.id、SketchParseOptions.skipNodes 一致；组件实例内的图层为实例路径 */
  id: string;
  name: string;
  /** page / artboard / group / symbolInstance / text / rectangle … */
  type: string;
  hidden?: boolean;
  mask?: boolean;
  /** 子图层，上层在前（与 Sketch 图层面板一致） */
  children?: SketchLayer[];
}

/** 实例展开作用域：母版内图层 id 路径 → 覆盖的属性 */
interface Scope {
  overrides: Map<string, Map<string, any>>;
  /** 实例路径前缀（以 / 结尾），生成唯一的图层 id */
  path: string;
}

interface Prepared {
  node: Layer;
  m: VectorMatrix;
  a: number;
  id: string;
}

/** 一组同填充规则的路径；rect 为轴对齐（圆角）矩形的圆角半径 */
interface Shape {
  d: number[];
  rule: 'nonzero' | 'evenodd';
  rect?: number;
}

/** 形状图层的轮廓（局部坐标 → 画布已换算） */
interface Outline {
  d: number[];
  closed: boolean;
  /** 精确的简单形状：可以生成内 / 外描边的偏移轮廓 */
  simple?: { kind: 'rect'; w: number; h: number; r: number } | { kind: 'oval'; w: number; h: number };
  /** 开放路径的端点及切线方向（画布坐标），用于端点箭头 */
  ends?: { p: [number, number]; dir: [number, number] }[];
  /** 全部为直线段的折线点（画布坐标），可生成原生连线 */
  poly?: [number, number][];
  /** 布尔交集：形状只在这些路径内可见（逐个裁剪） */
  clips?: number[][];
}

type OptionalKeys = 'pages' | 'imageUrls' | 'origin' | 'skipNodes' | 'skipImages';
export type ResolvedOptions = Required<Omit<SketchParseOptions, OptionalKeys>> & Pick<SketchParseOptions, OptionalKeys>;

export function resolveOptions(options: SketchParseOptions = {}): ResolvedOptions {
  return { pageGap: 80, scale: 1, pageBorder: false, granularity: 'node', group: true, editable: true, images: true, ...options };
}

const SHAPES = new Set(['rectangle', 'oval', 'polygon', 'star', 'triangle', 'shapePath']);
const CONTAINERS = new Set(['group', 'artboard', 'symbolMaster', 'symbolInstance']);
/** 不参与渲染的图层 */
const NON_VISUAL = new Set(['slice', 'MSImmutableHotspotLayer', 'hotspot', 'MSHotspotLayer']);

const parsePoint = (s: string | undefined): [number, number] => {
  const m = typeof s === 'string' ? s.match(/-?[\d.]+(?:e-?\d+)?/gi) : null;
  return m && m.length >= 2 ? [+m[0], +m[1]] : [0, 0];
};
const parseRect = (s: string | undefined) => {
  const m = typeof s === 'string' ? s.match(/-?[\d.]+(?:e-?\d+)?/gi) : null;
  return m && m.length >= 4 ? { x: +m[0], y: +m[1], w: +m[2], h: +m[3] } : undefined;
};
const enabled = (x: any) => x && x.isEnabled !== false;

export class SketchToIR {
  private opts: ResolvedOptions;
  private archive!: SketchArchive;
  private masters = new Map<string, Layer>();
  private layerStyles = new Map<string, any>();
  private textStyles = new Map<string, any>();
  /** 字体 PostScript 名 → 字体族名（document.fontReferences） */
  private families = new Map<string, string>();
  private symbolStack: string[] = [];
  private page = 0;
  private dataUrls = new Map<string, string>();
  private skip = new Set<string>();
  /** 当前图层的混合模式（图层级，填充 / 描边自身没有混合模式时使用） */
  private blendMode = 0;
  /** 最近生成原生连线描述的 leaf（drawSelf 结束时记录连线的项数） */
  private edgeLeaf: SketchLeaf | undefined;
  stats!: SketchParseStats;

  constructor(options: SketchParseOptions = {}) {
    this.opts = resolveOptions(options);
  }

  build(data: Uint8Array): SketchTree {
    const t0 = now();
    const archive = readSketch(data, { images: this.opts.images });
    this.load(archive);
    this.skip = new Set(this.opts.skipNodes || []);
    const k = this.opts.scale > 0 ? this.opts.scale : 1;
    const oy0 = this.opts.origin?.y || 0;
    const pages: SketchUnit[][] = [];
    const pageList: SketchPageInfo[] = [];
    let ox = this.opts.origin?.x || 0;
    archive.pages.forEach((page, index) => {
      if (this.opts.pages && !this.opts.pages.includes(index)) return;
      this.page = index;
      const units: SketchUnit[] = [];
      try {
        if (this.opts.granularity === 'page') {
          const leaf = this.leaf(page, page.do_objectID);
          this.collectChildren(page.layers || [], IDENTITY, 1, undefined, 0, leaf);
          hasContent(leaf) && units.push(leaf);
        } else {
          this.visitChildren(page.layers || [], IDENTITY, 1, undefined, 0, 0, units);
        }
      } catch (e: any) {
        this.stats.errors.push(`page#${page.do_objectID}: ${e?.message || e}`);
      }
      const box = unitsBox(units);
      const m: VectorMatrix = [k, 0, 0, k, ox - box.x * k, oy0 - box.y * k];
      const info: SketchPageInfo = { name: page.name || `Page ${index + 1}`, x: ox, y: oy0, width: box.width * k, height: box.height * k };
      if (!isIdentity(m)) for (const u of units) transformUnit(u, m, k);
      if (this.opts.pageBorder) units.unshift(this.pageBorder(info));
      pageList.push(info);
      pages.push(units);
      ox += info.width + this.opts.pageGap;
      this.stats.pages++;
    });
    this.stats.ms = Math.round(now() - t0);
    return { pages, pageList, stats: this.stats, archive };
  }

  /** 图层树（不计算几何），与 Sketch 图层面板一致；组件实例展开为母版的子图层（按覆盖取文字可见性） */
  layers(data: Uint8Array): SketchLayer[] {
    const archive = readSketch(data, { images: false });
    this.load(archive);
    const walk = (raw: Layer, scope: Scope | undefined, depth: number): SketchLayer | undefined => {
      if (depth > 128 || NON_VISUAL.has(raw._class)) return undefined;
      const node = this.overridden(raw, scope);
      const id = (scope?.path || '') + raw.do_objectID;
      const layer: SketchLayer = { id, name: node.name || node._class, type: node._class };
      node.isVisible === false && (layer.hidden = true);
      node.hasClippingMask && (layer.mask = true);
      if (node._class !== 'shapeGroup') {
        const children: SketchLayer[] = [];
        this.eachChild(node, scope, id, (kids, s) => {
          for (const c of kids) {
            const l = walk(c, s, depth + 1);
            l && children.push(l);
          }
        });
        children.length && (layer.children = children.reverse());
      }
      return layer;
    };
    return archive.pages.map((p, index) => ({
      id: p.do_objectID,
      name: p.name || `Page ${index + 1}`,
      type: 'page',
      children: (p.layers || [])
        .map((l: Layer) => walk(l, undefined, 0))
        .filter(Boolean)
        .reverse(),
    }));
  }

  /** 建立组件母版、共享样式索引 */
  private load(archive: SketchArchive) {
    this.archive = archive;
    const meta = archive.meta || {};
    this.stats = {
      version: meta.version ?? 0,
      appVersion: meta.appVersion,
      pages: 0,
      nodes: 0,
      instances: 0,
      resized: 0,
      texts: 0,
      images: 0,
      gradients: 0,
      clips: 0,
      pens: 0,
      unsupported: {},
      errors: [],
      ms: 0,
    };
    this.masters = new Map();
    this.dataUrls = new Map();
    const doc = archive.document || {};
    for (const f of doc.foreignSymbols || []) f.symbolMaster?.symbolID && this.masters.set(f.symbolMaster.symbolID, f.symbolMaster);
    const scan = (l: Layer, depth: number) => {
      if (depth > 64) return;
      if (l._class === 'symbolMaster' && l.symbolID) this.masters.set(l.symbolID, l);
      for (const c of l.layers || []) if (c.layers || c._class === 'symbolMaster') scan(c, depth + 1);
    };
    for (const p of archive.pages) scan(p, 0);
    this.families = new Map();
    for (const f of doc.fontReferences || []) for (const ps of f.postscriptNames || []) f.fontFamilyName && this.families.set(ps, f.fontFamilyName);
    this.layerStyles = new Map();
    this.textStyles = new Map();
    for (const s of doc.layerStyles?.objects || []) this.layerStyles.set(s.do_objectID, s.value);
    for (const s of doc.foreignLayerStyles || []) s.localSharedStyle && this.layerStyles.set(s.localSharedStyle.do_objectID, s.localSharedStyle.value);
    for (const s of doc.layerTextStyles?.objects || []) this.textStyles.set(s.do_objectID, s.value);
    for (const s of doc.foreignTextStyles || []) s.localSharedStyle && this.textStyles.set(s.localSharedStyle.do_objectID, s.localSharedStyle.value);
  }

  private leaf(node: Layer, id: string, part?: SketchPenInfo['part']): SketchLeaf {
    return { kind: 'leaf', info: this.info(node, id, part), items: [], grads: [], boxes: [] };
  }

  private info(node: Layer, id: string, part?: SketchPenInfo['part']): SketchPenInfo {
    const info: SketchPenInfo = { page: this.page, id, type: node._class };
    node.name && (info.name = node.name);
    part && (info.part = part);
    return info;
  }

  private push(leaf: SketchLeaf, item: VectorItem, grad?: SketchGradient, box?: SketchTextBox) {
    leaf.items.push(item);
    leaf.grads.push(grad);
    leaf.boxes.push(box);
  }

  private count(key: string) {
    this.stats.unsupported[key] = (this.stats.unsupported[key] || 0) + 1;
  }

  // -------------------------------------------------------------------------
  // 遍历
  // -------------------------------------------------------------------------

  /** 合并覆盖，计算矩阵和不透明度；不可见时返回 undefined */
  private prepare(raw: Layer, parentM: VectorMatrix, alpha: number, scope: Scope | undefined, depth: number): Prepared | undefined {
    if (depth > 128 || !raw || NON_VISUAL.has(raw._class)) return undefined;
    const id = (scope?.path || '') + raw.do_objectID;
    if (this.skip.size && this.skip.has(id)) return undefined;
    const node = this.overridden(raw, scope);
    if (node.isVisible === false) return undefined;
    const a = alpha * (node.style?.contextSettings?.opacity ?? 1);
    if (!(a > 0.001)) return undefined;
    this.stats.nodes++;
    const st = node.style || {};
    const blend = st.contextSettings?.blendMode;
    blend && !APPROX_BLEND.has(blend) && this.count(`blend:${blend}`);
    for (const b of [st.blur, ...(st.blurs || [])]) enabled(b) && b._class && this.count(`blur:${b.type ?? 0}`);
    (st.innerShadows || []).some(enabled) && this.count('innerShadow');
    enabled(st.colorControls) && st.colorControls.isEnabled === true && this.count('colorControls');
    return { node, m: multiplyMatrix(parentM, localMatrix(node)), a, id };
  }

  /** 'node' / 'layer' 粒度：容器拆成子图元，其余图层连同子树合成一个图元 */
  private visit(raw: Layer, parentM: VectorMatrix, alpha: number, scope: Scope | undefined, depth: number, level: number, out: SketchUnit[]) {
    const r = this.prepare(raw, parentM, alpha, scope, depth);
    if (!r) return;
    try {
      const { node, id } = r;
      if (!this.splits(node, level)) {
        const leaf = this.leaf(node, id);
        this.drawTree(r, scope, depth, leaf);
        hasContent(leaf) && out.push(leaf);
        return;
      }
      let children: SketchUnit[] = [];
      const self = this.leaf(node, id, 'fill');
      this.drawSelf(r, self);
      hasContent(self) && children.push(self);
      const start = children.length;
      const inner = this.contentMatrix(r);
      this.eachChild(node, scope, id, (kids, s) => this.visitChildren(kids, inner, r.a, s, depth + 1, level + 1, children));
      const content = this.contentClip(r);
      if (content) for (let j = start; j < children.length; j++) this.clipUnit(children[j], content);
      children = prune(children);
      if (!children.length) return;
      // 页面顶层的画板不组合：组合后里面的图元无法直接选中
      const artboard = level === 0 && isArtboard(node);
      if (this.opts.granularity === 'node' && this.opts.group && !artboard && children.length > 1) out.push({ kind: 'group', info: this.info(node, id), children });
      else out.push(...children);
    } catch (e: any) {
      this.stats.errors.push(`${raw._class}#${raw.do_objectID}: ${e?.message || e}`);
    }
  }

  /** 遍历一组兄弟图层（从下往上），处理蒙版链 */
  private visitChildren(kids: Layer[], m: VectorMatrix, a: number, scope: Scope | undefined, depth: number, level: number, out: SketchUnit[]) {
    const ranges: [number, number, SketchClip][] = [];
    let mask: SketchClip | undefined;
    let from = 0;
    for (const c of kids) {
      if (mask && (c.shouldBreakMaskChain || c.hasClippingMask)) {
        ranges.push([from, out.length, mask]);
        mask = undefined;
      }
      const before = out.length;
      this.visit(c, m, a, scope, depth, level, out);
      if (c.hasClippingMask) {
        mask = this.maskClip(c, m, scope, depth);
        if (mask) {
          // 轮廓蒙版自身的样式照常显示；透明度蒙版只用来裁剪
          if (c.clippingMaskMode === 1) {
            out.splice(before);
            this.count('mask:alpha');
          }
          from = out.length;
        }
      }
    }
    mask && ranges.push([from, out.length, mask]);
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [f, t, clip] = ranges[i];
      for (let j = f; j < t; j++) this.clipUnit(out[j], clip);
    }
    if (ranges.length) out.splice(0, out.length, ...prune(out));
  }

  /** 'page' 粒度或不拆分的图层：整棵子树画进 leaf */
  private collectChildren(kids: Layer[], m: VectorMatrix, a: number, scope: Scope | undefined, depth: number, leaf: SketchLeaf) {
    const ranges: [number, number, SketchClip][] = [];
    let mask: SketchClip | undefined;
    let from = 0;
    for (const c of kids) {
      if (mask && (c.shouldBreakMaskChain || c.hasClippingMask)) {
        ranges.push([from, leaf.items.length, mask]);
        mask = undefined;
      }
      const before = leaf.items.length;
      const r = this.prepare(c, m, a, scope, depth);
      if (r) {
        try {
          this.drawTree(r, scope, depth, leaf);
        } catch (e: any) {
          this.stats.errors.push(`${c._class}#${c.do_objectID}: ${e?.message || e}`);
        }
      }
      if (c.hasClippingMask) {
        mask = this.maskClip(c, m, scope, depth);
        if (mask) {
          if (c.clippingMaskMode === 1) {
            spliceLeaf(leaf, before);
            this.count('mask:alpha');
          }
          from = leaf.items.length;
        }
      }
    }
    mask && ranges.push([from, leaf.items.length, mask]);
    for (let i = ranges.length - 1; i >= 0; i--) this.clipLeaf(leaf, ranges[i][0], ranges[i][2], ranges[i][1]);
  }

  private drawTree(r: Prepared, scope: Scope | undefined, depth: number, leaf: SketchLeaf) {
    this.drawSelf(r, leaf);
    if (!CONTAINERS.has(r.node._class)) return;
    const start = leaf.items.length;
    const inner = this.contentMatrix(r);
    this.eachChild(r.node, scope, r.id, (kids, s) => this.collectChildren(kids, inner, r.a, s, depth + 1, leaf));
    const content = this.contentClip(r);
    content && this.clipLeaf(leaf, start, content);
  }

  private splits(node: Layer, level: number) {
    if (!CONTAINERS.has(node._class)) return false;
    if (this.opts.granularity === 'layer') return level === 0;
    return this.opts.granularity === 'node';
  }

  /** 子图层的坐标系：组件实例的 scale 缩放内容 */
  private contentMatrix({ node, m }: Prepared): VectorMatrix {
    const s = node._class === 'symbolInstance' ? node.scale ?? 1 : 1;
    return s > 0 && s !== 1 ? multiplyMatrix(m, scaleMatrix(s, s)) : m;
  }

  /**
   * 子图层：组件实例展开为母版的子图层（尺寸不同时重排，带覆盖作用域）；fn 收到整组兄弟图层（蒙版链在组内处理）
   */
  private eachChild(node: Layer, outer: Scope | undefined, id: string, fn: (kids: Layer[], scope: Scope | undefined) => void) {
    if (node._class === 'shapeGroup') return;
    if (node._class !== 'symbolInstance') {
      fn(node.layers || [], outer);
      return;
    }
    const master = this.masters.get(node.symbolID);
    if (!master) {
      this.count('missingSymbol');
      return;
    }
    if (this.symbolStack.includes(node.symbolID)) {
      this.stats.errors.push(`组件循环引用：${master.name ?? node.symbolID}`);
      return;
    }
    this.stats.instances++;
    const scope: Scope = { overrides: instanceOverrides(node, outer), path: id + '/' };
    const s = node.scale > 0 ? node.scale : 1;
    const w = (node.frame?.width ?? 0) / s;
    const h = (node.frame?.height ?? 0) / s;
    const before = master.layers || [];
    // 尺寸变化或覆盖改变了内容（文字、可见性）时，按约束 / 自动布局重排母版的子图层
    const kids = resizeLayers(master, w, h, this.layoutContext(scope.overrides));
    kids !== before && this.stats.resized++;
    this.symbolStack.push(node.symbolID);
    try {
      fn(kids, scope);
    } finally {
      this.symbolStack.pop();
    }
  }

  /** 布局重排用的上下文：覆盖查询、嵌套实例、文字宽度估算 */
  private layoutContext(overrides: Map<string, Map<string, any>>): LayoutContext {
    return {
      override: (lid) => overrides.get(lid),
      nested: (inst) => this.layoutContext(instanceOverrides(inst, { overrides, path: '' })),
      master: (sid) => this.masters.get(sid),
      textWidth: (text, layer) => {
        const fd = layer.attributedString?.attributes?.[0]?.attributes?.MSAttributedStringFontAttribute?.attributes;
        return estimateTextWidth(text, fd?.size > 0 ? fd.size : 12);
      },
    };
  }

  /** 应用实例覆盖，返回（必要时复制的）图层 */
  private overridden(raw: Layer, scope: Scope | undefined): Layer {
    const ov = scope?.overrides.get(raw.do_objectID);
    if (!ov?.size) return raw;
    const node: Layer = { ...raw };
    for (const [prop, value] of ov) {
      if (prop === 'stringValue') {
        if (node.attributedString && typeof value === 'string') {
          const first = node.attributedString.attributes?.[0];
          node.attributedString = {
            ...node.attributedString,
            string: value,
            attributes: first ? [{ ...first, location: 0, length: value.length }] : [],
          };
        }
      } else if (prop === 'symbolID') {
        if (node._class === 'symbolInstance') value ? (node.symbolID = value) : (node.isVisible = false);
      } else if (prop === 'isVisible') {
        node.isVisible = !!value && value !== '0';
      } else if (prop === 'image') {
        if (value?._ref) {
          if (node._class === 'bitmap') node.image = value;
          else if (node.style?.fills?.some((f: any) => f.fillType === 4)) {
            node.style = { ...node.style, fills: node.style.fills.map((f: any) => (f.fillType === 4 ? { ...f, image: value } : f)) };
          }
        }
      } else if (prop === 'layerStyle') {
        const st = this.layerStyles.get(value);
        st ? (node.style = st) : this.count('override:missingStyle');
      } else if (prop === 'textStyle') {
        const st = this.textStyles.get(value);
        if (st) {
          node.style = st;
          const enc = st.textStyle?.encodedAttributes;
          if (enc && node.attributedString) {
            const len = node.attributedString.string?.length ?? 0;
            node.attributedString = { ...node.attributedString, attributes: [{ _class: 'stringAttribute', location: 0, length: len, attributes: enc }] };
          }
        } else this.count('override:missingStyle');
      } else if (/^color:(fill|border)-\d+$/.test(prop)) {
        const [, kind, n] = prop.match(/^color:(fill|border)-(\d+)$/)!;
        const key = kind === 'fill' ? 'fills' : 'borders';
        const list = node.style?.[key];
        if (list?.[+n] && value) {
          const copy = [...list];
          copy[+n] = { ...copy[+n], color: value };
          node.style = { ...node.style, [key]: copy };
          // 文字的填充覆盖即文字颜色
          if (node._class === 'text' && kind === 'fill') node.textColorOverride = value;
        }
      } else if (prop === 'textColor' || prop === 'fillColor') {
        node.textColorOverride = value;
      } else {
        this.count(`override:${prop}`);
      }
    }
    return node;
  }

  // -------------------------------------------------------------------------
  // 裁剪
  // -------------------------------------------------------------------------

  /** 画板 / Frame / 组件（实例）裁剪内容到自身矩形 */
  private contentClip({ node, m }: Prepared): SketchClip | undefined {
    const box = node._class === 'symbolInstance' ? this.masters.get(node.symbolID) : node;
    if (!box || !clipsContent(box)) return undefined;
    const w = node.frame?.width ?? 0;
    const h = node.frame?.height ?? 0;
    if (!(w > 0 && h > 0)) return undefined;
    const radii = cornerRadii(box, w, h);
    const d = rectOutline(w, h, radii, m).d;
    const clip = makeClip([{ d, rule: 'nonzero' }]);
    if (axisAligned(m)) {
      clip.rect = true;
      const r = Math.max(...radii) * matrixScale(m);
      r > 0 && (clip.r = r);
    }
    return clip;
  }

  /** 蒙版图层的裁剪区域：形状的轮廓；组合取子图层轮廓的并集；位图、文字取框 */
  private maskClip(raw: Layer, parentM: VectorMatrix, scope: Scope | undefined, depth: number): SketchClip | undefined {
    const r = this.prepare(raw, parentM, 1, scope, depth);
    if (!r) return undefined;
    this.stats.nodes--;
    const shapes: Shape[] = [];
    this.maskShape(r, scope, depth, shapes);
    if (!shapes.length) return { d: [], box: { x: 0, y: 0, width: 0, height: 0 } };
    const clip = makeClip(shapes);
    if (shapes.length === 1 && shapes[0].rect !== undefined && axisAligned(r.m)) {
      clip.rect = true;
      shapes[0].rect > 0 && (clip.r = shapes[0].rect);
    }
    return clip;
  }

  private maskShape(r: Prepared, scope: Scope | undefined, depth: number, out: Shape[]) {
    const { node, m } = r;
    if (SHAPES.has(node._class) || node._class === 'shapeGroup') {
      const o = this.outline(node, m);
      if (o && o.d.length) {
        const rule = node.style?.windingRule === 1 ? 'evenodd' : 'nonzero';
        out.push({ d: o.d, rule, rect: o.simple?.kind === 'rect' ? o.simple.r * matrixScale(m) : undefined });
      }
      return;
    }
    if (CONTAINERS.has(node._class)) {
      const inner = this.contentMatrix(r);
      this.eachChild(node, scope, r.id, (kids, s) => {
        for (const c of kids) {
          const cr = this.prepare(c, inner, 1, s, depth + 1);
          if (cr) {
            this.stats.nodes--;
            this.maskShape(cr, s, depth + 1, out);
          }
        }
      });
      return;
    }
    const w = node.frame?.width ?? 0;
    const h = node.frame?.height ?? 0;
    if (w > 0 && h > 0) out.push({ d: new VectorPathBuilder(m).polyline([[0, 0], [w, 0], [w, h], [0, h]], true).d, rule: 'nonzero', rect: 0 });
  }

  private clipUnit(u: SketchUnit, clip: SketchClip) {
    if (u.kind === 'leaf') this.clipLeaf(u, 0, clip);
    else for (const c of u.children) this.clipUnit(c, clip);
  }

  /**
   * 裁剪 leaf 中 [from, to) 的项：完全在区域内的保留（仍可拆成原生图元），完全在区域外的丢弃，
   * 跨边界的（相邻的合并）包进一个 IR 裁剪项
   */
  private clipLeaf(leaf: SketchLeaf, from: number, clip: SketchClip, to = leaf.items.length) {
    const items: VectorItem[] = [];
    const grads: SketchLeaf['grads'] = [];
    const boxes: SketchLeaf['boxes'] = [];
    let changed = false;
    const keep = (i: number) => {
      items.push(leaf.items[i]);
      grads.push(leaf.grads[i]);
      boxes.push(leaf.boxes[i]);
    };
    let run: VectorItem[] = [];
    const flush = () => {
      if (!run.length) return;
      const item: VectorClipItem = { t: 'c', d: clip.d, items: run };
      clip.rule && (item.rule = clip.rule);
      items.push(item);
      grads.push(undefined);
      boxes.push(undefined);
      this.stats.clips++;
      run = [];
    };
    for (let i = 0; i < leaf.items.length; i++) {
      if (i < from || i >= to) {
        flush();
        keep(i);
        continue;
      }
      const tb = leaf.boxes[i];
      const box = tb ? transformBox(tb.m, { x: 0, y: 0, width: tb.w, height: tb.h }) : computeItemsBox([leaf.items[i]]);
      const rel = clipRelation(box, clip);
      if (rel === 'in') {
        flush();
        keep(i);
        continue;
      }
      changed = true;
      rel === 'cross' && run.push(leaf.items[i]);
    }
    flush();
    leaf.items = items;
    leaf.grads = grads;
    leaf.boxes = boxes;
    // 连线被裁剪后不能再用原生连线表示
    if (changed && leaf.edge) delete leaf.edge;
  }

  // -------------------------------------------------------------------------
  // 绘制
  // -------------------------------------------------------------------------

  /** 绘制图层自身（容器的背景 / 描边、形状、文字、位图） */
  private drawSelf({ node, m, a }: Prepared, leaf: SketchLeaf) {
    const n0 = leaf.items.length;
    const cls = node._class;
    this.blendMode = node.style?.contextSettings?.blendMode || 0;
    try {
      if (SHAPES.has(cls) || cls === 'shapeGroup') this.drawShape(node, m, a, leaf);
      else if (cls === 'text') this.drawText(node, m, a, leaf);
      else if (cls === 'bitmap') this.drawBitmap(node, m, a, leaf);
      else if (CONTAINERS.has(cls)) this.drawContainer(node, m, a, leaf);
      else if (cls !== 'page') this.count(`type:${cls}`);
    } catch (e: any) {
      this.stats.errors.push(`${cls} ${node.name ?? node.do_objectID}: ${e?.message || e}`);
    }
    this.blendMode = 0;
    if (this.edgeLeaf === leaf && leaf.edge && leaf.edge.span === undefined) leaf.edge.span = leaf.items.length;
    this.edgeLeaf = undefined;
    // 阴影只对单独成图元的图层有意义（合并的图元无法逐项设置）
    // 细线阴影（无偏移、几乎不模糊）已作为描边环画出（ringShadows），这里只取最明显的投影
    const shadows = this.styleOf(node)
      .shadows?.filter(enabled)
      .filter((sh: any) => !isRingShadow(sh)) || [];
    if (shadows.length) {
      if (n0 === 0 && leaf.items.length > 0 && !leaf.shadow) {
        const sh = shadows.reduce((best: any, x: any) => (shadowWeight(x) > shadowWeight(best) ? x : best));
        const k = matrixScale(m);
        const c = sh.color || {};
        leaf.shadow = {
          color: rgbaCss(c.red ?? 0, c.green ?? 0, c.blue ?? 0, (c.alpha ?? 1) * (sh.contextSettings?.opacity ?? 1) * a),
          x: (sh.offsetX ?? 0) * k,
          y: (sh.offsetY ?? 0) * k,
          blur: (sh.blurRadius ?? 0) * k,
        };
        shadows.length > 1 && this.count('shadow:multiple');
        sh.spread && this.count('shadow:spread');
      } else this.count(CONTAINERS.has(cls) ? 'shadow:group' : 'shadow:merged');
    }
  }

  /** 图层实际显示的样式：组件实例自身没有填充 / 描边 / 阴影时用母版的（勾选「在实例中显示背景」的 Frame 母版） */
  private styleOf(node: Layer): any {
    const st = node.style || {};
    if (node._class !== 'symbolInstance') return st;
    const master = this.masters.get(node.symbolID);
    if (!master || master.includeBackgroundColorInInstance !== true || isPreviewBackground(master)) return st;
    const ms = master.style || {};
    return { ...ms, shadows: (st.shadows || []).some(enabled) ? st.shadows : ms.shadows, contextSettings: st.contextSettings };
  }

  /**
   * 细线阴影 → 描边环：无偏移、模糊 ≤ 1.5 的阴影在 Sketch / macOS 设计稿中用作外轮廓细线（窗口、面板边缘），
   * 画成轮廓外侧的描边（宽 = spread + blur / 2）
   */
  private ringShadows(st: any, o: Outline, m: VectorMatrix, a: number, leaf: SketchLeaf) {
    if (!o.simple) return;
    for (const sh of (st.shadows || []).filter(enabled)) {
      if (!isRingShadow(sh)) continue;
      const w = (sh.spread || 0) + (sh.blurRadius || 0) / 2;
      if (!(w > 0.05)) continue;
      const c = sh.color || {};
      const color = rgbaCss(c.red ?? 0, c.green ?? 0, c.blue ?? 0, Math.min(1, (c.alpha ?? 1) * (sh.contextSettings?.opacity ?? 1) * a));
      const d = offsetSimple(o.simple, w / 2, m);
      d && this.push(leaf, pathItem(d, { stroke: color, lw: w * matrixScale(m) }));
    }
  }

  /** 画板背景（旧）/ Frame、组件母版的填充和描边（新） */
  private drawContainer(node: Layer, m: VectorMatrix, a: number, leaf: SketchLeaf) {
    let box: Layer = node;
    if (node._class === 'symbolInstance') {
      const master = this.masters.get(node.symbolID);
      // 母版的背景（旧 backgroundColor / 新版的填充、描边）只在勾选「在实例中显示背景」时出现在实例里；
      // 图形（groupBehavior 0）母版的单一不透明纯色填充是画布上的预览底色（如 UI Kit 的「Nested Symbol BG」），不出现在实例里
      if (!master || master.includeBackgroundColorInInstance !== true || isPreviewBackground(master)) return;
      box = master;
    } else if (!hasFrameStyle(node) && !(node.hasBackgroundColor && node.backgroundColor)) return;
    const w = node.frame?.width ?? 0;
    const h = node.frame?.height ?? 0;
    if (!(w > 0 && h > 0)) return;
    const o = rectOutline(w, h, cornerRadii(box, w, h), m);
    if (box.hasBackgroundColor && box.backgroundColor) {
      const c = box.backgroundColor;
      const color = rgbaCss(c.red, c.green, c.blue, (c.alpha ?? 1) * a);
      this.push(leaf, pathItem(o.d, { fill: color, stroke: 'none' }));
    }
    // 只有画板、Frame、组件母版有自身样式；普通编组的样式不显示
    if (hasFrameStyle(box) || box._class === 'symbolMaster') {
      const st = box.style || {};
      if ((st.fills || []).some(enabled) || (st.borders || []).some(enabled)) this.paint(node, st, o, m, a, leaf);
      this.ringShadows(this.styleOf(node), o, m, a, leaf);
    }
  }

  private drawShape(node: Layer, m: VectorMatrix, a: number, leaf: SketchLeaf) {
    const o = this.outline(node, m);
    if (!o || !o.d.length) return;
    const start = leaf.items.length;
    this.paint(node, node.style || {}, o, m, a, leaf);
    this.ringShadows(node.style || {}, o, m, a, leaf);
    // 布尔交集：填充、描边都裁剪到各个相交的形状内
    for (const d of o.clips || []) this.clipLeaf(leaf, start, { d, box: computeItemsBox([{ t: 'p', d }]) });
  }

  /** 填充（从下往上）→ 描边 → 端点箭头 */
  private paint(node: Layer, st: any, o: Outline, m: VectorMatrix, a: number, leaf: SketchLeaf) {
    const w = node.frame?.width ?? 0;
    const h = node.frame?.height ?? 0;
    const rule = st.windingRule === 1 ? 'evenodd' : undefined;
    const fills = (st.fills || []).filter(enabled);
    for (const f of fills) {
      const op = (f.contextSettings?.opacity ?? 1) * a;
      if (!(op > 0)) continue;
      const fb = f.contextSettings?.blendMode;
      fb && !APPROX_BLEND.has(fb) && this.count(`blend:${fb}`);
      if (f.fillType === 4) {
        this.imageFill(node, f, o, m, op, leaf);
        continue;
      }
      if (f.fillType === 5) {
        this.count('fill:noise');
        continue;
      }
      const paint = this.paintOf(f, w, h, m, op);
      if (!paint) continue;
      this.push(leaf, pathItem(o.d, { fill: paint.ir, stroke: 'none', rule }), paint.grad);
    }
    const borders = (st.borders || []).filter(enabled);
    if (!borders.length) return;
    const opt = st.borderOptions || {};
    const k = matrixScale(m);
    const native = leaf.items.length === 0 && !leaf.edge ? this.edgeOf(node, st, o, borders, fills, m, a) : undefined;
    for (const b of borders) {
      const lw = b.thickness ?? 1;
      if (!(lw > 0)) continue;
      const op = (b.contextSettings?.opacity ?? 1) * a;
      const paint = this.paintOf(b, w, h, m, op);
      if (!paint) continue;
      const style: VectorStyle = { stroke: paint.ir, lw: lw * k };
      const dash = (opt.dashPattern || []).filter((v: number) => Number.isFinite(v));
      if (dash.length && dash.some((v: number) => v > 0)) {
        const ds = dash.map((v: number) => Math.max(Math.abs(v) * k, 0.01));
        ds.length % 2 && ds.push(...ds);
        style.dash = ds;
      }
      opt.lineCapStyle === 1 ? (style.cap = 'round') : opt.lineCapStyle === 2 && (style.cap = 'square');
      opt.lineJoinStyle === 1 ? (style.join = 'round') : opt.lineJoinStyle === 2 && (style.join = 'bevel');
      const pos = o.closed ? b.position ?? 0 : 0;
      if (pos === 0) {
        this.push(leaf, pathItem(o.d, style), paint.grad);
      } else if (o.simple) {
        // 矩形、椭圆：内 / 外描边换成精确的偏移轮廓（仍是单路径，可绑定颜色和线宽）
        const off = (pos === 1 ? -lw : lw) / 2;
        const d = offsetSimple(o.simple, off, m);
        d && this.push(leaf, pathItem(d, style), paint.grad);
      } else {
        // 任意路径：两倍线宽描边并裁剪到轮廓内（内侧）或轮廓外（外侧）
        const wide = pathItem(o.d, { ...style, lw: lw * 2 * k });
        if (pos === 1) {
          this.push(leaf, { t: 'c', d: o.d, rule, items: [wide] } as VectorClipItem);
        } else {
          const bb = computeItemsBox([{ t: 'p', d: o.d }]);
          const e = lw * 2 * k + 1;
          const outer = new VectorPathBuilder().polyline(
            [[bb.x - e, bb.y - e], [bb.x + bb.width + e, bb.y - e], [bb.x + bb.width + e, bb.y + bb.height + e], [bb.x - e, bb.y + bb.height + e]],
            true,
          ).d;
          this.push(leaf, { t: 'c', d: [...outer, ...o.d], rule: 'evenodd', items: [wide] } as VectorClipItem);
        }
        this.stats.clips++;
      }
    }
    if (native) {
      leaf.edge = native;
      this.edgeLeaf = leaf;
    }
    // 开放路径的端点箭头（用最上层描边的颜色和线宽）
    if (o.ends && (st.startMarkerType || st.endMarkerType)) {
      const b = borders[borders.length - 1];
      const color = this.paintOf(b, w, h, m, (b.contextSettings?.opacity ?? 1) * a)?.color;
      if (color) {
        const lw = (b.thickness ?? 1) * k;
        const [s, e] = o.ends;
        st.startMarkerType && this.marker(leaf, st.startMarkerType, s.p, s.dir, lw, color);
        st.endMarkerType && this.marker(leaf, st.endMarkerType, e.p, e.dir, lw, color);
      }
    }
  }

  /** 端点标记：dir 为端点处指向路径外的单位向量 */
  private marker(leaf: SketchLeaf, type: number, p: [number, number], dir: [number, number], lw: number, color: string) {
    const [x, y] = p;
    const [ux, uy] = dir;
    const nx = -uy;
    const ny = ux;
    const at = (f: number, s: number): [number, number] => [x + ux * f + nx * s, y + uy * f + ny * s];
    const b = new VectorPathBuilder();
    switch (type) {
      case 1: {
        // 开放箭头：两条边，尖端在端点
        const L = lw * 3 + 3;
        b.polyline([at(-L, L * 0.75), [x, y], at(-L, -L * 0.75)]);
        this.push(leaf, pathItem(b.d, { stroke: color, lw, cap: 'round', join: 'round' }));
        return;
      }
      case 2: {
        const L = lw * 3 + 3;
        b.polyline([at(L * 0.3, 0), at(-L, L * 0.7), at(-L, -L * 0.7)], true);
        this.push(leaf, pathItem(b.d, { fill: color, stroke: 'none' }));
        return;
      }
      case 3: {
        const L = lw * 2 + 2;
        b.polyline([at(0, L), at(0, -L)]);
        this.push(leaf, pathItem(b.d, { stroke: color, lw }));
        return;
      }
      case 4:
      case 5: {
        const r = lw * 1.5 + 2;
        b.ellipse(x, y, r, r, 0, 0, Math.PI * 2).close();
        this.push(leaf, pathItem(b.d, type === 5 ? { fill: color, stroke: 'none' } : { fill: 'none', stroke: color, lw }));
        return;
      }
      case 6:
      case 7: {
        const r = lw * 1.5 + 2;
        b.polyline([at(-r, -r), at(r, -r), at(r, r), at(-r, r)], true);
        this.push(leaf, pathItem(b.d, type === 7 ? { fill: color, stroke: 'none' } : { fill: 'none', stroke: color, lw }));
        return;
      }
      default:
        this.count(`marker:${type}`);
    }
  }

  /** 不带填充、单色居中描边的直线 / 折线 → 原生连线描述（箭头可映射时） */
  private edgeOf(node: Layer, st: any, o: Outline, borders: any[], fills: any[], m: VectorMatrix, a: number): SketchEdge | undefined {
    if (!o.poly || o.poly.length < 2 || fills.length || borders.length !== 1) return undefined;
    const b = borders[0];
    if ((b.fillType ?? 0) !== 0 || !b.color) return undefined;
    const ARROW: Record<number, SketchEdge['from']> = {
      1: { type: 'line', filled: false, size: 0 },
      2: { type: 'triangle', filled: true, size: 0 },
      4: { type: 'circle', filled: false, size: 0 },
      5: { type: 'circle', filled: true, size: 0 },
    };
    const sm = st.startMarkerType || 0;
    const em = st.endMarkerType || 0;
    if ((sm && !ARROW[sm]) || (em && !ARROW[em])) return undefined;
    const k = matrixScale(m);
    const lw = (b.thickness ?? 1) * k;
    const c = b.color;
    const edge: SketchEdge = {
      points: o.poly.map(([x, y]) => ({ x, y })),
      color: rgbaCss(c.red, c.green, c.blue, (c.alpha ?? 1) * (b.contextSettings?.opacity ?? 1) * a),
      lineWidth: lw,
      native: true,
    };
    const dash = (st.borderOptions?.dashPattern || []).filter((v: number) => v > 0);
    dash.length && (edge.dash = dash.map((v: number) => v * k));
    const size = lw * 3 + 3;
    sm && (edge.from = { ...ARROW[sm], size });
    em && (edge.to = { ...ARROW[em], size });
    void node;
    return edge;
  }

  /** 纯色 / 渐变 → IR 颜色或渐变 + 旁路渐变（绑定图元渐变用）；color 为代表色 */
  private paintOf(f: any, w: number, h: number, m: VectorMatrix, op: number): { ir: string | VectorGradient; color: string; grad?: SketchGradient } | undefined {
    if (!(op > 0)) return undefined;
    if ((f.fillType ?? 0) === 0) {
      const c = f.color;
      if (!c) return undefined;
      const color = blendColor(c, op, f.contextSettings?.blendMode ?? this.blendMode);
      return color ? { ir: color, color } : undefined;
    }
    if (f.fillType !== 1 || !f.gradient) return undefined;
    const g = f.gradient;
    const stops = (g.stops || [])
      .filter((s: any) => s.color)
      .map((s: any) => ({ i: s.position ?? 0, c: [s.color.red ?? 0, s.color.green ?? 0, s.color.blue ?? 0, (s.color.alpha ?? 1) * op] as Rgba }))
      .sort((x: any, y: any) => x.i - y.i);
    if (!stops.length) return undefined;
    const avg = stops.reduce((acc: number[], s: any) => acc.map((v, i) => v + s.c[i] / stops.length), [0, 0, 0, 0]);
    const color = rgbaCss(avg[0], avg[1], avg[2], avg[3]);
    if (stops.length < 2 || !(w > 0 && h > 0)) return { ir: color, color };
    this.stats.gradients++;
    const [fx, fy] = parsePoint(g.from);
    const [tx, ty] = parsePoint(g.to);
    const irStops = stops.map((s: any) => ({ o: Math.max(0, Math.min(1, s.i)), c: rgbaCss(s.c[0], s.c[1], s.c[2], s.c[3]) }));
    // 渐变定义在图层的 0~1 比例空间中（随图层宽高拉伸）
    const nm = multiplyMatrix(m, scaleMatrix(w, h));
    const at = (x: number, y: number) => applyMatrix(nm, x, y) as [number, number];
    if ((g.gradientType ?? 0) === 0) {
      return { ir: { type: 'linear', x0: fx, y0: fy, x1: tx, y1: ty, m: nm, stops: irStops }, color, grad: { type: 'linear', p0: at(fx, fy), p1: at(tx, ty), stops } };
    }
    g.gradientType === 2 && this.count('gradient:angular');
    // 径向：比例空间中以 from 为圆心、|to - from| 为半径的圆，另一半轴按 elipseLength 缩放
    const r = Math.hypot(tx - fx, ty - fy);
    if (!(r > 0)) return { ir: color, color };
    const e = g.elipseLength > 0 ? g.elipseLength : 1;
    const ang = Math.atan2(ty - fy, tx - fx);
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    // 单位圆 → 比例空间的椭圆
    const em: VectorMatrix = multiplyMatrix(nm, [cos * r, sin * r, -sin * r * e, cos * r * e, fx, fy]);
    const ir: VectorGradient = { type: 'radial', x0: 0, y0: 0, r0: 0, x1: 0, y1: 0, r1: 1, m: em, stops: irStops };
    const grad: SketchGradient = { type: 'radial', p0: at(fx, fy), p1: at(tx, ty), p2: applyMatrix(em, 0, 1) as [number, number], stops };
    return { ir, color, grad };
  }

  /** 图片填充：按图层框放置；非矩形的形状裁剪到轮廓 */
  private imageFill(node: Layer, f: any, o: Outline, m: VectorMatrix, op: number, leaf: SketchLeaf) {
    const w = node.frame?.width ?? 0;
    const h = node.frame?.height ?? 0;
    if (!this.opts.images || !(w > 0 && h > 0) || this.skipped(f.image)) return;
    const src = this.imageSrc(f.image);
    if (!src) {
      this.count('missingImage');
      return;
    }
    this.stats.images++;
    const item: VectorImageItem = { t: 'i', src, m: multiplyMatrix(m, scaleMatrix(w, h)) };
    op < 0.999 && (item.alpha = op);
    const mode = f.patternFillType ?? 1;
    // 图片与图层框同比例时，铺满 / 适应都等同拉伸（可生成原生图片图元）
    const size = this.imageDims(f.image);
    const same = size && size.width > 0 && size.height > 0 && Math.abs(size.width / size.height / (w / h) - 1) < 0.01;
    if (mode === 0) this.count('image:tile');
    else if (mode === 1 && !same) item.fit = 'cover';
    else if (mode === 3 && !same) item.fit = 'contain';
    if (o.simple?.kind === 'rect') {
      o.simple.r > 0 && (item.radius = o.simple.r * matrixScale(m));
      this.push(leaf, item);
      return;
    }
    this.push(leaf, { t: 'c', d: o.d, rule: node.style?.windingRule === 1 ? 'evenodd' : undefined, items: [item] } as VectorClipItem);
    this.stats.clips++;
  }

  private drawBitmap(node: Layer, m: VectorMatrix, a: number, leaf: SketchLeaf) {
    const w = node.frame?.width ?? 0;
    const h = node.frame?.height ?? 0;
    if (!(w > 0 && h > 0)) return;
    const st = node.style || {};
    const radii = cornerRadii(node, w, h);
    const rect = (): Outline => rectOutline(w, h, radii, m);
    if (node.fillReplacesImage && (st.fills || []).some(enabled)) {
      this.paint(node, st, rect(), m, a, leaf);
      return;
    }
    if (!this.opts.images || this.skipped(node.image)) return;
    const src = this.imageSrc(node.image);
    if (!src) {
      this.count('missingImage');
      return;
    }
    this.stats.images++;
    const crop = parseRect(node.clippingMask);
    let im = multiplyMatrix(m, scaleMatrix(w, h));
    const cropped = crop && crop.w > 0 && crop.h > 0 && (Math.abs(crop.x) > 1e-6 || Math.abs(crop.y) > 1e-6 || Math.abs(crop.w - 1) > 1e-6 || Math.abs(crop.h - 1) > 1e-6);
    if (cropped) im = multiplyMatrix(im, multiplyMatrix(scaleMatrix(1 / crop.w, 1 / crop.h), translateMatrix(-crop.x, -crop.y)));
    const item: VectorImageItem = { t: 'i', src, m: im };
    a < 0.999 && (item.alpha = a);
    const uniform = radii.every((r) => Math.abs(r - radii[0]) < 1e-6);
    if (!cropped && radii[0] > 0 && uniform) item.radius = radii[0] * matrixScale(m);
    if (cropped || (!uniform && radii.some((r) => r > 0))) {
      this.push(leaf, { t: 'c', d: rect().d, items: [item] } as VectorClipItem);
      this.stats.clips++;
    } else this.push(leaf, item);
    // 位图上的描边
    if ((st.borders || []).some(enabled)) this.paint(node, { ...st, fills: [] }, rect(), m, a, leaf);
    (st.fills || []).some(enabled) && this.count('bitmap:fill');
  }

  /** 不导入的图片（skipImages） */
  private skipped(ref: any) {
    return !!ref?._ref && !!this.opts.skipImages?.includes(ref._ref);
  }

  private imageBytes(ref: any): Uint8Array | undefined {
    const key: string = ref?._ref || '';
    return key ? this.archive.images.get(key) ?? this.archive.images.get(`${key}.png`) : undefined;
  }

  /** 图片像素尺寸（读文件头），读不出时 undefined */
  private imageDims(ref: any) {
    const b = this.imageBytes(ref);
    return b ? imageSize(b) : undefined;
  }

  /** 图片地址：调用方提供的 URL 优先，否则内嵌为 data URL */
  private imageSrc(ref: any): string | undefined {
    if (!ref) return undefined;
    const key: string = ref._ref || '';
    const url = key && this.opts.imageUrls?.[key];
    if (url) return url;
    if (ref._class === 'MSJSONOriginalDataReference' && ref.data?._data) return `data:image/png;base64,${ref.data._data}`;
    let src = this.dataUrls.get(key);
    if (src === undefined) {
      const bytes = this.imageBytes(ref);
      src = bytes ? bytesToDataURL(bytes) : '';
      this.dataUrls.set(key, src);
    }
    return src || undefined;
  }

  // -------------------------------------------------------------------------
  // 几何
  // -------------------------------------------------------------------------

  /** 形状 / 布尔组合的轮廓（画布坐标） */
  private outline(node: Layer, m: VectorMatrix): Outline | undefined {
    if (node._class !== 'shapeGroup') return shapeOutline(node, m);
    // 布尔运算从下往上依次作用：并、减直接合成路径；交集换成裁剪（(A ∩ B) − C = (A − C) ∩ B）
    const parts: { d: number[]; op: number }[] = [];
    const clips: number[][] = [];
    let approx = false;
    (node.layers || []).forEach((c: Layer) => {
      if (c.isVisible === false) return;
      const cm = multiplyMatrix(m, localMatrix(c));
      const o = this.outline(c, cm);
      if (!o?.d.length) return;
      const op = parts.length === 0 && !clips.length ? -1 : c.booleanOperation ?? -1;
      if (op === 2 && parts.length) {
        clips.push(o.d, ...(o.clips || []));
        return;
      }
      // 交集之后再并入的形状、带交集的子组合（非第一个）无法用裁剪精确表示
      if (clips.length && op !== 1) approx = true;
      if (o.clips?.length) {
        parts.length && (approx = true);
        clips.push(...o.clips);
      }
      parts.push({ d: o.d, op });
    });
    approx && this.count('boolean:intersect');
    if (!parts.length) return undefined;
    const withClips = (o: Outline): Outline => (clips.length ? { ...o, clips } : o);
    if (parts.length === 1) return withClips({ d: parts[0].d, closed: true });
    const subtract = parts.some((p, i) => i > 0 && p.op === 1);
    const xor = parts.some((p, i) => i > 0 && p.op === 3);
    xor && this.count('boolean:difference');
    let d: number[] = [];
    for (const p of parts) {
      let pd = p.d;
      // 减去：子形状取与已有形状相反的方向，nonzero 下得到洞
      if (subtract) pd = orient(pd, p.op === 1 ? -1 : 1);
      d = d.concat(pd);
    }
    return withClips({ d, closed: true });
  }

  // -------------------------------------------------------------------------
  // 文字
  // -------------------------------------------------------------------------

  private drawText(node: Layer, m: VectorMatrix, a: number, leaf: SketchLeaf) {
    this.stats.texts++;
    const as = node.attributedString;
    let str: string = as?.string ?? '';
    if (!as?.string && node.attributedString?.archivedAttributedString) {
      this.count('text:archived');
      str = node.name || '';
    }
    if (!str.trim()) return;
    const w = node.frame?.width ?? 0;
    const h = node.frame?.height ?? 0;
    const runs = textRuns(node, str, this.families);
    if (!runs.length) return;
    const st = node.style || {};
    // 文字图层的填充覆盖文字颜色（最上层的可用填充）
    const fills = (st.fills || []).filter(enabled);
    const topFill = node.textColorOverride ? undefined : [...fills].reverse().find((f: any) => (f.fillType ?? 0) === 0 || (f.fillType === 1 && f.gradient));
    // 渐变填充：按文字图层框（frame 比例坐标）计算，IR 中文字用代表色，原生文字图元绑定渐变
    let textGrad: SketchGradient | undefined;
    let gradColor: string | undefined;
    if (topFill?.fillType === 1) {
      const paint = this.paintOf(topFill, w, h, m, (topFill.contextSettings?.opacity ?? 1) * a);
      textGrad = paint?.grad;
      gradColor = paint?.color;
    }
    const fillOverride = node.textColorOverride ?? (topFill && (topFill.fillType ?? 0) === 0 ? topFill.color : undefined);
    (st.borders || []).some(enabled) && this.count('text:border');
    const wrap = isFixedWidth(node);
    const vAlign = st.textStyle?.verticalAlignment ?? runs[0].attrs.textStyleVerticalAlignmentKey ?? 0;
    const valign: SketchTextBox['valign'] = vAlign === 1 ? 'middle' : vAlign === 2 ? 'bottom' : 'top';
    // 按段落拆分；同一段落内多种样式时取主样式
    const paras: { text: string; style: TextRunStyle }[] = [];
    let pos = 0;
    let mixed = false;
    for (const line of str.split(/\r\n|\n|\r|\u2028|\u2029/)) {
      const end = pos + line.length;
      const inPara = runs.filter((r) => r.end > pos && r.start < Math.max(end, pos + 1));
      const keys = new Set(inPara.filter((r) => str.slice(Math.max(r.start, pos), Math.min(r.end, end)).trim()).map((r) => r.key));
      keys.size > 1 && (mixed = true);
      let best = inPara[0] || runs[runs.length - 1];
      let bestLen = -1;
      for (const r of inPara) {
        const len = str.slice(Math.max(r.start, pos), Math.min(r.end, end)).trim().length;
        len > bestLen && ((best = r), (bestLen = len));
      }
      paras.push({ text: applyTransform(line, best.style.transform), style: best.style });
      pos = end + (str[end] === '\r' && str[end + 1] === '\n' ? 2 : 1);
    }
    mixed && this.count('text:mixedStyle');
    runs.some((r) => r.style.underline || r.style.strike) && this.count('text:decoration');
    const uniform = new Set(paras.map((p) => p.style.key)).size === 1;
    const lineCount = (p: { text: string; style: TextRunStyle }) => (wrap && w > 0 ? Math.max(1, wrapTextLines(p.text, p.style.size, w).length) : 1);
    const lineH = (s: TextRunStyle, lines: number) => {
      if (s.lineHeight > 0) return s.lineHeight;
      // 单行、不换行的文字框高度就是行高
      if (paras.length === 1 && lines === 1 && h > 0 && !wrap) return h;
      return s.size * defaultLineHeight(s.font);
    };
    const emit = (text: string, s: TextRunStyle, y: number, boxH: number, lh: number, va: SketchTextBox['valign']) => {
      if (!text.trim()) return;
      const color = gradColor ?? blendColor(fillOverride ?? s.color, a, this.blendMode) ?? colorCss(fillOverride ?? s.color, a);
      const item: VectorTextItem = { t: 't', text: text.replace(/\s+$/, ''), x: s.align === 'center' ? w / 2 : s.align === 'right' ? w : 0, y: 0, h: s.size, a: s.align, lh: lh / s.size, fill: color };
      // 每行字形在行高内垂直居中（同 meta2d 原生文字、CSS），整块以 'middle' 锚定在块中心
      wrap && w > 0 && (item.bw = w);
      const n = Math.max(1, wrapTextLines(item.text, s.size, item.bw).length);
      item.b = 'middle';
      item.y = va === 'middle' ? y + boxH / 2 : va === 'bottom' ? y + boxH - (n * lh) / 2 : y + (n * lh) / 2;
      item.font = s.font;
      s.weight >= 600 && (item.bold = true);
      s.italic && (item.italic = true);
      const box: SketchTextBox = { m: multiplyMatrix(m, translateMatrix(0, y)), w: Math.max(w, 1), h: Math.max(boxH, 1), align: s.align, valign: va, lh: lh / s.size, wrap, weight: s.weight };
      s.kerning && (box.spacing = s.kerning);
      this.push(leaf, transformItem(item, m), textGrad, box);
    };
    if (uniform) {
      const s = paras[0].style;
      const text = paras.map((p) => p.text).join('\n');
      const lines = paras.reduce((n, p) => n + lineCount(p), 0);
      emit(text, s, 0, h, lineH(s, lines), valign);
      return;
    }
    // 各段落样式不同：逐段从上往下排布（每段一个文字框），整体按垂直对齐偏移
    const blocks: { p: (typeof paras)[number]; y: number; h: number; lh: number }[] = [];
    let y = 0;
    for (const p of paras) {
      const lines = lineCount(p);
      const lh = lineH(p.style, lines);
      blocks.push({ p, y, h: lines * lh, lh });
      y += lines * lh + (p.style.paragraphSpacing || 0);
    }
    const total = y - (paras[paras.length - 1].style.paragraphSpacing || 0);
    const dy = valign === 'middle' ? (h - total) / 2 : valign === 'bottom' ? h - total : 0;
    for (const b of blocks) emit(b.p.text, b.p.style, b.y + dy, b.h, b.lh, 'top');
  }

  // -------------------------------------------------------------------------

  private pageBorder(p: SketchPageInfo): SketchLeaf {
    const b = new VectorPathBuilder().polyline(
      [
        [p.x, p.y],
        [p.x + p.width, p.y],
        [p.x + p.width, p.y + p.height],
        [p.x, p.y + p.height],
      ],
      true,
    );
    const leaf: SketchLeaf = { kind: 'leaf', info: { page: this.page, name: p.name, part: 'page' }, items: [], grads: [], boxes: [] };
    this.push(leaf, pathItem(b.d, { stroke: '#9aa4b2', dash: [6, 4] }));
    return leaf;
  }
}

// ---------------------------------------------------------------------------
// 变换、几何
// ---------------------------------------------------------------------------

/**
 * 实例的覆盖：母版内图层 id 路径（`a/b`）→ 属性 → 值。
 * 外层实例对本实例内部的覆盖（路径以本实例 id 开头）优先于本实例自身的 overrideValues
 */
function instanceOverrides(node: Layer, outer: Scope | undefined): Map<string, Map<string, any>> {
  const overrides = new Map<string, Map<string, any>>();
  const put = (path: string, prop: string, value: any, keep: boolean) => {
    let o = overrides.get(path);
    if (!o) overrides.set(path, (o = new Map()));
    if (keep && o.has(prop)) return;
    o.set(prop, value);
  };
  if (outer) {
    const prefix = node.do_objectID + '/';
    for (const [p, o] of outer.overrides) if (p.startsWith(prefix)) for (const [k, v] of o) put(p.slice(prefix.length), k, v, false);
  }
  for (const ov of node.overrideValues || []) {
    const name: string = ov.overrideName || '';
    const i = name.indexOf('_');
    if (i > 0) put(name.slice(0, i), name.slice(i + 1), ov.value, true);
  }
  return overrides;
}

/** 图层局部坐标（frame 内，原点在左上）→ 父图层坐标 */
export function localMatrix(l: Layer): VectorMatrix {
  const f = l.frame;
  if (!f) return IDENTITY;
  const w = f.width || 0;
  const h = f.height || 0;
  const rot = l.rotation || 0;
  const fx = l.isFlippedHorizontal ? -1 : 1;
  const fy = l.isFlippedVertical ? -1 : 1;
  if (!rot && fx === 1 && fy === 1) return [1, 0, 0, 1, f.x || 0, f.y || 0];
  // Sketch 的 rotation 为逆时针角度（Y 向下的屏幕上），翻转在图层自身坐标中、先于旋转
  const t = (-rot * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const R: VectorMatrix = [c * fx, s * fx, -s * fy, c * fy, 0, 0];
  const [ox, oy] = applyMatrix(R, -w / 2, -h / 2);
  return [R[0], R[1], R[2], R[3], (f.x || 0) + w / 2 + ox, (f.y || 0) + h / 2 + oy];
}

interface Pt {
  p: [number, number];
  from: [number, number];
  to: [number, number];
  hasFrom: boolean;
  hasTo: boolean;
  r: number;
  k: number;
}

/** 形状图层的 points → 轮廓 */
function shapeOutline(node: Layer, m: VectorMatrix): Outline | undefined {
  const w = node.frame?.width ?? 0;
  const h = node.frame?.height ?? 0;
  const raw: any[] = node.points || [];
  if (raw.length < 2) return undefined;
  const sc = (v: [number, number]): [number, number] => [v[0] * w, v[1] * h];
  const fixedR = node._class === 'rectangle' && node.hasConvertedToNewRoundCorners === false ? node.fixedRadius || 0 : 0;
  // 新版的圆角在 style.corners（矩形四个点依次为左上、右上、右下、左下）
  const styleR = node._class === 'rectangle' && node.style?.corners ? cornerRadii(node, w, h) : undefined;
  const P: Pt[] = raw.map((q, idx) => {
    const p = sc(parsePoint(q.point));
    const from = sc(parsePoint(q.curveFrom ?? q.point));
    const to = sc(parsePoint(q.curveTo ?? q.point));
    const near = (u: [number, number]) => Math.abs(u[0] - p[0]) < 1e-6 && Math.abs(u[1] - p[1]) < 1e-6;
    return {
      p,
      from,
      to,
      hasFrom: q.hasCurveFrom ?? !near(from),
      hasTo: q.hasCurveTo ?? !near(to),
      r: Math.max(0, q.cornerRadius || fixedR),
      k: idx,
    };
  });
  const closed = node.isClosed !== false;
  const n = P.length;
  if (styleR && n === 4) P.forEach((q, i) => !(q.r > 0) && styleR[i] > 0 && (q.r = styleR[i]));
  const b = new VectorPathBuilder(m);
  // 直角点的圆角：切点、控制点
  const corner = (k: number) => {
    const q = P[k];
    if (!(q.r > 0) || q.hasFrom || q.hasTo) return undefined;
    if (!closed && (k === 0 || k === n - 1)) return undefined;
    const prev = P[(k - 1 + n) % n];
    const next = P[(k + 1) % n];
    if (prev.hasFrom || next.hasTo) return undefined;
    const v1 = [prev.p[0] - q.p[0], prev.p[1] - q.p[1]];
    const v2 = [next.p[0] - q.p[0], next.p[1] - q.p[1]];
    const l1 = Math.hypot(v1[0], v1[1]);
    const l2 = Math.hypot(v2[0], v2[1]);
    if (!(l1 > 0 && l2 > 0)) return undefined;
    const u1 = [v1[0] / l1, v1[1] / l1];
    const u2 = [v2[0] / l2, v2[1] / l2];
    const theta = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (!(theta > 1e-3 && theta < Math.PI - 1e-3)) return undefined;
    const tanHalf = Math.tan(theta / 2);
    let d = q.r / tanHalf;
    d = Math.min(d, l1 / 2, l2 / 2);
    const r = d * tanHalf;
    const handle = (4 / 3) * Math.tan((Math.PI - theta) / 4) * r;
    const tin: [number, number] = [q.p[0] + u1[0] * d, q.p[1] + u1[1] * d];
    const tout: [number, number] = [q.p[0] + u2[0] * d, q.p[1] + u2[1] * d];
    return { tin, tout, c1: [tin[0] - u1[0] * handle, tin[1] - u1[1] * handle] as [number, number], c2: [tout[0] - u2[0] * handle, tout[1] - u2[1] * handle] as [number, number] };
  };
  const R = P.map((_, k) => corner(k));
  const start = R[0] ? R[0].tout : P[0].p;
  b.moveTo(start[0], start[1]);
  const segs = closed ? n : n - 1;
  let straight = true;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    if (P[i].hasFrom || P[j].hasTo) {
      straight = false;
      b.cubicTo(P[i].from[0], P[i].from[1], P[j].to[0], P[j].to[1], P[j].p[0], P[j].p[1]);
      continue;
    }
    const e = R[j];
    if (e) {
      straight = false;
      b.lineTo(e.tin[0], e.tin[1]);
      b.cubicTo(e.c1[0], e.c1[1], e.c2[0], e.c2[1], e.tout[0], e.tout[1]);
    } else b.lineTo(P[j].p[0], P[j].p[1]);
  }
  closed && b.close();
  const o: Outline = { d: b.d, closed };
  // 简单形状：未编辑过的矩形（四角同半径）、椭圆
  if (node._class === 'rectangle' && node.edited !== true && n === 4 && P.every((q) => !q.hasFrom && !q.hasTo)) {
    const rs = P.map((q) => q.r);
    if (rs.every((r) => Math.abs(r - rs[0]) < 1e-6)) o.simple = { kind: 'rect', w, h, r: Math.min(rs[0], w / 2, h / 2) };
  } else if (node._class === 'oval' && node.edited !== true) {
    o.simple = { kind: 'oval', w, h };
  }
  if (!closed) {
    const T = (v: [number, number]) => applyMatrix(m, v[0], v[1]) as [number, number];
    const dirOf = (p: [number, number], toward: [number, number]): [number, number] => {
      const a = T(p);
      const t = T(toward);
      const l = Math.hypot(a[0] - t[0], a[1] - t[1]);
      return l > 0 ? [(a[0] - t[0]) / l, (a[1] - t[1]) / l] : [1, 0];
    };
    const first = P[0];
    const last = P[n - 1];
    const s1 = first.hasFrom ? first.from : P[1].hasTo ? P[1].to : P[1].p;
    const e1 = last.hasTo ? last.to : P[n - 2].hasFrom ? P[n - 2].from : P[n - 2].p;
    o.ends = [
      { p: T(first.p), dir: dirOf(first.p, s1) },
      { p: T(last.p), dir: dirOf(last.p, e1) },
    ];
    straight && (o.poly = P.map((q) => T(q.p)));
  }
  return o;
}

/** 矩形 / 椭圆的偏移轮廓（off > 0 向外） */
function offsetSimple(s: NonNullable<Outline['simple']>, off: number, m: VectorMatrix): number[] | undefined {
  const b = new VectorPathBuilder(m);
  if (s.kind === 'oval') {
    const rx = s.w / 2 + off;
    const ry = s.h / 2 + off;
    if (!(rx > 0 && ry > 0)) return undefined;
    return b.ellipse(s.w / 2, s.h / 2, rx, ry, 0, 0, Math.PI * 2).close().d;
  }
  const x0 = -off;
  const y0 = -off;
  const x1 = s.w + off;
  const y1 = s.h + off;
  if (!(x1 > x0 && y1 > y0)) return undefined;
  const r = Math.max(0, Math.min(s.r + off, (x1 - x0) / 2, (y1 - y0) / 2));
  if (!(s.r > 0) || !(r > 0)) return b.polyline([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true).d;
  const H = Math.PI / 2;
  b.moveTo(x0 + r, y0).lineTo(x1 - r, y0);
  b.ellipse(x1 - r, y0 + r, r, r, 0, -H, 0, false, true);
  b.lineTo(x1, y1 - r);
  b.ellipse(x1 - r, y1 - r, r, r, 0, 0, H, false, true);
  b.lineTo(x0 + r, y1);
  b.ellipse(x0 + r, y1 - r, r, r, 0, H, Math.PI, false, true);
  b.lineTo(x0, y0 + r);
  b.ellipse(x0 + r, y0 + r, r, r, 0, Math.PI, Math.PI + H, false, true);
  return b.close().d;
}

const OP_SIZE = [3, 3, 7, 5, 1, 9];

/** 路径整体方向：sign > 0 使总有向面积为正（Y 向下的屏幕上顺时针），sign < 0 为负 */
function orient(d: number[], sign: number): number[] {
  const area = signedArea(d);
  return area * sign < 0 ? reversePath(d) : d;
}

function signedArea(d: number[]): number {
  let a = 0;
  let sx = 0;
  let sy = 0;
  let px = 0;
  let py = 0;
  for (let i = 0; i < d.length; ) {
    const op = d[i];
    if (op === 0) {
      a += px * sy - sx * py;
      sx = px = d[i + 1];
      sy = py = d[i + 2];
    } else if (op === 4) {
      a += px * sy - sx * py;
      px = sx;
      py = sy;
    } else if (op !== 5) {
      const n = OP_SIZE[op];
      const x = d[i + n - 2];
      const y = d[i + n - 1];
      a += px * y - x * py;
      px = x;
      py = y;
    }
    i += OP_SIZE[op] || 1;
  }
  a += px * sy - sx * py;
  return a / 2;
}

/** 反转路径方向（只含 move / line / cubic / quad / close） */
function reversePath(d: number[]): number[] {
  type Seg = { op: number; pts: number[] };
  const subs: { start: [number, number]; segs: Seg[]; closed: boolean }[] = [];
  let cur: (typeof subs)[number] | undefined;
  let px = 0;
  let py = 0;
  for (let i = 0; i < d.length; ) {
    const op = d[i];
    if (op === 5) return d; // 椭圆弧不反转
    if (op === 0) {
      cur = { start: [d[i + 1], d[i + 2]], segs: [], closed: false };
      subs.push(cur);
      px = d[i + 1];
      py = d[i + 2];
    } else if (op === 4) {
      cur && (cur.closed = true);
      cur && ((px = cur.start[0]), (py = cur.start[1]));
    } else if (cur) {
      const n = OP_SIZE[op];
      cur.segs.push({ op, pts: [px, py, ...d.slice(i + 1, i + n)] });
      px = d[i + n - 2];
      py = d[i + n - 1];
    }
    i += OP_SIZE[op] || 1;
  }
  const out: number[] = [];
  for (const s of subs) {
    const last = s.segs[s.segs.length - 1];
    const end = last ? [last.pts[last.pts.length - 2], last.pts[last.pts.length - 1]] : s.start;
    out.push(0, end[0], end[1]);
    for (let k = s.segs.length - 1; k >= 0; k--) {
      const g = s.segs[k];
      const p = g.pts;
      if (g.op === 1) out.push(1, p[0], p[1]);
      else if (g.op === 2) out.push(2, p[4], p[5], p[2], p[3], p[0], p[1]);
      else if (g.op === 3) out.push(3, p[2], p[3], p[0], p[1]);
    }
    s.closed && out.push(4);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文字样式
// ---------------------------------------------------------------------------

interface TextRunStyle {
  key: string;
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  color: any;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  paragraphSpacing: number;
  kerning: number;
  transform: number;
  underline: boolean;
  strike: boolean;
}

function textRuns(node: Layer, str: string, families: Map<string, string>): { start: number; end: number; key: string; style: TextRunStyle; attrs: any }[] {
  const list: any[] = node.attributedString?.attributes || [];
  const base = node.style?.textStyle?.encodedAttributes || {};
  const runs = (list.length ? list : [{ location: 0, length: str.length, attributes: base }]).map((r) => {
    const attrs = r.attributes || base;
    const style = runStyle(attrs, families);
    return { start: r.location ?? 0, end: (r.location ?? 0) + (r.length ?? str.length), key: style.key, style, attrs };
  });
  return runs.sort((x, y) => x.start - y.start);
}

function runStyle(attrs: any, families: Map<string, string>): TextRunStyle {
  const fd = attrs.MSAttributedStringFontAttribute?.attributes || {};
  const ps = attrs.paragraphStyle || {};
  const name: string = fd.name || 'Helvetica';
  const size = fd.size > 0 ? fd.size : 12;
  const { family, weight, italic } = fontInfo(name, families.get(name));
  const al = ps.alignment ?? 0;
  const align = al === 1 ? 'right' : al === 2 ? 'center' : 'left';
  const color = attrs.MSAttributedStringColorAttribute || attrs.NSColor || { red: 0, green: 0, blue: 0, alpha: 1 };
  const lineHeight = ps.maximumLineHeight > 0 ? ps.maximumLineHeight : ps.minimumLineHeight > 0 ? ps.minimumLineHeight : 0;
  const style: TextRunStyle = {
    key: '',
    font: family,
    size,
    weight,
    italic,
    color,
    align,
    lineHeight,
    paragraphSpacing: ps.paragraphSpacing || 0,
    kerning: attrs.kerning || 0,
    transform: attrs.MSAttributedStringTextTransformAttribute || 0,
    underline: !!attrs.underlineStyle,
    strike: !!attrs.strikethroughStyle,
  };
  style.key = JSON.stringify([name, size, colorCss(color, 1), align, lineHeight, style.kerning, style.transform]);
  return style;
}

/** 定宽（自动换行）的文字框 */
function isFixedWidth(node: Layer) {
  if (node.textBehaviour !== undefined) return node.textBehaviour === 1 || node.textBehaviour === 2;
  if (node.horizontalSizing !== undefined) return node.horizontalSizing !== 1;
  return false;
}

/** Sketch 的缺省行高（字体自身的行距）近似 */
function defaultLineHeight(font: string) {
  return /PingFang|Hiragino|Heiti|Songti|Kaiti|STHeiti|STSong|YaHei|SimSun|SimHei|Noto Sans (CJK|SC|TC|JP)|Source Han|思源|苹方|微软雅黑/i.test(font) ? 1.4 : 1.2;
}

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/, 100],
  [/extralight|ultralight/, 200],
  [/semibold|demibold/, 600],
  [/extrabold|ultrabold/, 800],
  [/black|heavy/, 900],
  [/bold/, 700],
  [/medium/, 500],
  [/light/, 300],
];

/** 字体样式名（PostScript 名的后缀，如 Semibold、BoldItalic）→ CSS 字重 */
export function fontWeight(style: string | undefined): number {
  const s = (style || '').toLowerCase().replace(/[\s_-]/g, '');
  for (const [re, w] of WEIGHTS) if (re.test(s)) return w;
  return 400;
}

/** 常见字体 PostScript 名前缀 → CSS 字体族 */
const FAMILIES: [RegExp, string][] = [
  [/^\.?SF(Pro|UI|Compact|NS)/i, '"SF Pro", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif'],
  [/^PingFang(SC|TC|HK)?/i, '"PingFang SC", "Microsoft YaHei", sans-serif'],
  [/^HelveticaNeue/i, '"Helvetica Neue", Helvetica, Arial, sans-serif'],
  [/^Helvetica/i, 'Helvetica, Arial, sans-serif'],
  [/^ArialMT|^Arial/i, 'Arial, sans-serif'],
  [/^Roboto/i, 'Roboto, sans-serif'],
  [/^SourceHanSans|^NotoSansCJK/i, '"Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", sans-serif'],
];

/**
 * PostScript 字体名 → CSS 字体族列表、字重、斜体。
 * known 为文件记录的字体族名（document.fontReferences），排在最前（readSketchFonts 注册的内嵌字体用这个名字）
 */
export function fontInfo(ps: string, known?: string): { family: string; weight: number; italic: boolean } {
  const i = ps.lastIndexOf('-');
  const base = i > 0 ? ps.slice(0, i) : ps;
  const style = i > 0 ? ps.slice(i + 1) : '';
  const italic = /italic|oblique/i.test(style);
  let weight = fontWeight(style);
  if (!style && /bold/i.test(base)) weight = 700;
  const lead = known ? `"${known.replace(/"/g, '')}", ` : '';
  for (const [re, fam] of FAMILIES) if (re.test(base)) return { family: lead && !fam.startsWith(lead) ? lead + fam : fam, weight, italic };
  if (lead) return { family: `${lead}sans-serif`, weight, italic };
  // 驼峰拆词：PlayfairDisplay → Playfair Display；同时保留原名
  const spaced = base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/MT$/, '').trim();
  const fam = spaced !== base ? `"${spaced}", "${base}", sans-serif` : `"${base}", sans-serif`;
  return { family: fam, weight, italic };
}

function applyTransform(s: string, t: number) {
  return t === 1 ? s.toUpperCase() : t === 2 ? s.toLowerCase() : s;
}

function colorCss(c: any, a: number) {
  return rgbaCss(c?.red ?? 0, c?.green ?? 0, c?.blue ?? 0, (c?.alpha ?? 1) * a);
}

// ---------------------------------------------------------------------------
// 类型判断、裁剪工具
// ---------------------------------------------------------------------------

/**
 * 图层自身的填充 / 描边是否显示：旧画板（背景色另算）、新格式的 Frame（groupBehavior 1）；
 * 普通编组（group 0）、图形（组件母版 groupBehavior 0）的样式只是预览，不显示
 */
function hasFrameStyle(l: Layer) {
  if (l._class === 'symbolMaster' || l._class === 'group') return l.groupBehavior === 1;
  return l._class === 'artboard' || l._class === 'symbolInstance';
}

/**
 * 四角圆角半径（左上、右上、右下、左下），已按尺寸限制。
 * 新版在 style.corners.radii（1 个值表示四角相同）；旧版矩形在 points[i].cornerRadius / fixedRadius
 */
function cornerRadii(l: Layer, w: number, h: number): [number, number, number, number] {
  const c = l.style?.corners;
  let r: number[] = [0, 0, 0, 0];
  if (c && Array.isArray(c.radii) && c.radii.length) r = c.radii.length >= 4 ? c.radii.slice(0, 4) : [0, 1, 2, 3].map(() => c.radii[0]);
  else if (l._class === 'rectangle' && l.points?.length === 4) r = l.points.map((p: any) => p.cornerRadius || l.fixedRadius || 0);
  const lim = Math.min(w, h) / 2;
  return r.map((v) => Math.max(0, Math.min(+v || 0, lim))) as [number, number, number, number];
}

/** (0, 0, w, h) 的（圆角）矩形轮廓 */
function rectOutline(w: number, h: number, radii: number[], m: VectorMatrix): Outline {
  const b = new VectorPathBuilder(m);
  const [tl, tr, br, bl] = radii;
  const uniform = radii.every((r) => Math.abs(r - tl) < 1e-6);
  if (!radii.some((r) => r > 0)) return { d: b.polyline([[0, 0], [w, 0], [w, h], [0, h]], true).d, closed: true, simple: { kind: 'rect', w, h, r: 0 } };
  const H = Math.PI / 2;
  b.moveTo(tl, 0).lineTo(w - tr, 0);
  tr > 0 && b.ellipse(w - tr, tr, tr, tr, 0, -H, 0, false, true);
  b.lineTo(w, h - br);
  br > 0 && b.ellipse(w - br, h - br, br, br, 0, 0, H, false, true);
  b.lineTo(bl, h);
  bl > 0 && b.ellipse(bl, h - bl, bl, bl, 0, H, Math.PI, false, true);
  b.lineTo(0, tl);
  tl > 0 && b.ellipse(tl, tl, tl, tl, 0, Math.PI, Math.PI + H, false, true);
  b.close();
  const o: Outline = { d: b.d, closed: true };
  uniform && (o.simple = { kind: 'rect', w, h, r: tl });
  return o;
}

/**
 * 图形母版（groupBehavior 0）的预览底色：只有一个不透明纯色填充、没有描边 / 阴影 / 圆角。
 * Sketch 的「图形」母版没有画板外观，这种填充只在编辑母版时作为底色显示（UI Kit 中的浅蓝 / 白色底板）
 */
function isPreviewBackground(m: Layer) {
  if (m.groupBehavior === 1 || m._class !== 'symbolMaster') return false;
  const st = m.style || {};
  const fills = (st.fills || []).filter(enabled);
  if (fills.length !== 1 || (fills[0].fillType ?? 0) !== 0 || (fills[0].contextSettings?.blendMode || 0) !== 0) return false;
  if ((fills[0].color?.alpha ?? 1) < 0.999 || (fills[0].contextSettings?.opacity ?? 1) < 0.999) return false;
  if ((st.borders || []).some(enabled) || (st.shadows || []).some(enabled)) return false;
  return !(st.corners?.radii || []).some((r: number) => r > 0);
}

/** 无偏移、几乎不模糊的阴影（用作轮廓细线） */
function isRingShadow(sh: any) {
  return Math.abs(sh.offsetX || 0) < 0.01 && Math.abs(sh.offsetY || 0) < 0.01 && (sh.blurRadius || 0) <= 1.5 && (sh.spread || 0) >= 0;
}

/** 投影的明显程度（选主投影用） */
function shadowWeight(sh: any) {
  return (sh.color?.alpha ?? 1) * (1 + (sh.blurRadius || 0) + Math.hypot(sh.offsetX || 0, sh.offsetY || 0));
}

/** 近似处理的混合模式（换算成普通叠加的颜色），不计入 unsupported */
const APPROX_BLEND = new Set([1, 2, 4, 5, 7, 8, 9, 16, 17]);

/**
 * 混合模式的近似：Canvas 按图元逐个绘制，无法与下层真实混合，按「与中灰背景混合后的效果」换算成普通颜色：
 * - 变亮类（Lighten / Screen / Plus Lighter）：只会提亮 → 白色，不透明度 = 颜色亮度 × alpha；
 * - 变暗类（Darken / Multiply / Plus Darker）：只会压暗 → 黑色，不透明度 = (1 - 亮度) × alpha；
 * - 叠加类（Overlay / Soft Light / Hard Light）：亮于中灰提亮、暗于中灰压暗；
 * 其余模式按普通颜色绘制
 */
function blendColor(c: any, op: number, mode: number): string | undefined {
  const r = c.red ?? 0;
  const g = c.green ?? 0;
  const b = c.blue ?? 0;
  const a = (c.alpha ?? 1) * op;
  if (!(a > 0)) return undefined;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  switch (mode) {
    case 4:
    case 5:
    case 17: {
      const k = lum * a;
      return k > 0.002 ? rgbaCss(1, 1, 1, Math.min(1, k)) : undefined;
    }
    case 1:
    case 2:
    case 16: {
      const k = (1 - lum) * a;
      return k > 0.002 ? rgbaCss(0, 0, 0, Math.min(1, k)) : undefined;
    }
    case 7:
    case 8:
    case 9: {
      // 叠加 / 柔光 / 强光：中灰不改变下层，偏亮提亮、偏暗压暗
      const k = Math.abs(lum - 0.5) * a * (mode === 8 ? 0.5 : 1);
      return k > 0.002 ? rgbaCss(lum > 0.5 ? 1 : 0, lum > 0.5 ? 1 : 0, lum > 0.5 ? 1 : 0, Math.min(1, k)) : undefined;
    }
    default:
      return rgbaCss(r, g, b, a);
  }
}

/** 画板：旧格式 artboard / 新格式的 Frame（groupBehavior 1）/ 组件母版 */
function isArtboard(l: Layer) {
  return l._class === 'artboard' || l._class === 'symbolMaster' || (l._class === 'group' && l.groupBehavior === 1);
}

/**
 * 是否裁剪内容：旧格式画板、组件母版总是裁剪；
 * 新格式 Frame 的 clippingBehavior：0 缺省（裁剪），1 不裁剪，2 裁剪
 */
function clipsContent(l: Layer) {
  if (l._class === 'artboard') return true;
  if (l._class === 'symbolMaster') return l.clippingBehavior === undefined ? true : l.clippingBehavior !== 1;
  if (l._class === 'group' && l.groupBehavior === 1) return l.clippingBehavior !== 1;
  return false;
}

function hasContent(leaf: SketchLeaf) {
  return leaf.items.length > 0 || !!leaf.edge;
}

function spliceLeaf(leaf: SketchLeaf, from: number) {
  leaf.items.splice(from);
  leaf.grads.splice(from);
  leaf.boxes.splice(from);
}

function makeClip(paths: Shape[]): SketchClip {
  const d = paths.length === 1 ? paths[0].d : paths.flatMap((p) => p.d);
  const clip: SketchClip = { d, box: computeItemsBox([{ t: 'p', d }]) };
  paths.every((p) => p.rule === 'evenodd') && (clip.rule = 'evenodd');
  return clip;
}

/** 无旋转（或旋转 90° 的倍数）、无斜切 */
function axisAligned(m: VectorMatrix) {
  const e = 1e-9;
  return (Math.abs(m[1]) < e && Math.abs(m[2]) < e) || (Math.abs(m[0]) < e && Math.abs(m[3]) < e);
}

/** 内容框与裁剪区域的关系：in 完全在内（不用裁剪），out 完全在外，cross 跨边界 */
function clipRelation(b: VectorBox, clip: SketchClip): 'in' | 'out' | 'cross' {
  if (!clip.d.length) return 'out';
  const c = clip.box;
  const e = 0.5;
  const bx1 = b.x + b.width;
  const by1 = b.y + b.height;
  const cx1 = c.x + c.width;
  const cy1 = c.y + c.height;
  if (b.x >= cx1 - 1e-6 || bx1 <= c.x + 1e-6 || b.y >= cy1 - 1e-6 || by1 <= c.y + 1e-6) {
    if (!(b.width === 0 || b.height === 0) || b.x > cx1 || bx1 < c.x || b.y > cy1 || by1 < c.y) return 'out';
  }
  if (!clip.rect || b.x < c.x - e || b.y < c.y - e || bx1 > cx1 + e || by1 > cy1 + e) return 'cross';
  const r = clip.r || 0;
  if (r > 0) {
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
function prune(units: SketchUnit[]): SketchUnit[] {
  return units.filter((u) => {
    if (u.kind === 'leaf') return hasContent(u);
    u.children = prune(u.children);
    return u.children.length > 0;
  });
}

function forEachLeaf(units: SketchUnit[], fn: (leaf: SketchLeaf) => void) {
  for (const u of units) u.kind === 'leaf' ? fn(u) : forEachLeaf(u.children, fn);
}

function unitsBox(units: SketchUnit[]): VectorBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (b: VectorBox) => {
    if (!(b.width > 0 || b.height > 0) || !Number.isFinite(b.x)) return;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  };
  forEachLeaf(units, (leaf) => {
    leaf.items.length && add(computeItemsBox(leaf.items));
    leaf.boxes.forEach((tb) => tb && add(transformBox(tb.m, { x: 0, y: 0, width: tb.w, height: tb.h })));
  });
  return x1 >= x0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 0, height: 0 };
}

/** 页面定位：只含平移 + 等比缩放，旁路数据按同一矩阵换算 */
function transformUnit(u: SketchUnit, m: VectorMatrix, k: number) {
  if (u.kind === 'group') {
    for (const c of u.children) transformUnit(c, m, k);
    return;
  }
  const pt = (p: [number, number]) => applyMatrix(m, p[0], p[1]) as [number, number];
  u.items = u.items.map((it) => transformItem(it, m, k));
  u.grads = u.grads.map((g) => g && { ...g, p0: pt(g.p0), p1: pt(g.p1), p2: g.p2 && pt(g.p2) });
  u.boxes = u.boxes.map((b) => b && { ...b, m: multiplyMatrix(m, b.m) });
  if (u.edge) {
    u.edge.points = u.edge.points.map((p) => {
      const [x, y] = applyMatrix(m, p.x, p.y);
      return { x, y };
    });
    u.edge.lineWidth *= k;
    u.edge.dash = u.edge.dash?.map((v) => v * k);
    u.edge.from && (u.edge.from = { ...u.edge.from, size: u.edge.from.size * k });
    u.edge.to && (u.edge.to = { ...u.edge.to, size: u.edge.to.size * k });
  }
  if (u.shadow) {
    u.shadow.x *= k;
    u.shadow.y *= k;
    u.shadow.blur *= k;
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 图元树 → 纯 Vector IR */
export function treeToItems(units: SketchUnit[]): VectorItem[] {
  const out: VectorItem[] = [];
  forEachLeaf(units, (leaf) => out.push(...leaf.items));
  return out;
}

