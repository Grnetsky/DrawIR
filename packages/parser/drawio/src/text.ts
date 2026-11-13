import { decodeEntities } from './xml';

const BLOCK = /^(div|p|li|ul|ol|h[1-6]|tr|table|blockquote|pre|hr)$/i;

/**
 * HTML 标签（html=1 的 value）→ 纯文本，保留换行。
 * 块级元素在非行首时换行，`<br>` 总是换行，其余标签剥离，空白按 HTML 规则折叠。
 */
export function htmlToText(html: string): string {
  let out = '';
  const parts = html.split(/(<[^>]*>)/);
  let skip = 0; // <style>/<script> 内容
  for (const part of parts) {
    if (!part) continue;
    if (part[0] === '<') {
      const m = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(part);
      if (!m) continue;
      const close = !!m[1];
      const tag = m[2].toLowerCase();
      if (tag === 'style' || tag === 'script') {
        skip += close ? -1 : 1;
      } else if (tag === 'br') {
        out += '\n';
      } else if (BLOCK.test(tag)) {
        if (out && !out.endsWith('\n')) out += '\n';
      }
      continue;
    }
    if (skip > 0) continue;
    // 先折叠源码空白，再解码实体（&nbsp; 不参与折叠）
    let t = part.replace(/[ \t\r\n]+/g, ' ');
    if (out === '' || out.endsWith('\n')) t = t.replace(/^ /, '');
    out += decodeEntities(t);
  }
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** 占位符 `%name%` 替换（placeholders=1 或 UserObject 标签） */
export function fillPlaceholders(text: string, attrs: Record<string, string>): string {
  return text.replace(/%([A-Za-z0-9_\-.]+)%/g, (m, k) => (k in attrs ? attrs[k] : m));
}
