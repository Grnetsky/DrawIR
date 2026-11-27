/**
 * 轻量 XML 解析器（不依赖 DOM，可在 Worker / Node 运行），只保留 SVG 解析需要的信息：
 * 元素、属性、文本（含 CDATA）。支持 DOCTYPE 内部实体声明（Illustrator 导出的 SVG 常用 &ns_svg; 之类）。
 * SVG 命名空间的前缀会被去掉（`svg:rect` → `rect`），其它命名空间的元素保留前缀，后续会被忽略。
 */

export interface XmlElement {
  kind: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  parent?: XmlElement;
}

export interface XmlText {
  kind: 'text';
  text: string;
  /** 来自 CDATA */
  cdata?: boolean;
}

export type XmlNode = XmlElement | XmlText;

const SVG_NS = 'http://www.w3.org/2000/svg';

const BUILTIN: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string, entities: Record<string, string> = BUILTIN): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[\w.:-]+);/g, (all, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    const v = entities[name] ?? BUILTIN[name];
    return v !== undefined ? v : all;
  });
}

export function parseXml(src: string): XmlElement {
  const root: XmlElement = { kind: 'element', tag: '#document', attrs: {}, children: [] };
  const entities: Record<string, string> = { ...BUILTIN };
  const stack: XmlElement[] = [root];
  /** 每层元素可见的命名空间前缀 → uri */
  const nsStack: Record<string, string>[] = [{ '': SVG_NS, svg: SVG_NS }];
  const len = src.length;
  let i = 0;

  const top = () => stack[stack.length - 1];
  const addText = (text: string, cdata?: boolean) => {
    if (!text) return;
    const parent = top();
    parent.children.push(cdata ? { kind: 'text', text, cdata } : { kind: 'text', text });
  };

  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      addText(decodeEntities(src.slice(i), entities));
      break;
    }
    lt > i && addText(decodeEntities(src.slice(i, lt), entities));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      addText(src.slice(i + 9, end < 0 ? len : end), true);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      i = end < 0 ? len : end + 2;
      continue;
    }
    if (src.startsWith('<!', i)) {
      i = skipDeclaration(src, i, entities);
      continue;
    }
    if (src[i + 1] === '/') {
      const end = src.indexOf('>', i + 2);
      const name = src.slice(i + 2, end < 0 ? len : end).trim();
      i = end < 0 ? len : end + 1;
      // 容错：关闭到最近的同名元素，找不到就忽略这个结束标签
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].attrs['#raw'] === name || stack[k].tag === name) {
          stack.length = k;
          nsStack.length = k;
          break;
        }
      }
      continue;
    }
    // 开始标签
    let j = i + 1;
    while (j < len && !/[\s/>]/.test(src[j])) j++;
    const rawName = src.slice(i + 1, j);
    const attrs: Record<string, string> = {};
    let selfClose = false;
    while (j < len) {
      while (j < len && /\s/.test(src[j])) j++;
      const c = src[j];
      if (c === '>') {
        j++;
        break;
      }
      if (c === '/' && src[j + 1] === '>') {
        selfClose = true;
        j += 2;
        break;
      }
      let k = j;
      while (k < len && !/[\s=/>]/.test(src[k])) k++;
      const name = src.slice(j, k);
      j = k;
      while (j < len && /\s/.test(src[j])) j++;
      let value = '';
      if (src[j] === '=') {
        j++;
        while (j < len && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, j + 1);
          value = src.slice(j + 1, end < 0 ? len : end);
          j = end < 0 ? len : end + 1;
        } else {
          let e = j;
          while (e < len && !/[\s>]/.test(src[e])) e++;
          value = src.slice(j, e);
          j = e;
        }
      }
      if (name) attrs[name] = decodeEntities(value, entities);
      else j++; // 非法字符，跳过
    }
    i = j;

    const ns = { ...nsStack[nsStack.length - 1] };
    for (const k in attrs) {
      if (k === 'xmlns') ns[''] = attrs[k];
      else if (k.startsWith('xmlns:')) ns[k.slice(6)] = attrs[k];
    }
    const colon = rawName.indexOf(':');
    const prefix = colon > 0 ? rawName.slice(0, colon) : '';
    const local = colon > 0 ? rawName.slice(colon + 1) : rawName;
    const tag = ns[prefix] === SVG_NS ? local : rawName;
    const el: XmlElement = { kind: 'element', tag, attrs, children: [], parent: top() };
    tag !== rawName && (attrs['#raw'] = rawName);
    top().children.push(el);
    if (!selfClose) {
      stack.push(el);
      nsStack.push(ns);
      // 原始文本元素：内容不按标签解析
      if (tag === 'style' || tag === 'script') {
        const close = src.indexOf(`</${rawName}`, i);
        const end = close < 0 ? len : close;
        const body = src.slice(i, end);
        // style 里常见 CDATA 包裹
        const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(body);
        addText(m ? m[1] : body, !!m);
        i = end;
      }
    }
  }
  return root;
}

/** 跳过 <!DOCTYPE ...> / <!ENTITY ...>，同时收集内部实体 */
function skipDeclaration(src: string, i: number, entities: Record<string, string>): number {
  const len = src.length;
  let j = i + 2;
  let depth = 0;
  while (j < len) {
    const c = src[j];
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, j + 1);
      j = end < 0 ? len : end + 1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) break;
    j++;
  }
  const body = src.slice(i, j);
  const re = /<!ENTITY\s+(?!%)([\w.:-]+)\s+(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) entities[m[1]] = decodeEntities(m[2] ?? m[3] ?? '', entities);
  return j + 1;
}

/** 元素的子元素 */
export function childElements(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.kind === 'element');
}

/** 元素的全部文本（递归） */
export function textContent(el: XmlElement): string {
  let s = '';
  for (const c of el.children) s += c.kind === 'text' ? c.text : textContent(c);
  return s;
}
