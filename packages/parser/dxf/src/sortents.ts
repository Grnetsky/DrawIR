/**
 * 读取 AutoCAD 的绘制次序表（SORTENTSTABLE，「前置 / 后置」命令写入）。
 *
 * DXF 里实体的书写顺序不等于显示顺序：用户把一块白色底板「后置」后，底板在 ENTITIES 段里
 * 可能仍排在最后，真正的显示顺序记在 OBJECTS 段的 SORTENTSTABLE 中（实体句柄 → 排序句柄）。
 * 不读这张表，底板就会盖在所有图形上面。
 *
 * dxf-json 不解析这个对象，这里直接扫描 DXF 文本的 OBJECTS 段（只读组码 0/330/331/5，开销很小）。
 *
 * @returns 所属块记录句柄 → (实体句柄 → 排序键)
 */
export function readSortEntsTables(text: string): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  const start = text.includes('SORTENTSTABLE') ? findObjectsSection(text) : -1;
  if (start < 0) {
    return result;
  }
  // 从 OBJECTS 段的「0 / SECTION」之后逐对读取（组码行、值行交替）
  const lines = text.slice(start).split(/\r?\n/);
  let first = lines.findIndex((l) => l.trim() === 'OBJECTS');
  first < 0 && (first = 0);
  for (let i = first + 1; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() !== '0') continue;
    const name = lines[i + 1].trim();
    if (name === 'ENDSEC') break;
    if (name !== 'SORTENTSTABLE') continue;

    let owner = '';
    const entityHandles: string[] = [];
    const sortHandles: string[] = [];
    let inTable = false; // 100 AcDbSortentsTable 之后的 330 才是所属块记录
    let j = i + 2;
    for (; j + 1 < lines.length; j += 2) {
      const code = lines[j].trim();
      const value = lines[j + 1].trim();
      if (code === '0') break;
      if (code === '100' && value === 'AcDbSortentsTable') inTable = true;
      else if (code === '330' && inTable && !owner) owner = value;
      else if (code === '331') entityHandles.push(value);
      else if (code === '5' && entityHandles.length > sortHandles.length) sortHandles.push(value);
    }
    i = j - 2;
    if (!owner || !entityHandles.length) continue;
    const map = result.get(owner) || new Map<string, number>();
    entityHandles.forEach((h, k) => {
      const key = parseInt(sortHandles[k], 16);
      Number.isFinite(key) && map.set(h.toUpperCase(), key);
    });
    result.set(owner, map);
  }
  return result;
}

function findObjectsSection(text: string) {
  const m = /\n\s*2\r?\n\s*OBJECTS\r?\n/.exec(text);
  return m ? m.index : -1;
}

/**
 * 按绘制次序排序实体。没有登记在表里的实体用自己的句柄作为排序键（AutoCAD 的规则），
 * 排序稳定：键相同的保持原有顺序。
 */
export function applyDrawOrder<T extends { handle?: string }>(entities: T[], order?: Map<string, number>): T[] {
  if (!order?.size) {
    return entities;
  }
  // ATTRIB / SEQEND 属于前面的 INSERT（dxf-json 把它们平铺在 INSERT 之后），与 INSERT 一起移动，不单独排序
  const groups: { items: T[]; key: number; i: number }[] = [];
  entities.forEach((e: any, i) => {
    const last = groups[groups.length - 1];
    if (last && (e.type === 'ATTRIB' || e.type === 'SEQEND') && last.items[0] && (last.items[0] as any).type === 'INSERT') {
      last.items.push(e);
      return;
    }
    const h = String(e.handle || '').toUpperCase();
    const key = order.get(h) ?? parseInt(h, 16);
    groups.push({ items: [e], key: Number.isFinite(key) ? key : Infinity, i });
  });
  groups.sort((a, b) => a.key - b.key || a.i - b.i);
  return groups.flatMap((g) => g.items);
}
