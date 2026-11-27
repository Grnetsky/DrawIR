import { createGeom } from '@drawir/core';
import { decodeMermaid, detectMermaidType } from './decode';
import { MermaidToIR, unitItems } from './ir';
import { MermaidConverter, type MermaidPenAdapter } from './parser';
import type { MermaidDocument, MermaidInfo, MermaidParseOptions, MermaidParseStats, MermaidVectorDocument } from './types';

export type MermaidInput = string | ArrayBuffer | Uint8Array | Blob;

export async function toMermaidText(input: MermaidInput): Promise<string> {
  if (typeof input === 'string') return input;
  if (input instanceof ArrayBuffer) return new TextDecoder().decode(input);
  if (input instanceof Uint8Array) return new TextDecoder().decode(input);
  return new TextDecoder().decode(await (input as Blob).arrayBuffer());
}

export function createParsers(adapter: MermaidPenAdapter) {
  return {
    async parseMermaid(input: MermaidInput, options: MermaidParseOptions = {}): Promise<MermaidDocument> {
      return new MermaidConverter(options, adapter).convert(await toMermaidText(input));
    },
    parseMermaidSync(data: string | Uint8Array, options: MermaidParseOptions = {}): MermaidDocument {
      return new MermaidConverter(options, adapter).convert(data);
    },
  };
}

/** 纯 DrawIR（与 meta2d 版本无关），可交给 core 的 vectorDocumentToPens */
export async function parseMermaidVector(input: MermaidInput, options: MermaidParseOptions = {}): Promise<MermaidVectorDocument> {
  return parseMermaidVectorSync(await toMermaidText(input), options);
}

/** 同 parseMermaidVector，输入为已读取的数据 */
export function parseMermaidVectorSync(data: string | Uint8Array, options: MermaidParseOptions = {}): MermaidVectorDocument {
  const tree = new MermaidToIR(options).build(data);
  const items = tree.pages.flatMap((units) => units.flatMap(unitItems));
  return {
    ...createGeom(items),
    vectors: {},
    width: tree.width,
    height: tree.height,
    pageList: tree.pageList,
    stats: tree.stats,
  };
}

/** 轻量读取图表类型和数量，不计算布局与几何 */
export async function readMermaidInfo(input: MermaidInput): Promise<MermaidInfo> {
  const source = await toMermaidText(input);
  const stats: MermaidParseStats = { pages: 0, nodes: 0, edges: 0, pens: 0, unsupported: {}, errors: [], ms: 0 };
  const model = decodeMermaid(source, stats);
  return {
    type: detectMermaidType(source),
    title: model.title,
    nodes: model.kind === 'flowchart' ? model.nodeOrder.length : model.participantOrder.length,
    edges: model.kind === 'flowchart' ? model.edges.length : countMessages(model.events),
  };
}

function countMessages(events: any[]): number {
  return events.reduce((sum, event) => sum + (event.kind === 'message' ? 1 : event.kind === 'block' ? countMessages(event.sections.flatMap((s: any) => s.events)) : 0), 0);
}
