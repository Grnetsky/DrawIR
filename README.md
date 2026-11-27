# DrawIR

DrawIR 是平台无关的矢量绘图中间描述语言（IR）monorepo。CAD、Visio、draw.io、Figma、Sketch、SVG、EPGIS SYM、GenCAD、Mermaid 解析器只生成矢量数据，Canvas 等后端各自实现渲染接口；核心库不包含编辑器、Pen、原生图形或 DOM 对象。

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
- `@drawir/parser-sketch`（`packages/parser/sketch`）：Sketch `.sketch` → Vector IR。
- `@drawir/parser-svg`（`packages/parser/svg`）：SVG / SVGZ → Vector IR。
- `@drawir/parser-sym`（`packages/parser/sym`）：EPGIS `EP Version 1.0` 符号库 `.sym` → Vector IR。
- `@drawir/parser-gencad`（`packages/parser/gencad`）：GenCAD 1.4 PCB `.cad` → Vector IR。
- `@drawir/parser-mermaid`（`packages/parser/mermaid`）：Mermaid（flowchart / sequenceDiagram，内置布局）→ Vector IR。

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

`items` 有六种：

- `t: 'p'`：路径，支持 move、line、二次/三次贝塞尔、close、ellipse；填充 / 描边可以是颜色或线性 / 径向渐变。
- `t: 't'`：文字，包含锚点、字高、旋转、对齐和字体信息。
- `t: 'h'`：边界裁剪的图案填充。
- `t: 'r'`：通过 id 和仿射矩阵引用 `vectors` 中的共享几何。
- `t: 'i'`：图片（单位正方形经矩阵映射，支持 fill / contain / cover、圆角、透明度）。
- `t: 'c'`：裁剪（蒙版），子项只在裁剪路径内可见。

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

打开终端显示的本地地址。Demo 默认加载内置 Vector IR 示例，支持打开或拖放 DXF / VSDX / draw.io / Figma / Sketch / SVG / SYM / GenCAD / Mermaid（.mmd）文件、Canvas / SVG / HTML / meta2d 后端切换，以及缩放、平移和适应画布。

```bash
pnpm demo:build
```

生产文件输出到 `demo/dist`。

## 任意格式 → HTML

```ts
import { parseSvg, HtmlRenderer } from 'drawir';

const html = new HtmlRenderer(document.querySelector('#host')!);
html.render(await parseSvg(file), { fit: true, width: 800, height: 600 });
// 也可在 Node / Worker 中得到字符串：renderHtml(doc, { fit: true })
```

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
