/**
 * DrawIR 入口（只此文件为 DrawIR 独有）。src 下其余文件与 ../../../meta2d-svg/src 逐字同步（仅 @meta2d/drawir → @drawir/core），
 * 同一套解析逻辑：meta2d-svg 输出 meta2d 图元（v1 / v2 适配层），这里输出 DrawIR 的 VectorDocument。
 */
export type { SvgParseOptions, SvgParseStats, SvgPageInfo, SvgVectorDocument, SvgVectorDocument as SvgDocument } from './types';
export type { SvgUnit, SvgLeaf, SvgGroup, SvgTree } from './ir';
export { SvgToIR, parseSvgRoot } from './ir';
export {
  parseSvgVector as parseSvg,
  parseSvgVectorSync as parseSvgSync,
  readSvgImages,
  readSvgInfo,
  type SvgInput,
  type SvgImage,
  type SvgInfo,
} from './common';
