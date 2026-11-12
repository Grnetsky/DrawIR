import type { RenderOptions } from '@drawir/render-core';

export type CanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface CanvasTarget {
  width: number;
  height: number;
  clientWidth?: number;
  clientHeight?: number;
  getContext(type: '2d'): CanvasContext | null;
}

export interface CanvasRendererOptions extends RenderOptions {
  pixelRatio?: number;
  width?: number;
  height?: number;
  autoResize?: boolean;
  /** 覆盖文档的 '$fg' 颜色。 */
  color?: string;
  lineWidth?: number;
  lineDash?: number[];
  /** 固定颜色也统一使用前景色。 */
  tint?: boolean;
}

export interface CanvasSize {
  width: number;
  height: number;
  pixelRatio: number;
}
