import { createGeom } from '@drawir/core';
import { decodeGenCAD, type GenCADDocumentSource } from './decode';
import { GenCADToIR, unitItems } from './ir';
import { GenCADConverter, type GenCADPenAdapter } from './parser';
import type { GenCADDocument, GenCADInfo, GenCADParseOptions, GenCADVectorDocument } from './types';

export type GenCADInput = string | ArrayBuffer | Uint8Array | Blob;

export async function toBytes(input: GenCADInput): Promise<Uint8Array> {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await (input as Blob).arrayBuffer());
}

export function createParsers(adapter: GenCADPenAdapter) {
  return {
    async parseGenCAD(input: GenCADInput, options: GenCADParseOptions = {}): Promise<GenCADDocument> {
      return new GenCADConverter(options, adapter).convert(await toBytes(input));
    },
    parseGenCADSync(data: string | Uint8Array, options: GenCADParseOptions = {}): GenCADDocument {
      return new GenCADConverter(options, adapter).convert(data);
    },
  };
}

/** 纯 DrawIR 结果，可交给 core 的 vectorDocumentToPens 或其它 DrawIR 后端 */
export async function parseGenCADVector(input: GenCADInput, options: GenCADParseOptions = {}): Promise<GenCADVectorDocument> {
  return parseGenCADVectorSync(await toBytes(input), options);
}

/** 同 parseGenCADVector，输入为已读取的数据 */
export function parseGenCADVectorSync(data: string | Uint8Array, options: GenCADParseOptions = {}): GenCADVectorDocument {
  const tree = new GenCADToIR(options).build(data);
  const items = tree.pages.flatMap((units) => units.flatMap(unitItems));
  const last = tree.pageList[tree.pageList.length - 1];
  return {
    ...createGeom(items),
    vectors: {},
    width: last ? last.x + last.width : 0,
    height: Math.max(0, ...tree.pageList.map((p) => p.height)),
    background: tree.background,
    pageList: tree.pageList,
    stats: tree.stats,
    header: tree.header,
    layers: tree.layers,
  };
}

/** 不生成几何，读取导入界面需要的板信息 */
export async function readGenCADInfo(input: GenCADInput): Promise<GenCADInfo> {
  return infoOf(decodeGenCAD(await toBytes(input)));
}

export function readGenCADInfoSync(data: string | Uint8Array): GenCADInfo {
  return infoOf(decodeGenCAD(data));
}

export async function readGenCADLayers(input: GenCADInput): Promise<string[]> {
  return (await readGenCADInfo(input)).layers;
}

export interface GenCADPageMeta {
  index: 0;
  name: string;
  drawing?: string;
  units: string;
}

/** GenCAD 单文件只有一块 PCB，统一返回一页，便于复用多页导入 UI */
export async function readGenCADPages(input: GenCADInput): Promise<GenCADPageMeta[]> {
  const info = await readGenCADInfo(input);
  return [{ index: 0, name: info.header.drawing?.split(/[\\/]/).pop() || 'GenCAD PCB', drawing: info.header.drawing, units: info.header.units }];
}

function infoOf(doc: GenCADDocumentSource): GenCADInfo {
  return {
    header: doc.header,
    layers: doc.layers,
    components: doc.components.length,
    pads: doc.components.reduce((n, c) => n + (c.shape && doc.shapes.get(c.shape)?.pins.length || 0), 0),
    routes: doc.routes.reduce((n, r) => n + r.segments.length, 0),
    vias: doc.routes.reduce((n, r) => n + r.vias.length, 0),
  };
}
