import { FigmaToIR } from './parser';
import type { FigmaDocument, FigmaParseOptions } from './types';

export type { FigmaDocument, FigmaParseOptions, FigmaParseStats, FigmaPageInfo } from './types';
export { FigmaToIR } from './parser';
export { readFig } from './archive';
export type { FigArchive } from './archive';
export { decodeSchema, decodeMessage } from './kiwi';
export type { KiwiSchema, KiwiDefinition, KiwiField } from './kiwi';

async function toBytes(input: ArrayBuffer | Uint8Array | Blob): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await (input as Blob).arrayBuffer());
}

/** 解析 Figma 本地文件（.fig，ZIP 包或裸 fig-kiwi 格式） */
export async function parseFigma(input: ArrayBuffer | Uint8Array | Blob, options: FigmaParseOptions = {}): Promise<FigmaDocument> {
  return new FigmaToIR(options).convert(await toBytes(input));
}

export function parseFigmaSync(data: Uint8Array, options: FigmaParseOptions = {}): FigmaDocument {
  return new FigmaToIR(options).convert(data);
}
