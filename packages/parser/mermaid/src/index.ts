/**
 * DrawIR 入口（只此文件为 DrawIR 独有）。src 下其余文件与 ../../../meta2d-mermaid/src 逐字同步（仅 @meta2d/drawir → @drawir/core），
 * 同一套解析逻辑：meta2d-mermaid 输出 meta2d 图元（v1 / v2 适配层），这里输出 DrawIR 的 VectorDocument。
 */
export type { MermaidParseOptions, MermaidParseStats, MermaidPageInfo, MermaidVectorDocument, MermaidDiagramType, MermaidInfo } from './types';
export type { MermaidUnit, MermaidLeaf, MermaidGroup, MermaidTree } from './ir';
export { MermaidToIR } from './ir';
export {
  parseMermaidVector as parseMermaid,
  parseMermaidVectorSync as parseMermaidSync,
  readMermaidInfo,
  toMermaidText,
  type MermaidInput,
} from './common';
