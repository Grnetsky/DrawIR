import { VectorPathBuilder, type VectorMatrix } from '@drawir/core';

export interface VectorNetworkShape {
  d: number[];
  rule: 'nonzero' | 'evenodd';
}

interface Vertex {
  x: number;
  y: number;
}

interface Segment {
  start: number;
  end: number;
  tsx: number;
  tsy: number;
  tex: number;
  tey: number;
}

/**
 * Figma vectorNetworkBlob → 闭合填充区域。
 * 布局：12 字节头；顶点为 styleID、x、y；线段为 styleID、起终点和相对切线；区域保存有序线段索引。
 */
export function vectorNetworkToShapes(blob: Uint8Array, m: VectorMatrix): VectorNetworkShape[] {
  try {
    if (blob.byteLength < 12) return [];
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    let p = 0;
    const u32 = () => {
      const v = view.getUint32(p, true);
      p += 4;
      return v;
    };
    const f32 = () => {
      const v = view.getFloat32(p, true);
      p += 4;
      return v;
    };
    const vertexCount = u32();
    const segmentCount = u32();
    const regionCount = u32();
    if (vertexCount > (blob.byteLength - 12) / 12) return [];
    const vertices: Vertex[] = [];
    for (let i = 0; i < vertexCount; i++) {
      u32();
      const x = f32();
      const y = f32();
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
      vertices.push({ x, y });
    }
    if (segmentCount > (blob.byteLength - p) / 28) return [];
    const segments: Segment[] = [];
    for (let i = 0; i < segmentCount; i++) {
      u32();
      const segment = { start: u32(), tsx: f32(), tsy: f32(), end: u32(), tex: f32(), tey: f32() };
      if (segment.start >= vertexCount || segment.end >= vertexCount) return [];
      if (![segment.tsx, segment.tsy, segment.tex, segment.tey].every(Number.isFinite)) return [];
      segments.push(segment);
    }

    const shapes: VectorNetworkShape[] = [];
    for (let i = 0; i < regionCount; i++) {
      const packed = u32();
      const loopCount = u32();
      const b = new VectorPathBuilder(m);
      for (let j = 0; j < loopCount; j++) {
        const count = u32();
        if (count > (blob.byteLength - p) / 4) return [];
        const indices = Array.from({ length: count }, u32);
        if (indices.some((index) => index >= segmentCount)) return [];
        if (indices.length) drawLoop(b, indices.map((index) => segments[index]), vertices);
      }
      if (p > blob.byteLength) return [];
      b.d.length && shapes.push({ d: b.d, rule: packed & 1 ? 'nonzero' : 'evenodd' });
    }
    return p === blob.byteLength ? shapes : [];
  } catch {
    return [];
  }
}

function drawLoop(b: VectorPathBuilder, segments: Segment[], vertices: Vertex[]) {
  const first = segments[0];
  const second = segments[1];
  const reverseFirst = !!second && !touches(first.end, second) && touches(first.start, second);
  let current = reverseFirst ? first.end : first.start;
  const start = current;
  b.moveTo(vertices[current].x, vertices[current].y);
  for (const segment of segments) {
    if (segment.start === current) {
      drawSegment(b, segment, vertices, false);
      current = segment.end;
    } else if (segment.end === current) {
      drawSegment(b, segment, vertices, true);
      current = segment.start;
    } else {
      current = segment.start;
      b.moveTo(vertices[current].x, vertices[current].y);
      drawSegment(b, segment, vertices, false);
      current = segment.end;
    }
  }
  current !== start && b.lineTo(vertices[start].x, vertices[start].y);
  b.close();
}

function touches(vertex: number, segment: Segment) {
  return segment.start === vertex || segment.end === vertex;
}

function drawSegment(b: VectorPathBuilder, segment: Segment, vertices: Vertex[], reverse: boolean) {
  const a = vertices[reverse ? segment.end : segment.start];
  const z = vertices[reverse ? segment.start : segment.end];
  const c1x = a.x + (reverse ? segment.tex : segment.tsx);
  const c1y = a.y + (reverse ? segment.tey : segment.tsy);
  const c2x = z.x + (reverse ? segment.tsx : segment.tex);
  const c2y = z.y + (reverse ? segment.tsy : segment.tey);
  if (segment.tsx || segment.tsy || segment.tex || segment.tey) b.cubicTo(c1x, c1y, c2x, c2y, z.x, z.y);
  else b.lineTo(z.x, z.y);
}
