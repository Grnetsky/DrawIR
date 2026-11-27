/**
 * DrawIR 入口（只此文件为 DrawIR 独有）。src 下其余文件与 ../../../visio2meta2d/src 逐字同步（仅 @meta2d/drawir → @drawir/core），
 * 同一套解析逻辑：visio2meta2d 输出 meta2d 图元（v1 / v2 适配层），这里输出 DrawIR 的 VectorDocument。
 */
export type { VisioParseOptions, VisioParseStats, VisioPageInfo, VisioVectorDocument, VisioVectorDocument as VisioDocument } from './types';
export { parseVisioVector as parseVisio, parseVisioVectorSync as parseVisioSync, type VisioInput } from './common';
export { VsdxPackage } from './package';
