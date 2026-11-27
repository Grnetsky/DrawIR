export type { GenCADDocument, GenCADParseOptions, GenCADParseStats, GenCADPageInfo, GenCADPenInfo, GenCADVectorDocument, GenCADInfo } from './types';
export type { GenCADPenAdapter, TextSpec, LineSpec } from './parser';
export type { GenCADUnit, GenCADLeaf, GenCADGroup, GenCADTree, GenCADTextBox, GenCADEdge } from './ir';
export { GenCADConverter } from './parser';
export { GenCADToIR, unitItems, resolveOptions } from './ir';
export { decodeGenCAD, genCADUnitToInches, genCADNodeKey } from './decode';
export type { GenCADDocumentSource, GenCADHeader, GenCADGeometry, GenCADComponent, GenCADShape, GenCADPad, GenCADPadStack, GenCADRoute } from './decode';
export { parseGenCADVector, parseGenCADVectorSync, readGenCADInfo, readGenCADInfoSync, readGenCADLayers, readGenCADPages, toBytes, type GenCADInput, type GenCADPageMeta } from './common';
export { contentBox, penRectOfGeom, MIN_PEN_SIZE, type Meta2dPensDocument } from './util';
