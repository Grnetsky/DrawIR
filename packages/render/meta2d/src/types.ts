import type { VectorGeom } from '@drawir/core';
import type { RenderOptions } from '@drawir/render-core';

/**
 * IR 文档 → meta2d 图元的粒度：
 * - `'item'`：每个顶层绘制项一个图元，可单独选中、移动、编辑（缺省）
 * - `'document'`：整份文档一个图元，适合只看不改的大图纸
 */
export type Meta2dGranularity = 'item' | 'document';

export interface Meta2dConvertOptions {
  granularity?: Meta2dGranularity;
  /** granularity 为 'item' 时，绘制项超过该数量自动改为 'document'（图元过多会拖慢 meta2d 的拾取和撤销），缺省 20000 */
  maxPens?: number;
  /**
   * 可编辑模式（granularity 为 'item' 时生效，缺省 true）：
   * - 文字项转为 meta2d 原生文字图元（name: 'text'），双击即可修改；
   * - 单路径项的固定描边色 / 填充色 / 线宽提升到 pen.color / pen.background / pen.lineWidth，属性面板修改立即生效。
   */
  editable?: boolean;
  /** 文档坐标 → 画布坐标的缩放，缺省 1 */
  scale?: number;
  /** 文档原点在画布上的位置，缺省 { x: 0, y: 0 } */
  origin?: { x: number; y: number };
  /** 覆盖 doc.color（'$fg'）；都没有时跟随 meta2d 主题 / 图元颜色 */
  color?: string;
  /** 覆盖 doc.background（'$bg'），写入 pen.background */
  background?: string;
  /** 覆盖 doc.lineWidth（'$lw' 与最细线宽），写入 pen.lineWidth */
  lineWidth?: number;
  /** 覆盖 doc.lineDash，写入 pen.lineDash */
  lineDash?: number[];
  /** 固定颜色也统一使用前景色（pen.vectorTint） */
  tint?: boolean;
  /** 图元锁定状态（meta2d LockState），缺省不锁定 */
  locked?: number;
  /**
   * 共享几何 id 前缀。多次导入的文档可能使用相同的 id（如 dxf-1），
   * 追加到同一图纸时会互相覆盖，因此缺省为每次转换生成随机前缀；传 false 保留原 id。
   */
  namespace?: string | false;
  /** 写入每个图元的额外属性（如 { drawir: { source: 'dxf' } }） */
  extra?: Record<string, any>;
}

/** 转换结果：可直接 meta2d.open(data)，或 addVectors(vectors) + addPens(pens) 追加 */
export interface Meta2dData {
  pens: any[];
  vectors: Record<string, VectorGeom>;
  background?: string;
  /** 实际使用的粒度（可能因 maxPens 自动降级） */
  granularity: Meta2dGranularity;
}

/** Meta2dRenderer.render() 的选项 */
export interface Meta2dRenderOptions extends RenderOptions, Meta2dConvertOptions {
  /**
   * 渲染方式：
   * - `'open'`：作为新图纸打开，替换当前内容（缺省；`clear: false` 时为 'append'）
   * - `'append'`：追加到当前图纸，可撤销，不改变视图（除非显式 fit / viewport）
   */
  mode?: 'open' | 'append';
  /** 追加时是否记录撤销历史，缺省 true */
  history?: boolean;
}

/** Meta2dRenderer 依赖的 Meta2d 实例方法（@meta2d/core 1.x 的 Meta2d 满足此接口） */
export interface Meta2dLike {
  open(data?: any, render?: boolean): void;
  addPens(pens: any[], history?: boolean): Promise<any[]>;
  addVectors(vectors: Record<string, VectorGeom>): void;
  setBackgroundColor(color?: string): void;
  scale(scale: number, center?: { x: number; y: number }): void;
  translate(x: number, y: number): void;
  render(patchFlags?: boolean | number): void;
  store: { data: { scale: number; x: number; y: number; origin: { x: number; y: number } } };
  canvas?: { canvas?: { offsetWidth: number; offsetHeight: number } };
  destroy?(onlyData?: boolean): void;
}
