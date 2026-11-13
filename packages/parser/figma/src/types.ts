import type { VectorDocument } from '@drawir/core';

export interface FigmaParseOptions {
  /** 只转换这些页（从 0 开始，不含内部页），缺省全部 */
  pages?: number[];
  /** 多页横向排布时的页间距（输出单位），缺省 80 */
  pageGap?: number;
  /** Figma 像素 → 输出单位的缩放，缺省 1 */
  scale?: number;
  /** 为每页绘制内容范围边框，缺省 false */
  pageBorder?: boolean;
  /**
   * 文字输出方式：
   * - `'text'`（缺省）：文字项，按 Figma 排版结果逐行/逐样式段定位，字体由渲染端提供；
   * - `'path'`：使用文件中缓存的字形轮廓，输出为填充路径，与 Figma 显示完全一致，但不可再编辑/检索。
   */
  text?: 'text' | 'path';
}

export interface FigmaParseStats {
  /** .fig 文件格式版本号 */
  version: number;
  pages: number;
  nodes: number;
  instances: number;
  texts: number;
  /** 图片填充不属于纯矢量 IR，此字段记录跳过的图片填充数量。 */
  images: number;
  unsupported: Record<string, number>;
  errors: string[];
  ms: number;
}

export interface FigmaPageInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 页面背景色 */
  background?: string;
}

export interface FigmaDocument extends VectorDocument {
  stats: FigmaParseStats;
  pageList: FigmaPageInfo[];
  background?: string;
}
