# DrawIR

DrawIR 是平台无关的矢量绘图中间描述语言（IR）monorepo。CAD、Visio 解析器只生成矢量数据，Canvas 等后端各自实现渲染接口；核心库不包含编辑器、Pen、原生图形或 DOM 对象。

## 包结构

`packages/parser` 和 `packages/render` 只是分类目录，本身不是包。实际包如下：

- `@drawir/core`（`packages/core`）：`VectorDocument`、path/text/hatch/ref、矩阵、包围盒和路径构建工具，仅依赖 ES 标准库。
- `@drawir/parser-dxf`（`packages/parser/dxf`）：DXF → Vector IR。
- `@drawir/parser-visio`（`packages/parser/visio`）：VSDX → Vector IR。
- `@drawir/render-core`（`packages/render/core`）：平台无关的 `Renderer` 接口与后端注册表。
- `@drawir/render-canvas`（`packages/render/canvas`）：HTML Canvas / OffscreenCanvas 的矢量指令解释器。

根包 `drawir` 统一导出以上 API，也可以只使用子包。

## 核心模型

```ts
interface VectorDocument extends VectorGeom {
  bbox: { x: number; y: number; width: number; height: number };
  items: VectorItem[];
  vectors?: Record<string, VectorGeom>;
  width?: number;
  height?: number;
  color?: string;
  background?: string;
  lineWidth?: number;
  lineDash?: number[];
}
```

`items` 只有四种：

- `t: 'p'`：路径，支持 move、line、二次/三次贝塞尔、close、ellipse。
- `t: 't'`：文字，包含锚点、字高、旋转、对齐和字体信息。
- `t: 'h'`：边界裁剪的图案填充。
- `t: 'r'`：通过 id 和仿射矩阵引用 `vectors` 中的共享几何。

颜色 `'$fg'`、`'$bg'` 和线宽 `'$lw'` 由后端根据文档或渲染参数解析。所有数据都可直接 JSON 序列化，也可跨 Worker 传输。

## 构建

```bash
pnpm install
pnpm build
```

## 运行 Demo

```bash
pnpm dev
```

打开终端显示的本地地址。Demo 默认加载内置 Vector IR 示例，支持打开或拖放 DXF / VSDX 文件，以及缩放、平移和适应画布。

```bash
pnpm demo:build
```

生产文件输出到 `demo/dist`。

## DXF → Canvas

```ts
import { parseDxf, CanvasRenderer } from 'drawir';

const renderer = new CanvasRenderer(document.querySelector('canvas')!, {
  fit: true,
  padding: 24,
});

async function openDxf(file: File) {
  const doc = await parseDxf(file);
  await renderer.render(doc, { background: '#ffffff' });
}
```

已有文本时可同步解析：

```ts
const doc = parseDxfSync(dxfText, {
  granularity: 'layer',
  contrastColor: true,
});
```

## Visio VSDX → Canvas

```ts
const doc = await parseVisio(vsdxFile, { pageBorder: true });
await renderer.render(doc, { fit: true });
```

母版、组合和连接线在解析期转换为普通矢量项。位图不属于纯矢量 IR，会跳过并计入 `doc.stats.images`。仅支持 `.vsdx`，旧版 `.vsd` 需先另存为 VSDX；DWG 需先另存为 DXF。

## 手工创建 IR

```ts
import {
  CanvasRenderer,
  VectorPathBuilder,
  createGeom,
  pathItem,
  type VectorDocument,
} from 'drawir';

const path = new VectorPathBuilder();
path.moveTo(0, 0).lineTo(120, 0).lineTo(120, 70).lineTo(0, 70).close();
const geom = createGeom([
  pathItem(path.d, { stroke: '$fg', fill: '$bg', lw: '$lw' }),
  { t: 't', text: '文档', x: 60, y: 35, h: 14, a: 'center', b: 'middle' },
]);

const doc: VectorDocument = {
  ...geom,
  width: 120,
  height: 70,
  color: '#1890ff',
  background: '#e6f7ff',
  lineWidth: 2,
};

new CanvasRenderer(canvas).render(doc, { fit: true });
```

## 实现其他渲染后端

后端只需要解释 `VectorDocument`，不需要了解 DXF、Visio 或 Canvas：

```ts
import type { Renderer, RenderOptions, VectorDocument } from 'drawir';

class SvgRenderer implements Renderer {
  readonly name = 'svg';

  render(doc: VectorDocument, options?: RenderOptions) {
    // 在 SVG 平台中实现 path/text/hatch/ref。
  }
}
```

通过注册表切换后端：

```ts
const renderers = new RendererRegistry()
  .register('canvas', () => new CanvasRenderer(canvas))
  .register('svg', () => new SvgRenderer());

const renderer = renderers.create('canvas');
await renderer.render(doc, { fit: true });
```

## Canvas 配置

- `fit`、`padding`、`viewport: { scale, x, y }`：视口控制。
- `pixelRatio`、`width`、`height`、`autoResize`：高清屏和画布尺寸。
- `background`、`clear`：背景和清屏。
- `color`、`lineWidth`、`lineDash`、`tint`：覆盖动态颜色、线宽和整体着色。

```ts
renderer.render(doc, {
  pixelRatio: 2,
  viewport: { scale: 1.5, x: 40, y: 20 },
});
```

解析器不依赖 DOM 或渲染器，可在 Web Worker 中运行；Canvas 后端也接受 `OffscreenCanvas`。
