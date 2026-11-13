# 渲染方实现指南：如何为 Vector IR 实现一个渲染后端

**渲染方**负责把 `VectorDocument` 画到某个目标上：HTML Canvas、SVG、WebGL、PDF、原生 Skia / CoreGraphics、打印机……渲染方**只理解 IR**，完全不需要了解 DXF、Visio 或任何源格式。

IR 字段的完整语义见 [IR 教程](./ir-spec.md)。参考实现：

- `packages/render/canvas`（`@drawir/render-canvas`）——**语义基准实现**，有疑问时以它为准
- `packages/render/svg`（`@drawir/render-svg`）——输出字符串的后端示例
- `packages/render/meta2d`（`@drawir/render-meta2d`）——把 IR 交给外部引擎（meta2d.js 1.x）的后端示例：转换为引擎的数据模型，而非逐条绘制

---

## 1. 需要实现什么

### 1.1 `Renderer` 接口

接口定义在 `@drawir/render-core`：

```ts
interface Viewport {
  scale: number;   // 世界坐标 → 目标坐标的缩放
  x: number;       // 平移（目标坐标，通常是 CSS 像素）
  y: number;
}

interface RenderOptions {
  viewport?: Partial<Viewport>;
  fit?: boolean;        // 按文档尺寸自适应目标，显式 viewport 优先
  padding?: number;     // fit 时的留白，缺省 20
  background?: string;  // 覆盖文档背景；空字符串禁用背景
  clear?: boolean;      // 绘制前清屏，缺省 true
}

interface Renderer<Options extends RenderOptions = RenderOptions, Result = void | Promise<void>> {
  readonly name: string;
  render(document: VectorDocument, options?: Options): Result;
  destroy?(): void;
}
```

- `Options`：扩展 `RenderOptions`，加入后端特有参数。
- `Result`：后端返回值。Canvas 返回 `void`，SVG 返回 SVG 字符串，PDF 后端可以返回 `Promise<Uint8Array>`。

### 1.2 推荐支持的通用选项

两个官方后端都支持以下选项，新后端建议保持一致，以便调用方无缝切换：

| 选项 | 含义 |
| --- | --- |
| `color` | 覆盖 `doc.color`（`$fg` 的取值） |
| `lineWidth` | 覆盖 `doc.lineWidth`（`$lw` 的取值，屏幕像素） |
| `lineDash` | 覆盖 `doc.lineDash` |
| `tint` | 所有固定颜色也统一使用前景色 |
| `width` / `height` | 目标尺寸 |

选项优先级：**`render()` 参数 > 构造函数默认参数 > 文档字段 > 内置缺省值**。

### 1.3 注册到 RendererRegistry

```ts
import { RendererRegistry } from '@drawir/render-core';

const renderers = new RendererRegistry()
  .register('canvas', () => new CanvasRenderer(canvas))
  .register('svg', () => new SvgRenderer(host))
  .register('webgl', () => new WebGLRenderer(glCanvas));

renderers.create('webgl').render(doc, { fit: true });
```

---

## 2. 渲染管线

```
render(doc, options)
 ├─ 1. 合并选项（参数 > 默认 > 文档）
 ├─ 2. 确定目标尺寸、像素比
 ├─ 3. 清屏，绘制背景（options.background ?? doc.background）
 ├─ 4. 计算视口：viewport 显式值 / fit 自适应 / 单位视口
 ├─ 5. 设置根变换：pixelRatio × viewport
 └─ 6. drawItems(doc.items, 初始状态)
        ├─ 'p' → drawPath
        ├─ 't' → drawText
        ├─ 'h' → drawHatch
        └─ 'r' → save → transform(m) → drawItems(vectors[id].items, 新状态) → restore
```

### 2.1 视口与 fit

```ts
function fitViewport(doc: VectorDocument, width: number, height: number, padding = 20): Viewport {
  const content = doc.width && doc.height
    ? { x: 0, y: 0, width: doc.width, height: doc.height }
    : doc.bbox;
  const scale = Math.min((width - padding * 2) / content.width, (height - padding * 2) / content.height);
  if (!(scale > 0) || !Number.isFinite(scale)) return { scale: 1, x: 0, y: 0 };
  return {
    scale,
    x: (width - content.width * scale) / 2 - content.x * scale,
    y: (height - content.height * scale) / 2 - content.y * scale,
  };
}
```

`@drawir/render-canvas` 已导出 `fitViewport`，可直接复用。根变换为：

```
[pixelRatio·scale, 0, 0, pixelRatio·scale, pixelRatio·x, pixelRatio·y]
```

### 2.2 绘制状态

遍历时需要携带一个状态对象，进入引用时派生新状态：

```ts
interface DrawState {
  k: number;          // 当前局部单位 → 世界单位的累计缩放（引用嵌套时累乘）
  px: number;         // 当前局部单位 → 设备像素的累计缩放
  fg: string;         // 当前 '$fg' 的值
  bg?: string;        // '$bg' 的值
  docLw: number;      // '$lw'：屏幕像素线宽
  docDash?: number[]; // 文档虚线（屏幕像素）
  tint: boolean;
  depth: number;      // 引用嵌套深度
}
```

`px` 是最关键的量：**1 个局部单位 = `px` 个设备像素**。很多"与缩放无关"的语义（细线、`$lw`、`px` 线宽、太小的文字跳过）都靠它换算。有 `getTransform()` 的平台可以直接取当前矩阵行列式开方：`px = sqrt(|a·d - b·c|)`。

---

## 3. 各绘制项的实现

### 3.1 路径指令遍历

所有后端都需要一个路径解释器。把它写成"指令 → 回调"的形式，可以同时服务于描边、填充、裁剪：

```ts
import { VectorOp, VectorOpSize, ellipseToCubics, type VectorPathData } from '@drawir/core';

function tracePath(sink: PathSink, d: VectorPathData) {
  for (let i = 0; i < d.length; ) {
    const op = d[i];
    switch (op) {
      case VectorOp.Move:  sink.moveTo(d[i + 1], d[i + 2]); break;
      case VectorOp.Line:  sink.lineTo(d[i + 1], d[i + 2]); break;
      case VectorOp.Cubic: sink.bezierCurveTo(d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5], d[i + 6]); break;
      case VectorOp.Quad:  sink.quadraticCurveTo(d[i + 1], d[i + 2], d[i + 3], d[i + 4]); break;
      case VectorOp.Close: sink.closePath(); break;
      case VectorOp.Ellipse:
        if (sink.ellipse) {
          sink.ellipse(d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5], d[i + 6], d[i + 7], !!d[i + 8]);
        } else {
          // 目标不支持椭圆弧：转三次贝塞尔（每段 ≤ 90°）
          const { start, curves } = ellipseToCubics(d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5], d[i + 6], d[i + 7], !!d[i + 8]);
          sink.lineTo(start[0], start[1]);
          for (const c of curves) sink.bezierCurveTo(c[0], c[1], c[2], c[3], c[4], c[5]);
        }
        break;
      default:
        return; // 未知操作码：停止
    }
    i += VectorOpSize[op];
  }
}
```

`@drawir/render-canvas` 已导出 `traceVectorPath(sink, d, noEllipse?)`，任何实现了 `moveTo / lineTo / bezierCurveTo / quadraticCurveTo / closePath` 的对象（如 `Path2D`、自定义的 WebGL 曲线细分器）都可以直接作为 `sink`。

各平台映射：

| IR | Canvas | SVG | Skia | PDF |
| --- | --- | --- | --- | --- |
| Move | `moveTo` | `M` | `moveTo` | `m` |
| Line | `lineTo` | `L` | `lineTo` | `l` |
| Cubic | `bezierCurveTo` | `C` | `cubicTo` | `c` |
| Quad | `quadraticCurveTo` | `Q` | `quadTo` | 升阶为 `c` |
| Close | `closePath` | `Z` | `close` | `h` |
| Ellipse | `ellipse` | 转贝塞尔 | `arcTo(oval)` 或转贝塞尔 | 转贝塞尔 |

> 注意：SVG 的 `A` 指令语义与 Canvas `ellipse` 不同（端点参数化），直接转换容易出错，官方 SVG 后端选择统一转贝塞尔。

二次曲线升阶为三次：`c1 = p0 + 2/3·(q - p0)`，`c2 = p + 2/3·(q - p)`。

### 3.2 颜色解析

```ts
function resolveColor(c: string | undefined, st: DrawState, fallback: 'fg' | 'none') {
  if (c === undefined) return fallback === 'fg' ? st.fg : undefined;
  if (c === 'none') return undefined;
  if (c === '$fg' || st.tint) return st.fg;
  if (c === '$bg') return st.bg;          // 没有背景时为 undefined → 不绘制
  return c;                               // CSS 颜色
}
```

缺省：路径 `stroke` → `fg`，路径 `fill` → `none`，文字 `fill` → `fg`，图案 `stroke` → `fg`。

### 3.3 路径 `'p'`

顺序：**先填充，后描边**。

```ts
function drawPath(ctx, item, st) {
  const s = item.s;
  ctx.save();
  ctx.beginPath();
  tracePath(ctx, item.d);
  if (s?.alpha !== undefined) ctx.globalAlpha *= s.alpha;

  const fill = resolveColor(s?.fill, st, 'none');
  if (fill) { ctx.fillStyle = fill; ctx.fill(s?.rule ?? 'nonzero'); }

  const stroke = (s?.lw === '$lw' && st.docLw === 0) ? undefined : resolveColor(s?.stroke, st, 'fg');
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidthOf(s, st);
    ctx.setLineDash(dashOf(s, st));
    if (s?.cap) ctx.lineCap = s.cap;
    if (s?.join) ctx.lineJoin = s.join;
    ctx.stroke();
  }
  ctx.restore();
}
```

**线宽换算**（结果是当前局部单位）：

```ts
const onePx = 1 / st.px;
function lineWidthOf(s, st) {
  if (s?.lw === '$lw') return st.docLw / st.k;              // $lw：屏幕像素，随 k 反算
  let lw = Math.max(typeof s?.lw === 'number' ? s.lw : 0, minLw / st.k); // 细线下限
  if (s?.px) lw = Math.max(lw, s.px / st.px);               // px：屏幕像素下限
  return lw;
}
```

其中 `minLw` 为文档 `lineWidth`（> 1 时）或 1 个设备像素。语义总结：

| 写法 | 放大视图时 | 缩小视图时 |
| --- | --- | --- |
| 无 `lw` | 始终约 1 像素 | 始终约 1 像素 |
| `lw: 数字` | 变粗 | 变细，但不小于 1 像素 |
| `lw: '$lw'` | 保持 `lineWidth` 像素 | 保持 `lineWidth` 像素 |
| `px: n` | 至少 n 像素 | 至少 n 像素 |

**虚线**：`s.dash` 优先，其次文档 `lineDash`（屏幕像素，需 `/ k` 换算回局部单位）。若一个周期在屏幕上小于约 3 像素，应改画实线，否则会出现大量抗锯齿噪点并严重拖慢渲染。

不支持非缩放描边的平台（如 SVG），可用 `vector-effect="non-scaling-stroke"` 近似 `px` 语义。

### 3.4 文字 `'t'`

```ts
import { textItemLines } from '@drawir/core';

function drawText(ctx, item, st) {
  const color = resolveColor(item.fill, st, 'fg');
  const size = item.h * st.px;              // 设备像素字号
  if (!color || !item.text || size < 1) return; // 太小的字直接跳过

  ctx.save();
  ctx.translate(item.x, item.y);
  if (item.r) ctx.rotate(item.r);
  // 用设备像素字号设置字体，再缩回局部坐标：避免浏览器对极小/极大字号的取整问题
  ctx.scale((item.w || 1) / st.px, (item.m ? -1 : 1) / st.px);
  ctx.font = `${item.italic ? 'italic ' : ''}${item.bold ? 'bold ' : ''}${size}px ${item.font || 'Arial, sans-serif'}`;
  ctx.textAlign = item.a || 'left';
  ctx.textBaseline = item.b || 'alphabetic';
  ctx.fillStyle = color;

  const lines = textItemLines(item);        // 必须用它，保证与 bbox 一致的换行
  const lh = (item.lh || 1.25) * size;
  let y = 0;
  if (item.b === 'middle') y = -(lines.length - 1) * lh / 2;
  else if (item.b === 'bottom' || item.b === 'ideographic') y = -(lines.length - 1) * lh;
  lines.forEach((line, i) => line && ctx.fillText(line, 0, y + i * lh));
  ctx.restore();
}
```

变换顺序 `translate → rotate → scale(w, ±1)` 不能乱。对齐值映射：

| IR `a` | Canvas `textAlign` | SVG `text-anchor` |
| --- | --- | --- |
| `left` / `start` | `left` | `start` |
| `center` | `center` | `middle` |
| `right` / `end` | `right` | `end` |

| IR `b` | Canvas `textBaseline` | SVG `dominant-baseline` |
| --- | --- | --- |
| `top` / `hanging` | 同名 | `hanging` |
| `middle` | `middle` | `central` |
| `alphabetic` | `alphabetic` | `alphabetic` |
| `bottom` / `ideographic` | 同名 | `text-after-edge` |

没有文字排版能力的后端（如纯 WebGL）可以：用 SDF 字体图集；或在 Canvas 上把文字栅格化成纹理；或调用方预先把文字转成路径。

### 3.5 图案填充 `'h'`

算法：

1. 用边界 `d` 以 **evenodd** 规则建立裁剪区。
2. 求边界的轴对齐包围盒（四个角点）。
3. 对每组线族 `{a, x, y, dx, dy, dash}`：
   - 方向 `u = (cos a, sin a)`，法向 `n = (-sin a, cos a)`；
   - 线间距 `spacing = (dx, dy)·n`，为 0 跳过；错位 `shift = (dx, dy)·u`；
   - 把包围盒四角投影到 `n` 上除以 `spacing`，得到线序号范围 `[floor(nMin), ceil(nMax)]`；投影到 `u` 上得到线段长度范围 `[tMin, tMax]`；
   - 第 `i` 条线经过 `P_i = (x + i·dx, y + i·dy)`，画从 `P_i + u·t0` 到 `P_i + u·t1` 的线段，`t0/t1` 在 `tMin/tMax` 基础上减去 `P_i` 自身在 `u` 上的投影，并各外扩 `|shift|`。
4. 线宽使用细线（1 设备像素）。

**dash 转换**：hatch 的 dash 是 CAD 格式（正 = 实，负 = 间隙，0 = 点），要转成平台的"实/虚交替正数"数组：

```ts
function toCanvasDash(dash: number[] | undefined, dot: number) {
  if (!dash?.length) return undefined;
  const out: number[] = [];
  if (dash[0] < 0) out.push(0);                 // 以间隙开头：先补一个 0 长实线
  for (const v of dash) {
    const len = v === 0 ? dot : Math.abs(v);
    const draw = v >= 0;
    if (draw === (out.length % 2 === 0)) out.push(len);
    else out[out.length - 1] += len;            // 相邻同类合并
  }
  if (out.length % 2) out.push(0);
  return out;
}
```

每条线的 `lineDashOffset = t0 mod period`，保证所有线的虚线相位对齐到同一个基准，图案才不会错乱。

**降级保护**：线条数超过上限（官方为 1500）或屏幕间距小于 2 像素时，改为用前景色 35% 透明度填充边界区域，避免卡死。

### 3.6 引用 `'r'`

```ts
case 'r': {
  if (st.depth >= 24) break;                // 深度上限，防止循环引用
  const def = doc.vectors?.[item.id];
  if (!def) break;
  ctx.save();
  ctx.transform(...item.m);
  const s = matrixScale(item.m);
  const fg = item.c && item.c !== '$fg' ? resolveColor(item.c, st, 'fg') : st.fg;
  drawItems(def.items, { ...st, k: st.k * s, px: st.px * s, fg, depth: st.depth + 1 });
  ctx.restore();
  break;
}
```

要点：

- `k`、`px` 随 `matrixScale(m)` **累乘**，否则块内的细线、`$lw`、文字跳过阈值会错误。
- `item.c` 覆盖块内 `$fg`；它本身也可能是 `$fg`，表示沿用外层颜色。
- 保留式后端（SVG、场景图、WebGL 实例化）可以把共享几何只生成一次再多次实例化。SVG 用 `<g transform>` 包裹即可；若想更小可用 `<defs>` + `<use>`，但要注意 `$fg` 随引用变化时需要 CSS 变量或 `currentColor`。

---

## 4. 两类后端的实现模式

### 4.1 即时模式（Canvas、Skia、CoreGraphics、PDF 内容流）

直接参照 `packages/render/canvas/src/vector.ts`：一个递归的 `drawItems`，用平台的 `save / transform / restore` 处理引用。几乎是一比一翻译。

### 4.2 保留/字符串模式（SVG、DOM、场景图）

参照 `packages/render/svg/src`：

- 每个项生成一个节点/字符串片段；
- 引用生成 `<g transform="matrix(...)">` 并递归；
- 裁剪路径需要唯一 id（用计数器生成）；
- 输出前对文字做 XML 转义，数字统一格式化（避免 `1e-7` 和超长小数）；
- 无法感知当前像素比时，`$lw` / 细线退化为"世界单位 = 像素"的近似，`px` 用 `vector-effect="non-scaling-stroke"`。

### 4.3 GPU 后端（WebGL / WebGPU）提示

- 路径：用 `traceVectorPath` 喂给自己的细分器（贝塞尔按屏幕误差自适应分段），描边做三角带扩展，填充用 stencil 或 earcut 三角化（`rule` 决定 stencil 规则）。
- `$fg` / `$bg` / 线宽做成 uniform，换主题、改线宽无需重建几何。
- `vectors` 天然适合 instancing：每个 `id` 一份顶点缓冲，每个引用一个实例矩阵 + 颜色。
- 视口变化只改 uniform；细线、`px` 线宽在着色器里按屏幕像素扩展。

---

## 5. 最小后端示例：Path2D 命中测试"渲染器"

渲染器不一定要画东西。下面这个后端把 IR"渲染"为可命中测试的对象列表，展示了接口的通用性：

```ts
import type { VectorDocument, VectorItem } from '@drawir/core';
import { multiplyMatrix, IDENTITY, type Matrix } from '@drawir/core';
import type { Renderer, RenderOptions } from '@drawir/render-core';
import { traceVectorPath } from '@drawir/render-canvas';

interface HitShape { path: Path2D; matrix: Matrix; item: VectorItem }

export class HitTestRenderer implements Renderer<RenderOptions, HitShape[]> {
  readonly name = 'hit-test';

  render(doc: VectorDocument): HitShape[] {
    const out: HitShape[] = [];
    const walk = (items: VectorItem[], m: Matrix, depth: number) => {
      for (const item of items) {
        if (item.t === 'p' || item.t === 'h') {
          const path = new Path2D();
          traceVectorPath(path, item.d);
          out.push({ path, matrix: m, item });
        } else if (item.t === 'r' && depth < 24) {
          const def = doc.vectors?.[item.id];
          def && walk(def.items, multiplyMatrix(m, item.m), depth + 1);
        }
      }
    };
    walk(doc.items, IDENTITY, 0);
    return out;
  }
}
```

---

## 6. 自检清单

- [ ] Demo 内置示例（`pnpm dev`）与 Canvas 后端结果一致。
- [ ] 加载一份 DXF、一份 VSDX，与 Canvas 后端对比：圆弧方向、镜像块、文字旋转/镜像/多行对齐。
- [ ] 不写 `lw` 的线在任意缩放下都约为 1 像素。
- [ ] `$lw` 线在缩放时像素宽度不变；`lineWidth: 0` 时不描边。
- [ ] 切换 `color` / `background` 后 `$fg` / `$bg` 正确变化，块内 BYBLOCK 颜色随 `ref.c` 变化。
- [ ] `$bg` 在没有背景时不绘制。
- [ ] 极小字号跳过、极密 hatch 降级、虚线过密退化为实线——大图不卡死。
- [ ] 循环引用、缺失 `id`、未知操作码不崩溃。
- [ ] `render()` 可重复调用（不泄漏状态，`save/restore` 配对）。
