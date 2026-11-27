import {
  ellipseToCubics,
  invertMatrix,
  isGradient,
  isIdentity,
  matrixScale,
  textItemLines,
  VectorGeom,
  VectorColor,
  VectorGradient,
  VectorHatchItem,
  VectorImageItem,
  VectorItem,
  VectorOp,
  VectorOpSize,
  VectorPaint,
  VectorPathData,
  VectorStyle,
  VectorTextItem,
} from '@drawir/core';
import type { CanvasContext } from './types';

interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
  quadraticCurveTo(x1: number, y1: number, x: number, y: number): void;
  closePath(): void;
  ellipse?(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
}

interface DrawState {
  k: number;
  px: number;
  fg: string;
  bgs: string[];
  minLw: number;
  documentDash?: number[];
  documentLw: number;
  tint: boolean;
  depth: number;
  /** 图片还没加载好：加载完成后回调（由调用方重绘） */
  wait?: () => void;
}

const MAX_DEPTH = 24;
const MAX_HATCH_LINES = 1500;
const MIN_DASH_PERIOD_PX = 3;

export function traceVectorPath(sink: PathSink, data: VectorPathData, noEllipse = false) {
  for (let i = 0; i < data.length; ) {
    const op = data[i];
    switch (op) {
      case VectorOp.Move:
        sink.moveTo(data[i + 1], data[i + 2]);
        break;
      case VectorOp.Line:
        sink.lineTo(data[i + 1], data[i + 2]);
        break;
      case VectorOp.Cubic:
        sink.bezierCurveTo(data[i + 1], data[i + 2], data[i + 3], data[i + 4], data[i + 5], data[i + 6]);
        break;
      case VectorOp.Quad:
        sink.quadraticCurveTo(data[i + 1], data[i + 2], data[i + 3], data[i + 4]);
        break;
      case VectorOp.Close:
        sink.closePath();
        break;
      case VectorOp.Ellipse:
        if (!noEllipse && sink.ellipse) {
          sink.ellipse(
            data[i + 1],
            data[i + 2],
            data[i + 3],
            data[i + 4],
            data[i + 5],
            data[i + 6],
            data[i + 7],
            !!data[i + 8],
          );
        } else {
          const { start, curves } = ellipseToCubics(
            data[i + 1],
            data[i + 2],
            data[i + 3],
            data[i + 4],
            data[i + 5],
            data[i + 6],
            data[i + 7],
            !!data[i + 8],
          );
          sink.lineTo(start[0], start[1]);
          for (const curve of curves) sink.bezierCurveTo(curve[0], curve[1], curve[2], curve[3], curve[4], curve[5]);
        }
        break;
      default:
        return;
    }
    i += VectorOpSize[op];
  }
}

function resolveColor(color: VectorColor | undefined, state: DrawState, fallback: 'fg' | 'none') {
  if (color === undefined) return fallback === 'fg' ? state.fg : undefined;
  if (color === 'none') return undefined;
  if (color === '$fg' || state.tint) return state.fg;
  return color;
}

/** 填充 / 描边：渐变原样返回（着色模式下改用前景色），颜色同 resolveColor（与 @meta2d/core vector 一致） */
function resolvePaint(paint: VectorPaint | undefined, state: DrawState, fallback: 'fg' | 'none') {
  if (isGradient(paint)) return state.tint ? state.fg : paint;
  return resolveColor(paint, state, fallback);
}

/** IR 渐变 → CanvasGradient（渐变空间），按渐变对象缓存 */
const gradientCache = new WeakMap<VectorGradient, CanvasGradient>();

function canvasGradient(ctx: CanvasContext, g: VectorGradient): CanvasGradient | undefined {
  let cg = gradientCache.get(g);
  if (cg) return cg;
  const ok = (...v: number[]) => v.every(Number.isFinite);
  if (g.type === 'radial') {
    const r0 = Math.max(g.r0 || 0, 0);
    const r1 = Math.max(g.r1 ?? 1, 0);
    if (!ok(g.x0, g.y0, g.x1, g.y1, r0, r1)) return undefined;
    cg = ctx.createRadialGradient(g.x0, g.y0, r0, g.x1, g.y1, r1);
  } else {
    if (!ok(g.x0, g.y0, g.x1, g.y1)) return undefined;
    cg = ctx.createLinearGradient(g.x0, g.y0, g.x1, g.y1);
  }
  for (const stop of g.stops || []) {
    try {
      cg.addColorStop(Math.min(1, Math.max(0, stop.o)), stop.c);
    } catch {
      // 无法解析的颜色
    }
  }
  gradientCache.set(g, cg);
  return cg;
}

/**
 * 用 IR 渐变填充 / 描边当前路径。路径已按构建时的变换固定，transform(g.m) 只影响渐变的解释；
 * 描边线宽、虚线按 m 的缩放反向换算，保持局部坐标中的粗细。
 */
function paintGradient(ctx: CanvasContext, g: VectorGradient, fill: boolean, rule?: CanvasFillRule) {
  const cg = canvasGradient(ctx, g);
  if (!cg) return;
  ctx.save();
  const m = g.m;
  if (m && !isIdentity(m)) {
    if (!invertMatrix(m)) {
      ctx.restore();
      return;
    }
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    if (!fill) {
      const k = matrixScale(m) || 1;
      ctx.lineWidth /= k;
      const dash = ctx.getLineDash();
      dash.length && ctx.setLineDash(dash.map((v) => v / k));
    }
  }
  if (fill) {
    ctx.fillStyle = cg;
    ctx.fill(rule);
  } else {
    ctx.strokeStyle = cg;
    ctx.stroke();
  }
  ctx.restore();
}

function setDash(ctx: CanvasContext, dash: number[] | undefined, px: number) {
  if (dash?.length) {
    const period = dash.reduce((sum, value) => sum + value, 0);
    if (period * px >= MIN_DASH_PERIOD_PX) {
      ctx.setLineDash(dash);
      return;
    }
  }
  ctx.setLineDash([]);
}

function applyStroke(ctx: CanvasContext, style: VectorStyle | undefined, state: DrawState) {
  if (style?.lw === '$lw') {
    ctx.lineWidth = state.documentLw / state.k;
    if (style.dash?.length) setDash(ctx, style.dash, state.px);
    else if (state.documentDash?.length) setDash(ctx, state.documentDash.map((value) => value / state.k), state.px);
    else ctx.setLineDash([]);
  } else {
    let lineWidth = Math.max(typeof style?.lw === 'number' ? style.lw : 0, state.minLw / state.k);
    if (style?.px) lineWidth = Math.max(lineWidth, style.px / state.px);
    ctx.lineWidth = lineWidth;
    if (style?.dash?.length) setDash(ctx, style.dash, state.px);
    else if (state.documentDash?.length) setDash(ctx, state.documentDash.map((value) => value / state.k), state.px);
    else ctx.setLineDash([]);
  }
  if (style?.cap) ctx.lineCap = style.cap;
  if (style?.join) ctx.lineJoin = style.join;
}

function drawPath(ctx: CanvasContext, data: VectorPathData, style: VectorStyle | undefined, state: DrawState) {
  const stroke = style?.lw === '$lw' && state.documentLw === 0 ? undefined : resolvePaint(style?.stroke, state, 'fg');
  ctx.save();
  ctx.beginPath();
  traceVectorPath(ctx, data);
  if (style?.alpha !== undefined) ctx.globalAlpha *= style.alpha;
  if (style?.fill === '$bg') {
    for (const background of state.bgs) {
      ctx.fillStyle = background;
      ctx.fill(style.rule);
    }
  } else {
    const fill = resolvePaint(style?.fill, state, 'none');
    if (isGradient(fill)) {
      paintGradient(ctx, fill, true, style?.rule);
    } else if (fill) {
      ctx.fillStyle = fill;
      ctx.fill(style?.rule);
    }
  }
  if (stroke) {
    applyStroke(ctx, style, state);
    if (isGradient(stroke)) {
      paintGradient(ctx, stroke, false);
    } else {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawText(ctx: CanvasContext, item: VectorTextItem, state: DrawState) {
  const color = resolveColor(item.fill, state, 'fg');
  if (!color || !item.text) return;
  const size = item.h * state.px;
  if (!(size >= 1)) return;
  ctx.save();
  ctx.translate(item.x, item.y);
  if (item.r) ctx.rotate(item.r);
  ctx.scale((item.w || 1) / state.px, (item.m ? -1 : 1) / state.px);
  ctx.font = `${item.italic ? 'italic ' : ''}${item.bold ? 'bold ' : ''}${size}px ${item.font || 'Arial, sans-serif'}`;
  ctx.textAlign = item.a || 'left';
  ctx.textBaseline = item.b || 'alphabetic';
  ctx.fillStyle = color;
  const lines = textItemLines(item);
  const lineHeight = (item.lh || 1.25) * size;
  let y = 0;
  if (item.b === 'middle') y = (-(lines.length - 1) * lineHeight) / 2;
  else if (item.b === 'bottom' || item.b === 'ideographic') y = -(lines.length - 1) * lineHeight;
  lines.forEach((line, index) => line && ctx.fillText(line, 0, y + index * lineHeight));
  ctx.restore();
}

function hatchBounds(data: VectorPathData) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < data.length; ) {
    const op = data[i];
    const size = VectorOpSize[op];
    if (!size) break;
    if (op === VectorOp.Ellipse) {
      const radius = Math.max(data[i + 3], data[i + 4]);
      minX = Math.min(minX, data[i + 1] - radius);
      maxX = Math.max(maxX, data[i + 1] + radius);
      minY = Math.min(minY, data[i + 2] - radius);
      maxY = Math.max(maxY, data[i + 2] + radius);
    } else {
      for (let j = 1; j + 1 < size; j += 2) {
        minX = Math.min(minX, data[i + j]);
        maxX = Math.max(maxX, data[i + j]);
        minY = Math.min(minY, data[i + j + 1]);
        maxY = Math.max(maxY, data[i + j + 1]);
      }
    }
    i += size;
  }
  return { minX, minY, maxX, maxY };
}

function canvasDash(dash: number[] | undefined, dot: number) {
  if (!dash?.length) return undefined;
  const out: number[] = [];
  if (dash[0] < 0) out.push(0);
  for (const value of dash) {
    const length = value === 0 ? dot : Math.abs(value);
    const draw = value >= 0;
    if (draw === (out.length % 2 === 0)) out.push(length);
    else if (out.length) out[out.length - 1] += length;
    else out.push(0, length);
  }
  if (out.length % 2) out.push(0);
  return out;
}

function drawHatch(ctx: CanvasContext, item: VectorHatchItem, state: DrawState) {
  const color = resolveColor(item.stroke, state, 'fg');
  if (!color || !item.lines.length) return;
  const { minX, minY, maxX, maxY } = hatchBounds(item.d);
  if (!(maxX >= minX && maxY >= minY)) return;
  ctx.save();
  ctx.beginPath();
  traceVectorPath(ctx, item.d);
  ctx.clip('evenodd');
  ctx.strokeStyle = color;
  ctx.lineWidth = state.minLw / state.k;
  const corners = [
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
  ];
  for (const line of item.lines) {
    const ux = Math.cos(line.a);
    const uy = Math.sin(line.a);
    const nx = -uy;
    const ny = ux;
    const spacing = line.dx * nx + line.dy * ny;
    if (!(Math.abs(spacing) > 1e-12)) continue;
    const shift = line.dx * ux + line.dy * uy;
    let nMin = Infinity;
    let nMax = -Infinity;
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const [x, y] of corners) {
      const n = ((x - line.x) * nx + (y - line.y) * ny) / spacing;
      const t = (x - line.x) * ux + (y - line.y) * uy;
      nMin = Math.min(nMin, n);
      nMax = Math.max(nMax, n);
      tMin = Math.min(tMin, t);
      tMax = Math.max(tMax, t);
    }
    const first = Math.floor(nMin);
    const last = Math.ceil(nMax);
    if (last - first > MAX_HATCH_LINES || Math.abs(spacing) * state.px < 2) {
      ctx.save();
      ctx.globalAlpha *= 0.35;
      ctx.fillStyle = color;
      ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
      ctx.restore();
      continue;
    }
    let pattern = canvasDash(line.dash, state.minLw / state.k);
    const period = pattern?.reduce((sum, value) => sum + value, 0) || 0;
    if (pattern && period * state.px < MIN_DASH_PERIOD_PX) pattern = undefined;
    if (!pattern) {
      ctx.setLineDash([]);
      ctx.beginPath();
    }
    for (let i = first; i <= last; i++) {
      const px = line.x + i * line.dx;
      const py = line.y + i * line.dy;
      const base = (px - line.x) * ux + (py - line.y) * uy;
      const t0 = tMin - base - Math.abs(shift);
      const t1 = tMax - base + Math.abs(shift);
      const x0 = px + ux * t0;
      const y0 = py + uy * t0;
      const x1 = px + ux * t1;
      const y1 = py + uy * t1;
      if (pattern) {
        ctx.setLineDash(pattern);
        ctx.lineDashOffset = period ? ((t0 % period) + period) % period : 0;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      } else {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
    }
    if (!pattern) ctx.stroke();
  }
  ctx.restore();
}

export type VectorImageSource = HTMLImageElement | ImageBitmap;

interface VectorImageEntry {
  img?: VectorImageSource;
  failed?: boolean;
  waiters: Set<() => void>;
}

const imageCache = new Map<string, VectorImageEntry>();

function loadVectorImage(src: string): Promise<VectorImageSource> {
  if (typeof Image !== 'undefined') {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // data: / blob: 不需要跨域；其它地址按匿名跨域加载，否则画布被污染后不能导出图片
      /^(data|blob):/i.test(src) || (img.crossOrigin = 'anonymous');
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }
  // Worker：没有 Image，用 fetch + createImageBitmap
  return fetch(src)
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b));
}

/** 取已加载的图片；第一次取时开始加载并返回 undefined，加载完成后调用 wait */
export function getVectorImage(src: string, wait?: () => void): VectorImageSource | undefined {
  let entry = imageCache.get(src);
  if (!entry) {
    const e: VectorImageEntry = { waiters: new Set() };
    entry = e;
    imageCache.set(src, e);
    loadVectorImage(src).then(
      (img) => {
        e.img = img;
        const list = [...e.waiters];
        e.waiters.clear();
        list.forEach((cb) => cb());
      },
      () => {
        e.failed = true;
        e.waiters.clear();
      },
    );
  }
  if (!entry.img && !entry.failed && wait) entry.waiters.add(wait);
  return entry.img;
}

/** 图片项：单位正方形经 item.m 映射到局部坐标，支持圆角和 fill / contain / cover（与 @meta2d/core vector 一致） */
function drawImageItem(ctx: CanvasContext, item: VectorImageItem, img: VectorImageSource) {
  const m = item.m;
  const bw = Math.hypot(m[0], m[1]);
  const bh = Math.hypot(m[2], m[3]);
  const iw = img.width;
  const ih = img.height;
  if (!(bw > 0 && bh > 0 && iw > 0 && ih > 0)) return;
  ctx.save();
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  if (item.alpha !== undefined) ctx.globalAlpha *= item.alpha;
  if (item.radius && item.radius > 0) {
    // 单位正方形里的圆角：两个方向的缩放不同，用椭圆角
    const rx = Math.min(item.radius / bw, 0.5);
    const ry = Math.min(item.radius / bh, 0.5);
    const H = Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(rx, 0);
    ctx.lineTo(1 - rx, 0);
    ctx.ellipse(1 - rx, ry, rx, ry, 0, -H, 0);
    ctx.lineTo(1, 1 - ry);
    ctx.ellipse(1 - rx, 1 - ry, rx, ry, 0, 0, H);
    ctx.lineTo(rx, 1);
    ctx.ellipse(rx, 1 - ry, rx, ry, 0, H, Math.PI);
    ctx.lineTo(0, ry);
    ctx.ellipse(rx, ry, rx, ry, 0, Math.PI, Math.PI + H);
    ctx.closePath();
    ctx.clip();
  }
  try {
    if (item.fit === 'contain') {
      const s = Math.min(bw / iw, bh / ih);
      const dw = (iw * s) / bw;
      const dh = (ih * s) / bh;
      ctx.drawImage(img, (1 - dw) / 2, (1 - dh) / 2, dw, dh);
    } else if (item.fit === 'cover') {
      const s = Math.max(bw / iw, bh / ih);
      const sw = bw / s;
      const sh = bh / s;
      ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, 1, 1);
    } else {
      ctx.drawImage(img, 0, 0, 1, 1);
    }
  } catch {
    // 图片解码失败
  }
  ctx.restore();
}

function drawItems(
  ctx: CanvasContext,
  items: VectorItem[],
  state: DrawState,
  resolve: (id: string) => VectorGeom | undefined,
) {
  for (const item of items) {
    switch (item.t) {
      case 'p':
        drawPath(ctx, item.d, item.s, state);
        break;
      case 't':
        drawText(ctx, item, state);
        break;
      case 'h':
        drawHatch(ctx, item, state);
        break;
      case 'c': {
        // 裁剪（蒙版 / 容器内容裁剪）：内容只在裁剪路径内可见
        if (state.depth >= MAX_DEPTH || !item.items.length) break;
        ctx.save();
        ctx.beginPath();
        traceVectorPath(ctx, item.d);
        ctx.clip(item.rule);
        drawItems(ctx, item.items, { ...state, depth: state.depth + 1 }, resolve);
        ctx.restore();
        break;
      }
      case 'i': {
        if (!item.src) break;
        const img = getVectorImage(item.src, state.wait);
        img && drawImageItem(ctx, item, img);
        break;
      }
      case 'r': {
        if (state.depth >= MAX_DEPTH) break;
        const definition = resolve(item.id);
        if (!definition) break;
        ctx.save();
        const m = item.m;
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        const scale = matrixScale(m);
        const foreground = item.c && item.c !== '$fg' ? resolveColor(item.c, state, 'fg') : state.fg;
        drawItems(
          ctx,
          definition.items,
          { ...state, k: state.k * scale, px: state.px * scale, fg: foreground || state.fg, depth: state.depth + 1 },
          resolve,
        );
        ctx.restore();
        break;
      }
    }
  }
}

export interface VectorDrawOptions {
  color?: string;
  background?: string;
  lineWidth?: number;
  lineDash?: number[];
  tint?: boolean;
  viewportScale?: number;
  pixelRatio?: number;
  /** 有图片还没加载好时，加载完成后调用（用于重绘） */
  onImageLoad?: () => void;
}

export function drawVectorGeom(
  ctx: CanvasContext,
  geom: VectorGeom,
  vectors: Record<string, VectorGeom> = {},
  options: VectorDrawOptions = {},
) {
  if (!geom.items.length) return;
  let px = (options.viewportScale || 1) * (options.pixelRatio || 1);
  try {
    const transform = ctx.getTransform();
    const determinant = Math.sqrt(Math.abs(transform.a * transform.d - transform.b * transform.c));
    if (determinant > 0) px = determinant;
  } catch {
    // 宿主没有 getTransform 时使用调用方提供的视口缩放。
  }
  const onePx = px > 0 ? 1 / px : 1;
  const minLw = options.lineWidth && options.lineWidth > 1 ? options.lineWidth : onePx;
  const documentLw = options.lineWidth === 0 ? 0 : Math.max(options.lineWidth || onePx, onePx);
  ctx.save();
  try {
    drawItems(
      ctx,
      geom.items,
      {
        k: 1,
        px,
        fg: options.color || '#000000',
        bgs: options.background && options.background !== 'none' ? [options.background] : [],
        minLw,
        documentDash: options.lineDash,
        documentLw: documentLw,
        tint: !!options.tint,
        depth: 0,
        wait: options.onImageLoad,
      },
      (id) => vectors[id],
    );
  } finally {
    ctx.restore();
  }
}
