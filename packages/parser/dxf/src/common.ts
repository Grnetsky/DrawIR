import { createGeom } from '@drawir/core';
import { DxfParser } from 'dxf-json';
import { DxfConverter, type DxfPenAdapter } from './parser';
import type { DxfDocument, DxfParseOptions, DxfVectorDocument } from './types';
import { bakePenStyle } from './util';

export type DxfInput = string | ArrayBuffer | Uint8Array | Blob;

/** $DWGCODEPAGE → TextDecoder 编码。R2007 起 DXF 统一 UTF-8，之前按代码页 */
const CODEPAGES: Record<string, string> = {
  ANSI_936: 'gbk',
  ANSI_950: 'big5',
  ANSI_932: 'shift_jis',
  ANSI_949: 'euc-kr',
  ANSI_1252: 'windows-1252',
  ANSI_1251: 'windows-1251',
  ANSI_1250: 'windows-1250',
};

function detectEncoding(bytes: Uint8Array): string {
  // 只看文件头：$ACADVER 与 $DWGCODEPAGE 都在 HEADER 段开头
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*AC(\d{4})/.exec(head)?.[1];
  // AC1021 = R2007，起统一 UTF-8
  if (ver && +ver >= 1021) return 'utf-8';
  const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/.exec(head)?.[1]?.toUpperCase();
  return (cp && CODEPAGES[cp]) || 'utf-8';
}

/** 读取 DXF 文本，自动处理编码 */
export async function readDxfText(input: DxfInput, encoding?: string) {
  if (typeof input === 'string') return input;
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(await (input as Blob).arrayBuffer());
  const enc = encoding || detectEncoding(bytes);
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function convertDxf(text: string, options: DxfParseOptions, adapter: DxfPenAdapter): DxfDocument {
  const dxf = new DxfParser().parseSync(text);
  return new DxfConverter(options, adapter).convert(dxf, text);
}

export function createParsers(adapter: DxfPenAdapter) {
  return {
    async parseDxf(input: DxfInput, options: DxfParseOptions = {}): Promise<DxfDocument> {
      const text = await readDxfText(input, options.encoding);
      return convertDxf(text, options, adapter);
    },
    parseDxfSync(text: string, options: DxfParseOptions = {}): DxfDocument {
      return convertDxf(text, options, adapter);
    },
  };
}

/** 生成纯 IR 用的适配器：editable 为 false 时只产生矢量图元，不会调用 text / group */
const vectorAdapter: DxfPenAdapter = {
  vector() {},
  text: () => undefined,
  group: (_group, children) => children,
};

/**
 * 解析为纯 Vector IR（与 meta2d 版本无关）：可交给 core 的 vectorDocumentToPens，或任意 DrawIR 渲染后端。
 * 与 parseDxf 共用同一套解析；图元上的颜色 / 线宽写回矢量项（见 bakePenStyle）
 */
export async function parseDxfVector(input: DxfInput, options: DxfParseOptions = {}): Promise<DxfVectorDocument> {
  return parseDxfVectorSync(await readDxfText(input, options.encoding), options);
}

/** 同 parseDxfVector，输入为 DXF 文本 */
export function parseDxfVectorSync(text: string, options: DxfParseOptions = {}): DxfVectorDocument {
  const res = convertDxf(text, { ...options, editable: false }, vectorAdapter);
  const vectors = res.vectors || {};
  const items = res.pens.flatMap((pen) => (pen.vector ? bakePenStyle(pen.vector.items, pen) : []));
  return {
    ...createGeom(items, (id) => vectors[id]),
    vectors,
    width: res.width,
    height: res.height,
    layers: res.layers,
    stats: res.stats,
  };
}
