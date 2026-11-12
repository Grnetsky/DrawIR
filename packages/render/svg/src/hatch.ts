import { VectorOp, VectorOpSize } from '@drawir/core';
import type { VectorHatchItem, VectorHatchLine, VectorPathData } from '@drawir/core';
import { vectorPathToSvg } from './path';
import type { SvgState } from './types';
import { number, resolveColor } from './utils';

const MAX_HATCH_LINES = 1500;

function bounds(data: VectorPathData) {
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

function dashArray(line: VectorHatchLine, dot: number) {
  if (!line.dash?.length) return undefined;
  const out: number[] = [];
  if (line.dash[0] < 0) out.push(0);
  for (const value of line.dash) {
    const length = value === 0 ? dot : Math.abs(value);
    const draw = value >= 0;
    if (draw === (out.length % 2 === 0)) out.push(length);
    else if (out.length) out[out.length - 1] += length;
    else out.push(0, length);
  }
  if (out.length % 2) out.push(0);
  return out;
}

export function renderHatch(item: VectorHatchItem, state: SvgState) {
  const color = resolveColor(item.stroke, state, 'fg');
  if (!item.lines.length || color === 'none') return '';
  const box = bounds(item.d);
  if (!(box.maxX >= box.minX && box.maxY >= box.minY)) return '';
  const id = `drawir-clip-${state.nextId()}`;
  const path = vectorPathToSvg(item.d);
  const output = [
    `<defs><clipPath id="${id}"><path d="${path}" clip-rule="evenodd"/></clipPath></defs>`,
    `<g clip-path="url(#${id})" fill="none" stroke="${color}" stroke-width="${number(state.lineWidth)}">`,
  ];
  const corners = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.minX, box.maxY],
    [box.maxX, box.maxY],
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
    if (last - first > MAX_HATCH_LINES) {
      output.push(`<path d="${path}" fill="${color}" fill-opacity="0.35" stroke="none"/>`);
      continue;
    }
    const dash = dashArray(line, state.lineWidth);
    const period = dash?.reduce((sum, value) => sum + value, 0) || 0;
    for (let i = first; i <= last; i++) {
      const px = line.x + i * line.dx;
      const py = line.y + i * line.dy;
      const base = (px - line.x) * ux + (py - line.y) * uy;
      const t0 = tMin - base - Math.abs(shift);
      const t1 = tMax - base + Math.abs(shift);
      const attributes = [
        `x1="${number(px + ux * t0)}"`,
        `y1="${number(py + uy * t0)}"`,
        `x2="${number(px + ux * t1)}"`,
        `y2="${number(py + uy * t1)}"`,
      ];
      if (dash) {
        attributes.push(`stroke-dasharray="${dash.map(number).join(' ')}"`);
        attributes.push(`stroke-dashoffset="${number(period ? ((t0 % period) + period) % period : 0)}"`);
      }
      output.push(`<line ${attributes.join(' ')}/>`);
    }
  }
  output.push('</g>');
  return output.join('');
}
