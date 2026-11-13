import { inflateSync, strFromU8, unzlibSync } from 'fflate';
import { child, parseXml, XmlNode } from './xml';

/**
 * draw.io 的几种容器格式 → 页面列表。
 *
 * - `.drawio` / `.xml`：`<mxfile><diagram>…</diagram></mxfile>`，diagram 内容是
 *   明文 `<mxGraphModel>`，或 `base64(deflateRaw(encodeURIComponent(xml)))` 压缩串；
 * - 直接的 `<mxGraphModel>`（复制粘贴、旧版导出）；
 * - `.drawio.svg`：根 `<svg>` 的 `content` 属性存放 mxfile；
 * - `.drawio.png`：PNG 的 `tEXt` / `zTXt` / `iTXt` 块，关键字 `mxfile`。
 */

export interface DrawioPageSource {
  name: string;
  id?: string;
  model: XmlNode;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function readPages(input: string | Uint8Array): DrawioPageSource[] {
  let text: string;
  if (typeof input === 'string') text = input;
  else if (PNG_SIG.every((b, i) => input[i] === b)) {
    const t = pngText(input);
    if (!t) throw new Error('PNG 中没有嵌入 draw.io 图表数据（导出时需勾选“包含绘图副本”）');
    text = t;
  } else text = strFromU8(input);
  return readXmlPages(text, 0);
}

function readXmlPages(text: string, depth: number): DrawioPageSource[] {
  text = text.replace(/^\uFEFF/, '').trim();
  if (/^%3C/i.test(text)) text = safeDecodeURI(text);
  const root = parseXml(text).children.find((c) => c.tag);
  if (!root) throw new Error('不是有效的 draw.io 文件（无法解析 XML）');
  switch (root.tag) {
    case 'mxfile': {
      const pages: DrawioPageSource[] = [];
      root.children
        .filter((c) => c.tag === 'diagram')
        .forEach((d, i) => {
          const model = diagramModel(d);
          if (model) pages.push({ name: d.attrs.name || `Page-${i + 1}`, id: d.attrs.id, model });
        });
      return pages;
    }
    case 'mxGraphModel':
      return [{ name: 'Page-1', model: root }];
    case 'diagram': {
      const model = diagramModel(root);
      return model ? [{ name: root.attrs.name || 'Page-1', model }] : [];
    }
    case 'svg': {
      let content = root.attrs.content;
      if (!content || depth > 1) throw new Error('SVG 中没有嵌入 draw.io 图表数据（需要 .drawio.svg 格式）');
      content = content.trim();
      if (!content.startsWith('<') && !/^%3C/i.test(content)) content = strFromU8(base64ToBytes(content));
      return readXmlPages(content, depth + 1);
    }
    default:
      throw new Error(`不是有效的 draw.io 文件（根元素为 <${root.tag}>，应为 <mxfile> 或 <mxGraphModel>）`);
  }
}

/** diagram 元素 → mxGraphModel（必要时解压） */
function diagramModel(d: XmlNode): XmlNode | undefined {
  const direct = child(d, 'mxGraphModel');
  if (direct) return direct;
  const raw = d.text.trim();
  if (!raw) return undefined;
  const xml = decompress(raw);
  return parseXml(xml).children.find((c) => c.tag === 'mxGraphModel');
}

export function decompress(raw: string): string {
  if (raw.startsWith('<')) return raw;
  const bytes = base64ToBytes(raw);
  let s: string;
  try {
    s = strFromU8(inflateSync(bytes), true);
  } catch {
    // 部分工具只做了 base64 + URI 编码，没有压缩
    s = strFromU8(bytes, true);
  }
  return s.startsWith('<') ? s : safeDecodeURI(s);
}

function safeDecodeURI(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62; // base64url
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

export function base64ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) {
      if (c === 61) break; // '='
      continue; // 空白等
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

/** 读取 PNG 文本块中关键字为 mxfile 的内容 */
function pngText(png: Uint8Array): string | undefined {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  while (p + 12 <= png.length) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    const data = png.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IEND') break;
    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') continue;
    const z = data.indexOf(0);
    if (z < 0 || latin1(data.subarray(0, z)) !== 'mxfile') continue;
    let value: string;
    if (type === 'tEXt') value = latin1(data.subarray(z + 1));
    else if (type === 'zTXt') value = latin1(unzlibSync(data.subarray(z + 2)));
    else {
      const compressed = data[z + 1] === 1;
      let q = z + 3;
      q = data.indexOf(0, q) + 1; // 语言标签
      q = data.indexOf(0, q) + 1; // 翻译关键字
      const body = data.subarray(q);
      value = strFromU8(compressed ? unzlibSync(body) : body);
    }
    value = value.trim();
    return value.startsWith('<') ? value : safeDecodeURI(value);
  }
  return undefined;
}

function latin1(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}
