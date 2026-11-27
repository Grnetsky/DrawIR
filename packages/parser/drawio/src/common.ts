import { createGeom } from '@drawir/core';
import { base64ToBytes, readPages } from './decode';
import { DrawioToIR, normalizeImageSrc, resolveOptions, unitItems } from './ir';
import { DrawioConverter, type DrawioPenAdapter } from './parser';
import { parseStyle } from './style';
import type { DrawioDocument, DrawioParseOptions, DrawioVectorDocument } from './types';
import { hashKey } from './util';
import { child, type XmlNode } from './xml';

export type DrawioInput = string | ArrayBuffer | Uint8Array | Blob;

/** 文本保持文本（.drawio / .xml / .svg），二进制（.png 或未知编码）为字节 */
export async function toData(input: DrawioInput): Promise<string | Uint8Array> {
  if (typeof input === 'string' || input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await (input as Blob).arrayBuffer());
}

export function createParsers(adapter: DrawioPenAdapter) {
  return {
    /** 解析 draw.io 文件（.drawio / .xml / .drawio.svg / .drawio.png，或 mxGraphModel 文本）为 meta2d 图元 */
    async parseDrawio(input: DrawioInput, options: DrawioParseOptions = {}): Promise<DrawioDocument> {
      return new DrawioConverter(options, adapter).convert(await toData(input));
    },
    parseDrawioSync(data: string | Uint8Array, options: DrawioParseOptions = {}): DrawioDocument {
      return new DrawioConverter(options, adapter).convert(data);
    },
  };
}

/**
 * 解析为纯 Vector IR（与 meta2d 版本无关）：可交给 core 的 vectorDocumentToPens，或任意 DrawIR 渲染后端。
 * 图片为 IR 图片项，渐变为 IR 渐变（style.fill）
 */
export async function parseDrawioVector(input: DrawioInput, options: DrawioParseOptions = {}): Promise<DrawioVectorDocument> {
  return parseDrawioVectorSync(await toData(input), options);
}

/** 同 parseDrawioVector，输入为已读取的数据 */
export function parseDrawioVectorSync(data: string | Uint8Array, options: DrawioParseOptions = {}): DrawioVectorDocument {
  const tree = new DrawioToIR(resolveOptions({ ...options, granularity: 'node' })).build(data);
  const items = tree.pages.flatMap((units, i) => {
    const bg = tree.pageBackgrounds[i];
    const page = units.flatMap(unitItems);
    if (!bg) return page;
    const d = [0, bg.x, bg.y, 1, bg.x + bg.width, bg.y, 1, bg.x + bg.width, bg.y + bg.height, 1, bg.x, bg.y + bg.height, 4];
    return [{ t: 'p' as const, d, s: { fill: bg.color, stroke: 'none' } }, ...page];
  });
  const last = tree.pageList[tree.pageList.length - 1];
  const doc: DrawioVectorDocument = {
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

export interface DrawioPageMeta {
  /** 页序号（与解析选项 pages 一致，从 0 开始） */
  index: number;
  name: string;
  /** 形状数 / 连线数 */
  vertices: number;
  edges: number;
}

/** 页面里的 mxCell（含 UserObject / object 包装的） */
function cellsOf(model: XmlNode): { cell: XmlNode; label?: string }[] {
  const root = child(model, 'root');
  const out: { cell: XmlNode; label?: string }[] = [];
  for (const n of root?.children || []) {
    if (n.tag === 'mxCell') out.push({ cell: n, label: n.attrs.value });
    else if (n.tag === 'UserObject' || n.tag === 'object') {
      const c = child(n, 'mxCell');
      c && out.push({ cell: c, label: n.attrs.label });
    }
  }
  return out;
}

/** 读取页面列表（不解析几何），供导入配置界面选择页面 */
export async function readDrawioPages(input: DrawioInput): Promise<DrawioPageMeta[]> {
  return readPages(await toData(input)).map((p, index) => {
    const cells = cellsOf(p.model);
    return {
      index,
      name: p.name,
      vertices: cells.filter((c) => c.cell.attrs.vertex === '1').length,
      edges: cells.filter((c) => c.cell.attrs.edge === '1').length,
    };
  });
}

export interface DrawioImage {
  /** 图片 key，即 DrawioParseOptions.imageUrls / skipImages 的键 */
  key: string;
  /** 图片地址：内嵌图片为 data URL，外部图片为 URL */
  src: string;
  /** 内嵌在文件中（data URL），可以上传；外部图片只能按地址引用 */
  embedded: boolean;
  /** 内嵌图片的字节 */
  bytes?: Uint8Array;
  mime: string;
  /** 建议的文件名 */
  name: string;
  /** 引用次数 */
  uses: number;
  /** 首次引用处的显示尺寸（draw.io 像素） */
  width?: number;
  height?: number;
}

/**
 * 取出文件中用到的图片（style 的 image=），内嵌图片可先上传到服务器，
 * 再把 key → URL 传给 imageUrls，避免图片以 data URL 内嵌进图纸 JSON。
 */
export async function readDrawioImages(input: DrawioInput, options: Pick<DrawioParseOptions, 'imageBase'> = {}): Promise<DrawioImage[]> {
  const base = resolveOptions(options).imageBase;
  const map = new Map<string, DrawioImage>();
  for (const page of readPages(await toData(input))) {
    for (const { cell, label } of cellsOf(page.model)) {
      const style = cell.attrs.style;
      if (!style || style.indexOf('image=') < 0) continue;
      const src = normalizeImageSrc(parseStyle(style).image, base);
      if (!src) continue;
      const key = hashKey(src);
      const hit = map.get(key);
      if (hit) {
        hit.uses++;
        continue;
      }
      const embedded = /^data:/i.test(src);
      let mime = 'image/png';
      let bytes: Uint8Array | undefined;
      if (embedded) {
        const comma = src.indexOf(',');
        const head = src.slice(5, comma);
        mime = head.split(';')[0] || mime;
        const body = src.slice(comma + 1);
        bytes = /;base64$/i.test(head) ? base64ToBytes(body) : new TextEncoder().encode(safeDecode(body));
      } else {
        const ext = /\.(png|jpe?g|gif|svg|webp|bmp)(?:[?#]|$)/i.exec(src)?.[1]?.toLowerCase();
        ext && (mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`);
      }
      const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/svg+xml' ? 'svg' : mime.replace(/^image\//, '') || 'png';
      const text = (label || '').replace(/<[^>]*>/g, '').trim();
      const stem = text || (!embedded && src.split(/[?#]/)[0].split('/').pop()?.replace(/\.[a-z0-9]+$/i, '')) || `image-${map.size + 1}`;
      const name = `${stem.replace(/[\\/:*?"<>|#%\s]+/g, '_').slice(0, 60)}.${ext}`;
      const geo = child(cell, 'mxGeometry');
      const img: DrawioImage = { key, src, embedded, mime, name, uses: 1 };
      bytes && (img.bytes = bytes);
      geo?.attrs.width && (img.width = +geo.attrs.width);
      geo?.attrs.height && (img.height = +geo.attrs.height);
      map.set(key, img);
    }
  }
  return [...map.values()];
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
