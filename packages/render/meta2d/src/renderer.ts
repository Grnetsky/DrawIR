import type { VectorDocument } from '@drawir/core';
import type { Renderer, Viewport } from '@drawir/render-core';
import { toMeta2dData } from './convert';
import type { Meta2dData, Meta2dLike, Meta2dRenderOptions } from './types';

/**
 * meta2d.js 1.x 渲染后端：把 Vector IR 转成 vector 图元后交给 Meta2d 实例绘制。
 *
 * 与 Canvas / SVG 后端不同，结果是可交互的 meta2d 图纸：图元可选中、移动、缩放、编辑，
 * 平移缩放由 meta2d 自己处理，`meta2d.data()` 保存时自动带上用到的共享几何。
 *
 * ```ts
 * import { Meta2d } from '@meta2d/core';
 * const renderer = new Meta2dRenderer(new Meta2d('app'));
 * await renderer.render(doc, { fit: true });
 * ```
 */
export class Meta2dRenderer implements Renderer<Meta2dRenderOptions, Promise<Meta2dData>> {
  readonly name = 'meta2d';

  constructor(
    readonly meta2d: Meta2dLike,
    private defaults: Meta2dRenderOptions = {},
  ) {}

  async render(document: VectorDocument, options: Meta2dRenderOptions = {}): Promise<Meta2dData> {
    const opts: Meta2dRenderOptions = { ...this.defaults, ...options };
    const data = toMeta2dData(document, opts);
    const mode = opts.mode ?? (opts.clear === false ? 'append' : 'open');
    const m = this.meta2d;

    if (mode === 'open') {
      // open 会重置视口为 scale = 1、平移 0，与 IR 的单位视口一致
      m.open({ pens: data.pens, vectors: data.vectors, background: data.background }, false);
      m.setBackgroundColor(data.background);
    } else {
      // 先注册共享几何，再添加引用它们的图元
      m.addVectors(data.vectors);
      await m.addPens(data.pens, opts.history !== false);
      opts.background !== undefined && m.setBackgroundColor(opts.background || undefined);
    }

    if (opts.viewport) {
      this.setViewport({ scale: 1, x: 0, y: 0, ...opts.viewport });
    } else if (opts.fit) {
      const v = this.fitViewport(document, opts);
      v && this.setViewport(v);
    }
    // open(data, false) 会让画布处于 opening 状态，必须 render(true) 才会解除并强制重绘
    m.render(true);
    return data;
  }

  /** 设置视口：屏幕坐标 = 画布坐标 × scale + (x, y)，与其他后端的 Viewport 语义相同 */
  setViewport(v: Viewport) {
    const m = this.meta2d;
    const d = m.store.data;
    // 1.x：屏幕 = 画布坐标 × scale + origin + data.x；以 (0, 0) 为中心缩放后 origin 同比缩放
    if (Math.abs(d.scale - v.scale) > 1e-9) m.scale(v.scale, { x: 0, y: 0 });
    const s = d.scale || 1;
    const tx = v.x - d.origin.x - d.x;
    const ty = v.y - d.origin.y - d.y;
    (tx || ty) && m.translate(tx / s, ty / s);
  }

  /** 当前视口（屏幕坐标 = 画布坐标 × scale + (x, y)） */
  getViewport(): Viewport {
    const d = this.meta2d.store.data;
    return { scale: d.scale, x: d.origin.x + d.x, y: d.origin.y + d.y };
  }

  /** 文档内容（width/height 优先，否则 bbox）适配到画布的视口 */
  fitViewport(document: VectorDocument, opts: Meta2dRenderOptions = this.defaults): Viewport | undefined {
    const el = this.meta2d.canvas?.canvas;
    const width = el?.offsetWidth ?? 0;
    const height = el?.offsetHeight ?? 0;
    if (!(width > 0) || !(height > 0)) return undefined;
    const k = opts.scale && opts.scale > 0 ? opts.scale : 1;
    const ox = opts.origin?.x ?? 0;
    const oy = opts.origin?.y ?? 0;
    const c = document.width && document.height ? { x: 0, y: 0, width: document.width, height: document.height } : document.bbox;
    const content = { x: ox + c.x * k, y: oy + c.y * k, width: c.width * k, height: c.height * k };
    const padding = opts.padding ?? 20;
    const scale = Math.min((width - padding * 2) / content.width, (height - padding * 2) / content.height);
    if (!(scale > 0) || !Number.isFinite(scale)) return undefined;
    return {
      scale,
      x: (width - content.width * scale) / 2 - content.x * scale,
      y: (height - content.height * scale) / 2 - content.y * scale,
    };
  }

  /** 后端不持有 Meta2d 实例（由调用方创建），destroy 只清空图纸 */
  destroy() {
    this.meta2d.open({ pens: [] }, true);
  }
}

/** 便捷函数：解析结果直接加载到 meta2d（缺省作为新图纸打开并适配视图） */
export function loadToMeta2d(meta2d: Meta2dLike, document: VectorDocument, options: Meta2dRenderOptions = {}) {
  return new Meta2dRenderer(meta2d).render(document, { fit: options.mode !== 'append' && !options.viewport, ...options });
}
