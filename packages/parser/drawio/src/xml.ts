/**
 * 极简 XML 读取器。
 *
 * draw.io 文件只用到元素、属性和少量文本（压缩后的 diagram 内容），但要求：
 * - 保留兄弟元素的原始顺序（mxCell 与 UserObject 交错，顺序即绘制顺序）；
 * - 属性里的实体（`&lt;`、`&#xa;` 等）只解码一次（HTML 标签存放在 value 属性中）。
 * 通用 XML 库在这两点上都需要额外配置，这里直接手写，几十行即可，且不依赖 DOM。
 */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** 解析 XML 文本，返回虚拟根节点（tag = '#document'） */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      top.text += src.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
    } else if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const e = src.indexOf('>', lt);
      i = e < 0 ? n : e + 1;
    } else if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const name = src.slice(lt + 2, e < 0 ? n : e).trim();
      // 容错：弹出到同名元素为止
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      i = e < 0 ? n : e + 1;
    } else {
      // 找到标签结束的 '>'，跳过引号内的内容
      let j = lt + 1;
      let quote = '';
      for (; j < n; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      let body = src.slice(lt + 1, j);
      const selfClose = body.endsWith('/');
      if (selfClose) body = body.slice(0, -1);
      const m = /^[^\s/>]+/.exec(body);
      const node: XmlNode = { tag: m ? m[0] : '', attrs: {}, children: [], text: '' };
      ATTR.lastIndex = node.tag.length;
      let a: RegExpExecArray | null;
      while ((a = ATTR.exec(body))) node.attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
      top.children.push(node);
      if (!selfClose) stack.push(node);
      i = j + 1;
    }
  }
  return root;
}

export function child(node: XmlNode | undefined, tag: string): XmlNode | undefined {
  return node?.children.find((c) => c.tag === tag);
}
