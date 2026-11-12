/**
 * MTEXT 格式码解析（\P 换行、\f 字体、\C 颜色、\H 字高、\W 宽度、{} 分组、%%c 等特殊字符）。
 *
 * V1 只认一种固定的开头格式（\fxxx|b0|i0|c0|p0;），其余格式码原样显示在画面上。这里按 AutoCAD 规范
 * 剥离所有格式码，保留文字和最常用的样式（首个颜色、粗斜体、宽度因子、字高比例）。
 * 富文本的逐段样式在 CAD 图纸里很少用到，统一到整段，换取 IR 简单。
 */
export interface ParsedMText {
  text: string;
  font?: string;
  bold?: boolean;
  italic?: boolean;
  /** \C 颜色索引 */
  aci?: number;
  /** \c 真彩色 */
  rgb?: number;
  /** \W 宽度因子 */
  widthFactor?: number;
  /** \H 字高：绝对值或倍数（以 x 结尾） */
  height?: number;
  heightIsFactor?: boolean;
}

const SPECIAL: Record<string, string> = {
  c: 'Ø',
  d: '°',
  p: '±',
  '%': '%',
};

/** 替换 %%c %%d %%p %%nnn 以及 \U+XXXX */
export function decodeSpecial(s: string) {
  return s
    .replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(+n))
    .replace(/%%([cdp%])/gi, (_, c) => SPECIAL[c.toLowerCase()] ?? '')
    .replace(/%%[ou]/gi, '') // 上划线/下划线开关
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\M\+[0-9a-fA-F](\d{4})?/g, '');
}

export function parseMText(raw: string): ParsedMText {
  const out: ParsedMText = { text: '' };
  let text = '';
  const s = raw || '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' || ch === '}') {
      continue;
    }
    if (ch !== '\\') {
      text += ch;
      continue;
    }
    const code = s[i + 1];
    if (code === undefined) break;
    switch (code) {
      case 'P':
      case 'X':
        text += '\n';
        i++;
        break;
      case '~':
        text += ' ';
        i++;
        break;
      case '\\':
      case '{':
      case '}':
        text += code;
        i++;
        break;
      case 'L':
      case 'l':
      case 'O':
      case 'o':
      case 'K':
      case 'k':
        // 下划线/上划线/删除线开关：不渲染
        i++;
        break;
      case 'S': {
        // 堆叠分数 \S1^2; / \S1/2; / \S1#2;
        const end = s.indexOf(';', i);
        const body = end > 0 ? s.slice(i + 2, end) : s.slice(i + 2);
        text += body.replace(/[\^#]/g, '/');
        i = end > 0 ? end : s.length;
        break;
      }
      default: {
        // 其余带参数的格式码，以 ; 结束
        const end = s.indexOf(';', i);
        if (end < 0) {
          i++;
          break;
        }
        const arg = s.slice(i + 2, end);
        switch (code) {
          case 'f':
          case 'F': {
            const [font, ...flags] = arg.split('|');
            out.font === undefined && font && (out.font = font);
            for (const f of flags) {
              if (f === 'b1') out.bold = true;
              if (f === 'i1') out.italic = true;
            }
            break;
          }
          case 'C':
            out.aci === undefined && (out.aci = parseInt(arg, 10));
            break;
          case 'c':
            out.rgb === undefined && (out.rgb = parseInt(arg, 10));
            break;
          case 'W':
            out.widthFactor === undefined && (out.widthFactor = parseFloat(arg));
            break;
          case 'H':
            if (out.height === undefined) {
              out.heightIsFactor = /x$/i.test(arg);
              out.height = parseFloat(arg);
            }
            break;
          // \A 对齐、\Q 倾斜、\T 字距、\p 段落：忽略
        }
        i = end;
      }
    }
  }
  out.text = decodeSpecial(text).replace(/\n+$/, '');
  return out;
}

/** TEXT / ATTRIB 单行文字只需处理特殊字符（单行文字不支持 MTEXT 格式码） */
export function parseSingleLineText(raw: string) {
  return decodeSpecial(raw || '');
}
