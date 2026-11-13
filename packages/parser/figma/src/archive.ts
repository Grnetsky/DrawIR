import { inflateSync, unzlibSync, unzipSync } from 'fflate';
import { decompress as zstd } from 'fzstd';
import { decodeMessage, decodeSchema, KiwiSchema } from './kiwi';

/**
 * .fig 容器：
 * - 新版：ZIP 包，内含 `canvas.fig`、`meta.json`、`thumbnail.png`、`images/*`；
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
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function readFig(data: Uint8Array): FigArchive {
  let canvas = data;
  let meta: any;
  if (data[0] === 0x50 && data[1] === 0x4b) {
    const files = unzipSync(data, { filter: (f) => f.name === 'canvas.fig' || f.name === 'meta.json' });
    if (!files['canvas.fig']) throw new Error('ZIP 中没有 canvas.fig，不是有效的 Figma 文件');
    canvas = files['canvas.fig'];
    if (files['meta.json']) {
      try {
        meta = JSON.parse(new TextDecoder().decode(files['meta.json']));
      } catch {
        /* 忽略 */
      }
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
  return { header, version, schema, message, meta };
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
