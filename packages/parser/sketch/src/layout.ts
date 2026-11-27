/**
 * 组件实例的内容重排：实例尺寸与母版不同、或覆盖改变了内容（文字、可见性）时，
 * 按约束（resizing constraints）和自动布局（Flex / Stack）重新计算母版子图层的 frame。
 *
 * Sketch 只保存母版自身的布局结果，实例里的内容由 Sketch 在显示时重新排布，所以这里要自己算：
 * - 自由布局（Freeform）：按每个子图层两端的固定（pins）和尺寸方式（sizing）换算；
 *   新格式（Sketch 2025+）用 horizontalSizing / horizontalPins / verticalSizing / verticalPins，
 *   旧格式用 resizingConstraint 位掩码（63 = 都不固定，按比例缩放；清零的位表示固定：1 右、2 宽、4 左、8 下、16 高、32 上）。
 * - Flex 布局：增量重排——保持母版中已排好的位置，主轴上：
 *   隐藏的子项（覆盖 isVisible）让出自身尺寸 + 间距；适应内容（hug）的文字按新文字与原文字的估算宽度比例伸缩，
 *   hug 的嵌套 Stack / 实例按其内容的变化量伸缩；剩余空间的变化分给「填充」子项（sizing = fill），
 *   没有填充子项时按 justifyContent 平移。交叉轴按 alignItems / alignSelf 对齐或拉伸。
 * 子图层尺寸变了且自身是容器时递归重排；嵌套的组件实例由它自己展开时处理（得到的 frame 已包含内容变化）。
 */

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 布局上下文：当前实例作用域内的覆盖、母版查找、文字宽度估算 */
export interface LayoutContext {
  /** 图层（相对当前实例的 id 路径）的覆盖 */
  override(id: string): Map<string, any> | undefined;
  /** 嵌套实例的上下文（实例自身的覆盖 + 外层对它内部的覆盖） */
  nested(instance: any): LayoutContext;
  master(symbolID: string): any;
  /** 文字的估算宽度（同一字体下只用于求比例） */
  textWidth(text: string, layer: any): number;
}

/** Sizing：0 固定，1 适应内容（hug），2 填充（fill），3 相对（随父级等比缩放） */
const FIXED = 0;
const HUG = 1;
const FILL = 2;
const RELATIVE = 3;
/** Pins：1 固定起始边（左 / 上），4 固定末尾边（右 / 下），5 两端 */
const PIN_MIN = 1;
const PIN_MAX = 4;

interface AxisRule {
  min: boolean;
  max: boolean;
  sizing: number;
}

function axisRule(l: any, horizontal: boolean): AxisRule {
  const sizing = horizontal ? l.horizontalSizing : l.verticalSizing;
  if (sizing !== undefined) {
    const pins = (horizontal ? l.horizontalPins : l.verticalPins) || 0;
    return { min: !!(pins & PIN_MIN), max: !!(pins & PIN_MAX), sizing };
  }
  // 旧格式：resizingConstraint 中清零的位表示固定
  const rc = l.resizingConstraint ?? 63;
  const [maxBit, sizeBit, minBit] = horizontal ? [1, 2, 4] : [8, 16, 32];
  const min = !(rc & minBit);
  const max = !(rc & maxBit);
  const fixedSize = !(rc & sizeBit);
  if (rc === 63) return { min: false, max: false, sizing: RELATIVE };
  return { min, max, sizing: fixedSize ? FIXED : min || max ? FILL : RELATIVE };
}

/** 自由布局中一个轴的换算：父级从 P 变为 P2 */
function resizeAxis(pos: number, size: number, P: number, P2: number, r: AxisRule): [number, number] {
  const d = P2 - P;
  if (Math.abs(d) < 1e-9) return [pos, size];
  const s = P > 0 ? P2 / P : 1;
  if ((r.min && r.max) || (r.sizing === FILL && !r.min && !r.max)) return [pos, Math.max(0, size + d)];
  const size2 = r.sizing === RELATIVE ? size * s : size;
  if (r.min) return [pos, size2];
  if (r.max) return [P2 - (P - pos - size) - size2, size2];
  if (r.sizing === RELATIVE) return [pos * s, size2];
  // 两端都不固定：中心按比例
  return [(pos + size / 2) * s - size2 / 2, size2];
}

const isFlex = (l: any) => l?.groupLayout?._class === 'MSImmutableFlexGroupLayout' || l?.groupLayout?._class === 'MSFlexGroupLayout';
const isContainer = (l: any) => Array.isArray(l.layers) && l._class !== 'symbolInstance' && l._class !== 'page' && l._class !== 'shapeGroup';
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

/** 覆盖后的可见性 */
function visible(l: any, ctx?: LayoutContext) {
  const v = ctx?.override(l.do_objectID)?.get('isVisible');
  if (v !== undefined) return !!v && v !== '0';
  return l.isVisible !== false;
}

/**
 * 返回容器（尺寸从 container.frame 变为 width × height）的子图层副本，frame 已换算；
 * 不修改原图层（母版被多个实例共用）。没有变化时返回原数组
 */
export function resizeLayers(container: any, width: number, height: number, ctx?: LayoutContext, depth = 0): any[] {
  const W = container.frame?.width ?? width;
  const H = container.frame?.height ?? height;
  const layers: any[] = container.layers || [];
  if (depth > 64 || !layers.length) return layers;
  const flex = isFlex(container);
  if (!flex && near(W, width) && near(H, height)) return layers;
  // 布尔组合（shapeGroup）的子形状随组合等比缩放
  const shape = container._class === 'shapeGroup';
  const frames = flex
    ? flexFrames(container, layers, W, H, width, height, ctx)
    : layers.map((l) => (shape ? scaledFrame(l, W, H, width, height) : freeFrame(l, W, H, width, height)));
  let changed = false;
  const out = layers.map((l, i) => {
    const f = frames[i];
    const old = l.frame;
    if (!old) return l;
    const moved = !(Math.abs(f.x - old.x) < 1e-6 && Math.abs(f.y - old.y) < 1e-6 && Math.abs(f.width - old.width) < 1e-6 && Math.abs(f.height - old.height) < 1e-6);
    let kids: any[] | undefined;
    if (isContainer(l) || l._class === 'shapeGroup') {
      const k = resizeLayers(l, f.width, f.height, ctx, depth + 1);
      k !== l.layers && (kids = k);
    }
    if (!moved && !kids) return l;
    changed = true;
    const copy = { ...l, frame: { ...old, ...f } };
    kids && (copy.layers = kids);
    return copy;
  });
  return changed ? out : layers;
}

function scaledFrame(l: any, W: number, H: number, W2: number, H2: number): Frame {
  const f = l.frame || { x: 0, y: 0, width: 0, height: 0 };
  const sx = W > 0 ? W2 / W : 1;
  const sy = H > 0 ? H2 / H : 1;
  return { x: f.x * sx, y: f.y * sy, width: f.width * sx, height: f.height * sy };
}

function freeFrame(l: any, W: number, H: number, W2: number, H2: number): Frame {
  const f = l.frame || { x: 0, y: 0, width: 0, height: 0 };
  const [x, width] = resizeAxis(f.x, f.width, W, W2, axisRule(l, true));
  const [y, height] = resizeAxis(f.y, f.height, H, H2, axisRule(l, false));
  return { x, y, width, height };
}

/** Flex 子项（参与布局、按主轴位置排序） */
function flowOf(layers: any[], row: boolean, ctx?: LayoutContext) {
  const flow: number[] = [];
  layers.forEach((l, i) => {
    if (l.flexItem?.ignoreLayout) return;
    if (l.isVisible === false && !l.flexItem?.preserveSpaceWhenHidden && !visible(l, ctx)) return;
    flow.push(i);
  });
  const pos = (i: number) => (row ? layers[i].frame?.x : layers[i].frame?.y) ?? 0;
  return flow.sort((a, b) => pos(a) - pos(b));
}

/**
 * Flex 子项在主轴上的尺寸变化（内容变化引起，不含父级的剩余空间分配）：
 * 被覆盖隐藏 → -(尺寸 + 间距)；hug 文字 → 按估算宽度比例；hug 的同向 Stack / 实例 → 其内容变化量
 */
function itemDelta(l: any, row: boolean, gap: number, ctx: LayoutContext | undefined, depth: number): number {
  const size = (row ? l.frame?.width : l.frame?.height) ?? 0;
  if (l.isVisible !== false && !visible(l, ctx) && !l.flexItem?.preserveSpaceWhenHidden) return -(size + gap);
  if (!ctx || depth > 32) return 0;
  if ((row ? l.horizontalSizing : l.verticalSizing) !== HUG) return 0;
  if (l._class === 'text') {
    if (!row) return 0;
    const s = ctx.override(l.do_objectID)?.get('stringValue');
    const old = l.attributedString?.string;
    if (typeof s !== 'string' || s === old || !old) return 0;
    const w0 = ctx.textWidth(old, l);
    const w1 = ctx.textWidth(s, l);
    return w0 > 0 ? size * (w1 / w0) - size : 0;
  }
  if (l._class === 'symbolInstance') {
    const id = ctx.override(l.do_objectID)?.get('symbolID') || l.symbolID;
    const m = ctx.master(id);
    if (!m) return 0;
    // 换了母版：按新母版的尺寸
    const swap = id !== l.symbolID ? ((row ? m.frame?.width : m.frame?.height) ?? size) - size : 0;
    return swap + contentDelta(m, row, ctx.nested(l), depth + 1);
  }
  if (isContainer(l)) return contentDelta(l, row, ctx, depth + 1);
  return 0;
}

/** hug 容器在轴向上因内容变化而产生的尺寸变化 */
function contentDelta(c: any, row: boolean, ctx: LayoutContext, depth: number): number {
  if (!isFlex(c)) return 0;
  const g = c.groupLayout || {};
  const cRow = (g.flexDirection ?? 0) === 0;
  const layers: any[] = c.layers || [];
  if (cRow !== row) {
    // 交叉轴：取各子项变化的最大值（只算变大的，简化）
    let d = 0;
    for (const i of flowOf(layers, cRow, ctx)) d = Math.max(d, itemDelta(layers[i], row, 0, ctx, depth));
    return d;
  }
  let d = 0;
  for (const i of flowOf(layers, cRow, ctx)) d += itemDelta(layers[i], row, g.allGuttersGap || 0, ctx, depth);
  return d;
}

/** Flex 布局的增量重排 */
function flexFrames(container: any, layers: any[], W: number, H: number, W2: number, H2: number, ctx?: LayoutContext): Frame[] {
  const g = container.groupLayout || {};
  const row = (g.flexDirection ?? 0) === 0;
  const gap = g.allGuttersGap || 0;
  const dMain = row ? W2 - W : H2 - H;
  const dCross = row ? H2 - H : W2 - W;
  const frames: Frame[] = layers.map((l) => ({ ...(l.frame || { x: 0, y: 0, width: 0, height: 0 }) }));
  layers.forEach((l, i) => l.flexItem?.ignoreLayout && (frames[i] = freeFrame(l, W, H, W2, H2)));
  const flow = flowOf(layers, row, ctx);
  const deltas = flow.map((i) => itemDelta(layers[i], row, gap, ctx, 0));
  const shown = flow.filter((i, k) => !(deltas[k] < 0 && !visible(layers[i], ctx)));
  const total = deltas.reduce((a, b) => a + b, 0);
  // 剩余空间的变化
  const free = dMain - total;
  const mainSizing = (l: any) => (row ? l.horizontalSizing : l.verticalSizing);
  const crossSizing = (l: any) => (row ? l.verticalSizing : l.horizontalSizing);
  const growers = shown.filter((i) => mainSizing(layers[i]) === FILL);
  let shift = 0;
  let k = 0;
  flow.forEach((i, n) => {
    const f = frames[i];
    const l = layers[i];
    const hidden = deltas[n] < 0 && !visible(l, ctx);
    let grow = hidden ? 0 : deltas[n];
    growers.includes(i) && (grow += free / growers.length);
    let offset = shift;
    if (!growers.length && !hidden) {
      switch (g.justifyContent ?? 0) {
        case 1:
          offset += free / 2;
          break;
        case 2:
          offset += free;
          break;
        case 3:
          offset += shown.length > 1 ? (k * free) / (shown.length - 1) : 0;
          break;
      }
    }
    if (row) {
      f.x += offset;
      f.width = Math.max(0, f.width + grow);
    } else {
      f.y += offset;
      f.height = Math.max(0, f.height + grow);
    }
    shift += hidden ? deltas[n] : grow;
    hidden || k++;
    // 交叉轴
    const self = l.flexItem?.alignSelf;
    const align = self !== undefined && self !== 5 ? self : g.alignItems ?? 0;
    if (Math.abs(dCross) > 1e-9) {
      if (crossSizing(l) === FILL || align === 3) {
        row ? (f.height = Math.max(0, f.height + dCross)) : (f.width = Math.max(0, f.width + dCross));
      } else {
        const o = align === 1 ? dCross / 2 : align === 2 ? dCross : 0;
        row ? (f.y += o) : (f.x += o);
      }
    }
  });
  return frames;
}
