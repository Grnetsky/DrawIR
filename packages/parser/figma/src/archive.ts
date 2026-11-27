import { inflateSync, unzlibSync, unzipSync } from 'fflate';
import { decompress as zstd } from 'fzstd';
import { decodeMessage, decodeSchema, KiwiSchema } from './kiwi';

/**
 * .fig 容器：
 * - 新版：ZIP 包，内含 `canvas.fig`、`meta.json`、`thumbnail.png`、`images/<sha1>`；
 * - `canvas.fig`（或旧版直接的 .fig）：8 字节魔数（`fig-kiwi` / `fig-jam.` …）+ uint32 版本号，
 *   随后是若干「uint32 长度 + 数据」块：第 0 块为压缩的 kiwi schema，第 1 块为压缩的消息。
 *   压缩方式按块判断：zstd（新版）、raw deflate（旧版）或 zlib。
 */

export interface FigArchive {
  header: string;
  version: number;
  schema: KiwiSchema;
  message: any;
  /** ZIP 包中的 meta.json（若有） */
  meta?: any;
  /** ZIP 包中的图片：SHA-1 十六进制 → 文件内容（readFig 的 images 为 false 时为空） */
  images: Map<string, Uint8Array>;
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function readFig(data: Uint8Array, opts: { images?: boolean } = {}): FigArchive {
  let canvas = data;
  let meta: any;
  const images = new Map<string, Uint8Array>();
  if (data[0] === 0x50 && data[1] === 0x4b) {
    const withImages = opts.images !== false;
    const files = unzipSync(data, {
      filter: (f) => f.name === 'canvas.fig' || f.name === 'meta.json' || (withImages && /^images\/[0-9a-f]+$/i.test(f.name)),
    });
    if (!files['canvas.fig']) throw new Error('ZIP 中没有 canvas.fig，不是有效的 Figma 文件');
    canvas = files['canvas.fig'];
    if (files['meta.json']) {
      try {
        meta = JSON.parse(new TextDecoder().decode(files['meta.json']));
      } catch {
        /* 忽略 */
      }
    }
    for (const name in files) {
      if (name.startsWith('images/')) images.set(name.slice(7).toLowerCase(), files[name]);
    }
  }
  const header = String.fromCharCode(...canvas.subarray(0, 8));
  if (!/^fig-/.test(header)) {
    throw new Error('不是有效的 Figma .fig 文件（缺少 fig-kiwi 文件头）。注意：Figma 网页版需通过「文件 → 另存为本地副本」导出');
  }
  const view = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength);
  const version = view.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let p = 12;
  while (p + 4 <= canvas.length) {
    const n = view.getUint32(p, true);
    p += 4;
    if (p + n > canvas.length) throw new Error('.fig 数据块被截断');
    chunks.push(canvas.subarray(p, p + n));
    p += n;
  }
  if (chunks.length < 2) throw new Error('.fig 文件缺少 schema 或数据块');
  const schema = decodeSchema(inflate(chunks[0]));
  const message = decodeMessage(schema, inflate(chunks[1]));
  return { header, version, schema, message, meta, images };
}

function inflate(b: Uint8Array): Uint8Array {
  if (ZSTD_MAGIC.every((v, i) => b[i] === v)) return zstd(b);
  try {
    return inflateSync(b);
  } catch {
    if (b[0] === 0x78) return unzlibSync(b);
    throw new Error('.fig 数据块的压缩格式无法识别');
  }
}

/** 图片的 SHA-1（kiwi 中为字节数组）→ 十六进制，即 ZIP 中 images/ 下的文件名 */
export function imageHash(hash: ArrayLike<number> | undefined): string {
  if (!hash?.length) return '';
  let s = '';
  for (let i = 0; i < hash.length; i++) s += (hash[i] & 0xff).toString(16).padStart(2, '0');
  return s;
}

/** 按文件头判断图片类型 */
export function imageMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b[0] === 0x3c) return 'image/svg+xml';
  return 'image/png';
}

export function bytesToDataURL(b: Uint8Array, mime = imageMime(b)): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) bin += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK) as any);
  return `data:${mime};base64,${btoa(bin)}`;
}
