/**
 * DrawIR 入口（只此文件为 DrawIR 独有）。src 下其余文件与 ../../../meta2d-drawio/src 逐字同步（仅 @meta2d/drawir → @drawir/core），
 * 同一套解析逻辑：meta2d-drawio 输出 meta2d 图元（v1 / v2 适配层），这里输出 DrawIR 的 VectorDocument。
 */
export type { DrawioParseOptions, DrawioParseStats, DrawioPageInfo, DrawioVectorDocument, DrawioVectorDocument as DrawioDocument } from './types';
export type { DrawioUnit, DrawioLeaf, DrawioGroup, DrawioLabel, DrawioEdge, DrawioArrow, DrawioTextStyle, DrawioTree } from './ir';
export { DrawioToIR } from './ir';
export { readPages as readDrawioPageSources, decompress as decompressDrawioDiagram, type DrawioPageSource } from './decode';
export {
  parseDrawioVector as parseDrawio,
  parseDrawioVectorSync as parseDrawioSync,
  readDrawioPages,
  readDrawioImages,
  type DrawioInput,
  type DrawioPageMeta,
  type DrawioImage,
} from './common';
