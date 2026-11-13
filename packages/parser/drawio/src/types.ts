import type { VectorDocument } from '@drawir/core';

export interface DrawioParseOptions {
  /** 只转换这些页（从 0 开始的索引），缺省全部 */
  pages?: number[];
  /** 多页横向排布时的页间距（输出单位），缺省 40 */
  pageGap?: number;
  /** draw.io 像素 → 输出单位的缩放，缺省 1 */
  scale?: number;
  /** 为每页绘制内容范围边框，缺省 false */
  pageBorder?: boolean;
}

export interface DrawioParseStats {
  pages: number;
  cells: number;
  vertices: number;
  edges: number;
  /** 位图不属于纯矢量 IR，此字段记录跳过的图片数量。 */
  images: number;
  unsupported: Record<string, number>;
  errors: string[];
  ms: number;
}

export interface DrawioPageInfo {
  name: string;
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawioDocument extends VectorDocument {
  stats: DrawioParseStats;
  pageList: DrawioPageInfo[];
  background?: string;
}
