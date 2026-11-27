/** <image> 相关：图片键、data URL 解码、内嵌位图的原始尺寸 */
import { hashString } from './util';

/** 图片键（imageUrls 的键）：data URL 用内容哈希，外链用原地址 */
export function imageKey(href: string) {
  return href.startsWith('data:') ? `data-${hashString(href)}` : href;
}

export interface DataUrl {
  mime: string;
  bytes: Uint8Array;
}

export function decodeDataUrl(href: string): DataUrl | undefined {
  const m = /^data:([^,;]*)((?:;[^,;]*)*?),(.*)$/s.exec(href.trim());
  if (!m) return undefined;
  const mime = (m[1] || 'text/plain').toLowerCase();
  const base64 = /;base64/i.test(m[2]);
  try {
    if (base64) {
      const bin = atob(m[3].replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { mime, bytes };
    }
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(m[3])) };
  } catch {
    return undefined;
  }
}

/** PNG / GIF / JPEG / WebP 的像素尺寸；其它格式返回 undefined */
export function bitmapSize(b: Uint8Array): { width: number; height: number } | undefined {
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32(16), height: u32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (tag === 'VP8 ') return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (tag === 'VP8L') {
      const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      // SOF0~SOF15（除 DHT C4、JPG C8、DAC CC）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

export function mimeExt(mime: string) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/svg+xml') return 'svg';
  const m = /^image\/([\w.+-]+)/.exec(mime);
  return m ? m[1] : 'bin';
}
