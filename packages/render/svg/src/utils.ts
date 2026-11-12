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

export function resolveColor(value: string | undefined, state: SvgState, fallback: 'fg' | 'none') {
  if (value === undefined) return fallback === 'fg' ? state.color : 'none';
  if (value === 'none') return 'none';
  if (value === '$fg' || state.tint) return state.color;
  if (value === '$bg') return state.background || 'none';
  return value;
}
