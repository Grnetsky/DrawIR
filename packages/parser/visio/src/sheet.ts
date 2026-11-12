/**
 * Visio「表单」（ShapeSheet）模型：单元格、几何段、行。
 *
 * Visio 的属性继承链：形状本身 → 母版形状（Master / MasterShape）→ 样式（LineStyle / FillStyle / TextStyle，样式本身也有继承）。
 * 几何段（Geometry Section）按 IX 合并：形状里出现的行覆盖母版同 IX 的行，Del='1' 表示删除。
 *
 * V1 把母版和形状的几何段分别生成绘图指令再拼起来，形状改了某一行就会画出两份；这里先合并成一份完整的几何再解释。
 */

export interface Cell {
  V?: string;
  U?: string;
  F?: string;
  E?: string;
}

export interface Row {
  T?: string;
  N?: string;
  IX?: string;
  Del?: string;
  cells: Record<string, Cell>;
}

export interface Section {
  N: string;
  IX?: string;
  Del?: string;
  /** 段级单元格（如 Geometry 的 NoFill / NoLine / NoShow） */
  cells: Record<string, Cell>;
  rows: Row[];
}

export interface RawShape {
  ID: string;
  Type?: string;
  Master?: string;
  MasterShape?: string;
  NameU?: string;
  Name?: string;
  LineStyle?: string;
  FillStyle?: string;
  TextStyle?: string;
  Del?: string;
  cells: Record<string, Cell>;
  sections: Section[];
  children: RawShape[];
  /** 原始 Text 元素内容（混合内容 XML 字符串） */
  text?: string;
  /** Foreign 数据关系 id */
  rel?: string;
  foreignType?: string;
  compression?: string;
}

function toCells(list: any[] | undefined): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const c of list || []) {
    if (c?.N) out[c.N] = { V: c.V, U: c.U, F: c.F, E: c.E };
  }
  return out;
}

function toRows(list: any[] | undefined): Row[] {
  return (list || []).map((r) => ({ T: r.T, N: r.N, IX: r.IX, Del: r.Del, cells: toCells(r.Cell) }));
}

export function toSections(list: any[] | undefined): Section[] {
  return (list || []).map((s) => ({ N: s.N, IX: s.IX, Del: s.Del, cells: toCells(s.Cell), rows: toRows(s.Row) }));
}

/** 把 fast-xml-parser 的 Shape 节点转成 RawShape（递归子形状） */
export function toRawShape(x: any): RawShape {
  const shape: RawShape = {
    ID: x.ID,
    Type: x.Type,
    Master: x.Master,
    MasterShape: x.MasterShape,
    NameU: x.NameU,
    Name: x.Name,
    LineStyle: x.LineStyle,
    FillStyle: x.FillStyle,
    TextStyle: x.TextStyle,
    Del: x.Del,
    cells: toCells(x.Cell),
    sections: toSections(x.Section),
    children: (x.Shapes?.Shape || []).map(toRawShape),
  };
  if (x.Text !== undefined) {
    shape.text = typeof x.Text === 'string' ? x.Text : '';
  }
  if (x.ForeignData) {
    shape.foreignType = x.ForeignData.ForeignType;
    shape.compression = x.ForeignData.CompressionType;
    shape.rel = x.ForeignData.Rel?.['r:id'];
  }
  return shape;
}

/**
 * 解析后的形状：每个属性都已按继承链求值。
 */
export class Sheet {
  constructor(
    public raw: RawShape,
    /** 母版对应形状（可能为空） */
    public master: Sheet | undefined,
    /** 样式查找：样式 ID → 样式表单 */
    private styles: Map<string, StyleSheet>,
  ) {}

  get id() {
    return this.raw.ID;
  }

  get type() {
    return this.raw.Type || this.master?.type || 'Shape';
  }

  get nameU() {
    return this.raw.NameU || this.master?.nameU;
  }

  /** 读取单元格的原始值（字符串）。kind 决定样式继承走哪一条 */
  cell(name: string, kind: 'line' | 'fill' | 'text' | 'any' = 'any'): Cell | undefined {
    const own = this.raw.cells[name];
    if (own && own.V !== undefined) return own;
    const m = this.master?.cell(name, kind);
    if (m) return m;
    return this.styleCell(name, kind);
  }

  private styleCell(name: string, kind: 'line' | 'fill' | 'text' | 'any'): Cell | undefined {
    const ids =
      kind === 'line'
        ? [this.raw.LineStyle]
        : kind === 'fill'
          ? [this.raw.FillStyle]
          : kind === 'text'
            ? [this.raw.TextStyle]
            : [this.raw.LineStyle, this.raw.FillStyle, this.raw.TextStyle];
    for (const id of ids) {
      if (id === undefined) continue;
      const c = this.styles.get(id)?.cell(name, kind);
      if (c) return c;
    }
    // 形状没写样式时用母版形状的样式
    if (ids.every((id) => id === undefined) && this.master) {
      return this.master.styleCell(name, kind);
    }
    return undefined;
  }

  num(name: string, def = 0, kind: 'line' | 'fill' | 'text' | 'any' = 'any') {
    const v = this.cell(name, kind)?.V;
    if (v === undefined || v === '' || v === 'Themed') return def;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : def;
  }

  str(name: string, kind: 'line' | 'fill' | 'text' | 'any' = 'any') {
    return this.cell(name, kind)?.V;
  }

  /** 合并后的段（同名同 IX 的段：形状覆盖母版，行按 IX 合并） */
  sections(name: string): Section[] {
    const own = this.raw.sections.filter((s) => s.N === name);
    const inherited = this.master?.sections(name) || [];
    if (!own.length) return inherited;
    const byIx = new Map<string, Section>();
    inherited.forEach((s, i) => byIx.set(s.IX ?? String(i), s));
    const result: Section[] = [];
    const seen = new Set<string>();
    for (const [key, base] of byIx) {
      const o = own.find((s, i) => (s.IX ?? String(i)) === key);
      seen.add(key);
      if (o?.Del === '1') continue;
      result.push(o ? mergeSection(base, o) : base);
    }
    own.forEach((s, i) => {
      const key = s.IX ?? String(i);
      if (!seen.has(key) && s.Del !== '1') result.push(s);
    });
    // Geometry 段按 IX 排序（Geometry1、Geometry2 …）
    return result.sort((a, b) => (+(a.IX ?? 0) || 0) - (+(b.IX ?? 0) || 0));
  }

  /** 读取某个段里某一行（按 N 或 IX） */
  row(section: string, key: { N?: string; IX?: string }): Row | undefined {
    for (const s of this.sections(section)) {
      const r = s.rows.find((r) => (key.N !== undefined ? r.N === key.N : r.IX === key.IX));
      if (r) return r;
    }
    return undefined;
  }
}

function mergeSection(base: Section, over: Section): Section {
  const rows: Row[] = [];
  const keyOf = (r: Row, i: number) => r.IX ?? r.N ?? String(i);
  const overMap = new Map(over.rows.map((r, i) => [keyOf(r, i), r]));
  const used = new Set<string>();
  base.rows.forEach((r, i) => {
    const k = keyOf(r, i);
    const o = overMap.get(k);
    used.add(k);
    if (o?.Del === '1') return;
    rows.push(o ? { ...r, ...o, T: o.T || r.T, cells: { ...r.cells, ...o.cells } } : r);
  });
  over.rows.forEach((r, i) => {
    const k = keyOf(r, i);
    !used.has(k) && r.Del !== '1' && rows.push(r);
  });
  rows.sort((a, b) => (+(a.IX ?? 0) || 0) - (+(b.IX ?? 0) || 0));
  return { ...base, ...over, cells: { ...base.cells, ...over.cells }, rows };
}

/** 文档样式表（StyleSheet），同样有继承 */
export class StyleSheet {
  constructor(
    public raw: any,
    private styles: Map<string, StyleSheet>,
    private cells = toCells(raw.Cell),
    public sections = toSections(raw.Section),
  ) {}

  cell(name: string, kind: 'line' | 'fill' | 'text' | 'any', depth = 0): Cell | undefined {
    const c = this.cells[name];
    if (c && c.V !== undefined) return c;
    if (depth > 16) return undefined;
    const parent =
      kind === 'line'
        ? this.raw.LineStyle
        : kind === 'fill'
          ? this.raw.FillStyle
          : kind === 'text'
            ? this.raw.TextStyle
            : this.raw.LineStyle ?? this.raw.FillStyle ?? this.raw.TextStyle;
    if (parent === undefined || parent === this.raw.ID) return undefined;
    return this.styles.get(parent)?.cell(name, kind, depth + 1);
  }
}
