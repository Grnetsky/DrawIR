/**
 * kiwi 二进制消息解码（https://github.com/evanw/kiwi 的格式）。
 *
 * .fig 文件自带 schema，因此这里只实现「读二进制 schema + 按 schema 解释消息」，
 * 不需要硬编码 Figma 的字段表，也不使用 `new Function` 生成代码（可在严格 CSP 下运行）。
 */

export interface KiwiField {
  name: string;
  type: string;
  isArray: boolean;
  value: number;
}

export interface KiwiDefinition {
  name: string;
  kind: 'ENUM' | 'STRUCT' | 'MESSAGE';
  fields: KiwiField[];
}

export interface KiwiSchema {
  definitions: KiwiDefinition[];
  byName: Map<string, KiwiDefinition>;
}

const KINDS = ['ENUM', 'STRUCT', 'MESSAGE'] as const;
const BUILTINS = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder() : undefined;

export class ByteReader {
  index = 0;
  constructor(public data: Uint8Array) {}

  private need(n: number) {
    if (this.index + n > this.data.length) throw new Error('kiwi：数据意外结束');
  }

  byte(): number {
    this.need(1);
    return this.data[this.index++];
  }

  bool(): boolean {
    const v = this.byte();
    if (v > 1) throw new Error('kiwi：无效的 bool');
    return v === 1;
  }

  bytes(): Uint8Array {
    const n = this.varUint();
    this.need(n);
    const out = this.data.subarray(this.index, this.index + n);
    this.index += n;
    return out;
  }

  varUint(): number {
    let value = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.byte();
      value |= (b & 127) << shift;
      shift += 7;
    } while (b & 128 && shift < 35);
    return value >>> 0;
  }

  varInt(): number {
    const v = this.varUint();
    return v & 1 ? ~(v >>> 1) : v >>> 1;
  }

  varUint64(): number {
    // JS number 精度只到 2^53，Figma 中此类字段用不到更高位
    let value = 0;
    let scale = 1;
    let b: number;
    let i = 0;
    do {
      b = this.byte();
      value += (b & 127) * scale;
      scale *= 128;
    } while (b & 128 && ++i < 9);
    return value;
  }

  varInt64(): number {
    const v = this.varUint64();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }

  varFloat(): number {
    this.need(1);
    const d = this.data;
    const i = this.index;
    if (d[i] === 0) {
      this.index++;
      return 0;
    }
    this.need(4);
    let bits = d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24);
    this.index += 4;
    // 编码时把指数位移到了最低字节，这里还原
    bits = (bits << 23) | (bits >>> 9);
    u32[0] = bits;
    return f32[0];
  }

  string(): string {
    const d = this.data;
    const start = this.index;
    let end = start;
    while (end < d.length && d[end] !== 0) end++;
    if (end >= d.length) throw new Error('kiwi：字符串未结束');
    this.index = end + 1;
    const slice = d.subarray(start, end);
    if (utf8) return utf8.decode(slice);
    let s = '';
    for (let k = 0; k < slice.length; k++) s += String.fromCharCode(slice[k]);
    return decodeURIComponent(escape(s));
  }
}

export function decodeSchema(data: Uint8Array): KiwiSchema {
  const r = new ByteReader(data);
  const count = r.varUint();
  const raw: { name: string; kind: number; fields: { name: string; type: number; isArray: boolean; value: number }[] }[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.string();
    const kind = r.byte();
    const n = r.varUint();
    const fields = [];
    for (let j = 0; j < n; j++) {
      const fname = r.string();
      const type = r.varInt();
      const isArray = !!(r.byte() & 1);
      const value = r.varUint();
      fields.push({ name: fname, type, isArray, value });
    }
    raw.push({ name, kind, fields });
  }
  const definitions: KiwiDefinition[] = raw.map((d) => {
    const kind = KINDS[d.kind];
    if (!kind) throw new Error(`kiwi：未知的定义类型 ${d.kind}`);
    return {
      name: d.name,
      kind,
      fields: d.fields.map((f) => {
        const type = kind === 'ENUM' ? '' : f.type < 0 ? BUILTINS[~f.type] : raw[f.type]?.name;
        if (type === undefined) throw new Error(`kiwi：字段 ${d.name}.${f.name} 类型无效`);
        return { name: f.name, type, isArray: f.isArray, value: f.value };
      }),
    };
  });
  return { definitions, byName: new Map(definitions.map((d) => [d.name, d])) };
}

/** 按 schema 解码一条消息为普通对象（枚举值为字符串，byte[] 为 Uint8Array） */
export function decodeMessage(schema: KiwiSchema, data: Uint8Array, root = 'Message'): any {
  const def = schema.byName.get(root);
  if (!def) throw new Error(`kiwi：schema 中没有 ${root}`);
  const r = new ByteReader(data);
  const enumMaps = new Map<KiwiDefinition, Map<number, string>>();
  const fieldMaps = new Map<KiwiDefinition, Map<number, KiwiField>>();

  const readValue = (type: string): any => {
    switch (type) {
      case 'bool':
        return r.bool();
      case 'byte':
        return r.byte();
      case 'int':
        return r.varInt();
      case 'uint':
        return r.varUint();
      case 'float':
        return r.varFloat();
      case 'string':
        return r.string();
      case 'int64':
        return r.varInt64();
      case 'uint64':
        return r.varUint64();
    }
    const d = schema.byName.get(type)!;
    if (d.kind === 'ENUM') {
      let m = enumMaps.get(d);
      if (!m) enumMaps.set(d, (m = new Map(d.fields.map((f) => [f.value, f.name]))));
      const v = r.varUint();
      return m.get(v) ?? v;
    }
    return readObject(d);
  };

  const readField = (f: KiwiField): any => {
    if (!f.isArray) return readValue(f.type);
    if (f.type === 'byte') return r.bytes();
    const n = r.varUint();
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = readValue(f.type);
    return out;
  };

  const readObject = (d: KiwiDefinition): any => {
    const obj: any = {};
    if (d.kind === 'STRUCT') {
      for (const f of d.fields) obj[f.name] = readField(f);
      return obj;
    }
    let m = fieldMaps.get(d);
    if (!m) fieldMaps.set(d, (m = new Map(d.fields.map((f) => [f.value, f]))));
    for (;;) {
      const tag = r.varUint();
      if (tag === 0) return obj;
      const f = m.get(tag);
      if (!f) throw new Error(`kiwi：${d.name} 中出现未知字段 #${tag}`);
      obj[f.name] = readField(f);
    }
  };

  return readObject(def);
}
