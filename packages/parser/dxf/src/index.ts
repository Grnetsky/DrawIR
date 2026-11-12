import { DxfParser } from 'dxf-json';
import { DxfToVector } from './parser';
import type { DxfDocument, DxfParseOptions } from './types';

export type { DxfDocument, DxfParseOptions, DxfParseStats, DxfEntityInfo } from './types';
export { DxfToVector } from './parser';
export { parseMText } from './text';

const CODEPAGES: Record<string, string> = {
  ANSI_936: 'gbk',
  ANSI_950: 'big5',
  ANSI_932: 'shift_jis',
  ANSI_949: 'euc-kr',
  ANSI_1252: 'windows-1252',
  ANSI_1251: 'windows-1251',
  ANSI_1250: 'windows-1250',
};

function detectEncoding(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*AC(\d{4})/.exec(head)?.[1];
  if (ver && +ver >= 1021) return 'utf-8';
  const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/.exec(head)?.[1]?.toUpperCase();
  return (cp && CODEPAGES[cp]) || 'utf-8';
}

export async function readDxfText(input: string | ArrayBuffer | Uint8Array | Blob, encoding?: string) {
  if (typeof input === 'string') return input;
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(await (input as Blob).arrayBuffer());
  const enc = encoding || detectEncoding(bytes);
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export async function parseDxf(
  input: string | ArrayBuffer | Uint8Array | Blob,
  options: DxfParseOptions = {},
): Promise<DxfDocument> {
  return parseDxfSync(await readDxfText(input, options.encoding), options);
}

export function parseDxfSync(text: string, options: DxfParseOptions = {}): DxfDocument {
  const dxf = new DxfParser().parseSync(text);
  return new DxfToVector(options).convert(dxf, text);
}
