import type { VectorDocument } from '@drawir/core';

export interface Viewport {
  /** 世界坐标到画布的缩放。 */
  scale: number;
  /** 画布平移，单位是 CSS 像素。 */
  x: number;
  y: number;
}

export interface RenderOptions {
  viewport?: Partial<Viewport>;
  /** 按文档尺寸适配目标，显式 viewport 优先。 */
  fit?: boolean;
  padding?: number;
  /** 覆盖文档背景；传空字符串可禁用背景。 */
  background?: string;
  clear?: boolean;
}

/** 所有后端共享的渲染契约。后端可在 options 中扩展自己的配置。 */
export interface Renderer<Options extends RenderOptions = RenderOptions> {
  readonly name: string;
  render(document: VectorDocument, options?: Options): void | Promise<void>;
  destroy?(): void;
}

export type RendererFactory = () => Renderer<any>;

/** 按名称管理后端，便于应用在不改业务代码的情况下切换渲染器。 */
export class RendererRegistry {
  private factories = new Map<string, RendererFactory>();

  register(name: string, factory: RendererFactory) {
    if (!name || typeof factory !== 'function') throw new Error('Renderer name and factory are required');
    this.factories.set(name, factory);
    return this;
  }

  has(name: string) {
    return this.factories.has(name);
  }

  create(name: string): Renderer<any> {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown renderer: ${name}`);
    return factory();
  }
}

export function renderDocument<Options extends RenderOptions>(
  renderer: Renderer<Options>,
  document: VectorDocument,
  options?: Options,
) {
  return renderer.render(document, options);
}
