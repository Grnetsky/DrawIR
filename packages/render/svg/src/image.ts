import type { VectorImageItem } from '@drawir/core';
import type { SvgState } from './types';
import { escapeXml, number } from './utils';

const ASPECT = { fill: 'none', contain: 'xMidYMid meet', cover: 'xMidYMid slice' } as const;

/**
 * 图片项：单位正方形经 item.m 映射到局部坐标。把 m 的两个轴归一化后作为 transform，
 * 图片按框的实际宽高放置，contain / cover 才能按真实宽高比计算（与 @meta2d/core vector 一致）。
 */
export function renderImage(item: VectorImageItem, state: SvgState) {
  if (!item.src) return '';
  const m = item.m;
  const bw = Math.hypot(m[0], m[1]);
  const bh = Math.hypot(m[2], m[3]);
  if (!(bw > 0 && bh > 0)) return '';
  const t = [m[0] / bw, m[1] / bw, m[2] / bh, m[3] / bh, m[4], m[5]].map(number).join(' ');
  let clip = '';
  let clipAttr = '';
  if (item.radius && item.radius > 0) {
    const id = `drawir-c${state.nextId()}`;
    const r = number(item.radius);
    clip = `<defs><clipPath id="${id}"><rect width="${number(bw)}" height="${number(bh)}" rx="${r}" ry="${r}"/></clipPath></defs>`;
    clipAttr = ` clip-path="url(#${id})"`;
  }
  const opacity = item.alpha !== undefined ? ` opacity="${number(item.alpha)}"` : '';
  const aspect = ASPECT[item.fit || 'fill'];
  return `<g transform="matrix(${t})"${opacity}>${clip}<image href="${escapeXml(item.src)}" width="${number(bw)}" height="${number(bh)}" preserveAspectRatio="${aspect}"${clipAttr}/></g>`;
}
