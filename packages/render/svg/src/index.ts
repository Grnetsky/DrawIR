import type { VectorDocument, VectorItem, VectorMatrix } from '@drawir/core';
import type { Renderer, Viewport } from '@drawir/render-core';
import { renderHatch } from './hatch';
import { renderPath, vectorPathToSvg } from './path';
import { renderText } from './text';
import type { SvgRendererOptions, SvgState, SvgTarget } from './types';
import { escapeXml, number, resolveColor } from './utils';

export type { SvgRendererOptions, SvgTarget } from './types';
export { vectorPathToSvg } from './path';

const MAX_DEPTH = 24;

function matrix(value: VectorMatrix) {
  return `matrix(${value.map(number).join(' ')})`;
}

export function renderVectorItems(
  items: VectorItem[],
  document: VectorDocument,
  state: SvgState,
  depth = 0,
): string {
  const output: string[] = [];
  for (const item of items) {
    switch (item.t) {
      case 'p':
        output.push(renderPath(item, state));
        break;
      case 't':
        output.push(renderText(item, state));
        break;
      case 'h':
        output.push(renderHatch(item, state));
        break;
      case 'r': {
        if (depth >= MAX_DEPTH) break;
        const definition = document.vectors?.[item.id];
        if (!definition) break;
        const color = item.c && item.c !== '$fg' ? resolveColor(item.c, state, 'fg') : state.color;
        output.push(
          `<g transform="${matrix(item.m)}">${renderVectorItems(
            definition.items,
            document,
            { ...state, color },
            depth + 1,
          )}</g>`,
        );
        break;
      }
    }
  }
  return output.join('');
}

function viewport(document: VectorDocument, options: SvgRendererOptions, width: number, height: number): Viewport {
  if (options.viewport) {
    return { scale: options.viewport.scale ?? 1, x: options.viewport.x ?? 0, y: options.viewport.y ?? 0 };
  }
  if (!options.fit) return { scale: 1, x: 0, y: 0 };
  const content = document.width && document.height
    ? { x: 0, y: 0, width: document.width, height: document.height }
    : document.bbox;
  const padding = options.padding ?? 20;
  const scale = Math.min((width - padding * 2) / content.width, (height - padding * 2) / content.height);
  if (!(scale > 0) || !Number.isFinite(scale)) return { scale: 1, x: 0, y: 0 };
  return {
    scale,
    x: (width - content.width * scale) / 2 - content.x * scale,
    y: (height - content.height * scale) / 2 - content.y * scale,
  };
}

export class SvgRenderer implements Renderer<SvgRendererOptions, string> {
  readonly name = 'svg';
  private target?: SvgTarget;
  private defaults: SvgRendererOptions;

  constructor(target?: SvgTarget, options: SvgRendererOptions = {}) {
    this.target = target;
    this.defaults = options;
  }

  render(document: VectorDocument, renderOptions: SvgRendererOptions = {}) {
    const options = { ...this.defaults, ...renderOptions };
    const width = Math.max(1, options.width ?? document.width ?? document.bbox.width ?? 1);
    const height = Math.max(1, options.height ?? document.height ?? document.bbox.height ?? 1);
    const view = viewport(document, options, width, height);
    const background = options.background ?? document.background;
    let nextId = 0;
    const state: SvgState = {
      color: options.color ?? document.color ?? '#000000',
      background,
      lineWidth: options.lineWidth ?? document.lineWidth ?? 1,
      lineDash: options.lineDash ?? document.lineDash,
      tint: options.tint ?? false,
      nextId: () => ++nextId,
    };
    const content = renderVectorItems(document.items, document, state);
    const backgroundRect = background && background !== 'none'
      ? `<rect width="100%" height="100%" fill="${escapeXml(background)}"/>`
      : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" viewBox="0 0 ${number(width)} ${number(height)}">${backgroundRect}<g transform="translate(${number(view.x)} ${number(view.y)}) scale(${number(view.scale)})">${content}</g></svg>`;
    if (this.target) this.target.innerHTML = svg;
    return svg;
  }
}

export function renderSvg(document: VectorDocument, options: SvgRendererOptions = {}) {
  return new SvgRenderer(undefined, options).render(document);
}
