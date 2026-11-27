import type { VectorDocument } from '@drawir/core';
import type { Meta2dPensDocument } from './util';

export interface SymPoint {
  x: number;
  y: number;
}

export interface SymTextParam {
  longAxis: number;
  centerX: number;
  centerY: number;
  shortAxis: number;
  width: number;
  text: string;
  angle: number;
}

export interface SymFontParam {
  height: number;
  width: number;
  escapement: number;
  orientation: number;
  weight: number;
  italic: boolean;
  underline: boolean;
  strikeOut: boolean;
  charSet: number;
  faceName: string;
}

export interface SymPointCell {
  kind: 'point';
  type: number;
  color: number;
  colorLocked: boolean;
  fillStyle?: number;
  fillColor?: number;
  offsetX?: number;
  offsetY?: number;
  size?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  width?: number;
  points?: SymPoint[];
  angle?: number;
  startAngle?: number;
  endAngle?: number;
  longAxis?: number;
  shortAxis?: number;
  ratio?: number;
  corners?: number;
  interAngle?: number;
  innerAngle?: number;
  asteriskType?: number;
  textParam?: SymTextParam;
  fontParam?: SymFontParam;
}

export interface SymTemplatePattern {
  mark: number;
  gap: number;
}

export interface SymSymbolTemplate {
  interval: number;
  patternElements: SymTemplatePattern[];
}

export interface SymLineCell {
  kind: 'line';
  type: number;
  width: number;
  color: number;
  simpleLineStyle?: number;
  offset?: number;
  hasTemplate?: number;
  symbolTemplate?: SymSymbolTemplate;
  cap?: number;
  join?: number;
  endType?: number;
  directionType?: number;
  pointCells?: SymPointCell[];
}

export interface SymFillCell {
  kind: 'fill';
  type: number;
  color: number;
  lineCells: SymLineCell[];
  simpleFillStyle: number;
}

export type SymCell = SymPointCell | SymLineCell | SymFillCell;

export interface SymSymbol {
  type: number;
  code: number;
  name: string;
  drawMode: number;
  cells: SymCell[];
  bounds?: { left: number; right: number; bottom: number; top: number };
  width?: number;
}

export interface SymSource {
  version: string;
  symbols: SymSymbol[];
}

export interface SymParseOptions {
  pages?: number[];
  codes?: number[];
  pageGap?: number;
  scale?: number;
  origin?: { x: number; y: number };
  granularity?: 'node' | 'layer' | 'page';
  group?: boolean;
  editable?: boolean;
}

export interface SymParseStats {
  pages: number;
  nodes: number;
  pens: number;
  unsupported: Record<string, number>;
  errors: string[];
  ms: number;
}

export interface SymPageInfo {
  name: string;
  code: number;
  symbolType: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SymPenInfo {
  page: number;
  id?: string;
  code: number;
  symbolType: number;
  cellType?: number;
  type?: string;
  name?: string;
  part?: 'label' | 'page';
  colorLocked?: boolean;
}

export interface SymDocument extends Meta2dPensDocument {
  stats: SymParseStats;
  pageList: SymPageInfo[];
}

export interface SymVectorDocument extends VectorDocument {
  stats: SymParseStats;
  pageList: SymPageInfo[];
}
