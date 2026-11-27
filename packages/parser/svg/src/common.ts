import { createGeom } from '@drawir/core';
import { decodeDataUrl, imageKey, mimeExt, bitmapSize } from './image';
import { SvgToIR, parseSvgRoot, unitItems } from './ir';
import { SvgConverter, type SvgPenAdapter } from './parser';
import type { SvgDocument, SvgParseOptions, SvgVectorDocument } from './types';
import { childElements, type XmlElement } from './xml';

/** SVG 源：文本、字节（.svg / .svgz）或 Blob / File */
export type SvgInput = string | ArrayBuffer | Uint8Array | Blob;

export async function toBytes(input: SvgInput): Promise<Uint8Array> {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await (input as Blob).arrayBuffer());
}

export function createParsers(adapter: SvgPenAdapter) {
  return {
    /** 解析 SVG（.svg / .svgz）为 meta2d 图元 */
    async parseSvg(input: SvgInput, options: SvgParseOptions = {}): Promise<SvgDocument> {
      return new SvgConverter(options, adapter).convert(typeof input === 'string' ? input : await toBytes(input));
    },
    parseSvgSync(data: Uint8Array | string, options: SvgParseOptions = {}): SvgDocument {
      return new SvgConverter(options, adapter).convert(data);
    },
  };
}

/**
 * 解析为纯 Vector IR（与 meta2d 版本无关）：可交给 core 的 vectorDocumentToPens，或任意 DrawIR 渲染后端。
 * 阴影（filter 投影）只在图元模式下生效
 */
export async function parseSvgVector(input: SvgInput, options: SvgParseOptions = {}): Promise<SvgVectorDocument> {
  return parseSvgVectorSync(typeof input === 'string' ? input : await toBytes(input), options);
}

/** 同 parseSvgVector，输入为已读取的数据 */
export function parseSvgVectorSync(data: string | Uint8Array, options: SvgParseOptions = {}): SvgVectorDocument {
  const tree = new SvgToIR(options).build(data);
  const items = tree.pages.flatMap((units) => units.flatMap(unitItems));
  const page = tree.pageList[0];
  const doc: SvgVectorDocument = {
    ...createGeom(items, (id) => tree.vectors[id]),
    vectors: tree.vectors,
    width: page ? page.width : 0,
    height: page ? page.height : 0,
    pageList: tree.pageList,
    stats: tree.stats,
  };
  tree.background && (doc.background = tree.background);
  return doc;
}

export interface SvgImage {
  /** imageUrls 的键：内嵌图片为 `data-<哈希>`，外链图片为原地址 */
  key: string;
  /** 原始 href */
  href: string;
  /** 内嵌在文件中（data URL，可上传）；外链图片按原地址引用 */
  embedded: boolean;
  /** 内嵌图片的内容（外链图片为 undefined） */
  bytes?: Uint8Array;
  mime?: string;
  /** 建议的文件名 */
  name: string;
  /** 位图像素尺寸（可识别 PNG / JPEG / GIF / WebP 时） */
  width?: number;
  height?: number;
  /** 引用次数 */
  uses: number;
}

/**
 * 取出 SVG 中的 <image>，便于先把内嵌图片上传到服务器，再把 key → URL 传给 imageUrls，
 * 避免图片以 data URL 内嵌进图纸 JSON
 */
export async function readSvgImages(input: SvgInput): Promise<SvgImage[]> {
  const root = parseSvgRoot(typeof input === 'string' ? input : await toBytes(input));
  const map = new Map<string, SvgImage>();
  const walk = (el: XmlElement) => {
    if (el.tag === 'image') {
      const href = (el.attrs.href ?? el.attrs['xlink:href'] ?? '').trim();
      if (href) {
        const key = imageKey(href);
        const hit = map.get(key);
        if (hit) hit.uses++;
        else {
          const img: SvgImage = { key, href, embedded: href.startsWith('data:'), name: '', uses: 1 };
          const data = href.startsWith('data:') ? decodeDataUrl(href) : undefined;
          if (data) {
            img.bytes = data.bytes;
            img.mime = data.mime;
            const size = bitmapSize(data.bytes);
            size && Object.assign(img, size);
          }
          const base = (el.attrs.id || el.attrs['inkscape:label'] || key).replace(/[\\/:*?"<>|#%\s]+/g, '_').slice(0, 60);
          img.name = data ? `${base}.${mimeExt(data.mime)}` : href.split(/[?#]/)[0].split('/').pop() || base;
          map.set(key, img);
        }
      }
    }
    childElements(el).forEach(walk);
  };
  walk(root);
  return [...map.values()];
}

export interface SvgInfo {
  /** 视口尺寸（width / height 属性，缺省按 viewBox） */
  width?: number;
  height?: number;
  viewBox?: [number, number, number, number];
  title?: string;
  /** 元素总数 */
  elements: number;
}

/** 读取尺寸等基本信息（不计算几何），供导入界面预览 */
export async function readSvgInfo(input: SvgInput, options: SvgParseOptions = {}): Promise<SvgInfo> {
  const tree = new SvgToIR({ ...options, images: false }).build(typeof input === 'string' ? input : await toBytes(input));
  const root = parseSvgRoot(typeof input === 'string' ? input : await toBytes(input));
  const vb = root.attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
  let elements = 0;
  const count = (el: XmlElement) => {
    elements++;
    childElements(el).forEach(count);
  };
  count(root);
  const title = childElements(root).find((c) => c.tag === 'title');
  const info: SvgInfo = { elements, width: tree.pageList[0]?.width, height: tree.pageList[0]?.height };
  vb && vb.length === 4 && vb.every(Number.isFinite) && (info.viewBox = vb as SvgInfo['viewBox']);
  title && (info.title = title.children.map((c) => (c.kind === 'text' ? c.text : '')).join('').trim());
  return info;
}
