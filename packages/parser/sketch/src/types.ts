import type { VectorDocument } from '@drawir/core';
import type { Meta2dPensDocument } from './util';

export interface SketchParseOptions {
  /** 只转换这些页（从 0 开始，顺序同 readSketchPages），缺省全部 */
  pages?: number[];
  /** 多页横向排布时的页间距（像素），缺省 80 */
  pageGap?: number;
  /** Sketch 点（pt，即 1x 像素）→ 画布像素的缩放，缺省 1 */
  scale?: number;
  /** 图纸左上角在画布上的位置，缺省 (0, 0) */
  origin?: { x: number; y: number };
  /** 为每页绘制内容范围边框，缺省 false */
  pageBorder?: boolean;
  /**
   * 图元粒度：
   * - `'node'`（缺省）：每个 Sketch 图层一个图元；Group / Frame / 画板 / 组件实例按 `group` 生成组合，保留层级；
   * - `'layer'`：页面顶层（或顶层画板的直接子图层）各合并为一个图元，图元少、适合只看不改的大图；
   * - `'page'`：每页一个图元。
   */
  granularity?: 'node' | 'layer' | 'page';
  /** `'node'` 粒度下 Group / Frame / 组件实例生成组合（整体选中、移动），缺省 true。页面顶层的画板不组合 */
  group?: boolean;
  /**
   * 生成可编辑的图元，缺省 true：文字为原生文字图元；图片为原生图片图元；不带箭头或箭头可映射的直线 / 折线为原生连线；
   * 路径的填充 / 描边 / 线宽 / 渐变绑定到图元属性。false 时全部为只读外观的矢量图元
   */
  editable?: boolean;
  /** 是否导入图片（位图图层、图片填充），缺省 true */
  images?: boolean;
  /**
   * 图片地址：图片引用（见 readSketchImages，如 `images/<sha1>.png`）→ URL。没有对应地址的图片内嵌为 data URL。
   * 可先用 readSketchImages 取出图片上传，再把返回的地址传进来，避免图纸 JSON 过大
   */
  imageUrls?: Record<string, string>;
  /** 不导入这些图片（图片引用，见 readSketchImages），用到它们的位图图层、图片填充直接跳过 */
  skipImages?: string[];
  /**
   * 不导入这些图层（图层 do_objectID，见 readSketchLayers / SketchPenInfo.id），连同子图层跳过。
   * 组件实例内的图层用实例路径（如 `<实例id>/<母版内图层id>`）
   */
  skipNodes?: string[];
}

export interface SketchParseStats {
  /** 文件格式版本（meta.json 的 version） */
  version: number;
  /** 保存文件的 Sketch 版本（meta.json 的 appVersion） */
  appVersion?: string;
  pages: number;
  nodes: number;
  /** 展开的组件实例数 */
  instances: number;
  /** 尺寸与母版不同、按约束 / 自动布局重排过内容的实例数 */
  resized: number;
  texts: number;
  images: number;
  gradients: number;
  /** 生成的 IR 裁剪项数（蒙版、画板 / Frame 内容裁剪、内外描边中跨边界的内容） */
  clips: number;
  /** 生成的图元数 */
  pens: number;
  /** 未支持（近似或跳过）的特性及数量，如 blur:0（高斯模糊）、innerShadow、boolean:intersect */
  unsupported: Record<string, number>;
  errors: string[];
  ms: number;
}

export interface SketchPageInfo {
  name: string;
  /** 页面内容在画布中的位置和尺寸 */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 图元上的 Sketch 源信息（pen.sketch）。Sketch 特有的内容都收在这里，不作为 core 图元的顶层属性 */
export interface SketchPenInfo {
  /** 所在页序号（与 SketchParseOptions.pages 一致） */
  page: number;
  /** 图层 do_objectID，组件实例内的图层为实例路径 */
  id?: string;
  /** 图层类型（_class）：group / artboard / symbolInstance / rectangle / shapePath / text / bitmap … */
  type?: string;
  /** 图层名 */
  name?: string;
  /** 从图层拆出的部分：'fill' 容器自身的背景 / 描边，'image' 图片，'page' 页面边框 */
  part?: 'fill' | 'image' | 'page';
}

export interface SketchDocument extends Meta2dPensDocument {
  stats: SketchParseStats;
  pageList: SketchPageInfo[];
  /** 画布背景色 */
  background?: string;
}

/** 纯 Vector IR 结果（parseSketchVector），可交给 core 的 vectorDocumentToPens 或任意 DrawIR 渲染后端 */
export interface SketchVectorDocument extends VectorDocument {
  stats: SketchParseStats;
  pageList: SketchPageInfo[];
}
