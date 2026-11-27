import { ellipseToCubics, VectorOp, VectorOpSize } from '@drawir/core';
import type { VectorPathData, VectorPathItem, VectorStyle } from '@drawir/core';
import type { SvgState } from './types';
import { escapeXml, number, resolvePaint } from './utils';

export function vectorPathToSvg(data: VectorPathData) {
  const out: string[] = [];
  for (let i = 0; i < data.length; ) {
    const op = data[i];
    switch (op) {
      case VectorOp.Move:
        out.push(`M${number(data[i + 1])} ${number(data[i + 2])}`);
        break;
      case VectorOp.Line:
        out.push(`L${number(data[i + 1])} ${number(data[i + 2])}`);
        break;
      case VectorOp.Cubic:
        out.push(`C${data.slice(i + 1, i + 7).map(number).join(' ')}`);
        break;
      case VectorOp.Quad:
        out.push(`Q${data.slice(i + 1, i + 5).map(number).join(' ')}`);
        break;
      case VectorOp.Close:
        out.push('Z');
        break;
      case VectorOp.Ellipse: {
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
        out.push(`L${number(start[0])} ${number(start[1])}`);
        for (const curve of curves) out.push(`C${curve.map(number).join(' ')}`);
        break;
      }
      default:
        return out.join(' ');
    }
    i += VectorOpSize[op];
  }
  return out.join(' ');
}

function styleAttributes(style: VectorStyle | undefined, state: SvgState, defs: string[]) {
  const attributes = [
    `fill="${escapeXml(resolvePaint(style?.fill, state, 'none', defs))}"`,
    `stroke="${escapeXml(resolvePaint(style?.stroke, state, 'fg', defs))}"`,
  ];
  const localWidth = style?.lw === '$lw' ? state.lineWidth : style?.lw ?? state.lineWidth;
  const width = Math.max(localWidth, style?.px || 0);
  attributes.push(`stroke-width="${number(width)}"`);
  if (style?.px && style.px >= localWidth) attributes.push('vector-effect="non-scaling-stroke"');
  const dash = style?.dash || state.lineDash;
  if (dash?.length) attributes.push(`stroke-dasharray="${dash.map(number).join(' ')}"`);
  if (style?.cap) attributes.push(`stroke-linecap="${style.cap}"`);
  if (style?.join) attributes.push(`stroke-linejoin="${style.join}"`);
  if (style?.rule) attributes.push(`fill-rule="${style.rule}"`);
  if (style?.alpha !== undefined) attributes.push(`opacity="${number(style.alpha)}"`);
  return attributes.join(' ');
}

export function renderPath(item: VectorPathItem, state: SvgState) {
  const defs: string[] = [];
  const attributes = styleAttributes(item.s, state, defs);
  return `${defs.length ? `<defs>${defs.join('')}</defs>` : ''}<path d="${vectorPathToSvg(item.d)}" ${attributes}/>`;
}
