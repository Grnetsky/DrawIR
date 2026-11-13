import {
  createGeom,
  type VectorDocument,
  type VectorGeom,
  type VectorItem,
  type VectorPathItem,
} from '@drawir/core';
import { textItemToPen } from './text';
import type { Meta2dConvertOptions, Meta2dData, Meta2dGranularity } from './types';

/** 与 @meta2d/core 的 MIN_PEN_SIZE / penRectOfGeom 一致：细的方向撑到 2 并居中，便于显示和选中 */
export const MIN_PEN_SIZE = 2;

export function penRectOfGeom(bbox: { x: number; y: number; width: number; height: number }) {
  const width = Math.max(bbox.width, MIN_PEN_SIZE);
  const height = Math.max(bbox.height, MIN_PEN_SIZE);
  return { x: bbox.x - (width - bbox.width) / 2, y: bbox.y - (height - bbox.height) / 2, width, height };
}

const isFixed = (c: string | undefined) => !!c && c !== 'none' && c[0] !== '$';

function randomId() {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Vector IR 文档 → meta2d 1.x 数据（`name: 'vector'` 矢量图元 + 共享几何）。
 *
 * meta2d 1.x 的 vector 图元直接解释同一套 IR：`pen.vector = { bbox, items }`，几何在局部坐标中，
 * 绘制时 bbox 映射到图元矩形；`'$fg'` 取图元当前描边色（随 pen.color、悬停、选中、主题变化），
 * `'$bg'` 取 pen.background，`'$lw'` 取 pen.lineWidth。共享几何放在 `data.vectors`。
 *
 * 纯函数：不依赖 DOM，运行时也不导入 @meta2d/core，可在 Worker 中运行。
 */
export function toMeta2dData(doc: VectorDocument, options: Meta2dConvertOptions = {}): Meta2dData {
  const s = options.scale && options.scale > 0 ? options.scale : 1;
  const ox = options.origin?.x ?? 0;
  const oy = options.origin?.y ?? 0;
  const ns = options.namespace === false ? '' : options.namespace ?? `drawir-${randomId()}`;
  const penPrefix = ns || `drawir-${randomId()}`;
  const editable = options.editable !== false;
  const color = options.color ?? doc.color;
  const background = options.background !== undefined ? options.background || undefined : doc.background;
  const lineWidth = options.lineWidth ?? doc.lineWidth;
  const lineDash = options.lineDash ?? doc.lineDash;

  // 共享几何加命名空间，引用项同步改名
  const rename = (id: string) => (ns ? `${ns}:${id}` : id);
  const renameItems = (items: VectorItem[]): VectorItem[] =>
    ns ? items.map((it) => (it.t === 'r' ? { ...it, id: rename(it.id) } : it)) : items;
  const vectors: Record<string, VectorGeom> = {};
  for (const id in doc.vectors || {}) {
    const g = doc.vectors![id];
    vectors[rename(id)] = { bbox: g.bbox, items: renameItems(g.items) };
  }
  const resolve = (id: string) => vectors[id];

  // 是否用到 '$bg'（含引用的共享几何）：只有用到时才写 pen.background
  const bgCache = new Map<string, boolean>();
  const usesBg = (items: VectorItem[], depth = 0): boolean =>
    items.some((it) => {
      if (it.t === 'p') return it.s?.fill === '$bg' || it.s?.stroke === '$bg';
      if (it.t === 't') return it.fill === '$bg';
      if (it.t === 'h') return it.stroke === '$bg';
      if (depth > 24) return false;
      if (!bgCache.has(it.id)) {
        bgCache.set(it.id, false);
        const def = resolve(it.id);
        bgCache.set(it.id, !!def && usesBg(def.items, depth + 1));
      }
      return bgCache.get(it.id)!;
    });

  const items = renameItems(doc.items || []);
  let granularity: Meta2dGranularity = options.granularity ?? 'item';
  if (granularity === 'item' && items.length > (options.maxPens ?? 20000)) granularity = 'document';

  let n = 0;
  const nextId = () => `${penPrefix}-${(n++).toString(36)}`;
  const finish = (pen: any) => {
    options.locked !== undefined && (pen.locked = options.locked);
    options.extra && Object.assign(pen, options.extra);
    return pen;
  };
  const vectorPen = (geomItems: VectorItem[]) => {
    const geom = createGeom(geomItems, resolve);
    const { bbox } = geom;
    if (!Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) || !Number.isFinite(bbox.width)) return undefined;
    const r = penRectOfGeom(bbox);
    const pen: any = {
      id: nextId(),
      name: 'vector',
      x: ox + r.x * s,
      y: oy + r.y * s,
      width: r.width * s,
      height: r.height * s,
      vector: geom,
      // 矢量图元不显示锚点、不做连线吸附：图元数量大时默认锚点会让拾取很慢
      disableAnchor: true,
      anchors: [],
    };
    color && (pen.color = color);
    background && usesBg(geomItems) && (pen.background = background);
    lineWidth !== undefined && (pen.lineWidth = lineWidth);
    lineDash?.length && (pen.lineDash = lineDash);
    options.tint && (pen.vectorTint = true);
    return pen;
  };

  const pens: any[] = [];
  if (granularity === 'document') {
    const pen = vectorPen(items);
    pen && pens.push(finish(pen));
  } else {
    for (const item of items) {
      if (editable && item.t === 't') {
        if (!item.text || !(item.h > 0)) continue;
        pens.push(finish(placeText(textItemToPen(item, color), nextId(), s, ox, oy)));
        continue;
      }
      const geomItems = editable && item.t === 'p' ? [bindable(item)] : [item];
      const pen = vectorPen(geomItems);
      if (!pen) continue;
      editable && item.t === 'p' && bindStyle(pen, s, lineWidth);
      pens.push(finish(pen));
    }
  }

  const out: Meta2dData = { pens, vectors, granularity };
  background && (out.background = background);
  return out;
}

/** 复制路径项（bindStyle 会修改样式） */
function bindable(item: VectorPathItem): VectorPathItem {
  return item.s ? { ...item, s: { ...item.s } } : { ...item };
}

/**
 * 单路径图元：固定描边色 → pen.color，固定填充色 → pen.background（样式改为 '$bg'），
 * 几何线宽 → pen.lineWidth（样式改为 '$lw'），属性面板修改即可生效。
 */
function bindStyle(pen: any, s: number, docLineWidth: number | undefined) {
  const it = pen.vector.items[0] as VectorPathItem;
  const st = it.s || (it.s = {});
  if (isFixed(st.stroke)) {
    pen.color = st.stroke;
    delete st.stroke;
  }
  if (isFixed(st.fill) && st.fill !== '$fg') {
    pen.background = st.fill;
    st.fill = '$bg';
  }
  if (st.stroke !== 'none') {
    if (typeof st.lw === 'number') {
      // pen.lineWidth 是画布单位，几何已按 s 缩放
      pen.lineWidth = st.lw * s;
      st.lw = '$lw';
    } else if (st.lw === '$lw') {
      pen.lineWidth = docLineWidth ?? 1;
    }
  }
  Object.keys(st).length || delete it.s;
}

/** 文档坐标中的文字图元 → 画布坐标 */
function placeText(pen: any, id: string, s: number, ox: number, oy: number) {
  pen.id = id;
  pen.x = ox + pen.x * s;
  pen.y = oy + pen.y * s;
  pen.width *= s;
  pen.height *= s;
  const size = pen.fontSize * s;
  // meta2d 1.x 中 0 < fontSize < 1 表示「相对图元高度的比例」
  pen.fontSize = size >= 1 || !(pen.height > 0) ? size : size / pen.height;
  return pen;
}
