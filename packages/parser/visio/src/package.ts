import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

/**
 * VSDX 包读取：解压 + XML 解析 + 关系（.rels）解析。
 *
 * V1 用 JSZip（异步、整体 ~100KB）并把 XML 转成自定义的 { ele, children } 树，每次查找都广度优先遍历整棵树；
 * 这里用 fflate 同步解压（~8KB），fast-xml-parser 解析成普通对象，按需建索引。
 */
export class VsdxPackage {
  private files: Record<string, Uint8Array>;
  private cache = new Map<string, any>();
  private parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    // 这些元素无论出现几次都按数组处理，避免「只有一个时是对象、多个时是数组」的分支。
    // 注意只对元素生效：Shape 上的 Master 属性与 <Master> 元素同名，不能把属性也变成数组
    isArray: (name, _jpath, _isLeaf, isAttribute) =>
      !isAttribute &&
      [
        'Shape',
        'Section',
        'Row',
        'Cell',
        'Connect',
        'Page',
        'Master',
        'StyleSheet',
        'Relationship',
        'cp',
        'pp',
        'fld',
      ].includes(name),
    // Text 元素是混合内容（文本与 <cp/> 交错），保留顺序单独解析
    stopNodes: ['*.Text'],
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false,
  });

  constructor(data: Uint8Array) {
    this.files = unzipSync(data);
  }

  has(path: string) {
    return !!this.files[path];
  }

  list() {
    return Object.keys(this.files);
  }

  bytes(path: string) {
    return this.files[path];
  }

  text(path: string) {
    const b = this.files[path];
    return b ? strFromU8(b) : undefined;
  }

  xml(path: string): any {
    if (this.cache.has(path)) return this.cache.get(path);
    const t = this.text(path);
    const v = t ? this.parser.parse(t) : undefined;
    this.cache.set(path, v);
    return v;
  }

  /** 读取某个部件的关系表：Id → 绝对路径 */
  rels(partPath: string): Record<string, string> {
    const dir = partPath.slice(0, partPath.lastIndexOf('/'));
    const name = partPath.slice(partPath.lastIndexOf('/') + 1);
    const x = this.xml(`${dir}/_rels/${name}.rels`);
    const out: Record<string, string> = {};
    for (const r of x?.Relationships?.Relationship || []) {
      out[r.Id] = resolvePath(dir, r.Target);
    }
    return out;
  }
}

export function resolvePath(dir: string, target: string) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = dir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
