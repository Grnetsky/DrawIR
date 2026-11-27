import type { VectorDocument } from '@drawir/core';
import type { Meta2dPensDocument } from './util';

export interface DxfParseOptions {
  /**
   * 图纸缩放：CAD 单位 → 画布像素。缺省按 `fitWidth/fitHeight` 自动计算，使整张图适配该尺寸。
   * 设置后忽略 fit*。
   */
  scale?: number;
  /** 自动缩放时图纸适配的宽度，默认 1920 */
  fitWidth?: number;
  /** 自动缩放时图纸适配的高度，默认 1080 */
  fitHeight?: number;
  /** 图纸左上角在画布上的位置，默认 (0, 0) */
  origin?: { x: number; y: number };
  /**
   * 图元粒度：
   * - 'entity'（默认）：每个顶层实体 / 块引用一个图元，可单独选中编辑
   * - 'layer'：每个图层合并为一个图元，图元数少，适合只看不改的大图纸
   */
  granularity?: 'entity' | 'layer';
  /** 是否解析填充（HATCH / SOLID），默认 true */
  hatch?: boolean;
  /** 是否解析文字（TEXT / MTEXT / ATTRIB），默认 true */
  text?: boolean;
  /** 只保留这些图层（图层名），缺省全部 */
  layers?: string[];
  /** 文字编码，缺省按 $DWGCODEPAGE 自动判断（R2007 以前的中文图纸常为 GBK） */
  encoding?: string;
  /**
   * 黑白色（ACI 7 及纯黑纯白真彩色）在 CAD 中随背景反色。默认 true：交给画布前景色（随主题），
   * 否则白底画布上白线看不见。
   */
  contrastColor?: boolean;
  /** 最小线宽（CAD 单位），默认 0 = 1 像素细线 */
  minLineWidth?: number;
  /**
   * 底板（覆盖图纸大半面积、只有填充的图元，如白色底板）的处理：
   * - 'back'（默认）：移到最底层并锁定，不遮挡图形
   * - 'keep'：按文件中的绘制次序原样保留
   * - 'remove'：去掉
   */
  backdrop?: 'back' | 'keep' | 'remove';
  /**
   * 绘制哪个空间：'model' 模型空间、'paper' 图纸空间（布局），
   * 'auto'（默认）优先模型空间，模型空间为空时用图纸空间
   */
  space?: 'auto' | 'model' | 'paper';
  /**
   * 生成可编辑的图元，默认 true：文字为原生文字图元（可改内容、字号、颜色），
   * 单路径实体的颜色 / 线宽绑定到图元属性（属性面板可改）。false 时全部为只读外观的矢量图元
   */
  editable?: boolean;
}

export interface DxfParseStats {
  /** 各类实体数量 */
  entities: Record<string, number>;
  /** 未支持（跳过）的实体类型及数量 */
  unsupported: Record<string, number>;
  /** 块定义数量（共享几何） */
  blocks: number;
  /** 解析错误（单个实体出错不影响其它实体） */
  errors: string[];
  scale: number;
  /** CAD 坐标范围（不含离群图元） */
  extents: { minX: number; minY: number; maxX: number; maxY: number };
  /** 远离主图、不参与范围计算的离群图元数（仍会绘制） */
  outliers?: number;
  /** 识别出的底板数（见 DxfParseOptions.backdrop） */
  backdrops?: number;
  /** 实际绘制的空间 */
  space?: 'model' | 'paper';
  ms: number;
}

/**
 * 图元上的 DXF 源信息（pen.dxf）。DXF 特有的内容都收在这里，不作为 core 图元的顶层属性。
 */
export interface DxfPenInfo {
  /** 实体类型：LINE / INSERT / MTEXT / ATTRIB …；按图层合并时缺省 */
  type?: string;
  /** 所在图层 */
  layer?: string;
  /** 实体句柄 */
  handle?: string;
  /** 块名（INSERT） */
  block?: string;
  /** 是否为底板（见 DxfParseOptions.backdrop） */
  backdrop?: boolean;
}

export interface DxfDocument extends Meta2dPensDocument {
  stats: DxfParseStats;
  /** 图层：名称 → 颜色，便于 UI 做图层开关（每个图元的 dxf.layer 记录了所属图层） */
  layers: Record<string, { color?: string; visible: boolean }>;
}

/** 纯 Vector IR 结果（parseDxfVector），可交给 core 的 vectorDocumentToPens 或任意 DrawIR 渲染后端 */
export interface DxfVectorDocument extends VectorDocument {
  stats: DxfParseStats;
  layers: Record<string, { color?: string; visible: boolean }>;
}
