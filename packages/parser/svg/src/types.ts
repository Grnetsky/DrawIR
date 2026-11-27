import type { VectorDocument } from '@drawir/core';
import type { Meta2dPensDocument } from './util';

export interface SvgParseOptions {
  /** SVG 用户单位（CSS 像素）→ 画布像素的缩放，缺省 1 */
  scale?: number;
  /** 图纸左上角在画布上的位置，缺省 (0, 0) */
  origin?: { x: number; y: number };
  /**
   * 页面范围：
   * - `'viewport'`（缺省）：SVG 视口（width / height / viewBox），图元相对视口的位置与源文件一致；
   * - `'content'`：内容的实际范围（去掉四周空白）。
   * 根元素既没有尺寸也没有 viewBox 时总是按内容范围
   */
  page?: 'viewport' | 'content';
  /** 绘制页面（视口）边框，缺省 false */
  pageBorder?: boolean;
  /**
   * 图元粒度：
   * - `'node'`（缺省）：每个图形元素一个图元；`<g>` / `<svg>` / `<use>` / `<a>` 生成组合，保留层级；
   * - `'layer'`：根元素的每个直接子元素合并为一个图元；
   * - `'page'`：整张 SVG 一个图元。
   */
  granularity?: 'node' | 'layer' | 'page';
  /** `'node'` 粒度下分组生成组合（整体选中、移动），缺省 true */
  group?: boolean;
  /**
   * 生成可编辑的图元，缺省 true：文字为原生文字图元，图片为原生图片图元；
   * 单色描边 / 填充 / 线宽 / 渐变绑定到图元属性（属性面板可改）。false 时全部为只读外观的矢量图元
   */
  editable?: boolean;
  /** 是否导入 `<image>`，缺省 true */
  images?: boolean;
  /**
   * 图片地址替换：图片键（见 readSvgImages，内嵌图片为 data URL 的哈希，外链图片为原地址）→ URL。
   * 可先用 readSvgImages 取出内嵌图片上传，再把返回的地址传进来，避免图纸 JSON 过大
   */
  imageUrls?: Record<string, string>;
  /** 不导入这些图片（键见 readSvgImages） */
  skipImages?: string[];
  /**
   * `currentColor`（且没有设置 color）的取值，缺省 `'$fg'`：跟随 meta2d 图元颜色 / 主题前景色。
   * 图标库（Feather、Lucide…）的 SVG 通常用 currentColor 着色
   */
  currentColor?: string;
}

export interface SvgParseStats {
  /** 遍历的元素数 */
  nodes: number;
  shapes: number;
  texts: number;
  images: number;
  gradients: number;
  /** 展开的 <use> 数 */
  uses: number;
  /** 生成的 IR 裁剪项数（clip-path、mask 中跨边界的内容） */
  clips: number;
  markers: number;
  /** 生成的图元数 */
  pens: number;
  /** 未支持（近似或跳过）的特性及数量，如 filter:feGaussianBlur、mask（按轮廓近似）、pattern（描边 / 文字的图案取主色） */
  unsupported: Record<string, number>;
  errors: string[];
  ms: number;
}

export interface SvgPageInfo {
  name: string;
  /** 页面在画布中的位置和尺寸 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 根元素的背景色（style="background: …"） */
  background?: string;
}

/** 图元上的 SVG 源信息（pen.svg）。SVG 特有的内容都收在这里，不作为 core 图元的顶层属性 */
export interface SvgPenInfo {
  /** 元素 id */
  id?: string;
  /** 元素标签：path / rect / g / text … */
  tag?: string;
  /** 图层名（inkscape:label / data-name / <title> / id） */
  name?: string;
  /** class 属性 */
  class?: string;
  /** 从元素拆出的部分：'label' 文字，'image' 图片，'page' 页面边框 */
  part?: 'label' | 'image' | 'page';
}

export interface SvgDocument extends Meta2dPensDocument {
  stats: SvgParseStats;
  pageList: SvgPageInfo[];
  /** 根元素的背景色 */
  background?: string;
}

/** 纯 Vector IR 结果（parseSvgVector），可交给 core 的 vectorDocumentToPens 或任意 DrawIR 渲染后端 */
export interface SvgVectorDocument extends VectorDocument {
  stats: SvgParseStats;
  pageList: SvgPageInfo[];
}
