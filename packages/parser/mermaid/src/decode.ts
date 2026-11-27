import type { MermaidDiagramType, MermaidParseStats } from './types';

export type MermaidShape = 'rect' | 'rounded' | 'stadium' | 'subroutine' | 'cylinder' | 'circle' | 'doublecircle' | 'diamond' | 'hexagon' | 'asymmetric' | 'parallelogram' | 'parallelogramAlt' | 'trapezoid' | 'trapezoidAlt';
export type MermaidStyles = Record<string, string>;

export interface FlowNode {
  id: string;
  label?: string;
  shape: MermaidShape;
  classes: string[];
  style: MermaidStyles;
  subgraph?: string;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  line: 'solid' | 'dotted' | 'thick' | 'invisible';
  from?: 'arrow' | 'circle' | 'cross';
  to?: 'arrow' | 'circle' | 'cross';
  style: MermaidStyles;
}

export interface FlowSubgraph {
  id: string;
  label: string;
  direction?: string;
  parent?: string;
  children: string[];
}

export interface FlowchartModel {
  kind: 'flowchart';
  title?: string;
  direction: string;
  nodes: Record<string, FlowNode>;
  nodeOrder: string[];
  edges: FlowEdge[];
  subgraphs: Record<string, FlowSubgraph>;
  subgraphOrder: string[];
  classDefs: Record<string, MermaidStyles>;
  config: MermaidStyles;
}

export interface SequenceParticipant {
  id: string;
  label: string;
  kind: 'participant' | 'actor';
}

export interface SequenceMessage {
  kind: 'message';
  source: string;
  target: string;
  text: string;
  line: 'solid' | 'dotted';
  arrow: 'none' | 'open' | 'solid' | 'cross' | 'async';
  activate?: boolean;
  deactivate?: boolean;
}

export interface SequenceNote {
  kind: 'note';
  position: 'left' | 'right' | 'over';
  participants: string[];
  text: string;
}

export interface SequenceActivation {
  kind: 'activate' | 'deactivate';
  participant: string;
}

export interface SequenceBlock {
  kind: 'block';
  blockType: 'loop' | 'alt' | 'opt' | 'par' | 'critical' | 'break' | 'rect';
  label: string;
  sections: { label?: string; events: SequenceEvent[] }[];
}

export type SequenceEvent = SequenceMessage | SequenceNote | SequenceActivation | SequenceBlock;

export interface SequenceModel {
  kind: 'sequenceDiagram';
  title?: string;
  participants: Record<string, SequenceParticipant>;
  participantOrder: string[];
  events: SequenceEvent[];
  autonumber: boolean;
  config: MermaidStyles;
}

export type MermaidModel = FlowchartModel | SequenceModel;

interface Statement {
  text: string;
  line: number;
}

export function decodeMermaid(source: string, stats: MermaidParseStats): MermaidModel {
  const { statements, config, frontTitle } = statementsOf(source, stats);
  const first = statements.find((s) => !s.text.startsWith('%%{'));
  if (!first) throw new Error('Mermaid 文本为空：请以 flowchart、graph 或 sequenceDiagram 开头');
  const type = /^(?:flowchart|graph)(?:\s|$)/.test(first.text) ? 'flowchart' : /^sequenceDiagram(?:\s|$)/.test(first.text) ? 'sequenceDiagram' : undefined;
  if (!type) {
    const found = first.text.split(/\s+/)[0];
    throw new Error(`暂不支持 Mermaid 图表类型 "${found}"；当前支持 flowchart / graph 和 sequenceDiagram`);
  }
  return type === 'flowchart' ? parseFlowchart(statements, config, frontTitle, stats) : parseSequence(statements, config, frontTitle, stats);
}

export function detectMermaidType(source: string): MermaidDiagramType {
  const text = stripFrontmatter(source).body;
  const line = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('%%'));
  if (/^(?:flowchart|graph)(?:\s|$)/.test(line || '')) return 'flowchart';
  if (/^sequenceDiagram(?:\s|$)/.test(line || '')) return 'sequenceDiagram';
  throw new Error('不是受支持的 Mermaid 文本：缺少 flowchart / graph / sequenceDiagram 声明');
}

function statementsOf(source: string, stats: MermaidParseStats) {
  const stripped = stripFrontmatter(source.replace(/^\uFEFF/, ''));
  const config = { ...stripped.config };
  const statements: Statement[] = [];
  stripped.body.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1 + stripped.skippedLines;
    const text = raw.trim();
    if (!text || text.startsWith('%%') && !text.startsWith('%%{')) return;
    if (text.startsWith('%%{')) {
      try {
        const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
        const init = JSON.parse(json);
        Object.assign(config, init.themeVariables || {});
        init.flowchart?.htmlLabels === false && (config.htmlLabels = 'false');
      } catch {
        count(stats, 'directive:init');
      }
      return;
    }
    for (const part of splitSemicolons(stripComment(raw))) {
      const value = part.trim();
      value && statements.push({ text: value, line });
    }
  });
  return { statements, config, frontTitle: stripped.title };
}

function stripFrontmatter(source: string) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const config: MermaidStyles = {};
  let title: string | undefined;
  if (lines[0]?.trim() !== '---') return { body: source, config, title, skippedLines: 0 };
  let end = 1;
  let inTheme = false;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (line.trim() === '---') break;
    if (/^\s*themeVariables\s*:/.test(line)) {
      inTheme = true;
      continue;
    }
    const m = /^(\s*)([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (!m[1]) inTheme = false;
    const value = unquote(m[3]);
    if (m[2] === 'title' && !inTheme) title = value;
    else if (inTheme && m[1]) config[m[2]] = value;
  }
  return { body: lines.slice(end + 1).join('\n'), config, title, skippedLines: Math.min(end + 1, lines.length) };
}

function stripComment(line: string) {
  let quote = '';
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if ((c === '"' || c === "'") && line[i - 1] !== '\\') quote = quote === c ? '' : quote || c;
    if (!quote && c === '%' && line[i + 1] === '%') return line.slice(0, i);
  }
  return line;
}

function splitSemicolons(line: string) {
  const out: string[] = [];
  let start = 0, quote = '', depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if ((c === '"' || c === "'") && line[i - 1] !== '\\') quote = quote === c ? '' : quote || c;
    if (quote) continue;
    if ('[({'.includes(c)) depth++;
    else if ('])}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out;
}

function parseFlowchart(statements: Statement[], config: MermaidStyles, title: string | undefined, stats: MermaidParseStats): FlowchartModel {
  const model: FlowchartModel = { kind: 'flowchart', title, direction: 'TB', nodes: {}, nodeOrder: [], edges: [], subgraphs: {}, subgraphOrder: [], classDefs: {}, config };
  const stack: string[] = [];
  let header = true;
  for (const statement of statements) {
    const s = statement.text;
    try {
      if (header && /^(?:flowchart|graph)(?:\s|$)/.test(s)) {
        model.direction = s.split(/\s+/)[1]?.toUpperCase() || 'TB';
        header = false;
        continue;
      }
      if (/^(?:accTitle|accDescr)\b/.test(s)) continue;
      if (/^title\s+/.test(s)) {
        model.title = s.replace(/^title\s+/, '').trim();
        continue;
      }
      const subgraph = /^subgraph\s+(?:"([^"]+)"|([^\s\[]+)(?:\s*\[(.*)\])?)$/.exec(s);
      if (subgraph) {
        const id = unquote(subgraph[1] || subgraph[2]);
        const parent = stack[stack.length - 1];
        model.subgraphs[id] = { id, label: subgraph[1] || (subgraph[3] ? cleanLabel(subgraph[3]) : id), parent, children: [] };
        model.subgraphOrder.push(id);
        parent && model.subgraphs[parent]?.children.push(id);
        stack.push(id);
        continue;
      }
      if (s === 'end') {
        if (stack.length) stack.pop();
        else stats.errors.push(`${statement.line}: 多余的 end`);
        continue;
      }
      const direction = /^direction\s+(TB|TD|BT|LR|RL)$/i.exec(s);
      if (direction) {
        const d = direction[1].toUpperCase();
        const current = stack[stack.length - 1];
        current ? (model.subgraphs[current].direction = d) : (model.direction = d);
        continue;
      }
      const classDef = /^classDef\s+([\w-]+)\s+(.+)$/.exec(s);
      if (classDef) {
        model.classDefs[classDef[1]] = parseStyles(classDef[2]);
        continue;
      }
      const className = /^class\s+(.+?)\s+([\w-]+)$/.exec(s);
      if (className) {
        for (const id of className[1].split(',')) {
          const node = ensureNode(model, id.trim(), stack[stack.length - 1]);
          node.classes.push(...className[2].split(',').map((v) => v.trim()));
        }
        continue;
      }
      const style = /^style\s+([^\s]+)\s+(.+)$/.exec(s);
      if (style) {
        Object.assign(ensureNode(model, style[1], stack[stack.length - 1]).style, parseStyles(style[2]));
        continue;
      }
      const linkStyle = /^linkStyle\s+(.+?)\s+(.+)$/.exec(s);
      if (linkStyle) {
        const styles = parseStyles(linkStyle[2]);
        if (linkStyle[1].trim() === 'default') for (const e of model.edges) Object.assign(e.style, styles);
        else for (const n of linkStyle[1].split(',')) {
          const edge = model.edges[+n.trim()];
          edge ? Object.assign(edge.style, styles) : stats.errors.push(`${statement.line}: linkStyle 索引 ${n.trim()} 不存在`);
        }
        continue;
      }
      if (/^(?:click|link)\b/.test(s)) {
        count(stats, 'flowchart:click');
        continue;
      }
      parseFlowStatement(model, s, stack[stack.length - 1]);
    } catch (e: any) {
      stats.errors.push(`${statement.line}: ${e?.message || e}`);
    }
  }
  if (stack.length) stats.errors.push('子图缺少 end');
  return model;
}

interface NodeRef {
  id: string;
  label?: string;
  shape?: MermaidShape;
  end: number;
}

function parseFlowStatement(model: FlowchartModel, s: string, subgraph?: string) {
  let pos = 0;
  let left = parseSide(model, s, pos, subgraph);
  pos = left.end;
  if (!left.nodes.length) throw new Error('无法识别节点');
  while (true) {
    const edge = parseEdge(s, pos);
    if (!edge) break;
    const right = parseSide(model, s, edge.end, subgraph);
    if (!right.nodes.length) throw new Error('连线缺少目标节点');
    for (const source of left.nodes) for (const target of right.nodes) {
      model.edges.push({ id: `edge-${model.edges.length}`, source, target, label: edge.label, line: edge.line, from: edge.from, to: edge.to, style: {} });
    }
    left = right;
    pos = right.end;
  }
  if (s.slice(pos).trim()) throw new Error(`无法识别语句 "${s.slice(pos).trim()}"`);
}

function parseSide(model: FlowchartModel, s: string, pos: number, subgraph?: string) {
  const nodes: string[] = [];
  while (true) {
    const ref = parseNodeRef(s, pos);
    if (!ref) break;
    const node = ensureNode(model, ref.id, subgraph);
    if (ref.shape) node.shape = ref.shape;
    if (ref.label !== undefined) node.label = ref.label;
    nodes.push(ref.id);
    pos = ref.end;
    const rest = s.slice(pos).match(/^\s*&\s*/);
    if (!rest) break;
    pos += rest[0].length;
  }
  return { nodes, end: pos };
}

function parseNodeRef(s: string, pos: number): NodeRef | undefined {
  const leading = /^\s*/.exec(s.slice(pos))![0].length;
  const start = pos + leading;
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (/[\s[\]{}()&|<>=;]/.test(c) || s.startsWith('--', i) || s.startsWith('==', i) || s.startsWith('-.', i) || s.startsWith('~~', i)) break;
    i++;
  }
  if (i === start) return undefined;
  const id = s.slice(start, i);
  const shapes: [string, string, MermaidShape][] = [
    ['(((', ')))', 'doublecircle'], ['([', '])', 'stadium'], ['[[', ']]', 'subroutine'], ['[(', ')]', 'cylinder'], ['((', '))', 'circle'], ['{{', '}}', 'hexagon'],
    ['[/', '\\]', 'trapezoid'], ['[\\', '/]', 'trapezoidAlt'], ['[/', '/]', 'parallelogram'], ['[\\', '\\]', 'parallelogramAlt'], ['>', ']', 'asymmetric'],
    ['[', ']', 'rect'], ['(', ')', 'rounded'], ['{', '}', 'diamond'],
  ];
  for (const [open, close, shape] of shapes) {
    if (!s.startsWith(open, i)) continue;
    const from = i + open.length;
    const end = s.indexOf(close, from);
    if (end < 0) continue;
    return { id, label: cleanLabel(s.slice(from, end)), shape, end: end + close.length };
  }
  const extended = /^@\{/.exec(s.slice(i));
  if (extended) throw new Error(`暂不支持节点 ${id} 的 @{...} 扩展形状语法`);
  return { id, end: i };
}

interface EdgeRef {
  end: number;
  label?: string;
  line: FlowEdge['line'];
  from?: FlowEdge['from'];
  to?: FlowEdge['to'];
}

function parseEdge(s: string, pos: number): EdgeRef | undefined {
  const leading = /^\s*/.exec(s.slice(pos))![0].length;
  const start = pos + leading;
  const m = /^(?:(<)|([ox]))?(--+|-\.-|-\.|==+|~~+)(>|o|x)?/.exec(s.slice(start));
  if (!m) return undefined;
  let end = start + m[0].length;
  let label: string | undefined;
  let to = markerName(m[4]);
  const from: FlowEdge['from'] = m[1] ? 'arrow' : markerName(m[2]);
  const line: FlowEdge['line'] = m[3][0] === '~' ? 'invisible' : m[3][0] === '=' ? 'thick' : m[3].includes('.') ? 'dotted' : 'solid';
  if (s[end] === '|') {
    const close = s.indexOf('|', end + 1);
    if (close < 0) throw new Error('连线标签缺少 |');
    label = cleanLabel(s.slice(end + 1, close));
    end = close + 1;
    const tail = /^(>|o|x)/.exec(s.slice(end));
    if (tail) {
      to = markerName(tail[1]);
      end += tail[0].length;
    }
  } else if (!m[4] && (m[3] === '--' || m[3] === '==' || m[3] === '-.')) {
    const rest = s.slice(end);
    const close = /\s+(\.->|--+>|==+>|-\.->)\s*/.exec(rest);
    if (close) {
      label = cleanLabel(rest.slice(0, close.index));
      to = 'arrow';
      end += close.index + close[0].length;
    }
  }
  return { end, label, line, from, to };
}

function markerName(s: string | undefined): FlowEdge['from'] {
  return s === '>' ? 'arrow' : s === 'o' ? 'circle' : s === 'x' ? 'cross' : undefined;
}

function ensureNode(model: FlowchartModel, id: string, subgraph?: string) {
  id = id.trim();
  if (!id) throw new Error('节点 id 为空');
  let node = model.nodes[id];
  if (!node) {
    node = model.nodes[id] = { id, shape: 'rect', classes: [], style: {}, subgraph };
    model.nodeOrder.push(id);
    subgraph && model.subgraphs[subgraph]?.children.push(id);
  }
  return node;
}

function parseSequence(statements: Statement[], config: MermaidStyles, title: string | undefined, stats: MermaidParseStats): SequenceModel {
  const model: SequenceModel = { kind: 'sequenceDiagram', title, participants: {}, participantOrder: [], events: [], autonumber: false, config };
  const blocks: SequenceBlock[] = [];
  const currentEvents = () => blocks.length ? blocks[blocks.length - 1].sections[blocks[blocks.length - 1].sections.length - 1].events : model.events;
  let messageNumber = 0;
  for (const statement of statements) {
    const s = statement.text;
    try {
      if (s === 'sequenceDiagram') continue;
      if (/^(?:accTitle|accDescr)\b/.test(s)) continue;
      if (/^title\s+/.test(s)) {
        model.title = s.replace(/^title\s+/, '').trim();
        continue;
      }
      if (/^autonumber\b/.test(s)) {
        model.autonumber = true;
        continue;
      }
      const participant = /^(participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(s);
      if (participant) {
        ensureParticipant(model, participant[2], participant[3], participant[1].toLowerCase() as 'participant' | 'actor');
        continue;
      }
      const note = /^Note\s+(left of|right of|over)\s+([^:]+)\s*:\s*(.*)$/i.exec(s);
      if (note) {
        const participants = note[2].split(',').map((v) => v.trim());
        participants.forEach((id) => ensureParticipant(model, id));
        currentEvents().push({ kind: 'note', position: note[1].toLowerCase().split(' ')[0] as SequenceNote['position'], participants, text: cleanLabel(note[3]) });
        continue;
      }
      const block = /^(loop|alt|opt|par|critical|break|rect)\s*(.*)$/i.exec(s);
      if (block) {
        const item: SequenceBlock = { kind: 'block', blockType: block[1].toLowerCase() as SequenceBlock['blockType'], label: cleanLabel(block[2]), sections: [{ events: [] }] };
        currentEvents().push(item);
        blocks.push(item);
        continue;
      }
      const section = /^(else|and)\s*(.*)$/i.exec(s);
      if (section && blocks.length) {
        blocks[blocks.length - 1].sections.push({ label: cleanLabel(section[2]), events: [] });
        continue;
      }
      if (s === 'end') {
        if (blocks.length) blocks.pop();
        else stats.errors.push(`${statement.line}: 多余的 end`);
        continue;
      }
      const activation = /^(activate|deactivate)\s+([^\s]+)$/i.exec(s);
      if (activation) {
        currentEvents().push({ kind: activation[1].toLowerCase() as SequenceActivation['kind'], participant: activation[2] });
        continue;
      }
      const message = /^([^\s-]+)\s*(-{1,2})(>>|>\)|>|x|\))?\s*([+-]?)\s*([^\s:]+)\s*:\s*(.*)$/.exec(s);
      if (message) {
        const source = message[1], target = message[5];
        ensureParticipant(model, source);
        ensureParticipant(model, target);
        const marker = message[3] || '';
        const arrow: SequenceMessage['arrow'] = marker === 'x' ? 'cross' : marker === ')' || marker === '>)' ? 'async' : marker === '>>' ? 'solid' : marker ? 'open' : 'none';
        const activate = message[4] === '+', deactivate = message[4] === '-';
        const text = model.autonumber ? `${++messageNumber}: ${cleanLabel(message[6])}` : cleanLabel(message[6]);
        currentEvents().push({ kind: 'message', source, target, text, line: message[2].length === 2 ? 'dotted' : 'solid', arrow, activate, deactivate });
        continue;
      }
      if (/^(?:create|destroy|box|link|links|properties)\b/i.test(s)) {
        count(stats, `sequence:${s.split(/\s+/)[0].toLowerCase()}`);
        continue;
      }
      count(stats, 'sequence:statement');
    } catch (e: any) {
      stats.errors.push(`${statement.line}: ${e?.message || e}`);
    }
  }
  if (blocks.length) stats.errors.push('时序图片段缺少 end');
  return model;
}

function ensureParticipant(model: SequenceModel, id: string, label?: string, kind?: 'participant' | 'actor') {
  let p = model.participants[id];
  if (!p) {
    p = model.participants[id] = { id, label: cleanLabel(label || id), kind: kind || 'participant' };
    model.participantOrder.push(id);
  } else {
    if (label) p.label = cleanLabel(label);
    if (kind) p.kind = kind;
  }
  return p;
}

export function parseStyles(s: string): MermaidStyles {
  const out: MermaidStyles = {};
  for (const part of s.split(',')) {
    const colon = part.indexOf(':');
    if (colon > 0) out[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).trim();
  }
  return out;
}

export function cleanLabel(s: string) {
  return unquote(s.trim());
}

function unquote(s: string) {
  const v = s.trim();
  return v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) ? v.slice(1, -1) : v;
}

function count(stats: MermaidParseStats, key: string) {
  stats.unsupported[key] = (stats.unsupported[key] || 0) + 1;
}
