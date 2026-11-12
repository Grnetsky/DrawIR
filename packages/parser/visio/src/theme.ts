import type { VsdxPackage } from './package';

/**
 * 主题颜色。单元格值为 'Themed' 或公式 THEMEVAL("AccentColor4") 时按主题取色；
 * 文件里大多数单元格已经带了计算好的 V 值，这里只兜底没有 V 值的情况。
 */
export interface Theme {
  colors: Record<string, string>;
  /** 文档背景 */
  background?: string;
  /** 变体配色（vt:variationClrScheme，每组 7 色），QuickStyle 颜色 100-106 / 200-206 取自这里 */
  variations: string[][];
  /** 主题填充样式列表（a:fillStyleLst 里的纯色），QuickStyleFillMatrix 1-6 取自这里 */
  fillStyles: (string | undefined)[];
  /** 填充样式的颜色表达式（vt:fillStyles，可引用 phClr），与 fillStyles 一一对应 */
  fillExprs: (ColorExpr | undefined)[];
  /** 文字样式的颜色表达式（vt:fontStyles），QuickStyleFontMatrix 1-6 取自这里 */
  fontExprs: (ColorExpr | undefined)[];
  /** 变体样式表（vt:variationStyleScheme）：矩阵值 100-103 → 第 n 个 varStyle 的 fillIdx / fontIdx */
  varStyles: { fill: number; font: number; line: number }[][];
}

/** 主题颜色表达式：基色（srgb / 主题色名 / phClr 占位色）+ tint / shade 调整 */
export interface ColorExpr {
  base: string;
  tint?: number;
  shade?: number;
}

function parseExpr(xml: string): ColorExpr | undefined {
  const srgb = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(xml)?.[1];
  const scheme = /<a:schemeClr val="(\w+)"/.exec(xml)?.[1];
  const base = srgb ? '#' + srgb.toUpperCase() : scheme;
  if (!base) return undefined;
  const tint = /<a:tint val="(\d+)"/.exec(xml)?.[1];
  const shade = /<a:shade val="(\d+)"/.exec(xml)?.[1];
  return { base, tint: tint ? +tint / 100000 : undefined, shade: shade ? +shade / 100000 : undefined };
}

/** 求颜色表达式的值。phClr 是「占位色」，即形状的 QuickStyle 颜色 */
export function evalColor(e: ColorExpr | undefined, theme: Theme, phClr: string | undefined): string | undefined {
  if (!e) return undefined;
  let c = e.base.startsWith('#') ? e.base : e.base === 'phClr' ? phClr : theme.colors[e.base] || theme.colors[SCHEME_ALIAS[e.base]];
  if (!c) return undefined;
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(c!.slice(i, i + 2), 16));
  // DrawingML：tint 向白色混合，shade 向黑色混合（线性近似）
  if (e.tint !== undefined) [r, g, b] = [r, g, b].map((v) => v * e.tint! + 255 * (1 - e.tint!));
  if (e.shade !== undefined) [r, g, b] = [r, g, b].map((v) => v * e.shade!);
  c = '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  return c;
}

const SCHEME_ALIAS: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };

const DEFAULT: Record<string, string> = {
  dk1: '#000000',
  lt1: '#FFFFFF',
  dk2: '#44546A',
  lt2: '#E7E6E6',
  accent1: '#5B9BD5',
  accent2: '#ED7D31',
  accent3: '#A5A5A5',
  accent4: '#FFC000',
  accent5: '#4472C4',
  accent6: '#70AD47',
};

export function readTheme(pkg: VsdxPackage): Theme {
  const path = pkg.list().find((n) => /^visio\/theme\/theme\d*\.xml$/.test(n));
  const colors = { ...DEFAULT };
  let background: string | undefined;
  const text = path && pkg.text(path);
  if (text) {
    const scheme = /<a:clrScheme[\s\S]*?<\/a:clrScheme>/.exec(text)?.[0] || '';
    for (const key of Object.keys(DEFAULT)) {
      const m = new RegExp(`<a:${key}>[\\s\\S]*?(?:srgbClr val="([0-9A-Fa-f]{6})"|lastClr="([0-9A-Fa-f]{6})")`).exec(scheme);
      const v = m?.[1] || m?.[2];
      v && (colors[key] = '#' + v.toUpperCase());
    }
    const bg = /<vt:bkgnd[^>]*>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(scheme)?.[1];
    bg && (background = '#' + bg.toUpperCase());
  }
  // 变体配色与填充样式（规则参照 LibreOffice libvisio 的 VSDXTheme）
  const variations: string[][] = [];
  const fillStyles: (string | undefined)[] = [];
  if (text) {
    const color = (xml: string) => {
      const m = /srgbClr val="([0-9A-Fa-f]{6})"|lastClr="([0-9A-Fa-f]{6})"/.exec(xml);
      const v = m?.[1] || m?.[2];
      return v ? '#' + v.toUpperCase() : undefined;
    };
    for (const vs of text.match(/<vt:variationClrScheme\b[\s\S]*?<\/vt:variationClrScheme>/g) || []) {
      const list: string[] = [];
      for (let i = 1; i <= 7; i++) {
        const m = new RegExp(`<vt:varColor${i}>([\\s\\S]*?)<\\/vt:varColor${i}>`).exec(vs);
        list.push((m && color(m[1])) || '');
      }
      variations.push(list);
    }
    const fsl = /<a:fillStyleLst>([\s\S]*?)<\/a:fillStyleLst>/.exec(text)?.[1] || '';
    // 只取直接子元素：solidFill / gradFill / pattFill / blipFill / noFill
    const re = /<a:(solidFill|gradFill|pattFill|blipFill|noFill)\b[\s\S]*?(?:<\/a:\1>|\/>)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fsl))) {
      fillStyles.push(m[1] === 'solidFill' ? color(m[0]) : undefined);
    }
  }
  // Visio 扩展的样式表：填充 / 文字颜色可引用 phClr，变体样式表把矩阵值 100+ 映射到具体样式序号
  const fillExprs: (ColorExpr | undefined)[] = [];
  const fontExprs: (ColorExpr | undefined)[] = [];
  const varStyles: { fill: number; font: number; line: number }[][] = [];
  if (text) {
    const fills = /<vt:fillStyles>([\s\S]*?)<\/vt:fillStyles>/.exec(text)?.[1] || '';
    for (const fp of fills.match(/<vt:fillProps\b[\s\S]*?<\/vt:fillProps>/g) || []) fillExprs.push(parseExpr(fp));
    const fonts = /<vt:fontStyles>([\s\S]*?)<\/vt:fontStyles>/.exec(text)?.[1] || '';
    for (const fp of fonts.match(/<vt:fontProps\b[\s\S]*?<\/vt:fontProps>/g) || []) fontExprs.push(parseExpr(fp));
    for (const sch of text.match(/<vt:variationStyleScheme\b[\s\S]*?<\/vt:variationStyleScheme>/g) || []) {
      const list: { fill: number; font: number; line: number }[] = [];
      for (const m of sch.matchAll(/<vt:varStyle fillIdx="(\d+)" lineIdx="(\d+)" effectIdx="\d+" fontIdx="(\d+)"/g)) {
        list.push({ fill: +m[1], line: +m[2], font: +m[3] });
      }
      varStyles.push(list);
    }
  }
  // a:fillStyleLst 里引用 phClr 的条目（如 shade 75%）也记成表达式，作为 vt:fillStyles 缺失时的兜底
  if (text && !fillExprs.length) {
    const fsl = /<a:fillStyleLst>([\s\S]*?)<\/a:fillStyleLst>/.exec(text)?.[1] || '';
    for (const m of fsl.match(/<a:(solidFill|gradFill|pattFill|blipFill|noFill)\b[\s\S]*?(?:<\/a:\1>|\/>)/g) || []) fillExprs.push(parseExpr(m));
  }
  return { colors, background, variations, fillStyles, fillExprs, fontExprs, varStyles };
}

/**
 * QuickStyle 矩阵值 → 样式序号（1 起）。1-6 直接是序号；100-103 查变体样式表的第 0-3 项。
 */
export function matrixIndex(theme: Theme, value: number, kind: 'fill' | 'font' | 'line', variation = 0): number | undefined {
  if (!(value > 0)) return undefined;
  if (value < 100) return value;
  const list = theme.varStyles[variation] || theme.varStyles[0];
  const v = list?.[value % 100];
  return v ? v[kind] : undefined;
}

/**
 * QuickStyle 颜色编号 → 颜色（libvisio getThemeColour）：
 * 0 dk1、1 lt1、2-7 accent1-6、8 背景；100-106 / 200-206 为当前变体的第 1-7 色。
 */
export function quickStyleColor(theme: Theme, value: number, variation = 0): string | undefined {
  if (!(value >= 0)) return undefined;
  if (value < 100) {
    const keys = ['dk1', 'lt1', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
    if (value === 8) return theme.background || theme.colors.lt1;
    return keys[value] ? theme.colors[keys[value]] : undefined;
  }
  if (!theme.variations.length) return undefined;
  const list = theme.variations[variation] || theme.variations[0];
  const i = value % 100;
  return i <= 6 ? list[i] || undefined : undefined;
}

/** Visio 颜色索引（0-23） */
const INDEX = [
  '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF',
  '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#C0C0C0', '#E6E6E6',
  '#CDCDCD', '#B3B3B3', '#9A9A9A', '#808080', '#666666', '#4D4D4D', '#333333', '#1A1A1A',
];

const THEMEVAL_MAP: Record<string, string> = {
  AccentColor: 'accent1',
  AccentColor2: 'accent2',
  AccentColor3: 'accent3',
  AccentColor4: 'accent4',
  AccentColor5: 'accent5',
  AccentColor6: 'accent6',
  LineColor: 'dk1',
  TextColor: 'dk1',
  FillColor: 'lt1',
  FillColor2: 'lt2',
  BackgroundColor: 'lt1',
};

/**
 * 解析颜色单元格。V 可能是 '#RRGGBB'、颜色索引数字、'Themed'；
 * F 可能是 THEMEVAL("AccentColor4") 等。
 */
export function resolveColor(v: string | undefined, f: string | undefined, theme: Theme): string | undefined {
  if (v && v.startsWith('#')) return v.toUpperCase();
  if (v && /^\d+$/.test(v)) return INDEX[+v];
  if (v === 'Themed' || (f && /THEMEVAL/i.test(f))) {
    const key = /THEMEVAL\("?(\w+)"?\)/i.exec(f || '')?.[1];
    const k = key && THEMEVAL_MAP[key];
    return k ? theme.colors[k] : undefined;
  }
  // RGB(r,g,b)
  const m = /RGB\((\d+),\s*(\d+),\s*(\d+)\)/i.exec(v || f || '');
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('').toUpperCase();
  return undefined;
}

/** 颜色 + 透明度（0-1，1 = 全透明）→ CSS */
export function withAlpha(hex: string | undefined, trans: number) {
  if (!hex) return undefined;
  if (!(trans > 0)) return hex;
  if (trans >= 1) return 'none';
  const a = Math.round((1 - trans) * 255)
    .toString(16)
    .padStart(2, '0');
  return hex.length === 7 ? hex + a.toUpperCase() : hex;
}
