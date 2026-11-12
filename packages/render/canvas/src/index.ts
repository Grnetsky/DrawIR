import type { VectorDocument } from '@drawir/core';
import type { Renderer, Viewport } from '@drawir/render-core';
import { drawVectorGeom } from './vector';
import type { CanvasContext, CanvasRendererOptions, CanvasSize, CanvasTarget } from './types';

export type { CanvasContext, CanvasRendererOptions, CanvasSize, CanvasTarget } from './types';
export { drawVectorGeom, traceVectorPath } from './vector';

export function fitViewport(document: VectorDocument, width: number, height: number, padding = 20): Viewport {
  const content = document.width && document.height
    ? { x: 0, y: 0, width: document.width, height: document.height }
    : document.bbox;
  const usableWidth = Math.max(0, width - padding * 2);
  const usableHeight = Math.max(0, height - padding * 2);
  const scale = Math.min(usableWidth / content.width, usableHeight / content.height);
  if (!(scale > 0) || !Number.isFinite(scale)) return { scale: 1, x: 0, y: 0 };
  return {
    scale,
    x: (width - content.width * scale) / 2 - content.x * scale,
    y: (height - content.height * scale) / 2 - content.y * scale,
  };
}

export class CanvasRenderer implements Renderer<CanvasRendererOptions> {
  readonly name = 'canvas';
  private ctx: CanvasContext;
  private canvas?: CanvasTarget;
  private defaults: CanvasRendererOptions;
  private size?: { width: number; height: number };

  constructor(target: CanvasTarget | CanvasContext, options: CanvasRendererOptions = {}) {
    if ('getContext' in target) {
      const ctx = target.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context is not available');
      this.ctx = ctx;
      this.canvas = target;
    } else {
      this.ctx = target;
      this.canvas = target.canvas as CanvasTarget;
    }
    this.defaults = options;
  }

  private resolveSize(options: CanvasRendererOptions): CanvasSize {
    const pixelRatio = options.pixelRatio ?? this.defaults.pixelRatio ??
      (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
    const ratio = pixelRatio > 0 && Number.isFinite(pixelRatio) ? pixelRatio : 1;
    const canvasWidth = this.canvas?.width || this.ctx.canvas.width;
    const canvasHeight = this.canvas?.height || this.ctx.canvas.height;
    const clientWidth = this.canvas?.clientWidth || 0;
    const clientHeight = this.canvas?.clientHeight || 0;
    const width = options.width ?? this.defaults.width ?? (clientWidth || this.size?.width || canvasWidth);
    const height = options.height ?? this.defaults.height ?? (clientHeight || this.size?.height || canvasHeight);
    return { width, height, pixelRatio: ratio };
  }

  render(document: VectorDocument, renderOptions: CanvasRendererOptions = {}) {
    const options = { ...this.defaults, ...renderOptions };
    const size = this.resolveSize(options);
    const ctx = this.ctx;
    if (options.autoResize !== false && this.canvas) {
      const width = Math.max(1, Math.round(size.width * size.pixelRatio));
      const height = Math.max(1, Math.round(size.height * size.pixelRatio));
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
    }
    this.size = { width: size.width, height: size.height };
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (options.clear !== false) {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        const background = options.background ?? document.background;
        if (background) {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        }
      }
      const viewport: Viewport = options.viewport
        ? { scale: options.viewport.scale ?? 1, x: options.viewport.x ?? 0, y: options.viewport.y ?? 0 }
        : options.fit
          ? fitViewport(document, size.width, size.height, options.padding ?? 20)
          : { scale: 1, x: 0, y: 0 };
      ctx.setTransform(
        size.pixelRatio * viewport.scale,
        0,
        0,
        size.pixelRatio * viewport.scale,
        size.pixelRatio * viewport.x,
        size.pixelRatio * viewport.y,
      );
      drawVectorGeom(ctx, document, document.vectors || {}, {
        ...options,
        color: options.color ?? document.color,
        background: options.background ?? document.background,
        lineWidth: options.lineWidth ?? document.lineWidth,
        lineDash: options.lineDash ?? document.lineDash,
        viewportScale: viewport.scale,
        pixelRatio: size.pixelRatio,
      });
    } finally {
      ctx.restore();
    }
  }
}
