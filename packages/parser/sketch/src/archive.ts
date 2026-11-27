import { strFromU8, unzipSync } from 'fflate';

/**
 * .sketch 容器（Sketch 43 及以后）：ZIP 包，内含
 * - `document.json`：页面列表（pages[]._ref → `pages/<id>.json`）、共享样式、外部库组件（foreignSymbols）等；
 * - `pages/<id>.json`：页面图层树；
 * - `meta.json`：格式版本（version）、Sketch 版本（appVersion）、页面 / 画板索引；
 * - `images/<sha1>.<ext>`：位图图层、图片填充引用的图片；`previews/preview.png`：预览图。
 * Sketch 43 之前的 .sketch 是 SQLite 数据库，不支持。
 */
export interface SketchArchive {
  document: any;
  meta: any;
  /** 与 document.pages 同序 */
  pages: any[];
  /** 图片引用（`images/xxx.png`）→ 文件内容（readSketch 的 images 为 false 时为空） */
  images: Map<string, Uint8Array>;
  /** 内嵌字体引用（`fonts/<sha1>`）→ 文件内容（readSketch 的 fonts 为 true 时才读取） */
  fonts: Map<string, Uint8Array>;
}

export function readSketch(data: Uint8Array, opts: { images?: boolean; fonts?: boolean } = {}): SketchArchive {
  if (data[0] !== 0x50 || data[1] !== 0x4b) {
    const head = String.fromCharCode(...data.subarray(0, 15));
    if (head === 'SQLite format 3') {
      throw new Error('这是 Sketch 43 之前的旧版文件（SQLite 格式），不支持。请用新版 Sketch 打开后重新保存');
    }
    throw new Error('不是有效的 Sketch 文件（不是 ZIP 包）');
  }
  const withImages = opts.images !== false;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) =>
        f.name === 'document.json' ||
        f.name === 'meta.json' ||
        /^pages\/[^/]+\.json$/.test(f.name) ||
        (withImages && f.name.startsWith('images/')) ||
        (!!opts.fonts && f.name.startsWith('fonts/')),
    });
  } catch (e: any) {
    throw new Error(`Sketch 文件解压失败：${e?.message || e}`);
  }
  if (!files['document.json']) throw new Error('不是有效的 Sketch 文件（缺少 document.json）');
  const json = (name: string) => {
    const b = files[name];
    if (!b) return undefined;
    try {
      return JSON.parse(strFromU8(b));
    } catch (e: any) {
      throw new Error(`${name} 不是有效的 JSON：${e?.message || e}`);
    }
  };
  const document = json('document.json');
  const meta = json('meta.json') || {};
  const pages: any[] = [];
  for (const ref of document.pages || []) {
    const name = `${ref._ref}.json`;
    const page = json(name);
    page ? pages.push(page) : pages.push({ _class: 'page', do_objectID: ref._ref, name: ref._ref, layers: [], missing: true });
  }
  const images = new Map<string, Uint8Array>();
  const fonts = new Map<string, Uint8Array>();
  for (const name in files) {
    if (name.startsWith('images/')) images.set(name, files[name]);
    else if (name.startsWith('fonts/')) fonts.set(name, files[name]);
  }
  return { document, meta, pages, images, fonts };
}

/** 从文件头读取图片的像素尺寸（PNG / JPEG / GIF / WebP），读不出时返回 undefined */
export function imageSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (!b || b.length < 24) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 0x89 && b[1] === 0x50) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      const len = dv.getUint16(i + 2);
      // SOF0~SOF15（除 DHT / JPG / DAC）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) };
      }
      i += 2 + len;
    }
    return undefined;
  }
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b.length >= 30) {
    const fmt = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fmt === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (fmt === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (fmt === 'VP8L') {
      const v = dv.getUint32(21, true);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
  }
  return undefined;
}

/** 按文件头判断图片类型 */
export function imageMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'image/heic';
  if (b[0] === 0x49 && b[1] === 0x49) return 'image/tiff';
  if (b[0] === 0x4d && b[1] === 0x4d) return 'image/tiff';
  if (b[0] === 0x25 && b[1] === 0x50) return 'application/pdf';
  if (b[0] === 0x3c) return 'image/svg+xml';
  return 'image/png';
}

export function bytesToDataURL(b: Uint8Array, mime = imageMime(b)): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) bin += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK) as any);
  return `data:${mime};base64,${btoa(bin)}`;
}
