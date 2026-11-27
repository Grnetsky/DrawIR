/**
 * DrawIR 入口（只此文件为 DrawIR 独有）。src 下其余文件与 ../../../meta2d-sketch/src 逐字同步（仅 @meta2d/drawir → @drawir/core），
 * 同一套解析逻辑：meta2d-sketch 输出 meta2d 图元（v1 / v2 适配层），这里输出 DrawIR 的 VectorDocument。
 */
export type { SketchParseOptions, SketchParseStats, SketchPageInfo, SketchVectorDocument, SketchVectorDocument as SketchDocument } from './types';
export type { SketchUnit, SketchLeaf, SketchGroup, SketchGradient, SketchTextBox, SketchEdge, SketchTree, SketchLayer } from './ir';
export { SketchToIR } from './ir';
export { readSketch, type SketchArchive } from './archive';
export {
  parseSketchVector as parseSketch,
  parseSketchVectorSync as parseSketchSync,
  readSketchPages,
  readSketchLayers,
  readSketchImages,
  readSketchFonts,
  registerSketchFonts,
  type SketchInput,
  type SketchPageMeta,
  type SketchImage,
  type SketchFont,
} from './common';
