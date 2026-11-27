import type {
  SymFillCell,
  SymFontParam,
  SymLineCell,
  SymPoint,
  SymPointCell,
  SymSource,
  SymSymbol,
  SymSymbolTemplate,
} from './types';

export const SYM_VERSION = 'EP Version 1.0';

class Reader {
  private view: DataView;
  position = 0;

  constructor(public readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining() {
    return this.data.byteLength - this.position;
  }

  need(size: number, what = '字段') {
    if (!Number.isInteger(size) || size < 0 || this.position + size > this.data.byteLength) {
      throw new Error(`SYM 数据损坏：读取${what}时超出记录边界（偏移 ${this.position}，长度 ${size}）`);
    }
  }

  u8() {
    this.need(1);
    return this.data[this.position++];
  }

  u32() {
    this.need(4, 'uint32');
    const value = this.view.getUint32(this.position, true);
    this.position += 4;
    return value;
  }

  i32() {
    this.need(4, 'int32');
    const value = this.view.getInt32(this.position, true);
    this.position += 4;
    return value;
  }

  f32() {
    this.need(4, 'float32');
    const value = this.view.getFloat32(this.position, true);
    this.position += 4;
    return value;
  }

  f64() {
    this.need(8, 'float64');
    const value = this.view.getFloat64(this.position, true);
    this.position += 8;
    return value;
  }

  bool() {
    return this.u8() === 1;
  }

  string(length = this.i32()) {
    this.need(length, 'GBK 字符串');
    const bytes = this.data.subarray(this.position, this.position + length);
    this.position += length;
    return new TextDecoder('gbk').decode(bytes).replace(/\0+$/, '');
  }

  count(value: number, minRecordSize: number, what: string) {
    if (value > Math.floor(this.remaining / minRecordSize)) {
      throw new Error(`SYM 数据损坏：${what}数量 ${value} 超出记录剩余长度`);
    }
    return value;
  }

  end(what: string) {
    if (this.remaining === 1 && this.data[this.position] === 0) {
      this.position++;
      return;
    }
    if (this.remaining !== 0) {
      throw new Error(`SYM ${what}解析后仍有 ${this.remaining} 字节，记录结构不匹配`);
    }
  }
}

function pointHeader(r: Reader): SymPointCell {
  return { kind: 'point', type: r.u32(), color: r.u32(), colorLocked: r.bool() };
}

function surfaceHeader(r: Reader, cell: SymPointCell) {
  cell.fillStyle = r.u32();
  cell.fillColor = r.u32();
}

function points(r: Reader, cell: SymPointCell) {
  cell.width = r.f64();
  const count = r.count(r.u32(), 16, '点');
  cell.points = Array.from({ length: count }, (): SymPoint => ({ x: r.f64(), y: r.f64() }));
}

function ellipseArc(r: Reader, cell: SymPointCell, surface: boolean) {
  if (surface) surfaceHeader(r, cell);
  cell.width = r.f64();
  cell.angle = r.f64();
  cell.startAngle = r.f64();
  cell.endAngle = r.f64();
  cell.longAxis = r.f64();
  cell.shortAxis = r.f64();
  cell.offsetX = r.f64();
  cell.offsetY = r.f64();
}

function font(r: Reader): SymFontParam {
  const result: SymFontParam = {
    height: r.f32(),
    width: r.f32(),
    escapement: r.i32(),
    orientation: r.i32(),
    weight: r.i32(),
    italic: r.bool(),
    underline: r.bool(),
    strikeOut: r.bool(),
    charSet: r.i32(),
    faceName: '',
  };
  r.u8();
  r.u8();
  r.u8();
  r.u8();
  result.faceName = r.string();
  return result;
}

export function readPointCell(r: Reader): SymPointCell {
  const cell = pointHeader(r);
  switch (cell.type) {
    case 1:
      cell.offsetX = r.f64();
      cell.offsetY = r.f64();
      cell.size = r.f64();
      break;
    case 2:
      cell.startX = r.f64();
      cell.startY = r.f64();
      cell.endX = r.f64();
      cell.endY = r.f64();
      cell.width = r.f64();
      break;
    case 3:
    case 5:
      points(r, cell);
      break;
    case 4:
    case 6:
    case 9:
      surfaceHeader(r, cell);
      points(r, cell);
      break;
    case 7:
      ellipseArc(r, cell, false);
      break;
    case 8:
      surfaceHeader(r, cell);
      cell.width = r.f64();
      cell.offsetX = r.f64();
      cell.offsetY = r.f64();
      cell.longAxis = r.f64();
      cell.shortAxis = r.f64();
      cell.angle = r.f64();
      break;
    case 10:
    case 11:
      ellipseArc(r, cell, true);
      break;
    case 12:
      surfaceHeader(r, cell);
      cell.longAxis = r.f64();
      cell.shortAxis = r.f64();
      cell.angle = r.f64();
      cell.ratio = r.f64();
      cell.corners = r.u32();
      cell.interAngle = r.f64();
      cell.innerAngle = r.f64();
      cell.width = r.f64();
      cell.asteriskType = r.u32();
      break;
    case 13: {
      surfaceHeader(r, cell);
      const longAxis = r.f64();
      const centerX = r.f64();
      const centerY = r.f64();
      const shortAxis = r.f64();
      const width = r.f64();
      const text = r.string();
      const angle = r.f64();
      cell.textParam = { longAxis, centerX, centerY, shortAxis, width, text, angle };
      cell.fontParam = font(r);
      break;
    }
    default:
      throw new Error(`暂不支持 SYM 点图元类型 ${cell.type}（14=图片、15=组合点）`);
  }
  return cell;
}

function template(r: Reader): SymSymbolTemplate {
  const interval = r.f64();
  const count = r.count(r.u32(), 8, '线模板');
  return {
    interval,
    patternElements: Array.from({ length: count }, () => ({ mark: r.u32(), gap: r.u32() })),
  };
}

function lineProperties(r: Reader, cell: SymLineCell) {
  cell.offset = r.f64();
  cell.hasTemplate = r.i32();
  if (cell.hasTemplate === 1) cell.symbolTemplate = template(r);
}

export function readLineCell(r: Reader): SymLineCell {
  const cell: SymLineCell = { kind: 'line', type: r.u32(), width: r.f64(), color: r.u32() };
  switch (cell.type) {
    case 0:
      cell.simpleLineStyle = r.u32();
      break;
    case 2:
      lineProperties(r, cell);
      cell.cap = r.u32();
      cell.join = r.u32();
      break;
    case 3: {
      lineProperties(r, cell);
      const count = r.count(r.u32(), 9, '点线图元');
      cell.pointCells = Array.from({ length: count }, () => readPointCell(r));
      break;
    }
    case 4: {
      cell.endType = r.u32();
      cell.directionType = r.u32();
      const count = r.count(r.u32(), 9, '定位点图元');
      cell.pointCells = Array.from({ length: count }, () => readPointCell(r));
      break;
    }
    default:
      throw new Error(`暂不支持 SYM 线图元类型 ${cell.type}（1=哈希线）`);
  }
  return cell;
}

function fillCell(r: Reader): SymFillCell {
  const type = r.u32();
  if (type !== 0) throw new Error(`暂不支持 SYM 面图元类型 ${type}`);
  const color = r.u32();
  const count = r.count(r.u32(), 16, '面轮廓线图元');
  const lineCells = Array.from({ length: count }, () => readLineCell(r));
  return { kind: 'fill', type, color, lineCells, simpleFillStyle: r.u32() };
}

function symbol(r: Reader): SymSymbol {
  const type = r.u32();
  const code = r.u32();
  const name = r.string();
  const drawMode = r.u32();
  const result: SymSymbol = { type, code, name, drawMode, cells: [] };
  if (type === 1) {
    const count = r.count(r.u32(), 9, '点符号图元');
    result.bounds = { left: r.f64(), right: r.f64(), bottom: r.f64(), top: r.f64() };
    result.cells = Array.from({ length: count }, () => readPointCell(r));
  } else if (type === 2) {
    const count = r.count(r.u32(), 16, '线符号图元');
    result.width = r.f64();
    result.cells = Array.from({ length: count }, () => readLineCell(r));
  } else if (type === 3) {
    result.cells = [fillCell(r)];
  }
  return result;
}

export function decodeSym(data: Uint8Array): SymSource {
  const versionBytes = new TextEncoder().encode(SYM_VERSION);
  if (data.length < versionBytes.length + 5 || !versionBytes.every((v, i) => data[i] === v)) {
    throw new Error(`不是有效的 EPGIS SYM 文件：缺少文件头 "${SYM_VERSION}"`);
  }
  const root = new Reader(data);
  root.position = versionBytes.length + 1;
  const symbols: SymSymbol[] = [];
  while (root.remaining > 0) {
    const recordOffset = root.position;
    const length = root.u32();
    root.need(length, '符号记录');
    const record = new Reader(data.subarray(root.position, root.position + length));
    try {
      const item = symbol(record);
      record.end(`符号 ${item.code}（${item.name}）`);
      symbols.push(item);
    } catch (e: any) {
      throw new Error(`${e?.message || e}；符号记录位于文件偏移 ${recordOffset}`);
    }
    root.position += length;
  }
  if (!symbols.length) throw new Error('SYM 文件中没有符号记录');
  return { version: SYM_VERSION, symbols };
}
