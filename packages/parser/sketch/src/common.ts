import { createGeom } from '@drawir/core';
import { imageMime, imageSize, readSketch } from './archive';
import { fontWeight, SketchToIR, treeToItems, type SketchLayer } from './ir';
import { SketchConverter, type SketchPenAdapter } from './parser';
import type { SketchDocument, SketchParseOptions, SketchVectorDocument } from './types';

export type SketchInput = ArrayBuffer | Uint8Array | Blob;

export async function toBytes(input: SketchInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await (input as Blob).arrayBuffer());
}

export function createParsers(adapter: SketchPenAdapter) {
  return {
    /** 解析 Sketch 文件（.sketch）为 meta2d 图元 */
    async parseSketch(input: SketchInput, options: SketchParseOptions = {}): Promise<SketchDocument> {
      return new SketchConverter(options, adapter).convert(await toBytes(input));
    },
    parseSketchSync(data: Uint8Array, options: SketchParseOptions = {}): SketchDocument {
      return new SketchConverter(options, adapter).convert(data);
    },
  };
}

/**
 * 解析为纯 Vector IR（与 meta2d 版本无关）：可交给 core 的 vectorDocumentToPens，或任意 DrawIR 渲染后端。
 * 图片为 IR 图片项，渐变为 IR 渐变（style.fill / stroke）
 */
export async function parseSketchVector(input: SketchInput, options: SketchParseOptions = {}): Promise<SketchVectorDocument> {
  return parseSketchVectorSync(await toBytes(input), options);
}

/** 同 parseSketchVector，输入为已读取的数据 */
export function parseSketchVectorSync(data: Uint8Array, options: SketchParseOptions = {}): SketchVectorDocument {
  const tree = new SketchToIR(options).build(data);
  const items = tree.pages.flatMap(treeToItems);
  const last = tree.pageList[tree.pageList.length - 1];
  return {
    ...createGeom(items),
    vectors: {},
    width: last ? last.x + last.width : 0,
    height: Math.max(0, ...tree.pageList.map((p) => p.height)),
    pageList: tree.pageList,
    stats: tree.stats,
  };
}

export interface SketchPageMeta {
  /** 页序号（与解析选项 pages 一致，从 0 开始） */
  index: number;
  /** 页面 do_objectID */
  id: string;
  name: string;
  /** 页面顶层图层数 */
  layers: number;
  /** 画板（含新版 Frame、组件母版）名称 */
  artboards: string[];
}

/** 读取页面列表（不解析几何），供导入配置界面选择页面 */
export async function readSketchPages(input: SketchInput): Promise<SketchPageMeta[]> {
  const sk = readSketch(await toBytes(input), { images: false });
  return sk.pages.map((p, index) => {
    const top: any[] = p.layers || [];
    return {
      index,
      id: p.do_objectID,
      name: p.name || `Page ${index + 1}`,
      layers: top.filter((l) => l.isVisible !== false).length,
      artboards: top.filter((l) => l._class === 'artboard' || l._class === 'symbolMaster' || (l._class === 'group' && l.groupBehavior === 1)).map((l) => l.name),
    };
  });
}

/**
 * 读取图层树（不计算几何），供导入配置界面按图层选择：每页一个根节点（type 为 page，顺序与解析选项 pages 一致），
 * 子图层上层在前；组件实例展开为母版内的图层。不导入的图层 id 传给 skipNodes
 */
export async function readSketchLayers(input: SketchInput): Promise<SketchLayer[]> {
  return new SketchToIR().layers(await toBytes(input));
}

export interface SketchImage {
  /** 图片引用（如 `images/<sha1>.png`），即 SketchParseOptions.imageUrls 的键 */
  ref: string;
  bytes: Uint8Array;
  mime: string;
  /** 建议的文件名 */
  name: string;
  /** 像素尺寸（读文件头，读不出时缺省） */
  width?: number;
  height?: number;
  /** 引用次数（位图图层、图片填充、覆盖） */
  uses: number;
}

/**
 * 取出文件中被图层引用的图片，便于先上传到服务器，再把 ref → URL 传给 imageUrls，
 * 避免图片以 data URL 内嵌进图纸 JSON。
 */
export async function readSketchImages(input: SketchInput): Promise<SketchImage[]> {
  const sk = readSketch(await toBytes(input));
  const uses = new Map<string, number>();
  const add = (ref: any) => ref?._ref && uses.set(ref._ref, (uses.get(ref._ref) || 0) + 1);
  const walk = (l: any, depth: number) => {
    if (!l || depth > 128) return;
    l._class === 'bitmap' && add(l.image);
    for (const f of l.style?.fills || []) f.fillType === 4 && add(f.image);
    for (const o of l.overrideValues || []) add(o.value);
    for (const c of l.layers || []) walk(c, depth + 1);
  };
  sk.pages.forEach((p) => walk(p, 0));
  for (const f of sk.document.foreignSymbols || []) walk(f.symbolMaster, 0);
  const out: SketchImage[] = [];
  for (const [ref, n] of uses) {
    const bytes = sk.images.get(ref) ?? sk.images.get(`${ref}.png`);
    if (!bytes) continue;
    const name = ref.replace(/^images\//, '');
    const size = imageSize(bytes);
    out.push({ ref, bytes, mime: imageMime(bytes), name: /\.[a-z0-9]+$/i.test(name) ? name : `${name}.png`, width: size?.width, height: size?.height, uses: n });
  }
  return out;
}

export interface SketchFont {
  /** 字体族名（CSS font-family，解析出的文字图元按这个名字引用） */
  family: string;
  /** 原始文件名，如 SF-Pro.ttf */
  fileName: string;
  /** 该字体文件包含的 PostScript 名 */
  postscriptNames: string[];
  bytes: Uint8Array;
}

/**
 * 读取文件内嵌的字体（Sketch「文档 → 嵌入字体」），用于在显示前注册（见 registerSketchFonts），
 * 本机没有安装设计稿字体时文字、SF Symbols 图标也能正确显示。注意字体的授权限制
 */
export async function readSketchFonts(input: SketchInput): Promise<SketchFont[]> {
  const sk = readSketch(await toBytes(input), { images: false, fonts: true });
  const out: SketchFont[] = [];
  for (const f of sk.document.fontReferences || []) {
    const bytes = f.fontData?._ref && sk.fonts.get(f.fontData._ref);
    if (!bytes || !f.fontFamilyName) continue;
    out.push({ family: f.fontFamilyName, fileName: f.fontFileName || '', postscriptNames: f.postscriptNames || [], bytes });
  }
  return out;
}

/**
 * 在浏览器 / Worker 中注册内嵌字体（FontFace），返回加载成功的字体族名。
 * 可变字体（如 SF-Pro.ttf）按字重范围 1~1000 注册；不支持 FontFace 的环境直接返回空数组
 */
export async function registerSketchFonts(fonts: SketchFont[]): Promise<string[]> {
  const g: any = typeof self !== 'undefined' ? self : globalThis;
  if (typeof g.FontFace !== 'function' || !g.document?.fonts && !g.fonts) return [];
  const set = g.document?.fonts || g.fonts;
  const ok: string[] = [];
  await Promise.all(
    fonts.map(async (f) => {
      const italic = f.postscriptNames.length > 0 && f.postscriptNames.every((n) => /italic|oblique/i.test(n));
      const variable = f.postscriptNames.length > 1;
      const style = f.postscriptNames[0]?.split('-').pop() || '';
      const weight = variable ? '1 1000' : String(fontWeight(style));
      try {
        const face = new g.FontFace(f.family, f.bytes, { weight, style: italic ? 'italic' : 'normal' });
        await face.load();
        set.add(face);
        ok.includes(f.family) || ok.push(f.family);
      } catch (e) {
        console.warn('sketch font', f.fileName, e);
      }
    }),
  );
  return ok;
}
