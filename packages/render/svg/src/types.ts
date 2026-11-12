import type { RenderOptions } from '@drawir/render-core';

export interface SvgTarget {
  innerHTML: string;
}

export interface SvgRendererOptions extends RenderOptions {
  width?: number;
  height?: number;
  color?: string;
  lineWidth?: number;
  lineDash?: number[];
  tint?: boolean;
}

export interface SvgState {
  color: string;
  background?: string;
  lineWidth: number;
  lineDash?: number[];
  tint: boolean;
  nextId: () => number;
}
