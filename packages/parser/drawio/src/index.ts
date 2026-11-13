import { DrawioToIR } from './parser';
import type { DrawioDocument, DrawioParseOptions } from './types';

export type { DrawioDocument, DrawioParseOptions, DrawioParseStats, DrawioPageInfo } from './types';
export { DrawioToIR } from './parser';
export { readPages as readDrawioPages, decompress as decompressDrawioDiagram } from './decode';
export type { DrawioPageSource } from './decode';

async function toData(input: string | ArrayBuffer | Uint8Array | Blob): Promise<string | Uint8Array> {
  if (typeof input === 'string' || input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await (input as Blob).arrayBuffer());
}

/**
 * 解析 draw.io 文件：`.drawio` / `.xml`（含压缩 diagram）、`.drawio.svg`、`.drawio.png`，
 * 或直接的 `<mxGraphModel>` 文本。
 */
export async function parseDrawio(
  input: string | ArrayBuffer | Uint8Array | Blob,
  options: DrawioParseOptions = {},
): Promise<DrawioDocument> {
  return new DrawioToIR(options).convert(await toData(input));
}

export function parseDrawioSync(data: string | Uint8Array, options: DrawioParseOptions = {}): DrawioDocument {
  return new DrawioToIR(options).convert(data);
}
