/**
 * DrawIR 入口（只此文件为 DrawIR 独有）。src 下其余文件与 ../../../meta2d-figma/src 逐字同步（仅 @meta2d/drawir → @drawir/core），
 * 同一套解析逻辑：meta2d-figma 输出 meta2d 图元（v1 / v2 适配层），这里输出 DrawIR 的 VectorDocument。
 */
export type { FigmaParseOptions, FigmaParseStats, FigmaPageInfo, FigmaVectorDocument, FigmaVectorDocument as FigmaDocument } from './types';
export type { FigmaUnit, FigmaLeaf, FigmaGroup, FigmaGradient, FigmaTextBox, FigmaTree, FigmaLayer } from './ir';
export { FigmaToIR } from './ir';
export { readFig, type FigArchive } from './archive';
export { decodeSchema, decodeMessage, type KiwiSchema, type KiwiDefinition, type KiwiField } from './kiwi';
export {
  parseFigmaVector as parseFigma,
  parseFigmaVectorSync as parseFigmaSync,
  readFigPages,
  readFigLayers,
  readFigImages,
  type FigmaInput,
  type FigmaPageMeta,
  type FigImage,
} from './common';
