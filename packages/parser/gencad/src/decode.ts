import { normalizeLayer } from './util';

export interface GenCADHeader {
  version: string;
  user?: string;
  drawing?: string;
  revision?: string;
  units: string;
  unitScale?: number;
  origin: { x: number; y: number };
  intertrack?: number;
}

export interface GenCADLineGeometry {
  kind: 'LINE';
  x1: number; y1: number; x2: number; y2: number;
  line: number;
}

export interface GenCADArcGeometry {
  kind: 'ARC';
  x1: number; y1: number; x2: number; y2: number; cx: number; cy: number;
  p1?: number; p2?: number;
  line: number;
}

export interface GenCADCircleGeometry {
  kind: 'CIRCLE';
  cx: number; cy: number; r: number;
  line: number;
}

export interface GenCADRectangleGeometry {
  kind: 'RECTANGLE';
  x: number; y: number; width: number; height: number;
  line: number;
}

export type GenCADGeometry = GenCADLineGeometry | GenCADArcGeometry | GenCADCircleGeometry | GenCADRectangleGeometry;

export interface GenCADText {
  x: number; y: number;
  size: number;
  rotation: number;
  mirror: string;
  layer: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  line: number;
}

export interface GenCADArtwork {
  name: string;
  layer: string;
  track?: string;
  filled: boolean;
  geometry: GenCADGeometry[];
  texts: GenCADText[];
  line: number;
}

export interface GenCADArtworkRef {
  name: string;
  x: number; y: number;
  rotation: number;
  mirror: string;
  flip?: boolean;
  line: number;
}

export interface GenCADPad {
  name: string;
  type: string;
  drill: number;
  geometry: GenCADGeometry[];
  line: number;
}

export interface GenCADPadRef {
  pad: string;
  layer: string;
  rotation: number;
  mirror: string;
  line: number;
}

export interface GenCADPadStack {
  name: string;
  drill: number;
  pads: GenCADPadRef[];
  line: number;
}

export interface GenCADPin {
  name: string;
  padstack: string;
  x: number; y: number;
  layer: string;
  rotation: number;
  mirror: string;
  line: number;
}

export interface GenCADShape {
  name: string;
  insert?: string;
  height?: number;
  geometry: GenCADGeometry[];
  pins: GenCADPin[];
  artworks: GenCADArtworkRef[];
  line: number;
}

export interface GenCADComponent {
  name: string;
  device?: string;
  x: number; y: number;
  layer: string;
  rotation: number;
  shape?: string;
  mirror: string;
  flip: boolean;
  texts: GenCADText[];
  artworks: GenCADArtworkRef[];
  value?: string;
  partNumber?: string;
  sheet?: string;
  line: number;
}

export interface GenCADDevice {
  name: string;
  part?: string;
  package?: string;
  type?: string;
  value?: string;
}

export interface GenCADRouteSegment {
  geometry: GenCADGeometry;
  track?: string;
  layer: string;
}

export interface GenCADVia {
  padstack: string;
  x: number; y: number;
  layer: string;
  drill: number;
  name: string;
  net?: string;
  line: number;
}

export interface GenCADTestPad {
  padstack: string;
  x: number; y: number;
  rotation: number;
  mirror: string;
  name: string;
  net?: string;
  layer: string;
  line: number;
}

export interface GenCADPlane {
  name: string;
  layer: string;
  track?: string;
  geometry: GenCADGeometry[];
  line: number;
}

export interface GenCADRoute {
  name: string;
  segments: GenCADRouteSegment[];
  vias: GenCADVia[];
  testpads: GenCADTestPad[];
  planes: GenCADPlane[];
  texts: GenCADText[];
  line: number;
}

export interface GenCADHole {
  x: number; y: number;
  diameter: number;
  plated: boolean;
  line: number;
}

export interface GenCADProbe {
  name: string;
  x: number; y: number;
  signal?: string;
  layer: string;
  kind: 'testpin' | 'powerpin';
  line: number;
}

export interface GenCADDocumentSource {
  header: GenCADHeader;
  board: GenCADGeometry[];
  boardTexts: GenCADText[];
  boardArtworks: GenCADArtwork[];
  cutouts: GenCADGeometry[][];
  pads: Map<string, GenCADPad>;
  padstacks: Map<string, GenCADPadStack>;
  artworks: Map<string, GenCADArtwork>;
  shapes: Map<string, GenCADShape>;
  components: GenCADComponent[];
  devices: Map<string, GenCADDevice>;
  signals: Map<string, string>;
  tracks: Map<string, number>;
  layers: string[];
  routes: GenCADRoute[];
  holes: GenCADHole[];
  probes: GenCADProbe[];
  errors: string[];
  unsupported: Record<string, number>;
}

interface Statement {
  command: string;
  args: string[];
  line: number;
  raw: string;
}

interface Section {
  name: string;
  statements: Statement[];
}

const GEOMETRY = new Set(['LINE', 'ARC', 'CIRCLE', 'RECTANGLE']);
const IGNORED = new Set(['ATTRIBUTE', 'TYPE', 'STYLE', 'DESC', 'TOL', 'PTOL', 'NTOL', 'VOLTS', 'PINDESC', 'PINFUNCT', 'PINCOUT', 'NAILLOC', 'PROBE']);

export function decodeGenCAD(input: string | Uint8Array): GenCADDocumentSource {
  const text = typeof input === 'string' ? input : decodeBytes(input);
  const sections = splitSections(text);
  if (!sections.some((s) => s.name === '$HEADER') || !/^\s*(?:\0|\uFEFF|\s)*\$HEADER[\s\S]*?\bGENCAD(?:\s+\d+(?:\.\d+)?)?/i.test(text)) {
    throw new Error('不是有效的 GenCAD 文件：缺少 $HEADER / GENCAD 标识。请使用 GenCAD 1.4 ASCII 格式的 .cad 文件');
  }
  const doc: GenCADDocumentSource = {
    header: { version: '1.4', units: 'INCH', origin: { x: 0, y: 0 } },
    board: [], boardTexts: [], boardArtworks: [], cutouts: [],
    pads: new Map(), padstacks: new Map(), artworks: new Map(), shapes: new Map(), components: [], devices: new Map(),
    signals: new Map(), tracks: new Map(), layers: [], routes: [], holes: [], probes: [], errors: [], unsupported: {},
  };
  for (const section of sections) {
    switch (section.name) {
      case '$HEADER': parseHeader(section.statements, doc); break;
      case '$BOARD': parseBoard(section.statements, doc); break;
      case '$PADS': parsePads(section.statements, doc); break;
      case '$PADSTACKS': parsePadstacks(section.statements, doc); break;
      case '$ARTWORKS': parseArtworks(section.statements, doc); break;
      case '$SHAPES': parseShapes(section.statements, doc); break;
      case '$COMPONENTS': parseComponents(section.statements, doc); break;
      case '$DEVICES': parseDevices(section.statements, doc); break;
      case '$SIGNALS': parseSignals(section.statements, doc); break;
      case '$TRACKS': parseTracks(section.statements, doc); break;
      case '$LAYERS': parseLayers(section.statements, doc); break;
      case '$ROUTES': parseRoutes(section.statements, doc); break;
      case '$MECH': parseMech(section.statements, doc); break;
      case '$TESTPINS':
      case '$POWERPINS': parseProbes(section.statements, doc, section.name === '$TESTPINS' ? 'testpin' : 'powerpin'); break;
      case '$PSEUDOS':
      case '$CHANGES': count(doc, `section:${section.name.slice(1)}`); break;
      default: count(doc, `section:${section.name.slice(1)}`); break;
    }
  }
  doc.layers = unique([
    ...doc.layers,
    ...doc.routes.flatMap((r) => r.segments.map((s) => s.layer)),
    ...[...doc.padstacks.values()].flatMap((p) => p.pads.map((p) => p.layer)),
    ...doc.components.flatMap((c) => [c.layer, ...c.texts.map((t) => t.layer)]),
    ...[...doc.artworks.values()].map((a) => a.layer),
  ].map(normalizeLayer).filter(Boolean));
  return doc;
}

export function genCADUnitToInches(header: GenCADHeader) {
  const n = header.unitScale || 1;
  switch (header.units) {
    case 'THOU': return 0.001;
    case 'MM': return 1 / 25.4;
    case 'MM100': return 1 / 2540;
    case 'USER': return 1 / n;
    case 'USERM': return 10 / (25.4 * n);
    case 'USERMM': return 1 / (25.4 * n);
    default: return 1;
  }
}

function decodeBytes(data: Uint8Array) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    text = new TextDecoder('windows-1252').decode(data);
  }
  return text.replace(/^[\0\uFEFF\s]+/, '');
}

function splitSections(text: string) {
  const sections: Section[] = [];
  let current: Section | undefined;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/\0/g, '').trim();
    if (!line) return;
    if (line[0] === '$') {
      const name = line.split(/\s+/)[0].toUpperCase();
      if (name.startsWith('$END')) {
        current = undefined;
      } else {
        current = { name, statements: [] };
        sections.push(current);
      }
      return;
    }
    if (!current) return;
    const tokens = tokenize(line);
    if (!tokens.length) return;
    current.statements.push({ command: tokens[0].toUpperCase(), args: tokens.slice(1), line: i + 1, raw: line });
  });
  return sections;
}

function tokenize(line: string) {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (/\s/.test(line[i])) i++;
    if (i >= line.length) break;
    if (line[i] === '"') {
      i++;
      let value = '';
      while (i < line.length) {
        const c = line[i++];
        if (c === '"') {
          if (line[i] === '"') {
            value += '"';
            i++;
            continue;
          }
          break;
        }
        if (c === '\\' && i < line.length && (line[i] === '"' || line[i] === '\\')) value += line[i++];
        else value += c;
      }
      out.push(value);
    } else {
      const start = i;
      while (i < line.length && !/\s/.test(line[i])) i++;
      out.push(line.slice(start, i));
    }
  }
  return out;
}

function parseHeader(statements: Statement[], doc: GenCADDocumentSource) {
  for (const s of statements) {
    switch (s.command) {
      case 'GENCAD': doc.header.version = s.args[0] || '1.4'; break;
      case 'USER': doc.header.user = s.args.join(' '); break;
      case 'DRAWING': doc.header.drawing = s.args.join(' '); break;
      case 'REVISION': doc.header.revision = s.args.join(' '); break;
      case 'UNITS': {
        const units = (s.args[0] || 'INCH').toUpperCase();
        doc.header.units = units;
        if (units.startsWith('USER')) doc.header.unitScale = positive(number(s, 1), 1);
        break;
      }
      case 'ORIGIN': doc.header.origin = { x: number(s, 0), y: number(s, 1) }; break;
      case 'INTERTRACK': doc.header.intertrack = number(s, 0); break;
      case 'ATTRIBUTE': break;
      default: count(doc, `header:${s.command}`); break;
    }
  }
}

function parseBoard(statements: Statement[], doc: GenCADDocumentSource) {
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i];
    const g = geometry(s, doc);
    if (g) doc.board.push(g);
    else if (s.command === 'TEXT') doc.boardTexts.push(text(s, doc));
    else if (s.command === 'CUTOUT' || s.command === 'MASK') {
      const items: GenCADGeometry[] = [];
      while (i + 1 < statements.length && GEOMETRY.has(statements[i + 1].command)) {
        const item = geometry(statements[++i], doc);
        item && items.push(item);
      }
      items.length && doc.cutouts.push(items);
    } else if (s.command === 'ARTWORK') {
      const art: GenCADArtwork = { name: s.args[0] || `board-artwork-${s.line}`, layer: layerAt(s.args, 1).layer, filled: false, geometry: [], texts: [], line: s.line };
      i = parseArtworkBody(statements, i, art, doc);
      doc.boardArtworks.push(art);
    } else if (s.command !== 'THICKNESS' && !IGNORED.has(s.command)) count(doc, `board:${s.command}`);
  }
}

function parsePads(statements: Statement[], doc: GenCADDocumentSource) {
  let current: GenCADPad | undefined;
  for (const s of statements) {
    if (s.command === 'PAD') {
      current = { name: s.args[0] || `PAD@${s.line}`, type: (s.args[1] || 'UNKNOWN').toUpperCase(), drill: number(s, 2), geometry: [], line: s.line };
      doc.pads.set(current.name, current);
      continue;
    }
    if (!current) continue;
    const g = geometry(s, doc);
    if (g) current.geometry.push(g);
    else if (!IGNORED.has(s.command)) count(doc, `pad:${s.command}`);
  }
}

function parsePadstacks(statements: Statement[], doc: GenCADDocumentSource) {
  let current: GenCADPadStack | undefined;
  for (const s of statements) {
    if (s.command === 'PADSTACK') {
      current = { name: s.args[0] || `PADSTACK@${s.line}`, drill: number(s, 1), pads: [], line: s.line };
      doc.padstacks.set(current.name, current);
      continue;
    }
    if (!current) continue;
    if (s.command === 'PAD') {
      const at = layerAt(s.args, 1);
      current.pads.push({ pad: s.args[0], layer: at.layer, rotation: number(s, at.next), mirror: (s.args[at.next + 1] || '0').toUpperCase(), line: s.line });
    } else if (!IGNORED.has(s.command)) count(doc, `padstack:${s.command}`);
  }
}

function parseArtworks(statements: Statement[], doc: GenCADDocumentSource) {
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i];
    if (s.command !== 'ARTWORK') {
      if (!IGNORED.has(s.command)) count(doc, `artworks:${s.command}`);
      continue;
    }
    const art: GenCADArtwork = { name: s.args[0] || `ARTWORK@${s.line}`, layer: 'TOP', filled: false, geometry: [], texts: [], line: s.line };
    i = parseArtworkBody(statements, i, art, doc);
    doc.artworks.set(art.name, art);
  }
}

function parseArtworkBody(statements: Statement[], i: number, art: GenCADArtwork, doc: GenCADDocumentSource) {
  while (i + 1 < statements.length) {
    const s = statements[i + 1];
    if (s.command === 'ARTWORK' || s.command === 'SHAPE' || s.command === 'COMPONENT' || s.command === 'CUTOUT' || s.command === 'MASK') break;
    i++;
    const g = geometry(s, doc);
    if (g) art.geometry.push(g);
    else if (s.command === 'LAYER') art.layer = s.args.join('_');
    else if (s.command === 'TRACK') art.track = s.args[0];
    else if (s.command === 'FILLED') art.filled = s.args[0] === 'YES' || s.args[0] === '1';
    else if (s.command === 'TEXT') art.texts.push(text(s, doc));
    else if (!IGNORED.has(s.command)) count(doc, `artwork:${s.command}`);
  }
  return i;
}

function parseShapes(statements: Statement[], doc: GenCADDocumentSource) {
  let current: GenCADShape | undefined;
  for (const s of statements) {
    if (s.command === 'SHAPE') {
      current = { name: s.args[0] || `SHAPE@${s.line}`, geometry: [], pins: [], artworks: [], line: s.line };
      doc.shapes.set(current.name, current);
      continue;
    }
    if (!current) continue;
    const g = geometry(s, doc);
    if (g) current.geometry.push(g);
    else if (s.command === 'PIN') {
      const at = layerAt(s.args, 4);
      current.pins.push({ name: s.args[0] || '', padstack: s.args[1], x: number(s, 2), y: number(s, 3), layer: at.layer, rotation: number(s, at.next), mirror: (s.args[at.next + 1] || '0').toUpperCase(), line: s.line });
    } else if (s.command === 'ARTWORK') current.artworks.push(artworkRef(s));
    else if (s.command === 'INSERT') current.insert = s.args[0];
    else if (s.command === 'HEIGHT') current.height = number(s, 0);
    else if (s.command === 'FIDUCIAL' || s.command === 'FID') count(doc, `shape:${s.command}`);
    else if (!IGNORED.has(s.command)) count(doc, `shape:${s.command}`);
  }
}

function parseComponents(statements: Statement[], doc: GenCADDocumentSource) {
  let current: GenCADComponent | undefined;
  for (const s of statements) {
    if (s.command === 'COMPONENT') {
      current = { name: s.args[0] || `COMPONENT@${s.line}`, x: 0, y: 0, layer: 'TOP', rotation: 0, mirror: '0', flip: false, texts: [], artworks: [], line: s.line };
      doc.components.push(current);
      continue;
    }
    if (!current) continue;
    switch (s.command) {
      case 'DEVICE': current.device = s.args.join(' '); break;
      case 'PLACE': current.x = number(s, 0); current.y = number(s, 1); break;
      case 'LAYER': current.layer = s.args.join('_'); break;
      case 'ROTATION': current.rotation = number(s, 0); break;
      case 'SHAPE': current.shape = s.args[0]; current.mirror = (s.args[1] || '0').toUpperCase(); current.flip = s.args.includes('FLIP'); break;
      case 'TEXT': current.texts.push(text(s, doc)); break;
      case 'ARTWORK': current.artworks.push(artworkRef(s)); break;
      case 'VALUE': current.value = s.args.join(' '); break;
      case 'PARTNUMBER': current.partNumber = s.args[0]; break;
      case 'SHEET': current.sheet = s.args[0]; break;
      case 'FID': count(doc, 'component:FID'); break;
      default: !IGNORED.has(s.command) && count(doc, `component:${s.command}`); break;
    }
  }
}

function parseDevices(statements: Statement[], doc: GenCADDocumentSource) {
  let current: GenCADDevice | undefined;
  for (const s of statements) {
    if (s.command === 'DEVICE') {
      current = { name: s.args.join(' ') };
      doc.devices.set(current.name, current);
    } else if (current && s.command === 'PART') current.part = s.args.join(' ');
    else if (current && s.command === 'PARTEMP') current.part ??= s.args.join(' ');
    else if (current && s.command === 'PACKAGE') current.package = s.args[0];
    else if (current && s.command === 'TYPE') current.type = s.args[0];
    else if (current && s.command === 'VALUE') current.value = s.args.join(' ');
  }
}

function parseSignals(statements: Statement[], doc: GenCADDocumentSource) {
  let signal = '';
  for (const s of statements) {
    if (s.command === 'SIGNAL') signal = s.args.join(' ');
    else if (s.command === 'NODE' && signal) doc.signals.set(nodeKey(s.args[0], s.args[1]), signal);
    else if (!IGNORED.has(s.command) && s.command !== 'NODE') count(doc, `signal:${s.command}`);
  }
}

function parseTracks(statements: Statement[], doc: GenCADDocumentSource) {
  for (const s of statements) {
    if (s.command === 'TRACK') doc.tracks.set(s.args[0], number(s, 1));
    else if (!IGNORED.has(s.command)) count(doc, `tracks:${s.command}`);
  }
}

function parseLayers(statements: Statement[], doc: GenCADDocumentSource) {
  for (const s of statements) {
    if (s.command === 'DEFINE') {
      const at = layerAt(s.args, 0);
      doc.layers.push(at.layer);
      s.args[at.next] && doc.layers.push(s.args[at.next]);
    } else if (s.command === 'LAYERSET' || s.command === 'LAYER') doc.layers.push(...s.args);
  }
}

function parseRoutes(statements: Statement[], doc: GenCADDocumentSource) {
  let route: GenCADRoute | undefined;
  let track: string | undefined;
  let layer = 'TOP';
  let plane: GenCADPlane | undefined;
  for (const s of statements) {
    if (s.command === 'ROUTE') {
      route = { name: s.args.join(' '), segments: [], vias: [], testpads: [], planes: [], texts: [], line: s.line };
      doc.routes.push(route);
      plane = undefined;
      continue;
    }
    if (!route) continue;
    if (s.command === 'TRACK') {
      track = s.args[0];
      plane = undefined;
      continue;
    }
    if (s.command === 'LAYER') {
      layer = s.args.join('_');
      plane = undefined;
      continue;
    }
    if (s.command === 'PLANE') {
      plane = { name: s.args[0] || `PLANE@${s.line}`, layer, track, geometry: [], line: s.line };
      route.planes.push(plane);
      continue;
    }
    const g = geometry(s, doc);
    if (g) {
      if (plane) plane.geometry.push(g);
      else route.segments.push({ geometry: g, track, layer });
      continue;
    }
    plane = undefined;
    if (s.command === 'VIA') {
      const at = layerAt(s.args, 3);
      route.vias.push({ padstack: s.args[0], x: number(s, 1), y: number(s, 2), layer: at.layer, drill: number(s, at.next), name: s.args[at.next + 1] || `via${route.vias.length + 1}`, net: route.name, line: s.line });
    } else if (s.command === 'TESTPAD') {
      route.testpads.push({ padstack: s.args[0], x: number(s, 1), y: number(s, 2), rotation: number(s, 3), mirror: (s.args[4] || '0').toUpperCase(), name: s.args[5] || `testpad${route.testpads.length + 1}`, net: route.name, layer, line: s.line });
    } else if (s.command === 'TEXT') route.texts.push(text(s, doc));
    else if (!IGNORED.has(s.command)) count(doc, `route:${s.command}`);
  }
}

function parseMech(statements: Statement[], doc: GenCADDocumentSource) {
  for (const s of statements) {
    if (s.command === 'HOLE' || s.command === 'FHOLE') doc.holes.push({ x: number(s, 0), y: number(s, 1), diameter: number(s, 2), plated: s.command === 'HOLE', line: s.line });
    else if (!IGNORED.has(s.command)) count(doc, `mech:${s.command}`);
  }
}

function parseProbes(statements: Statement[], doc: GenCADDocumentSource, kind: GenCADProbe['kind']) {
  for (const s of statements) {
    if (s.command === kind.toUpperCase()) {
      const at = layerAt(s.args, 7);
      doc.probes.push({ name: s.args[0], x: number(s, 1), y: number(s, 2), signal: s.args[3], layer: at.layer, kind, line: s.line });
    } else if (!IGNORED.has(s.command) && s.command !== 'TEXT') count(doc, `${kind}:${s.command}`);
  }
}

function geometry(s: Statement, doc: GenCADDocumentSource): GenCADGeometry | undefined {
  if (!GEOMETRY.has(s.command)) return undefined;
  try {
    switch (s.command) {
      case 'LINE': return { kind: 'LINE', x1: number(s, 0), y1: number(s, 1), x2: number(s, 2), y2: number(s, 3), line: s.line };
      case 'ARC': {
        if (s.args.length > 6) count(doc, 'arc:elliptical');
        return { kind: 'ARC', x1: number(s, 0), y1: number(s, 1), x2: number(s, 2), y2: number(s, 3), cx: number(s, 4), cy: number(s, 5), p1: optionalNumber(s, 6), p2: optionalNumber(s, 7), line: s.line };
      }
      case 'CIRCLE': return { kind: 'CIRCLE', cx: number(s, 0), cy: number(s, 1), r: Math.abs(number(s, 2)), line: s.line };
      case 'RECTANGLE': return { kind: 'RECTANGLE', x: number(s, 0), y: number(s, 1), width: number(s, 2), height: number(s, 3), line: s.line };
    }
  } catch (e: any) {
    doc.errors.push(`第 ${s.line} 行 ${s.command}: ${e?.message || e}`);
    return undefined;
  }
}

function text(s: Statement, doc: GenCADDocumentSource): GenCADText {
  const at = layerAt(s.args, 5);
  const rest = at.next;
  return {
    x: number(s, 0), y: number(s, 1), size: Math.abs(number(s, 2)), rotation: number(s, 3), mirror: (s.args[4] || '0').toUpperCase(), layer: at.layer,
    text: s.args[rest] || '',
    rect: { x: optionalNumber(s, rest + 1) || 0, y: optionalNumber(s, rest + 2) || 0, width: Math.abs(optionalNumber(s, rest + 3) || 0), height: Math.abs(optionalNumber(s, rest + 4) || 0) },
    line: s.line,
  };
}

function artworkRef(s: Statement): GenCADArtworkRef {
  return { name: s.args[0], x: number(s, 1), y: number(s, 2), rotation: number(s, 3), mirror: (s.args[4] || '0').toUpperCase(), flip: s.args.includes('FLIP'), line: s.line };
}

function layerAt(args: string[], index: number) {
  const first = (args[index] || 'TOP').toUpperCase();
  if (['POWER', 'GROUND', 'LAYER', 'LAYERSET'].includes(first) && args[index + 1] !== undefined) return { layer: `${first}_${args[index + 1]}`, next: index + 2 };
  if (first === 'INNER' && /^\d+$/.test(args[index + 1] || '')) return { layer: `INNER_${args[index + 1]}`, next: index + 2 };
  return { layer: first, next: index + 1 };
}

function number(s: Statement, index: number) {
  const n = Number(s.args[index]);
  if (!Number.isFinite(n)) throw new Error(`第 ${index + 2} 个参数应为数字，实际为 ${s.args[index] ?? '缺失'}`);
  return n;
}

function optionalNumber(s: Statement, index: number) {
  if (s.args[index] === undefined || s.args[index] === '') return undefined;
  const n = Number(s.args[index]);
  return Number.isFinite(n) ? n : undefined;
}

function nodeKey(component: string, pin: string) {
  return `${component}\u0000${pin}`;
}

function count(doc: GenCADDocumentSource, key: string) {
  doc.unsupported[key] = (doc.unsupported[key] || 0) + 1;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function positive(n: number, fallback: number) {
  return n > 0 ? n : fallback;
}

export { nodeKey as genCADNodeKey };
