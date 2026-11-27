import { createGeom } from '@drawir/core';
import { decodeSym } from './decode';
import { SymToIR, unitItems } from './ir';
import { SymConverter, type SymPenAdapter } from './parser';
import type { SymDocument, SymParseOptions, SymSource, SymVectorDocument } from './types';

export type SymInput = string | ArrayBuffer | Uint8Array | Blob;

export async function toBytes(input: SymInput): Promise<Uint8Array> {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await (input as Blob).arrayBuffer());
}

export async function readSymSymbols(input: SymInput): Promise<SymSource> {
  return decodeSym(await toBytes(input));
}

export function readSymSymbolsSync(data: Uint8Array): SymSource {
  return decodeSym(data);
}

export function createParsers(adapter: SymPenAdapter) {
  return {
    async parseSym(input: SymInput, options: SymParseOptions = {}): Promise<SymDocument> {
      return new SymConverter(options, adapter).convert(await toBytes(input));
    },
    parseSymSync(data: Uint8Array, options: SymParseOptions = {}): SymDocument {
      return new SymConverter(options, adapter).convert(data);
    },
  };
}

export async function parseSymVector(input: SymInput, options: SymParseOptions = {}): Promise<SymVectorDocument> {
  return parseSymVectorSync(await toBytes(input), options);
}

/** 同 parseSymVector，输入为已读取的数据 */
export function parseSymVectorSync(data: Uint8Array, options: SymParseOptions = {}): SymVectorDocument {
  const tree = new SymToIR(options).build(data);
  const items = tree.pages.flatMap((units) => units.flatMap(unitItems));
  const last = tree.pageList[tree.pageList.length - 1];
  return {
    ...createGeom(items, (id) => tree.vectors[id]),
    vectors: tree.vectors,
    width: last ? last.x + last.width : 0,
    height: Math.max(0, ...tree.pageList.map((p) => p.height)),
    pageList: tree.pageList,
    stats: tree.stats,
  };
}
