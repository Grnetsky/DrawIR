import type { VectorDocument } from '@drawir/core';
import type { Meta2dPensDocument } from './util';

export interface DrawioParseOptions {
  /** 只转换这些页（从 0 开始），缺省全部 */
  pages?: number[];
  /** 多页横向排布时的页间距（像素），缺省 40 */
  pageGap?: number;
  /** draw.io 像素 → 画布像素的缩放，缺省 1 */
  scale?: number;
  /** 图纸左上角在画布上的位置，缺省 (0, 0) */
  origin?: { x: number; y: number };
  /** 为每页绘制内容范围边框，缺省 false */
  pageBorder?: boolean;
  /**
   * draw.io 的 `default` 颜色（缺省描边、文字、填充）：
   * - `'theme'`（缺省）：跟随 meta2d 主题（描边 / 文字为前景色，填充为背景色）；
   * - `'light'`：按 draw.io 浅色主题固定为黑色描边 / 文字、白色填充，并给每页铺上页面背景（缺省白色），
   *   在深色画布上也与 draw.io 中显示一致。
   */
  colors?: 'theme' | 'light';
  /**
   * 图元粒度：
   * - `'node'`（缺省）：每个单元格（形状、连线）一个图元；容器、分组、泳道按 `group` 生成组合；
   * - `'layer'`：每个 draw.io 图层合并为一个图元；
   * - `'page'`：每页一个图元。
   */
  granularity?: 'node' | 'layer' | 'page';
  /** `'node'` 粒度下容器 / 分组 / 带标签的连线生成组合，缺省 true */
  group?: boolean;
  /**
   * 生成可编辑的图元，缺省 true：标签为图元文字（双击可改），单独的文字为原生文字图元；
   * 形状的填充 / 描边 / 线宽 / 渐变绑定到图元属性；纯图片为原生图片图元。
   * false 时每个单元格是只读外观的矢量图元（文字画在矢量里）
   */
  editable?: boolean;
  /** 是否导入图片，缺省 true */
  images?: boolean;
  /** 图片地址替换：图片 key（见 readDrawioImages）→ URL，如内嵌图片上传后的地址 */
  imageUrls?: Record<string, string>;
  /** 不导入这些图片（key，见 readDrawioImages） */
  skipImages?: string[];
  /** draw.io 内置图库的相对地址（如 `img/lib/...`）的前缀，缺省 `https://app.diagrams.net/` */
  imageBase?: string;
}

export interface DrawioParseStats {
  pages: number;
  cells: number;
  vertices: number;
  edges: number;
  images: number;
  gradients: number;
  /** 生成的图元数 */
  pens: number;
  /** 未支持（近似或跳过）的特性及数量，如 shape:mxgraph.aws4.xxx、edgeStyle:xxx */
  unsupported: Record<string, number>;
  errors: string[];
  ms: number;
}

export interface DrawioPageInfo {
  name: string;
  id?: string;
  /** 页面内容在画布中的位置和尺寸 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 页面背景色 */
  background?: string;
}

/** 图元上的 draw.io 源信息（pen.drawio）。draw.io 特有的内容都收在这里，不作为 core 图元的顶层属性 */
export interface DrawioPenInfo {
  /** 所在页序号（与 DrawioParseOptions.pages 一致） */
  page: number;
  /** 单元格 id */
  id?: string;
  type?: 'vertex' | 'edge' | 'layer' | 'page';
  /** 形状名（style 的 shape） */
  shape?: string;
  /** 从单元格拆出的部分：'label' 单独的标签文字，'image' 图片，'page' 页面背景 / 边框 */
  part?: 'label' | 'image' | 'page';
  /** UserObject / object 上的自定义属性（不含 label、id） */
  attrs?: Record<string, string>;
  /** 链接（UserObject 的 link） */
  link?: string;
  tooltip?: string;
}

export interface DrawioDocument extends Meta2dPensDocument {
  stats: DrawioParseStats;
  pageList: DrawioPageInfo[];
  /** 首个有背景色的页面的背景色 */
  background?: string;
}

/** 纯 Vector IR 结果（parseDrawioVector），可交给 core 的 vectorDocumentToPens 或任意 DrawIR 渲染后端 */
export interface DrawioVectorDocument extends VectorDocument {
  stats: DrawioParseStats;
  pageList: DrawioPageInfo[];
}
