import type { VectorDocument } from '@drawir/core';
import type { Meta2dPensDocument } from './util';
import type { GenCADHeader } from './decode';

export interface GenCADParseOptions {
  /** 源单位 → 画布像素；0 或缺省时按 fitWidth / fitHeight 自动适配 */
  scale?: number;
  fitWidth?: number;
  fitHeight?: number;
  origin?: { x: number; y: number };
  /** node：器件/焊盘/走线；layer：按 GenCAD 层合并；page：整板一个矢量图元 */
  granularity?: 'node' | 'layer' | 'page';
  group?: boolean;
  editable?: boolean;
  /** 只导入这些层（不区分大小写），如 ['TOP', 'SILKSCREEN_TOP'] */
  layers?: string[];
  /** 顶面、底面或两面；layers 设置后仍会再按 layers 过滤 */
  side?: 'top' | 'bottom' | 'both';
  pads?: boolean;
  routes?: boolean;
  components?: boolean;
  texts?: boolean;
  drills?: boolean;
  /** 板框内填充色；缺省不填充 */
  boardFill?: string;
  background?: string;
  /** 覆盖默认层色，键为 TOP、BOTTOM、SILKSCREEN_TOP 等 */
  layerColors?: Record<string, string>;
}

export interface GenCADParseStats {
  pages: number;
  nodes: number;
  components: number;
  pads: number;
  routes: number;
  vias: number;
  pens: number;
  unsupported: Record<string, number>;
  errors: string[];
  ms: number;
}

export interface GenCADPageInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  background?: string;
  units: string;
  drawing?: string;
}

export type GenCADPenType = 'board' | 'artwork' | 'component' | 'pin' | 'via' | 'route' | 'hole' | 'text' | 'layer' | 'page';

/** pen.gencad：GenCAD 特有的源信息 */
export interface GenCADPenInfo {
  page: number;
  id?: string;
  type?: GenCADPenType;
  name?: string;
  part?: 'outline' | 'copper' | 'drill' | 'silkscreen' | 'label' | 'plane' | 'cutout' | 'page';
  layer?: string;
  net?: string;
  component?: string;
  pin?: string;
  padstack?: string;
  sourceLine?: number;
}

export interface GenCADDocument extends Meta2dPensDocument {
  stats: GenCADParseStats;
  pageList: GenCADPageInfo[];
  background?: string;
  header: GenCADHeader;
  layers: string[];
}

export interface GenCADVectorDocument extends VectorDocument {
  stats: GenCADParseStats;
  pageList: GenCADPageInfo[];
  header: GenCADHeader;
  layers: string[];
}

export interface GenCADInfo {
  header: GenCADHeader;
  layers: string[];
  components: number;
  pads: number;
  routes: number;
  vias: number;
}
