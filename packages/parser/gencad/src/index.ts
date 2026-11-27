/**
 * DrawIR 入口（只此文件为 DrawIR 独有）。src 下其余文件与 ../../../meta2d-gencad/src 逐字同步（仅 @meta2d/drawir → @drawir/core），
 * 同一套解析逻辑：meta2d-gencad 输出 meta2d 图元（v1 / v2 适配层），这里输出 DrawIR 的 VectorDocument。
 */
export type { GenCADParseOptions, GenCADParseStats, GenCADPageInfo, GenCADInfo, GenCADVectorDocument } from './types';
export type { GenCADUnit, GenCADLeaf, GenCADGroup, GenCADTree, GenCADTextBox, GenCADEdge } from './ir';
export { GenCADToIR } from './ir';
export { decodeGenCAD, genCADUnitToInches, genCADNodeKey } from './decode';
export type { GenCADDocumentSource, GenCADHeader, GenCADGeometry, GenCADComponent, GenCADShape, GenCADPad, GenCADPadStack, GenCADRoute } from './decode';
export {
  parseGenCADVector as parseGenCAD,
  parseGenCADVectorSync as parseGenCADSync,
  readGenCADInfo,
  readGenCADInfoSync,
  readGenCADLayers,
  readGenCADPages,
  type GenCADInput,
  type GenCADPageMeta,
} from './common';
