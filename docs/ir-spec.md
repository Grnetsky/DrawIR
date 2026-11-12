# DrawIR 中间描述（Vector IR）完整教程

本文是 Vector IR 的规范与教程。它是解析方和渲染方之间唯一的契约：解析方只负责**生成**合法的 IR，渲染方只负责**解释** IR，两者互不知道对方的存在。

类型定义源码：`packages/core/src/vector/types.ts`；构建与变换工具：`packages/core/src/vector/geom.ts`；矩阵与曲线算法：`packages/core/src/math.ts`。

---

## 1. 设计原则

| 原则 | 含义 |
| --- | --- |
| 纯数据 | 只有数字、字符串、数组、普通对象。可以 `JSON.stringify`、`structuredClone`、`postMessage` 跨 Worker 传输。 |
| 平台无关 | 不含 DOM、Canvas、编辑器对象，不含任何源格式（DXF/Visio）概念。 |
| 指令紧凑 | 路径是扁平数字数组，比对象数组小一个数量级。 |
| 共享几何 | CAD 块、Visio 母版只存一份定义，多处通过矩阵引用。 |
| 动态样式 | `$fg` / `$bg` / `$lw` 让同一份 IR 在不同主题、不同线宽下复用。 |
| 字段短名 | `t`、`d`、`s`、`h` 等单字母字段降低大文件体积。 |

---

## 2. 坐标系

- **Y 轴向下**，与 Canvas / SVG 一致。源格式是 Y 向上（如 CAD）时，解析方必须在输出前翻转。
- **角度单位是弧度**。在 Y 向下坐标系里，正角度表示**屏幕上顺时针**。
- **单位是抽象的"局部单位"**。顶层文档的单位就是渲染时 `viewport.scale = 1` 下的 1 个 CSS 像素；共享几何内部使用自己的坐标系，经 `ref.m` 变换到外层。

### 2.1 矩阵

```ts
type Matrix = [a, b, c, d, e, f];
// x' = a·x + c·y + e
// y' = b·x + d·y + f
```

顺序与 Canvas `ctx.transform(a, b, c, d, e, f)` 和 SVG `matrix(a b c d e f)` 完全相同，可直接传入，不需要转换。

`@drawir/core` 提供的矩阵工具：

| 函数 | 作用 |
| --- | --- |
| `IDENTITY` | 单位矩阵 |
| `translateMatrix(x, y)` / `scaleMatrix(sx, sy?)` / `rotateMatrix(rad)` | 基础变换 |
| `multiplyMatrix(m1, m2)` | `m1 · m2`，**先应用 m2，再应用 m1** |
| `composeMatrix(m1, m2, ...)` | 按数组顺序依次应用（更直观） |
| `invertMatrix(m)` | 逆矩阵，不可逆返回 `undefined` |
| `applyMatrix(m, x, y)` | 变换点 |
| `applyMatrixToVector(m, x, y)` | 变换方向（忽略平移） |
| `matrixScale(m)` | 平均缩放 `sqrt(|det|)`，用于线宽、字号换算 |
| `isSimilarity(m)` | 是否为相似变换（旋转 + 等比缩放 + 镜像） |
| `transformBox(m, box)` | 变换包围盒后取外接矩形 |

示例：先缩放 2 倍，再旋转 90°，再平移到 (100, 50)：

```ts
const m = composeMatrix(scaleMatrix(2), rotateMatrix(Math.PI / 2), translateMatrix(100, 50));
```

---

## 3. 顶层结构：VectorDocument

```ts
interface VectorGeom {
  bbox: VectorBox;          // 本几何坐标系中的范围
  items: VectorItem[];      // 绘制项，按数组顺序绘制（后者覆盖前者）
}

interface VectorDocument extends VectorGeom {
  vectors?: Record<string, VectorGeom>;  // 共享几何表，供 ref 引用
  width?: number;           // 页面宽度（可选）
  height?: number;          // 页面高度（可选）
  color?: string;           // '$fg' 的缺省颜色
  background?: string;      // '$bg' 的缺省颜色，同时是页面背景
  lineWidth?: number;       // '$lw' 的缺省线宽
  lineDash?: number[];      // 缺省虚线
  [key: string]: any;       // 解析方可附加元数据（stats、layers、pageList…）
}

interface VectorBox { x: number; y: number; width: number; height: number }
```

要点：

- `bbox` 是**必填**的，渲染方用它做"适应画布"。用 `createGeom(items, resolve)` 可自动计算。
- `width` / `height` 同时存在时，渲染方的 `fit` 以 `(0, 0, width, height)` 为内容区域，否则以 `bbox` 为准。
- 解析方可以在文档上挂任意额外字段（如 DXF 的 `stats`、`layers`，Visio 的 `pageList`），渲染方必须忽略不认识的字段。

---

## 4. 四种绘制项

`items` 只有四种，用 `t` 字段区分：

| `t` | 类型 | 用途 |
| --- | --- | --- |
| `'p'` | `VectorPathItem` | 路径：线、多边形、曲线、圆、椭圆… |
| `'t'` | `VectorTextItem` | 文字 |
| `'h'` | `VectorHatchItem` | 图案填充（平行线族裁剪到边界内） |
| `'r'` | `VectorRefItem` | 引用 `vectors` 中的共享几何 |

### 4.1 路径 `'p'`

```ts
interface VectorPathItem {
  t: 'p';
  d: VectorPathData;   // 扁平指令数组
  s?: VectorStyle;     // 样式，缺省时只描边、用前景色
}
```

#### 路径指令 `d`

`d` 是 `number[]`，每条指令 = 操作码 + 参数，依次拼接：

| 操作码 | 名称 | 长度 | 格式 | 对应 Canvas |
| --- | --- | --- | --- | --- |
| `0` | Move | 3 | `0, x, y` | `moveTo` |
| `1` | Line | 3 | `1, x, y` | `lineTo` |
| `2` | Cubic | 7 | `2, x1, y1, x2, y2, x, y` | `bezierCurveTo` |
| `3` | Quad | 5 | `3, x1, y1, x, y` | `quadraticCurveTo` |
| `4` | Close | 1 | `4` | `closePath` |
| `5` | Ellipse | 9 | `5, cx, cy, rx, ry, rotation, start, end, acw` | `ellipse` |

`VectorOp` 枚举与 `VectorOpSize = [3, 3, 7, 5, 1, 9]` 在 core 中导出，遍历时用 `i += VectorOpSize[op]` 前进。遇到未知操作码应**停止解析该路径**（官方渲染器均如此）。

**Ellipse 语义与 Canvas `ellipse()` 完全一致**：

- `rotation` 为椭圆长轴旋转（弧度），`start` / `end` 为椭圆**参数角**（不是极角）。
- `acw` 为 `1` 表示逆时针（角度递减），`0` 为顺时针（角度递增）。
- 扫角规则：顺时针时 `end - start ≥ 2π` 画整圆，否则取 `(0, 2π)` 内等价值；逆时针对称。工具函数 `ellipseSweep(start, end, acw)` 实现了这一规则。
- 约定：Ellipse 前面应总有一条 Move/Line 到达弧的起点（`VectorPathBuilder.ellipse()` 会自动处理）。若当前点与起点不同，Canvas 会自动连一条直线。

示例——一个矩形和一个整圆：

```ts
// 矩形 (0,0)-(100,50)
const rect = [0, 0, 0,  1, 100, 0,  1, 100, 50,  1, 0, 50,  4];

// 圆心 (50,50)，半径 20
const circle = [0, 70, 50,  5, 50, 50, 20, 20, 0, 0, Math.PI * 2, 0];
```

#### 样式 `s`

```ts
interface VectorStyle {
  stroke?: VectorColor;      // 描边色，缺省 = 前景色
  fill?: VectorColor;        // 填充色，缺省 = 不填充
  lw?: number | '$lw';       // 局部单位线宽，随缩放变化
  px?: number;               // 屏幕像素线宽下限，不随缩放变化
  dash?: number[];           // 虚线（局部单位），[实, 虚, 实, 虚…]
  cap?: 'butt' | 'round' | 'square';
  join?: 'bevel' | 'round' | 'miter';
  rule?: 'nonzero' | 'evenodd';   // 填充规则
  alpha?: number;            // 0~1 整体不透明度
}
```

线宽语义（渲染方必须遵守）：

| 写法 | 含义 |
| --- | --- |
| 不写 `lw` | "细线"，渲染为 1 个屏幕像素（或文档 `lineWidth`，取较大者），缩放时保持细线。CAD 的 0 线宽就是这种。 |
| `lw: 2` | 2 个局部单位，放大时变粗。 |
| `lw: '$lw'` | 跟随文档/调用方的 `lineWidth`，单位是**屏幕像素**；`lineWidth` 为 0 时不描边。 |
| `px: 3` | 至少 3 个屏幕像素，与 `lw` 取大者。 |

想要"只填充不描边"：`{ fill: '#f00', stroke: 'none' }`。

### 4.2 文字 `'t'`

```ts
interface VectorTextItem {
  t: 't';
  text: string;      // 可含 '\n' 手动换行
  x: number; y: number;   // 锚点（局部坐标）
  h: number;         // 字高 = 字号（局部单位）
  r?: number;        // 旋转弧度，正值顺时针
  w?: number;        // 宽度因子，缺省 1（<1 变窄，>1 变宽）
  bw?: number;       // 定宽换行框宽度（含宽度因子），设置后自动换行
  m?: 1;             // 镜像：字形沿基线上下翻转
  a?: 'left' | 'right' | 'center' | 'start' | 'end';     // 水平对齐，缺省 left
  b?: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom'; // 垂直基线，缺省 alphabetic
  lh?: number;       // 行高倍数，缺省 1.25
  font?: string;     // CSS font-family，缺省 'Arial, sans-serif'
  bold?: boolean;
  italic?: boolean;
  fill?: VectorColor;  // 文字颜色，缺省 '$fg'
}
```

文字的局部绘制变换为：`translate(x, y) → rotate(r) → scale(w, m ? -1 : 1)`，然后以 `(0, 0)` 为锚点按 `a`、`b` 对齐绘制。

多行规则：

- 行由 `textItemLines(item)` 计算：先按 `\n` 拆段，若有 `bw` 再按 `bw / w` 自动折行（中日韩字符逐字可断，连续 ASCII 不拆）。**渲染方必须用这个函数**，否则与包围盒不一致。
- 行距 = `lh * h`。第 0 行在 `y = 0`；`b = 'middle'` 时整体上移 `(n-1)·行距/2`；`b = 'bottom' | 'ideographic'` 时上移 `(n-1)·行距`。

由于解析期无法测量真实字形，`textItemBox` 用字符类别估算宽度（CJK = 1h，大写/数字 = 0.7h，其他 0.55h，空格 0.35h）。

### 4.3 图案填充 `'h'`

```ts
interface VectorHatchItem {
  t: 'h';
  d: VectorPathData;        // 边界，多个闭合环，按 evenodd 得到孔洞
  lines: VectorHatchLine[]; // 若干组平行线族
  stroke?: VectorColor;     // 图案线颜色，缺省 '$fg'
}

interface VectorHatchLine {
  a: number;            // 线方向角（弧度）
  x: number; y: number; // 线族中一条线经过的点
  dx: number; dy: number; // 相邻两条线之间的平移向量
  dash?: number[];      // 正数=实线段，负数=间隙，0=点
}
```

- 第 `i` 条线经过 `(x + i·dx, y + i·dy)`，方向 `(cos a, sin a)`，无限延伸后裁剪到边界内。
- `dx, dy` 在法向上的投影是线间距；在线方向上的投影是相邻线的错位（形成砖墙、点阵等图案）。
- **实心填充不要用 hatch**，用带 `fill` 的路径项即可。
- 注意 hatch 的 `dash` 与路径 `dash` 格式不同：路径用 Canvas 格式（全正数交替），hatch 用 CAD 格式（符号区分实/虚）。

示例——45° 斜线，间距 10：

```ts
{
  t: 'h',
  d: [0, 0, 0, 1, 100, 0, 1, 100, 100, 1, 0, 100, 4],
  lines: [{ a: Math.PI / 4, x: 0, y: 0, dx: -10 * Math.SQRT1_2, dy: 10 * Math.SQRT1_2 }],
}
```

### 4.4 引用 `'r'`

```ts
interface VectorRefItem {
  t: 'r';
  id: string;          // vectors 中的键
  m: VectorMatrix;     // 定义坐标 → 当前坐标
  c?: VectorColor;     // 本次引用中 '$fg' 的取值
}
```

- 绘制时：`save → transform(m) → 绘制 vectors[id].items → restore`。
- 引用可以嵌套（共享几何内部再引用别的共享几何），渲染方需设深度上限（官方为 24）防止循环。
- `id` 不存在时静默跳过。
- `c` 用于 CAD 的"随块（BYBLOCK）"颜色：块内写 `'$fg'` 的元素，在这次引用中显示为 `c`。

---

## 5. 颜色与动态取值

`VectorColor` 是字符串：

| 值 | 含义 |
| --- | --- |
| 任意 CSS 颜色 | 固定颜色，如 `'#1890ff'`、`'rgba(0,0,0,.5)'`、`'red'` |
| `'$fg'` | 前景色。取值优先级：最近一层 `ref.c` > 渲染参数 `color` > `doc.color` > `#000000` |
| `'$bg'` | 背景色。取值：渲染参数 `background` > `doc.background`；都没有时**不绘制** |
| `'none'` | 不绘制 |

另外渲染参数 `tint: true` 会把所有固定颜色也统一替换为前景色（用于高亮、单色预览）。

缺省值汇总：

| 字段 | 缺省 |
| --- | --- |
| 路径 `stroke` | 前景色 |
| 路径 `fill` | 不填充 |
| 文字 `fill` | 前景色 |
| 图案 `stroke` | 前景色 |

---

## 6. 包围盒

每个 `VectorGeom`（文档本身和 `vectors` 里的每一项）都要有正确的 `bbox`：

- 路径：精确曲线极值（三次/二次贝塞尔极值、椭圆弧极值）；数字 `lw` 会外扩 `lw/2`。
- 文字：按 `textItemBox` 估算的旋转外接框。
- 图案：边界路径的范围。
- 引用：`transformBox(ref.m, vectors[id].bbox)`。

**不要手算**，使用：

```ts
const geom = createGeom(items, (id) => vectors[id]);
// 或单独计算
const bbox = computeItemsBox(items, (id) => vectors[id]);
```

注意：计算含引用的 bbox 前，被引用的共享几何必须已经存在于 `vectors` 中。

---

## 7. 从零手写一份 IR

### 7.1 最小文档

```json
{
  "bbox": { "x": 0, "y": 0, "width": 100, "height": 50 },
  "items": [
    { "t": "p", "d": [0, 0, 0, 1, 100, 0, 1, 100, 50, 1, 0, 50, 4] }
  ]
}
```

这是一个黑色细线矩形。

### 7.2 使用构建工具

```ts
import { VectorPathBuilder, createGeom, pathItem, type VectorDocument } from 'drawir';

const box = new VectorPathBuilder()
  .moveTo(0, 0).lineTo(120, 0).lineTo(120, 70).lineTo(0, 70).close();

const geom = createGeom([
  pathItem(box.d, { stroke: '$fg', fill: '$bg', lw: '$lw' }),
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
```

同一份 `doc` 渲染时传入 `{ color: '#f5222d' }` 即可整体换色，无需修改 IR。

### 7.3 共享几何与引用

```ts
import { composeMatrix, rotateMatrix, translateMatrix, createGeom, pathItem, type VectorItem } from 'drawir';

// 定义一个以原点为中心的"螺栓"符号
const bolt = createGeom([
  pathItem([0, 8, 0, 5, 0, 0, 8, 8, 0, 0, Math.PI * 2, 0], { stroke: '$fg' }),
  pathItem([0, -8, 0, 1, 8, 0, 0, 0, -8, 1, 0, 8], { stroke: '$fg' }),
]);
const vectors = { bolt };

const items: VectorItem[] = [
  { t: 'r', id: 'bolt', m: translateMatrix(20, 20) },                 // 默认前景色
  { t: 'r', id: 'bolt', m: translateMatrix(60, 20), c: '#f5222d' },   // 红色
  { t: 'r', id: 'bolt', m: composeMatrix(rotateMatrix(Math.PI / 4), translateMatrix(100, 20)) },
];

const doc = { ...createGeom(items, (id) => vectors[id]), vectors };
```

### 7.4 对已有项做变换

`transformItem(item, m)` 和 `transformPathData(d, m)` 会把一个项"烘焙"到新坐标系：线宽、虚线、字号按 `matrixScale(m)` 缩放；椭圆在相似变换下解析变换，非等比缩放时自动转成贝塞尔；文字的旋转、宽度因子、镜像会正确更新。

---

## 8. 合法性检查清单

一份合法的 IR 应满足：

- [ ] 所有坐标、尺寸为有限数（非 `NaN` / `Infinity`）。
- [ ] 路径 `d` 按 `VectorOpSize` 能被完整切分，以 Move 开头。
- [ ] 椭圆 `rx`、`ry` > 0。
- [ ] 文字 `h` > 0，`text` 非空。
- [ ] `ref.id` 在 `vectors` 中存在，引用链无环。
- [ ] 每个 `VectorGeom` 的 `bbox` 与内容一致（由 `createGeom` 生成）。
- [ ] 颜色只使用 CSS 颜色、`$fg`、`$bg`、`none`。
- [ ] 整个文档可被 `JSON.stringify` 往返。

---

## 9. 速查表

```
VectorDocument
├─ bbox {x,y,width,height}
├─ items[]
│   ├─ {t:'p', d:number[], s?:{stroke,fill,lw,px,dash,cap,join,rule,alpha}}
│   ├─ {t:'t', text, x, y, h, r?, w?, bw?, m?, a?, b?, lh?, font?, bold?, italic?, fill?}
│   ├─ {t:'h', d:number[], lines:[{a,x,y,dx,dy,dash?}], stroke?}
│   └─ {t:'r', id, m:[a,b,c,d,e,f], c?}
├─ vectors? {id: {bbox, items[]}}
├─ width?, height?
└─ color?($fg), background?($bg), lineWidth?($lw), lineDash?

路径指令: 0 M x y | 1 L x y | 2 C x1 y1 x2 y2 x y | 3 Q x1 y1 x y | 4 Z
         5 E cx cy rx ry rot start end acw
```
