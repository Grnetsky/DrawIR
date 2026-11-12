import type { VectorDocument } from '@drawir/core';

export interface DxfParseOptions {
  /** CAD 单位到输出单位的缩放；设置后忽略 fitWidth/fitHeight。 */
  scale?: number;
  fitWidth?: number;
  fitHeight?: number;
  origin?: { x: number; y: number };
  /** entity 保留实体边界用于计算范围；layer 先按图层合并。最终结果都是扁平矢量指令。 */
  granularity?: 'entity' | 'layer';
  hatch?: boolean;
  text?: boolean;
  layers?: string[];
  encoding?: string;
  contrastColor?: boolean;
  minLineWidth?: number;
  backdrop?: 'back' | 'keep' | 'remove';
  space?: 'auto' | 'model' | 'paper';
}

export interface DxfParseStats {
  entities: Record<string, number>;
  unsupported: Record<string, number>;
  blocks: number;
  errors: string[];
  scale: number;
  extents: { minX: number; minY: number; maxX: number; maxY: number };
  outliers?: number;
  backdrops?: number;
  space?: 'model' | 'paper';
  ms: number;
}

export interface DxfEntityInfo {
  type?: string;
  layer?: string;
  handle?: string;
  block?: string;
  backdrop?: boolean;
}

export interface DxfDocument extends VectorDocument {
  stats: DxfParseStats;
  layers: Record<string, { color?: string; visible: boolean }>;
}
