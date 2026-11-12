import { VisioToIR } from './parser';
import type { VisioDocument, VisioParseOptions } from './types';

export type { VisioDocument, VisioParseOptions, VisioParseStats, VisioPageInfo } from './types';
export { VisioToIR } from './parser';

async function toBytes(input: ArrayBuffer | Uint8Array | Blob): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await (input as Blob).arrayBuffer());
}

export async function parseVisio(
  input: ArrayBuffer | Uint8Array | Blob,
  options: VisioParseOptions = {},
): Promise<VisioDocument> {
  return new VisioToIR(options).convert(await toBytes(input));
}

export function parseVisioSync(data: Uint8Array, options: VisioParseOptions = {}): VisioDocument {
  return new VisioToIR(options).convert(data);
}
