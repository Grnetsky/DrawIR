import { readFig } from './archive';
import { toBytes, type FigmaInput } from './common';

/**
 * Figma 原型（Prototype）数据：起点、交互（触发 → 动作）。
 * 只做读取和规范化，不做任何与 meta2d 相关的转换。节点 id 与 FigmaPenInfo.id / FigmaLayer.id 一致（sessionID:localID）。
 *
 * 组件（SYMBOL）内部节点上的交互，nodeId 为组件内节点的 id，并带 componentId；
 * 调用方可按 `实例路径 + nodeId` 对应到每个实例内的同一节点。
 */
export interface FigmaPrototype {
  /** 原型起点（Flow starting points），按页面顺序 */
  starts: FigmaPrototypeStart[];
  interactions: FigmaInteraction[];
}

export interface FigmaPrototypeStart {
  /** 起点画板 id */
  nodeId: string;
  /** Flow 名称 */
  name?: string;
  description?: string;
}

export type FigmaTrigger =
  | 'click'
  | 'hover'
  | 'press'
  | 'drag'
  | 'mouseEnter'
  | 'mouseLeave'
  | 'mouseDown'
  | 'mouseUp'
  | 'timeout'
  | 'key'
  | 'other';

export interface FigmaInteraction {
  /** 触发交互的节点 id */
  nodeId: string;
  /** 节点所在的组件（SYMBOL）id：交互定义在组件内部时有值 */
  componentId?: string;
  trigger: FigmaTrigger;
  /** 原始 InteractionType，便于调试和未覆盖的类型 */
  rawTrigger?: string;
  /** timeout 触发的延时（毫秒） */
  delay?: number;
  actions: FigmaAction[];
}

export type FigmaAction =
  | ({ type: 'navigate' | 'swap' | 'scrollTo'; targetId: string } & FigmaTransition)
  | ({
      type: 'overlay';
      targetId: string;
      position?: string;
      /** MANUAL 时相对触发节点的位置 */
      offset?: { x: number; y: number };
    } & FigmaTransition)
  /** 切换组件变体（SWAP_STATE / CHANGE_TO） */
  | ({ type: 'changeTo'; targetId: string } & FigmaTransition)
  | { type: 'back' }
  | { type: 'close' }
  | { type: 'url'; url: string; newTab?: boolean }
  | { type: 'other'; raw: string };

export interface FigmaTransition {
  /** INSTANT_TRANSITION / DISSOLVE / SLIDE_FROM_LEFT / SMART_ANIMATE … */
  transition?: string;
  /** 毫秒 */
  duration?: number;
}

const TRIGGERS: Record<string, FigmaTrigger> = {
  ON_CLICK: 'click',
  ON_HOVER: 'hover',
  ON_PRESS: 'press',
  DRAG: 'drag',
  MOUSE_ENTER: 'mouseEnter',
  MOUSE_IN: 'mouseEnter',
  MOUSE_LEAVE: 'mouseLeave',
  MOUSE_OUT: 'mouseLeave',
  MOUSE_DOWN: 'mouseDown',
  MOUSE_UP: 'mouseUp',
  AFTER_TIMEOUT: 'timeout',
  ON_KEY_DOWN: 'key',
};

const gkey = (g: any) => (g && typeof g.sessionID === 'number' ? `${g.sessionID}:${g.localID}` : '');
/** Figma 文件里 0xFFFFFFFF:0xFFFFFFFF 表示「未指定」 */
const validId = (id: string) => !!id && id !== '4294967295:4294967295';
const ms = (seconds: unknown) => (typeof seconds === 'number' && seconds > 0 ? Math.round(seconds * 1000) : undefined);

function transitionOf(a: any): FigmaTransition {
  const t: FigmaTransition = {};
  a.transitionType && (t.transition = a.transitionType);
  const d = ms(a.transitionDuration);
  d && (t.duration = d);
  return t;
}

function action(a: any, out: FigmaAction[]) {
  switch (a.connectionType) {
    case 'INTERNAL_NODE': {
      const targetId = gkey(a.transitionNodeID);
      if (!validId(targetId)) return;
      const nav = a.navigationType || 'NAVIGATE';
      if (nav === 'OVERLAY') {
        const o: FigmaAction = { type: 'overlay', targetId, ...transitionOf(a) };
        a.overlayRelativePosition && (o.offset = { x: a.overlayRelativePosition.x, y: a.overlayRelativePosition.y });
        out.push(o);
      } else if (nav === 'SWAP_STATE') {
        out.push({ type: 'changeTo', targetId, ...transitionOf(a) });
      } else if (nav === 'SWAP') {
        out.push({ type: 'swap', targetId, ...transitionOf(a) });
      } else if (nav === 'SCROLL_TO') {
        out.push({ type: 'scrollTo', targetId, ...transitionOf(a) });
      } else {
        out.push({ type: 'navigate', targetId, ...transitionOf(a) });
      }
      return;
    }
    case 'BACK':
      out.push({ type: 'back' });
      return;
    case 'CLOSE':
      out.push({ type: 'close' });
      return;
    case 'URL':
      a.connectionURL && out.push({ type: 'url', url: a.connectionURL, newTab: a.openUrlInNewTab || undefined });
      return;
    case 'CONDITIONAL':
      // 条件分支：先取所有分支的动作（MVP 不表达条件）
      for (const branch of a.conditionalActions || []) for (const sub of branch.actions || []) action(sub, out);
      return;
    case 'NONE':
    case undefined:
      return;
    default:
      out.push({ type: 'other', raw: a.connectionType });
  }
}

/** 读取原型起点和交互（不解析几何） */
export async function readFigPrototype(input: FigmaInput): Promise<FigmaPrototype> {
  const fig = readFig(await toBytes(input), { images: false });
  const nodes: any[] = (fig.message.nodeChanges || []).filter((n: any) => n.guid && n.phase !== 'REMOVED');
  const byId = new Map(nodes.map((n) => [gkey(n.guid), n]));
  /** 节点所在的组件：向上找第一个 SYMBOL 祖先 */
  const componentOf = (n: any): string | undefined => {
    for (let p = byId.get(gkey(n.parentIndex?.guid)), i = 0; p && i < 256; p = byId.get(gkey(p.parentIndex?.guid)), i++) {
      if (p.type === 'SYMBOL') return gkey(p.guid);
      if (p.type === 'CANVAS') return undefined;
    }
    return undefined;
  };

  const starts: FigmaPrototypeStart[] = [];
  const interactions: FigmaInteraction[] = [];
  for (const n of nodes) {
    const id = gkey(n.guid);
    if (n.prototypeStartingPoint) {
      const s: FigmaPrototypeStart = { nodeId: id };
      n.prototypeStartingPoint.name && (s.name = n.prototypeStartingPoint.name);
      n.prototypeStartingPoint.description && (s.description = n.prototypeStartingPoint.description);
      starts.push(s);
    }
    // 旧版文件：页面上的 prototypeStartNodeID
    if (n.type === 'CANVAS') {
      const sid = gkey(n.prototypeStartNodeID);
      validId(sid) && !starts.some((s) => s.nodeId === sid) && starts.push({ nodeId: sid });
    }

    const list: any[] = (n.prototypeInteractions || []).filter((i: any) => !i.isDeleted);
    // 旧版文件：交互直接写在节点上（transitionNodeID + interactionType）
    if (!list.length && validId(gkey(n.transitionNodeID))) {
      list.push({
        event: { interactionType: n.interactionType || 'ON_CLICK', transitionTimeout: n.transitionTimeout },
        actions: [
          {
            connectionType: 'INTERNAL_NODE',
            transitionNodeID: n.transitionNodeID,
            navigationType: n.destinationIsOverlay ? 'OVERLAY' : 'NAVIGATE',
            transitionType: n.transitionType,
            transitionDuration: n.transitionDuration,
          },
        ],
      });
    }
    if (!list.length) continue;
    const componentId = componentOf(n);
    for (const i of list) {
      const actions: FigmaAction[] = [];
      for (const a of i.actions || []) action(a, actions);
      if (!actions.length) continue;
      const raw = i.event?.interactionType || 'ON_CLICK';
      const it: FigmaInteraction = { nodeId: id, trigger: TRIGGERS[raw] || 'other', actions };
      it.trigger === 'other' && (it.rawTrigger = raw);
      componentId && (it.componentId = componentId);
      const delay = ms(i.event?.transitionTimeout);
      it.trigger === 'timeout' && delay && (it.delay = delay);
      interactions.push(it);
    }
  }

  // overlay 的定位方式记录在目标画板上
  for (const it of interactions) {
    for (const a of it.actions) {
      if (a.type !== 'overlay') continue;
      const target = byId.get(a.targetId);
      target?.overlayPositionType && (a.position = target.overlayPositionType);
    }
  }
  return { starts, interactions };
}
