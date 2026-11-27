import type { VectorDocument } from '@drawir/core';
import type { Meta2dPensDocument } from './util';

export type MermaidDiagramType = 'flowchart' | 'sequenceDiagram';

export interface MermaidParseOptions {
  /** 布局坐标 → 画布像素，缺省 1 */
  scale?: number;
  /** 内容左上角在画布上的位置，缺省 (0, 0) */
  origin?: { x: number; y: number };
  /** node：每个形状/连线；layer/page：整图一个矢量图元 */
  granularity?: 'node' | 'layer' | 'page';
  /** 子图生成组合，缺省 true */
  group?: boolean;
  /** 原生文字、连线和可编辑样式，缺省 true */
  editable?: boolean;
  /** 绘制内容边框，缺省 false */
  pageBorder?: boolean;
  /** mermaid：浅色主题固定色；meta2d：前景/背景跟随画布主题 */
  colors?: 'mermaid' | 'meta2d';
  fontFamily?: string;
  fontSize?: number;
  /** 同层节点间距，缺省 50 */
  nodeSpacing?: number;
  /** 流程图层级间距，缺省 70 */
  rankSpacing?: number;
  /** 内容留白，缺省 20 */
  padding?: number;
}

export interface MermaidParseStats {
  pages: number;
  nodes: number;
  edges: number;
  pens: number;
  unsupported: Record<string, number>;
  errors: string[];
  ms: number;
}

export interface MermaidPageInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  background?: string;
}

/** pen.mermaid：Mermaid 源信息只放在这里 */
export interface MermaidPenInfo {
  page: number;
  diagram: MermaidDiagramType;
  id?: string;
  type?: 'node' | 'edge' | 'subgraph' | 'participant' | 'lifeline' | 'note' | 'fragment' | 'title' | 'activation' | 'page';
  shape?: string;
  name?: string;
  part?: 'label' | 'page';
}

export interface MermaidDocument extends Meta2dPensDocument {
  stats: MermaidParseStats;
  pageList: MermaidPageInfo[];
  background?: string;
}

export interface MermaidVectorDocument extends VectorDocument {
  stats: MermaidParseStats;
  pageList: MermaidPageInfo[];
}

export interface MermaidInfo {
  type: MermaidDiagramType;
  title?: string;
  nodes: number;
  edges: number;
}
