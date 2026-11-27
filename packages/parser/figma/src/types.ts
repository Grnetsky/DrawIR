import type { VectorDocument } from '@drawir/core';
import type { Meta2dPensDocument } from './util';

export interface FigmaParseOptions {
  /** 只转换这些页（从 0 开始，不含内部页），缺省全部 */
  pages?: number[];
  /** 多页横向排布时的页间距（像素），缺省 80 */
  pageGap?: number;
  /** Figma 像素 → 画布像素的缩放，缺省 1 */
  scale?: number;
  /** 图纸左上角在画布上的位置，缺省 (0, 0) */
  origin?: { x: number; y: number };
  /** 为每页绘制内容范围边框，缺省 false */
  pageBorder?: boolean;
  /**
   * 文字输出方式：
   * - `'text'`（缺省）：文字（editable 时为原生文字图元，可改内容、字号、颜色），字体由浏览器提供；
   * - `'path'`：使用文件中缓存的字形轮廓画成填充路径，与 Figma 显示完全一致，但不能再编辑。
   */
  text?: 'text' | 'path';
  /**
   * 图元粒度：
   * - `'node'`（缺省）：每个 Figma 图层一个图元；Frame / Group / 组件实例按 `group` 生成组合，保留层级；
   * - `'layer'`：页面顶层（或顶层画板的直接子图层）各合并为一个图元，图元少、适合只看不改的大图；
   * - `'page'`：每页一个图元。
   */
  granularity?: 'node' | 'layer' | 'page';
  /** `'node'` 粒度下 Frame / Group / 组件实例生成组合（整体选中、移动），缺省 true。页面顶层的画板不组合 */
  group?: boolean;
  /**
   * 生成可编辑的图元，缺省 true：文字为原生文字图元；单路径图层的填充 / 描边 / 线宽 / 渐变绑定到图元属性。
   * false 时全部为只读外观的矢量图元（图片仍为图片图元）
   */
  editable?: boolean;
  /** 是否导入图片填充，缺省 true（图片为原生图片图元） */
  images?: boolean;
  /**
   * 图片地址：图片 SHA-1（见 readFigImages）→ URL。没有对应地址的图片内嵌为 data URL。
   * 可先用 readFigImages 取出图片上传，再把返回的地址传进来，避免图纸 JSON 过大
   */
  imageUrls?: Record<string, string>;
  /** 不导入这些图片（SHA-1，见 readFigImages），用到它们的图片填充直接跳过 */
  skipImages?: string[];
  /**
   * 不导入这些图层（节点 id，见 readFigLayers / FigmaPenInfo.id），连同子图层跳过。
   * 组件实例内的图层用实例路径（如 `1:2/3:4`）
   */
  skipNodes?: string[];
  /**
   * 页面顶层的画板（Frame / Section）也生成组合，缺省 false。
   * 缺省不组合是为了方便直接选中画板内的图元；原型蓝图等需要知道「图元属于哪个画板」时开启（单个子图元也组合）
   */
  groupArtboards?: boolean;
}

export interface FigmaParseStats {
  /** .fig 文件格式版本号 */
  version: number;
  pages: number;
  nodes: number;
  instances: number;
  texts: number;
  images: number;
  gradients: number;
  /** 生成的 IR 裁剪项数（蒙版、Frame 内容裁剪中跨边界的内容） */
  clips: number;
  /** 生成的图元数 */
  pens: number;
  /** 未支持（近似或跳过）的特性及数量，如 mask:alpha（按轮廓近似的透明度蒙版）、effect:LAYER_BLUR */
  unsupported: Record<string, number>;
  errors: string[];
  ms: number;
}

export interface FigmaPageInfo {
  name: string;
  /** 页面内容在画布中的位置和尺寸 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 页面背景色 */
  background?: string;
}

/** 图元上的 Figma 源信息（pen.figma）。Figma 特有的内容都收在这里，不作为 core 图元的顶层属性 */
export interface FigmaPenInfo {
  /** 所在页序号（与 FigmaParseOptions.pages 一致） */
  page: number;
  /** 节点 guid（sessionID:localID），组件实例内的节点为实例路径 */
  id?: string;
  /** 节点类型：FRAME / GROUP / INSTANCE / TEXT / VECTOR / RECTANGLE … */
  type?: string;
  /** 图层名 */
  name?: string;
  /** 组件实例（INSTANCE）引用的组件（SYMBOL）节点 id，已按实例替换（overriddenSymbolID）解析 */
  componentId?: string;
  /** 从图层拆出的部分：'fill' 容器自身的背景 / 描边，'image' 图片填充，'page' 页面边框 */
  part?: 'fill' | 'image' | 'page';
}

export interface FigmaDocument extends Meta2dPensDocument {
  stats: FigmaParseStats;
  pageList: FigmaPageInfo[];
  /** 首个有背景色的页面的背景色 */
  background?: string;
}

/** 纯 Vector IR 结果（parseFigmaVector），可交给 core 的 vectorDocumentToPens 或任意 DrawIR 渲染后端 */
export interface FigmaVectorDocument extends VectorDocument {
  stats: FigmaParseStats;
  pageList: FigmaPageInfo[];
}
