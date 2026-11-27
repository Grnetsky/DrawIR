import { createGeom } from '@drawir/core';
import { readFig, imageMime } from './archive';
import { FigmaToIR, treeToItems, type FigmaLayer } from './ir';
import { FigmaConverter, type FigmaPenAdapter } from './parser';
import type { FigmaDocument, FigmaParseOptions, FigmaVectorDocument } from './types';

export type FigmaInput = ArrayBuffer | Uint8Array | Blob;

export async function toBytes(input: FigmaInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await (input as Blob).arrayBuffer());
}

export function createParsers(adapter: FigmaPenAdapter) {
  return {
    /** 解析 Figma 本地文件（.fig，ZIP 包或裸 fig-kiwi 格式）为 meta2d 图元 */
    async parseFigma(input: FigmaInput, options: FigmaParseOptions = {}): Promise<FigmaDocument> {
      return new FigmaConverter(options, adapter).convert(await toBytes(input));
    },
    parseFigmaSync(data: Uint8Array, options: FigmaParseOptions = {}): FigmaDocument {
      return new FigmaConverter(options, adapter).convert(data);
    },
  };
}

/**
 * 解析为纯 Vector IR（与 meta2d 版本无关）：可交给 core 的 vectorDocumentToPens，或任意 DrawIR 渲染后端。
 * 图片为 IR 图片项，渐变为 IR 渐变（style.fill / stroke）
 */
export async function parseFigmaVector(input: FigmaInput, options: FigmaParseOptions = {}): Promise<FigmaVectorDocument> {
  return parseFigmaVectorSync(await toBytes(input), options);
}

/** 同 parseFigmaVector，输入为已读取的数据 */
export function parseFigmaVectorSync(data: Uint8Array, options: FigmaParseOptions = {}): FigmaVectorDocument {
  const tree = new FigmaToIR(options).build(data);
  const items = tree.pages.flatMap(treeToItems);
  const last = tree.pageList[tree.pageList.length - 1];
  const doc: FigmaVectorDocument = {
    ...createGeom(items),
    vectors: {},
    width: last ? last.x + last.width : 0,
    height: Math.max(0, ...tree.pageList.map((p) => p.height)),
    pageList: tree.pageList,
    stats: tree.stats,
  };
  const bg = tree.pageList.find((p) => p.background)?.background;
  bg && (doc.background = bg);
  return doc;
}

export interface FigmaPageMeta {
  /** 页序号（与解析选项 pages 一致，从 0 开始，不含内部页） */
  index: number;
  name: string;
  /** 页面顶层图层数 */
  layers: number;
}

/** 读取页面列表（不解析几何），供导入配置界面选择页面 */
export async function readFigPages(input: FigmaInput): Promise<FigmaPageMeta[]> {
  const fig = readFig(await toBytes(input), { images: false });
  const nodes: any[] = (fig.message.nodeChanges || []).filter((n: any) => n.guid && n.phase !== 'REMOVED');
  const key = (g: any) => (g ? `${g.sessionID}:${g.localID}` : '');
  const doc = nodes.find((n) => n.type === 'DOCUMENT');
  const byParent = new Map<string, any[]>();
  for (const n of nodes) {
    const p = key(n.parentIndex?.guid);
    byParent.has(p) || byParent.set(p, []);
    byParent.get(p)!.push(n);
  }
  const order = (a: any, b: any) => {
    const pa = a.parentIndex?.position ?? '';
    const pb = b.parentIndex?.position ?? '';
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  };
  const canvases = (doc ? byParent.get(key(doc.guid)) || [] : nodes).filter((n) => n.type === 'CANVAS' && !n.internalOnly).sort(order);
  return canvases.map((c, index) => ({
    index,
    name: c.name || `Page ${index + 1}`,
    layers: (byParent.get(key(c.guid)) || []).filter((n) => n.visible !== false).length,
  }));
}

/**
 * 读取图层树（不计算几何），供导入配置界面按图层选择：每页一个根节点（type 为 CANVAS，顺序与解析选项 pages 一致），
 * 子图层上层在前；组件实例展开为组件内的图层。不导入的图层 id 传给 skipNodes
 */
export async function readFigLayers(input: FigmaInput): Promise<FigmaLayer[]> {
  return new FigmaToIR().layers(await toBytes(input));
}

export interface FigImage {
  /** SHA-1（十六进制），即 FigmaParseOptions.imageUrls 的键 */
  hash: string;
  bytes: Uint8Array;
  mime: string;
  /** 建议的文件名（图层里的图片名 + 扩展名） */
  name: string;
  /** 原始宽高（像素，来自图片填充的记录，可能缺省） */
  width?: number;
  height?: number;
  /** 引用次数（图片填充数） */
  uses: number;
}

/**
 * 取出文件中被图层引用的图片，便于先上传到服务器，再把 hash → URL 传给 imageUrls，
 * 避免图片以 data URL 内嵌进图纸 JSON。
 */
export async function readFigImages(input: FigmaInput): Promise<FigImage[]> {
  const fig = readFig(await toBytes(input));
  const refs = new Map<string, { name: string; width?: number; height?: number; uses: number }>();
  const scan = (paints: any[] | undefined) => {
    for (const p of paints || []) {
      if (p?.type !== 'IMAGE' || !p.image?.hash) continue;
      let h = '';
      for (const b of p.image.hash) h += (b & 0xff).toString(16).padStart(2, '0');
      const r = refs.get(h);
      if (r) r.uses++;
      else refs.set(h, { name: p.image.name || h, width: p.originalImageWidth, height: p.originalImageHeight, uses: 1 });
    }
  };
  for (const n of fig.message.nodeChanges || []) {
    scan(n.fillPaints);
    scan(n.strokePaints);
    for (const o of [...(n.symbolData?.symbolOverrides || []), ...(n.derivedSymbolData || [])]) {
      scan(o.fillPaints);
      scan(o.strokePaints);
    }
  }
  const out: FigImage[] = [];
  for (const [hash, r] of refs) {
    const bytes = fig.images.get(hash);
    if (!bytes) continue;
    const mime = imageMime(bytes);
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/svg+xml' ? 'svg' : mime.slice(6);
    const name = `${r.name.replace(/[\\/:*?"<>|#%\s]+/g, '_').slice(0, 60) || hash}.${ext}`;
    out.push({ hash, bytes, mime, name, width: r.width, height: r.height, uses: r.uses });
  }
  return out;
}
