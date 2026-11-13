# DrawIR

DrawIR 是平台无关的矢量绘图中间描述语言（IR）monorepo。CAD、Visio、draw.io、Figma 解析器只生成矢量数据，Canvas 等后端各自实现渲染接口；核心库不包含编辑器、Pen、原生图形或 DOM 对象。

## 文档

- [IR 中间描述完整教程](./docs/ir-spec.md)
- [解析方实现指南](./docs/parser-guide.md)
- [渲染方实现指南](./docs/renderer-guide.md)

## 包结构

`packages/parser` 和 `packages/render` 只是分类目录，本身不是包。实际包如下：

- `@drawir/core`（`packages/core`）：`VectorDocument`、path/text/hatch/ref、矩阵、包围盒和路径构建工具，仅依赖 ES 标准库。
- `@drawir/parser-dxf`（`packages/parser/dxf`）：DXF → Vector IR。
- `@drawir/parser-visio`（`packages/parser/visio`）：VSDX → Vector IR。
- `@drawir/parser-drawio`（`packages/parser/drawio`）：draw.io（diagrams.net）→ Vector IR。
- `@drawir/parser-figma`（`packages/parser/figma`）：Figma `.fig` → Vector IR。
- `@drawir/render-core`（`packages/render/core`）：平台无关的 `Renderer` 接口与后端注册表。
- `@drawir/render-canvas`（`packages/render/canvas`）：HTML Canvas / OffscreenCanvas 的矢量指令解释器。
- `@drawir/render-svg`（`packages/render/svg`）：SVG 字符串导出与页面渲染，支持 path/text/hatch/ref。
- `@drawir/render-meta2d`（`packages/render/meta2d`）：meta2d.js 1.x 后端，IR → 可交互的 `vector` 图元（需 `@meta2d/core` ≥ 1.1.35）。

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

打开终端显示的本地地址。Demo 默认加载内置 Vector IR 示例，支持打开或拖放 DXF / VSDX / draw.io / Figma 文件、Canvas / SVG / meta2d 后端切换，以及缩放、平移和适应画布。

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

## draw.io → Canvas

```ts
const doc = await parseDrawio(file, { pageBorder: true });
await renderer.render(doc, { fit: true });
```

支持 `.drawio` / `.xml`（明文或压缩的 diagram）、`.drawio.svg`、`.drawio.png` 以及裸 `<mxGraphModel>` 文本；多页按 `pageList` 横向排布。分组、泳道、常用形状（含部分 `mxgraph.flowchart.*`）、直线 / 正交 / 肘形 / ER 连线路由、箭头、HTML 标签在解析期转换为矢量项；`default` 颜色映射为 `$fg` / `$bg`，随渲染主题变化。图片和渐变不属于纯矢量 IR，分别计入 `doc.stats.images` 和 `doc.stats.unsupported`，不支持的形状退化为矩形。

## Figma → Canvas

```ts
const doc = await parseFigma(figFile, { pageBorder: true });
await renderer.render(doc, { fit: true });

// 文字使用文件内缓存的字形轮廓，与 Figma 显示完全一致（不依赖本机字体）
const exact = await parseFigma(figFile, { text: 'path' });
```

读取 Figma「另存为本地副本」得到的 `.fig`（ZIP 包或裸 `fig-kiwi` 格式）。kiwi schema 从文件中读取，不硬编码字段表。几何直接使用文件缓存的 `fillGeometry` / `strokeGeometry`（描边已展开为轮廓），组件实例按覆盖、派生布局和组件属性（可见性、文字、实例替换）展开，文字按 Figma 排版结果逐行、逐样式段定位。IR 不支持的特性按如下方式降级并计入 `doc.stats`：图片填充跳过（`images`），渐变取色标平均色，特殊混合模式层跳过，阴影 / 模糊忽略，frame 裁剪与遮罩不生效（`clipContent`、`mask`）。

## 渲染到 meta2d 1.x

```ts
import { Meta2d } from '@meta2d/core'; // ≥ 1.1.35，内置 vector 图元
import { Meta2dRenderer, toMeta2dData, parseDxf } from 'drawir';

const renderer = new Meta2dRenderer(new Meta2d('app'));
await renderer.render(await parseDxf(file), { fit: true });          // 作为新图纸打开
await renderer.render(doc2, { mode: 'append', origin: { x: 0, y: 800 } }); // 追加，可撤销

// 只转换数据（不依赖 DOM / meta2d，可在 Worker 中运行）
const { pens, vectors } = toMeta2dData(doc, { granularity: 'item' });
meta2d.open({ pens, vectors });
```

meta2d 1.x 的 `vector` 图元直接解释同一套 IR：`pen.vector = { bbox, items }`，共享几何放在 `data.vectors`，`meta2d.data()` 保存时自动带上用到的定义。

- 颜色语义：`$fg` 取图元描边色，跟随 `pen.color`、悬停/选中色和 meta2d 主题；`$bg` 对应 `pen.background`；`$lw` 和最细线宽对应 `pen.lineWidth`；`tint` 对应 `pen.vectorTint`。
- `granularity: 'item'`（缺省）：每个顶层绘制项一个图元，可单独选中和编辑；超过 `maxPens`（缺省 20000）时自动改为 `'document'`，整份文档一个图元。
- `editable`（缺省 true）：文字转为原生文字图元，双击即可修改；单路径的固定颜色和线宽提升为图元属性，在属性面板中修改即可生效。
- 共享几何 id 缺省加随机命名空间，多次追加时不会互相覆盖。
- meta2d 会把容器改成 `position: relative`。如果容器原本是绝对定位，请在内部再放一个宽高 100% 的 div 交给 `new Meta2d()`。

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

## SVG 渲染与导出

```ts
import { renderSvg, SvgRenderer } from 'drawir';

// 服务端或 Worker：直接返回完整 SVG 字符串，不依赖 DOM。
const svg = renderSvg(doc, { width: 960, height: 600, fit: true });

// 页面：把 SVG 写入目标元素，同时返回字符串。
const renderer = new SvgRenderer(document.querySelector('#svg-host')!);
renderer.render(doc, { fit: true });
```

## 实现其他渲染后端

后端只需要解释 `VectorDocument`，不需要了解 DXF、Visio、Canvas 或 SVG。`Renderer<Options, Result>` 的第二个泛型用于声明后端返回值。

通过注册表切换后端：

```ts
const renderers = new RendererRegistry()
  .register('canvas', () => new CanvasRenderer(canvas))
  .register('svg', () => new SvgRenderer(svgHost));

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
