import { createGeom, type VectorItem } from '@drawir/core';
import { VisioConverter, type VisioPenAdapter } from './parser';
import type { VisioDocument, VisioParseOptions, VisioVectorDocument } from './types';
import { bakePenStyle } from './util';

export type VisioInput = ArrayBuffer | Uint8Array | Blob;

export async function toBytes(input: VisioInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await (input as Blob).arrayBuffer());
}

export function createParsers(adapter: VisioPenAdapter) {
  return {
    async parseVisio(input: VisioInput, options: VisioParseOptions = {}): Promise<VisioDocument> {
      return new VisioConverter(options, adapter).convert(await toBytes(input));
    },
    parseVisioSync(data: Uint8Array, options: VisioParseOptions = {}): VisioDocument {
      return new VisioConverter(options, adapter).convert(data);
    },
  };
}

/** 顶层图元的外接盒（Visio 页面常比内容大很多，按内容适配更符合预期） */
export function contentBox(pens: any[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pens) {
    if (p.parentId) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.width);
    y1 = Math.max(y1, p.y + p.height);
  }
  return x1 > x0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 0, height: 0 };
}

/** 生成纯 IR 用的适配器：记录每个图元的类别；editable / nativeLines 为 false 时不会产生原生图形和连线 */
const KIND = '_irKind';
const vectorAdapter: VisioPenAdapter = {
  pen(pen, kind) {
    pen[KIND] = kind;
  },
  text: () => undefined,
  line(pen) {
    pen[KIND] = 'line';
  },
  isLine: (pen) => pen[KIND] === 'line',
  isGroup: (pen) => pen[KIND] === 'group',
  lineLabel: () => undefined,
  connect() {},
};

/** 图片图元 → IR 图片项：单位正方形映射到绕中心旋转后的图片框 */
function imageItem(pen: any): VectorItem {
  const r = ((pen.rotate || 0) * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const a = pen.width * cos;
  const b = pen.width * sin;
  const c = -pen.height * sin;
  const d = pen.height * cos;
  const cx = pen.x + pen.width / 2;
  const cy = pen.y + pen.height / 2;
  return { t: 'i', src: pen.image, m: [a, b, c, d, cx - (a + c) / 2, cy - (b + d) / 2] };
}

/**
 * 解析为纯 Vector IR（与 meta2d 版本无关）：可交给 core 的 vectorDocumentToPens，或任意 DrawIR 渲染后端。
 * 与 parseVisio 共用同一套解析（按 Visio 外观生成，连接线画成矢量）；图元上的颜色 / 线宽写回矢量项
 */
export async function parseVisioVector(input: VisioInput, options: VisioParseOptions = {}): Promise<VisioVectorDocument> {
  return parseVisioVectorSync(await toBytes(input), options);
}

/** 同 parseVisioVector，输入为 .vsdx 字节 */
export function parseVisioVectorSync(data: Uint8Array, options: VisioParseOptions = {}): VisioVectorDocument {
  const res = new VisioConverter({ ...options, editable: false, nativeLines: false }, vectorAdapter).convert(data);
  const items: VectorItem[] = [];
  for (const pen of res.pens) {
    if (pen.vector) items.push(...bakePenStyle(pen.vector.items, pen));
    else if (pen[KIND] === 'image' && pen.image) items.push(imageItem(pen));
  }
  const doc: VisioVectorDocument = {
    ...createGeom(items),
    vectors: res.vectors || {},
    width: res.width,
    height: res.height,
    pageList: res.pageList,
    stats: res.stats,
  };
  res.background && (doc.background = res.background);
  return doc;
}
