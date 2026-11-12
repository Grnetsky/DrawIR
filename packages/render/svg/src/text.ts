import { textItemLines } from '@drawir/core';
import type { VectorTextItem } from '@drawir/core';
import type { SvgState } from './types';
import { escapeXml, number, resolveColor } from './utils';

function anchor(align: VectorTextItem['a']) {
  if (align === 'center') return 'middle';
  if (align === 'right' || align === 'end') return 'end';
  return 'start';
}

function baseline(value: VectorTextItem['b']) {
  if (value === 'top' || value === 'hanging') return 'hanging';
  if (value === 'middle') return 'central';
  if (value === 'bottom' || value === 'ideographic') return 'text-after-edge';
  return 'alphabetic';
}

export function renderText(item: VectorTextItem, state: SvgState) {
  const fill = resolveColor(item.fill, state, 'fg');
  if (!item.text || fill === 'none') return '';
  const transforms = [`translate(${number(item.x)} ${number(item.y)})`];
  if (item.r) transforms.push(`rotate(${number((item.r * 180) / Math.PI)})`);
  if (item.m || (item.w && item.w !== 1)) transforms.push(`scale(${number(item.w || 1)} ${item.m ? -1 : 1})`);
  const lines = textItemLines(item);
  const lineHeight = (item.lh || 1.25) * item.h;
  let y = 0;
  if (item.b === 'middle') y = (-(lines.length - 1) * lineHeight) / 2;
  else if (item.b === 'bottom' || item.b === 'ideographic') y = -(lines.length - 1) * lineHeight;
  const spans = lines
    .map((line, index) => `<tspan x="0" y="${number(y + index * lineHeight)}">${escapeXml(line)}</tspan>`)
    .join('');
  const attributes = [
    `fill="${escapeXml(fill)}"`,
    `font-size="${number(item.h)}"`,
    `font-family="${escapeXml(item.font || 'Arial, sans-serif')}"`,
    `text-anchor="${anchor(item.a)}"`,
    `dominant-baseline="${baseline(item.b)}"`,
    'xml:space="preserve"',
  ];
  if (item.bold) attributes.push('font-weight="bold"');
  if (item.italic) attributes.push('font-style="italic"');
  return `<g transform="${transforms.join(' ')}"><text ${attributes.join(' ')}>${spans}</text></g>`;
}
