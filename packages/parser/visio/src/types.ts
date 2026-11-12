import type { VectorDocument } from '@drawir/core';

export interface VisioParseOptions {
  /** Visio 内部单位是英寸，默认每英寸 96 个输出单位。 */
  dpi?: number;
  pages?: number[];
  pageGap?: number;
  pageBorder?: boolean;
}

export interface VisioParseStats {
  pages: number;
  shapes: number;
  lines: number;
  /** 位图不属于纯矢量 IR，此字段记录跳过的位图数量。 */
  images: number;
  masters: number;
  unsupported: Record<string, number>;
  errors: string[];
  ms: number;
}

export interface VisioPageInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisioDocument extends VectorDocument {
  stats: VisioParseStats;
  pageList: VisioPageInfo[];
  background?: string;
}
