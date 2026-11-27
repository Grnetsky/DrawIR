/**
 * SVG 内嵌样式表（<style>）的最小 CSS 实现：
 * - 选择器：类型、*、#id、.class、[attr]、[attr=v]（含 ~= ^= $= *=）、:first-child / :last-child，
 *   组合符：后代（空格）、子（>）、相邻（+）、兄弟（~），逗号分组
 * - 层叠：!important > 特异度 > 出现顺序；@media / @supports 内的规则直接生效，其它 @ 规则忽略
 */
import { childElements, type XmlElement } from './xml';

export type Declarations = Record<string, { value: string; important: boolean }>;

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; op?: string; value?: string }[];
  pseudos: string[];
}

interface Selector {
  /** 从右到左：parts[0] 为目标元素；combs[i] 为 parts[i] 与 parts[i+1] 之间的组合符 */
  parts: Compound[];
  combs: string[];
  specificity: number;
}

export interface CssRule {
  selector: Selector;
  decls: Declarations;
  order: number;
}

export function stripComments(s: string) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 解析声明块 `a: b; c: d !important` */
export function parseDeclarations(s: string): Declarations {
  const out: Declarations = {};
  for (const part of splitTop(stripComments(s), ';')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    let important = false;
    const imp = /!\s*important\s*$/i.exec(value);
    if (imp) {
      important = true;
      value = value.slice(0, imp.index).trim();
    }
    if (name && value) out[name] = { value, important };
  }
  return out;
}

/** 按分隔符切分，忽略括号、引号内的分隔符 */
export function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      c === quote && (quote = '');
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === sep && depth <= 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((p) => p.trim()).filter(Boolean);
}

export function parseStylesheet(src: string, rules: CssRule[] = []): CssRule[] {
  const s = stripComments(src);
  let i = 0;
  const parseBlock = (end: number) => {
    while (i < end) {
      const open = s.indexOf('{', i);
      if (open < 0 || open >= end) {
        i = end;
        return;
      }
      const head = s.slice(i, open).trim();
      const close = matchBrace(s, open);
      if (head.startsWith('@')) {
        const at = /^@([\w-]+)/.exec(head)?.[1]?.toLowerCase();
        if (at === 'media' || at === 'supports' || at === 'layer') {
          i = open + 1;
          parseBlock(close);
        }
        i = close + 1;
        continue;
      }
      const decls = parseDeclarations(s.slice(open + 1, close));
      for (const sel of splitTop(head, ',')) {
        const selector = parseSelector(sel);
        selector && rules.push({ selector, decls, order: rules.length });
      }
      i = close + 1;
    }
  };
  // 跳过语句式 @ 规则（@import / @charset …）
  parseBlock(s.length);
  return rules;
}

function matchBrace(s: string, open: number) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return s.length;
}

function parseSelector(src: string): Selector | undefined {
  const tokens = src.replace(/\s*([>+~])\s*/g, ' $1 ').trim().split(/\s+/);
  const parts: Compound[] = [];
  const combs: string[] = [];
  let comb = ' ';
  let a = 0;
  let b = 0;
  let c = 0;
  for (const t of tokens) {
    if (t === '>' || t === '+' || t === '~') {
      comb = t;
      continue;
    }
    const cp = parseCompound(t);
    if (!cp) return undefined;
    if (parts.length) combs.unshift(comb);
    parts.unshift(cp);
    comb = ' ';
    cp.id && a++;
    b += cp.classes.length + cp.attrs.length + cp.pseudos.length;
    cp.tag && cp.tag !== '*' && c++;
  }
  if (!parts.length) return undefined;
  return { parts, combs, specificity: a * 10000 + b * 100 + c };
}

function parseCompound(t: string): Compound | undefined {
  const cp: Compound = { classes: [], attrs: [], pseudos: [] };
  const re = /(#[\w-]+)|(\.[\w-]+)|(\[[^\]]*\])|(::?[\w-]+(?:\([^)]*\))?)|(\*|[\w|-]+)/gy;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < t.length && (re.lastIndex = pos, (m = re.exec(t)))) {
    pos = re.lastIndex;
    if (m[1]) cp.id = m[1].slice(1);
    else if (m[2]) cp.classes.push(m[2].slice(1));
    else if (m[3]) {
      const am = /^\[\s*([\w:|-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]$/.exec(m[3]);
      if (!am) return undefined;
      cp.attrs.push({ name: am[1].replace('|', ':'), op: am[2], value: am[3] ?? am[4] ?? am[5] });
    } else if (m[4]) {
      const p = m[4].replace(/^::?/, '').toLowerCase();
      // 伪元素、交互伪类在静态图里永不匹配
      if (!['first-child', 'last-child', 'root'].includes(p)) return undefined;
      cp.pseudos.push(p);
    } else if (m[5]) cp.tag = m[5].replace(/^.*\|/, '');
  }
  return pos === t.length ? cp : undefined;
}

function matchCompound(el: XmlElement, cp: Compound): boolean {
  if (cp.tag && cp.tag !== '*' && cp.tag !== el.tag) return false;
  if (cp.id && el.attrs.id !== cp.id) return false;
  if (cp.classes.length) {
    const cls = (el.attrs.class || '').split(/\s+/);
    if (!cp.classes.every((c) => cls.includes(c))) return false;
  }
  for (const a of cp.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    if (!a.op) continue;
    const w = a.value ?? '';
    const ok =
      a.op === '=' ? v === w
        : a.op === '~=' ? v.split(/\s+/).includes(w)
          : a.op === '^=' ? v.startsWith(w)
            : a.op === '$=' ? v.endsWith(w)
              : a.op === '*=' ? v.includes(w)
                : v === w || v.startsWith(w + '-');
    if (!ok) return false;
  }
  for (const p of cp.pseudos) {
    const parent = el.parent;
    if (p === 'root') {
      if (parent && parent.tag !== '#document') return false;
      continue;
    }
    if (!parent) return false;
    const sibs = childElements(parent);
    if (p === 'first-child' && sibs[0] !== el) return false;
    if (p === 'last-child' && sibs[sibs.length - 1] !== el) return false;
  }
  return true;
}

function matchFrom(el: XmlElement, sel: Selector, k: number): boolean {
  if (!matchCompound(el, sel.parts[k])) return false;
  if (k === sel.parts.length - 1) return true;
  const comb = sel.combs[k];
  if (comb === '>') return !!el.parent && matchFrom(el.parent, sel, k + 1);
  if (comb === ' ') {
    for (let p = el.parent; p && p.tag !== '#document'; p = p.parent) if (matchFrom(p, sel, k + 1)) return true;
    return false;
  }
  const sibs = el.parent ? childElements(el.parent) : [];
  const idx = sibs.indexOf(el);
  if (comb === '+') return idx > 0 && matchFrom(sibs[idx - 1], sel, k + 1);
  for (let j = idx - 1; j >= 0; j--) if (matchFrom(sibs[j], sel, k + 1)) return true;
  return false;
}

/** 样式表规则作用到元素后的声明（已按层叠排序合并） */
export function matchRules(el: XmlElement, rules: CssRule[]): Declarations {
  const hits = rules.filter((r) => matchFrom(el, r.selector, 0));
  if (!hits.length) return {};
  hits.sort((x, y) => x.selector.specificity - y.selector.specificity || x.order - y.order);
  const out: Declarations = {};
  for (const r of hits) {
    for (const k in r.decls) {
      const d = r.decls[k];
      if (out[k]?.important && !d.important) continue;
      out[k] = d;
    }
  }
  return out;
}
