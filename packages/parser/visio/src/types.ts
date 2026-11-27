import type { VectorDocument } from '@drawir/core';
import type { Meta2dPensDocument } from './util';

export interface VisioParseOptions {
  /** 1 英寸 = 多少像素，默认 96（Visio 内部单位是英寸） */
  dpi?: number;
  /** 解析哪些页（从 0 开始的序号），缺省全部 */
  pages?: number[];
  /** 多页时页面之间的水平间距（像素），默认 40 */
  pageGap?: number;
  /** 连接线生成为 meta2d 原生连线（可编辑、跟随图形移动），默认 true；false 时画成矢量图元 */
  nativeLines?: boolean;
  /** 是否绘制每页的页面边框，默认 false */
  pageBorder?: boolean;
  /**
   * 生成可编辑的图元，默认 true：标准形状为原生图元（矩形、圆、菱形…），文字为原生文字图元，
   * 其余形状的颜色 / 线宽绑定到图元属性。false 时按 Visio 外观原样生成矢量图元
   */
  editable?: boolean;
}

export interface VisioParseStats {
  pages: number;
  shapes: number;
  lines: number;
  connections: number;
  images: number;
  /** 共享几何（母版）数 */
  masters: number;
  /** 未支持的几何行类型及数量 */
  unsupported: Record<string, number>;
  errors: string[];
  ms: number;
}

export interface VisioPageInfo {
  name: string;
  /** 页面在画布中的位置和尺寸 */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 图元上的 Visio 源信息（pen.vsdx）。Visio 特有的内容都收在这里，不作为 core 图元的顶层属性。
 */
export interface VisioPenInfo {
  /** 所在页序号（从 0 开始，与 VisioParseOptions.pages 一致） */
  page: number;
  /** 形状 ID（页内唯一） */
  id?: string;
  /** 形状类型：Shape / Group / Foreign … */
  type?: string;
  /** 形状显示名（Name） */
  name?: string;
  /** 形状通用名（NameU，缺省取母版名），如 Rectangle、Dynamic connector */
  nameU?: string;
  /** 由形状拆出的部分：'text' 形状 / 连线上的文字，'page' 页面边框 */
  part?: 'text' | 'page';
}

export interface VisioDocument extends Meta2dPensDocument {
  stats: VisioParseStats;
  pageList: VisioPageInfo[];
  /** 页面背景色（主题） */
  background?: string;
}

/** 纯 Vector IR 结果（parseVisioVector），可交给 core 的 vectorDocumentToPens 或任意 DrawIR 渲染后端 */
export interface VisioVectorDocument extends VectorDocument {
  stats: VisioParseStats;
  pageList: VisioPageInfo[];
}
