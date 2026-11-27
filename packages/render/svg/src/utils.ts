import { isGradient } from '@drawir/core';
import type { VectorColor, VectorGradient, VectorPaint } from '@drawir/core';
import type { SvgState } from './types';

export function number(value: number) {
  if (!Number.isFinite(value)) return '0';
  return String(Number(value.toFixed(6)));
}

export function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function resolveColor(value: VectorColor | undefined, state: SvgState, fallback: 'fg' | 'none') {
  if (value === undefined) return fallback === 'fg' ? state.color : 'none';
  if (value === 'none') return 'none';
  if (value === '$fg' || state.tint) return state.color;
  if (value === '$bg') return state.background || 'none';
  return value;
}

/** SVG 渐变定义（userSpaceOnUse，g.m 作为 gradientTransform），与 @meta2d/core vector 的 Canvas 渐变语义一致 */
export function gradientDef(g: VectorGradient, id: string) {
  const transform = g.m ? ` gradientTransform="matrix(${g.m.map(number).join(' ')})"` : '';
  const stops = (g.stops || [])
    .map((s) => `<stop offset="${number(Math.min(1, Math.max(0, s.o)))}" stop-color="${escapeXml(s.c)}"/>`)
    .join('');
  if (g.type === 'radial') {
    return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse"${transform} fx="${number(g.x0)}" fy="${number(g.y0)}" fr="${number(Math.max(g.r0 || 0, 0))}" cx="${number(g.x1)}" cy="${number(g.y1)}" r="${number(Math.max(g.r1 ?? 1, 0))}">${stops}</radialGradient>`;
  }
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse"${transform} x1="${number(g.x0)}" y1="${number(g.y0)}" x2="${number(g.x1)}" y2="${number(g.y1)}">${stops}</linearGradient>`;
}

/** 填充 / 描边：渐变时把定义追加到 defs 并返回 url(#id)，着色模式下渐变改用前景色 */
export function resolvePaint(value: VectorPaint | undefined, state: SvgState, fallback: 'fg' | 'none', defs: string[]) {
  if (isGradient(value)) {
    if (state.tint) return state.color;
    const id = `drawir-g${state.nextId()}`;
    defs.push(gradientDef(value, id));
    return `url(#${id})`;
  }
  return resolveColor(value, state, fallback);
}
