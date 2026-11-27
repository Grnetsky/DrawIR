export type { DrawioDocument, DrawioParseOptions, DrawioParseStats, DrawioPageInfo, DrawioPenInfo, DrawioVectorDocument } from './types';
export type { DrawioPenAdapter, ImageSpec, TextSpec, TextRect, LineSpec } from './parser';
export type { PenGradient } from './gradient';
export type { DrawioUnit, DrawioLeaf, DrawioGroup, DrawioLabel, DrawioEdge, DrawioArrow, DrawioTextStyle, DrawioTree } from './ir';
export { DrawioConverter } from './parser';
export { DrawioToIR, leafItems, unitItems, normalizeImageSrc } from './ir';
export { readPages as readDrawioPageSources, decompress as decompressDrawioDiagram, type DrawioPageSource } from './decode';
export {
  parseDrawioVector,
  parseDrawioVectorSync,
  readDrawioPages,
  readDrawioImages,
  toData,
  type DrawioInput,
  type DrawioPageMeta,
  type DrawioImage,
} from './common';
export { contentBox, penRectOfGeom, MIN_PEN_SIZE, type Meta2dPensDocument } from './util';
