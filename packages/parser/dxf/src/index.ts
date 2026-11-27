/**
 * DrawIR 入口（只此文件为 DrawIR 独有）。src 下其余文件与 ../../../dxf/src 逐字同步（仅 @meta2d/drawir → @drawir/core），
 * 同一套解析逻辑：dxf 输出 meta2d 图元（v1 / v2 适配层），这里输出 DrawIR 的 VectorDocument。
 */
export type { DxfParseOptions, DxfParseStats, DxfPenInfo, DxfPenInfo as DxfEntityInfo, DxfVectorDocument, DxfVectorDocument as DxfDocument } from './types';
export { parseDxfVector as parseDxf, parseDxfVectorSync as parseDxfSync, readDxfText, type DxfInput } from './common';
export { parseMText } from './text';
export { aciToHex, trueColorToHex } from './colors';
