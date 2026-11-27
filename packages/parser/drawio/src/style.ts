import type { VectorColor } from '@drawir/core';

/** 解析后的 draw.io 样式：`key=value;key2=value2;namedStyle` → 键值表 */
export type Style = Record<string, string>;

/**
 * 内置命名样式（draw.io 默认样式表 default.xml 的子集）。
 * 样式串中不带 `=` 的段是命名样式，先合并命名样式，再被显式键值覆盖。
 */
const NAMED: Record<string, Style> = {
  text: { fillColor: 'none', strokeColor: 'none', align: 'left', verticalAlign: 'top' },
  edgeLabel: {
    fillColor: 'none',
    strokeColor: 'none',
    labelBackgroundColor: 'default',
    align: 'center',
    verticalAlign: 'middle',
    fontSize: '11',
  },
  label: { fontStyle: '1', align: 'left', verticalAlign: 'middle', spacing: '2', spacingLeft: '52', imageWidth: '42', imageHeight: '42' },
  icon: { shape: 'label', align: 'center', verticalAlign: 'top', verticalLabelPosition: 'bottom' },
  swimlane: { shape: 'swimlane', fontSize: '12', fontStyle: '1', startSize: '23' },
  group: { verticalAlign: 'top', fillColor: 'none', strokeColor: 'none', gradientColor: 'none' },
  ellipse: { shape: 'ellipse', perimeter: 'ellipsePerimeter' },
  doubleEllipse: { shape: 'doubleEllipse', perimeter: 'ellipsePerimeter' },
  rhombus: { shape: 'rhombus', perimeter: 'rhombusPerimeter' },
  triangle: { shape: 'triangle', perimeter: 'trianglePerimeter' },
  line: { shape: 'line', strokeWidth: '4', labelBackgroundColor: 'default', verticalAlign: 'top', spacingTop: '8' },
  image: { shape: 'image', verticalLabelPosition: 'bottom', verticalAlign: 'top' },
};

export function parseStyle(src: string | undefined, isShapeName?: (name: string) => boolean): Style {
  const out: Style = {};
  if (!src) return out;
  const own: Style = {};
  for (const part of src.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) {
      const named = NAMED[part];
      if (named) Object.assign(out, named);
      else if (isShapeName?.(part)) out.shape = part;
    } else {
      own[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return Object.assign(out, own);
}

export function num(v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

export function flag(v: string | undefined, def = false): boolean {
  if (v === undefined || v === '') return def;
  return v === '1' || v === 'true';
}

/**
 * draw.io 颜色 → IR 颜色。
 * - `default`：随主题，描边/文字 → `$fg`，填充 → `$bg`
 * - `light-dark(a, b)`：取浅色主题的 a
 * - `none` → `'none'`；`inherit` 等无法解析的值 → 缺省值
 */
export function color(v: string | undefined, def: VectorColor | undefined, kind: 'fg' | 'bg'): VectorColor | undefined {
  if (v === undefined) return def;
  v = v.trim();
  if (!v) return def;
  if (v === 'none' || v === 'transparent') return 'none';
  if (v === 'default') return kind === 'fg' ? '$fg' : '$bg';
  const ld = /^light-dark\(\s*([^,]+?)\s*,/i.exec(v);
  if (ld) return color(ld[1], def, kind);
  if (v === 'inherit' || v === 'swimlane' || v === 'indicated') return def;
  return v;
}

/** 为固定颜色附加透明度（0~1）；动态颜色无法附加，交给 style.alpha */
export function withAlpha(c: VectorColor | undefined, alpha: number): VectorColor | undefined {
  if (!c || alpha >= 1 || c === 'none' || c[0] === '$') return c;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (!hex) return c;
  let h = hex[1];
  if (h.length === 3) h = h.replace(/./g, (x) => x + x);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${+alpha.toFixed(3)})`;
}
