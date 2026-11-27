import { estimateTextWidth } from '@drawir/core';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Mermaid 默认允许少量 HTML 标签；图元文字只保留文本与换行 */
export function mermaidText(value: string | undefined) {
  let s = (value || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/\\n/g, '\n');
  s = s.replace(/<[^>]*>/g, '');
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, key) => {
    if (key[0] === '#') {
      const n = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[key.toLowerCase()] ?? all;
  });
}

export function wrapMermaidText(text: string, maxWidth: number, fontSize: number, fontFamily?: string) {
  const out: string[] = [];
  for (const line of mermaidText(text).split('\n')) {
    if (estimateTextWidth(line, fontSize) <= maxWidth || !line) {
      out.push(line);
      continue;
    }
    let current = '';
    for (const char of line) {
      if (current && estimateTextWidth(current + char, fontSize) > maxWidth) {
        out.push(current.trimEnd());
        current = /\s/.test(char) ? '' : char;
      } else current += char;
    }
    current && out.push(current.trimEnd());
  }
  return out.join('\n');
}

export function textSize(text: string, fontSize: number, lineHeight = 1.5, fontFamily?: string) {
  const lines = mermaidText(text).split('\n');
  return {
    width: Math.max(0, ...lines.map((line) => estimateTextWidth(line, fontSize))),
    height: Math.max(1, lines.length) * fontSize * lineHeight,
  };
}
