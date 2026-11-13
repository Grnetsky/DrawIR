# 解析方实现指南：如何把一种文件格式转换成 Vector IR

**解析方**负责把某种源文件（DXF、VSDX，或你要接入的新格式，如 SVG、PDF、EMF…）转换为 `VectorDocument`。解析方**不绘制任何东西**，也不依赖 DOM 或任何渲染器。

IR 字段的完整语义见 [IR 教程](./ir-spec.md)。参考实现：

- `packages/parser/dxf`（`@drawir/parser-dxf`）
- `packages/parser/visio`（`@drawir/parser-visio`）
- `packages/parser/drawio`（`@drawir/parser-drawio`）
- `packages/parser/figma`（`@drawir/parser-figma`）

---

## 1. 职责边界

| 解析方应该做 | 解析方不应该做 |
| --- | --- |
| 读取、解码源文件（编码、压缩包、XML…） | 操作 DOM、Canvas、SVG 元素 |
| 把源格式的几何、样式、文字转成 IR 项 | 测量真实字宽、加载字体 |
| 坐标系转换（Y 翻转、单位换算、页面布局） | 关心视口、缩放、像素比 |
| 把块 / 母版 / 符号转成共享几何 + 引用 | 引入编辑器概念（选中、图层开关状态…） |
| 计算每个几何的包围盒 | 把位图塞进 IR（IR 是纯矢量） |
| 统计不支持的特性、记录错误 | 遇到单个坏图元就整体失败 |

---

## 2. 必须提供的 API

按现有包的约定，一个解析包至少导出以下内容：

```ts
// 1. 选项
export interface XxxParseOptions { /* 格式特有选项 */ }

// 2. 输出文档：在 VectorDocument 上扩展元数据
export interface XxxDocument extends VectorDocument {
  stats: XxxParseStats;
  // 其他元数据，如 layers、pageList
}

// 3. 统计信息
export interface XxxParseStats {
  unsupported: Record<string, number>; // 跳过的特性 → 次数
  errors: string[];                    // 单个图元的错误，不中断整体解析
  ms: number;                          // 耗时
  // 格式相关计数…
}

// 4. 异步入口：接受多种输入
export async function parseXxx(
  input: string | ArrayBuffer | Uint8Array | Blob,
  options?: XxxParseOptions,
): Promise<XxxDocument>;

// 5. 同步入口：输入已在内存中（方便在 Worker 中直接调用）
export function parseXxxSync(data: string | Uint8Array, options?: XxxParseOptions): XxxDocument;

// 6. 转换器类（可选导出，便于高级定制）
export class XxxToVector {
  constructor(options?: XxxParseOptions);
  convert(source: unknown): XxxDocument;
}
```

对照：

| 格式 | 异步 | 同步 | 转换器 |
| --- | --- | --- | --- |
| DXF | `parseDxf(input, opts)` | `parseDxfSync(text, opts)` | `DxfToVector` |
| VSDX | `parseVisio(input, opts)` | `parseVisioSync(bytes, opts)` | `VisioToIR` |
| draw.io | `parseDrawio(input, opts)` | `parseDrawioSync(textOrBytes, opts)` | `DrawioToIR` |
| Figma | `parseFigma(input, opts)` | `parseFigmaSync(bytes, opts)` | `FigmaToIR` |

`Blob` 输入用 `await blob.arrayBuffer()` 读取即可，这在浏览器、Worker、Node 18+ 中都可用。

---

## 3. 新建解析包

```
packages/parser/xxx/
├─ package.json      # name: @drawir/parser-xxx，dependencies: "@drawir/core": "workspace:*"
├─ tsconfig.json     # 参照 packages/parser/dxf/tsconfig.json，references 指向 core
└─ src/
   ├─ index.ts       # 公共入口：parseXxx / parseXxxSync / 类型导出
   ├─ types.ts       # Options / Stats / Document
   └─ parser.ts      # XxxToVector 转换器
```

然后：

1. 在根 `package.json` 的 `build` / `clean` 脚本里加入 `packages/parser/xxx`；
2. 在根 `package.json` 的 `dependencies` 里加入 `"@drawir/parser-xxx": "workspace:*"`；
3. 在 `src/index.ts` 中 `export * from '@drawir/parser-xxx';`。

---

## 4. 转换流程

推荐的整体流程（DXF、Visio 都遵循这个结构）：

```
读取输入 ──► 源格式解析（得到源对象树）
          ──► 读取全局表（样式、线型、颜色主题、图层…）
          ──► 遍历图元，逐个 emit 为 IR 项（块/母版 → vectors + ref）
          ──► 计算内容范围，确定世界矩阵（翻转、缩放、平移）
          ──► createGeom(items, resolve) 计算包围盒
          ──► 组装 VectorDocument + 元数据 + stats
```

### 4.1 骨架代码

```ts
import {
  createGeom, pathItem, VectorPathBuilder, composeMatrix, scaleMatrix, translateMatrix,
  type VectorGeom, type VectorItem, type VectorMatrix,
} from '@drawir/core';

export class XxxToVector {
  private vectors: Record<string, VectorGeom> = {};
  private nextId = 0;
  stats!: XxxParseStats;

  constructor(private opts: XxxParseOptions = {}) {}

  convert(src: XxxSource): XxxDocument {
    const t0 = performance.now();
    this.stats = { unsupported: {}, errors: [], ms: 0 };

    // 源坐标 → IR 坐标（这里假设源格式 Y 轴向上，高度为 H）
    const world: VectorMatrix = composeMatrix(scaleMatrix(1, -1), translateMatrix(0, src.height));

    const items: VectorItem[] = [];
    for (const shape of src.shapes) {
      try {
        this.emit(shape, world, items);
      } catch (e: any) {
        this.stats.errors.push(`${shape.type}#${shape.id}: ${e?.message || e}`);
      }
    }

    const geom = createGeom(items, (id) => this.vectors[id]);
    this.stats.ms = Math.round(performance.now() - t0);
    return { ...geom, vectors: this.vectors, width: src.width, height: src.height, stats: this.stats };
  }

  private emit(shape: XxxShape, m: VectorMatrix, out: VectorItem[]) {
    switch (shape.type) {
      case 'line': {
        const b = new VectorPathBuilder(m).moveTo(shape.x1, shape.y1).lineTo(shape.x2, shape.y2);
        out.push(pathItem(b.d, this.style(shape)));
        break;
      }
      // ... 其他图元
      default:
        this.stats.unsupported[shape.type] = (this.stats.unsupported[shape.type] || 0) + 1;
    }
  }
}
```

---

## 5. 关键实现要点

### 5.1 坐标系：用 `VectorPathBuilder` 在源坐标系里画

`VectorPathBuilder(matrix)` 接受一个矩阵，你可以直接用**源格式自己的坐标**调用 `moveTo / lineTo / cubicTo / quadTo / ellipse / bulgeTo / polyline`，构建器会自动：

- 把每个点按矩阵变换到 IR 坐标；
- 相似变换下椭圆弧解析变换（镜像时自动翻转角度和方向）；
- 非等比变换下把椭圆弧离散成三次贝塞尔；
- `ellipse()` 自动补起点 Move（`connect = true` 时与当前点连线）。

常见的世界矩阵：

```ts
// CAD：Y 向上 → Y 向下，同时缩放到目标尺寸并把左上角移到 origin
// （见 DxfToVector.convert 中的 this.world）
const world = [scale, 0, 0, -scale, ox - minX * scale, oy + maxY * scale];

// Visio：英寸 → 输出单位（k = dpi × 绘图比例），按页面高度翻转，页面横向排布
// （见 VisioToIR 中的 pageToOutput；形状自身的 localMatrix（LocPin → 翻转 → 旋转 → Pin）先作用）
const pageToOutput = [k, 0, 0, -k, pageX, pageHeight * k];
```

**IR 里的弧度都按 Y 向下解释**。如果你绕过构建器直接写 `5, cx, cy, ...` 指令，记得自己处理翻转带来的角度取反和方向反转。

### 5.2 曲线

| 源格式曲线 | 推荐转换 |
| --- | --- |
| 圆、圆弧、椭圆弧 | `builder.ellipse(...)` |
| 多段线凸度（bulge） | `builder.bulgeTo(x, y, bulge, from)` / `bulgeToArc` |
| 三点圆弧 | `circleFrom3Points` 求圆心半径后 `ellipse` |
| NURBS / B 样条 | `sampleNurbs(input)` 采样后 `polyline` |
| 仅有拟合点的样条 | `catmullRomToCubics(points)` 后逐段 `cubicTo` |
| SVG 风格 arcTo | 先转成中心参数，再 `ellipse` |

这些函数都在 `@drawir/core` 中导出。

### 5.3 块 / 母版 / 符号 → 共享几何

源格式中被多次复用的定义（CAD BLOCK、Visio Master、SVG `<symbol>`）应该转成共享几何：

```ts
private blockGeom(name: string): string | undefined {
  if (this.blockIds.has(name)) return this.blockIds.get(name) ?? undefined;
  this.blockIds.set(name, null);              // 先占位，防止循环引用
  const items: VectorItem[] = [];
  const base = translateMatrix(-block.baseX, -block.baseY); // 定义坐标以基点为原点
  for (const e of block.entities) this.emit(e, base, items, /* inBlock */ true);
  if (!items.length) { this.blockIds.set(name, undefined); return undefined; }
  const id = `xxx-${(++this.nextId).toString(36)}`;
  this.vectors[id] = createGeom(items, (i) => this.vectors[i]);
  this.blockIds.set(name, id);
  return id;
}

private insert(e: Insert, m: VectorMatrix, out: VectorItem[]) {
  const id = this.blockGeom(e.name);
  if (!id) return;
  const local = composeMatrix(scaleMatrix(e.sx, e.sy), rotateMatrix(e.rot), translateMatrix(e.x, e.y));
  const ref: VectorItem = { t: 'r', id, m: multiplyMatrix(m, local) };
  if (e.color !== BYBLOCK) ref.c = e.color;  // 随块颜色
  out.push(ref);
}
```

要点：

- 共享几何内部使用**定义自身的坐标系**（不要乘世界矩阵），世界矩阵放在 `ref.m` 中。
- 先生成被引用的几何，再计算引用方的 bbox。
- 用"占位 + 缓存"防止递归块死循环。
- 如果复用的定义很小、每个实例样式差异很大（如 Visio 母版的每个实例都被覆盖了几何），直接展开成普通项也是合理的（Visio 解析器就是在解析期展开母版，`vectors` 为空）。

### 5.4 颜色

| 源格式概念 | IR 写法 |
| --- | --- |
| 固定颜色 | CSS 颜色字符串（`#rrggbb` / `rgba()`） |
| 随主题的前景色（如 CAD ACI 7 白/黑反色） | `'$fg'` |
| 随块颜色（BYBLOCK） | 块内写 `'$fg'`，在 `ref.c` 中给出实际颜色 |
| 填充成背景色 / 遮罩（wipeout） | `'$bg'` |
| 透明 / 不绘制 | `'none'` 或省略字段 |
| 半透明 | `rgba()` 或 `s.alpha` |

DXF 的 ACI 索引色、真彩色转换见 `packages/parser/dxf/src/colors.ts`；Visio 主题色、QuickStyle 解析见 `packages/parser/visio/src/theme.ts`。

### 5.5 线宽与线型

- 源格式线宽为 0 / "细线"：**不写 `lw`**，渲染方会画 1 像素细线。
- 物理线宽（mm、pt）：换算成 IR 局部单位后写 `lw`（要乘以你的世界缩放）。
- 想让线宽始终保持若干屏幕像素：写 `px`。
- 线型（虚线）：把 pattern 换算到 IR 单位，写成 Canvas 风格的正数交替数组 `dash: [实, 虚, ...]`。CAD 线型里的"点"（长度 0）在路径 dash 中可以用一个很小的正数代替。注意乘上全局线型比例（如 DXF `$LTSCALE`）。

### 5.6 文字

- 锚点、字高统一换算到 IR 坐标；旋转角注意 Y 翻转后要**取反**。
- CAD 文字的对齐方式映射到 `a`（水平）+ `b`（垂直），例如"中间中心"→ `a: 'center', b: 'middle'`。
- 宽度因子写 `w`；镜像文字写 `m: 1`。
- 带格式的富文本（如 MTEXT 控制码）应在解析期剥离为纯文本，并保留 `\n` 换行；有参考框宽度时写 `bw` 让渲染方自动折行。参考：`packages/parser/dxf/src/text.ts` 中的 `parseMText`。
- 若源格式中的文字已经经过变换矩阵，可以先在定义坐标系里构造 `VectorTextItem`，再用 `transformItem(item, m)` 烘焙变换。
- 解析期无法测量字形宽度，bbox 由 `textItemBox` 估算，这是允许的近似。

### 5.7 填充

- 实心填充：带 `fill` 的路径项，多环有孔洞时设置 `rule: 'evenodd'`。
- 渐变：IR 目前不支持，退化为主色实心填充，并在 `stats.unsupported` 中计数。
- 图案填充：转成 `VectorHatchItem`。每组线族给出方向角、基点、偏移向量和 CAD 风格的 dash（正 = 实线，负 = 间隙，0 = 点）。用 `transformHatchLine(m, line)` 把源坐标下的线族变换到 IR 坐标。

### 5.8 绘制顺序

`items` 的顺序就是绘制顺序。源格式有显式绘制次序（如 DXF 的 `SORTENTSTABLE`、遮罩需要放最底层）时，要在输出前排好序。参考：`packages/parser/dxf/src/sortents.ts`。

### 5.9 不支持的内容

- **位图**：跳过，并在 stats 中计数（Visio 的 `stats.images`）。
- **未知图元**：跳过，计入 `stats.unsupported[type]`。
- **单个图元出错**：`try/catch` 捕获，写入 `stats.errors`，继续处理下一个。
- **整个文件无法识别**：抛出带明确提示的 `Error`（如"旧版 .vsd 不支持，请另存为 .vsdx"）。

### 5.10 性能

- 路径直接写扁平数组，不要先构造对象再转换。
- 重复几何一定要走 `vectors` + `ref`，大型 CAD 图纸能节省一个数量级的体积。
- 解析器应能在 Web Worker 中运行：不访问 `window`、`document`；`performance` 不存在时回退到 `Date.now()`。
- 可选的"粒度"选项（如 DXF 的 `granularity: 'entity' | 'layer'`）：按图层合并可以减少项数量。

---

## 6. 自检清单

- [ ] 输出能 `JSON.stringify` 往返，能 `postMessage` 到 Worker。
- [ ] `bbox` 由 `createGeom` 生成，`vectors` 中每个几何也有 bbox。
- [ ] Y 方向正确：文字正向可读，圆弧方向正确。
- [ ] 镜像块 / 负缩放的块里，圆弧和文字没有画反。
- [ ] 在白底和黑底下（切换 `color` / `background`）都能看清。
- [ ] 用 Canvas 和 SVG 两个后端渲染结果一致（`pnpm dev` 打开 Demo，拖入文件切换后端）。
- [ ] 坏文件给出可读错误；部分坏图元不影响其他图元，错误进入 `stats.errors`。
- [ ] 不依赖 DOM，可在 Node 中跑通。

---

## 7. 最小可运行示例：一个玩具格式解析器

假设源格式是如下 JSON（Y 轴向上，单位毫米）：

```json
{ "height": 100, "shapes": [
  { "type": "rect", "x": 10, "y": 10, "w": 50, "h": 30, "color": "#f00" },
  { "type": "circle", "x": 80, "y": 50, "r": 15 },
  { "type": "label", "x": 35, "y": 25, "size": 6, "text": "Hi" }
] }
```

```ts
import {
  VectorPathBuilder, createGeom, pathItem, composeMatrix, scaleMatrix, translateMatrix,
  type VectorDocument, type VectorItem,
} from '@drawir/core';

export function parseToy(src: any): VectorDocument {
  const k = 4; // 1 mm = 4 单位
  const world = composeMatrix(scaleMatrix(k, -k), translateMatrix(0, src.height * k));
  const items: VectorItem[] = [];
  for (const s of src.shapes) {
    const b = new VectorPathBuilder(world);
    switch (s.type) {
      case 'rect':
        b.polyline([[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]], true);
        items.push(pathItem(b.d, { stroke: s.color ?? '$fg' }));
        break;
      case 'circle':
        b.ellipse(s.x, s.y, s.r, s.r, 0, 0, Math.PI * 2);
        items.push(pathItem(b.d));
        break;
      case 'label': {
        const [x, y] = [s.x * k, (src.height - s.y) * k];
        items.push({ t: 't', text: s.text, x, y, h: s.size * k, a: 'center', b: 'middle' });
        break;
      }
    }
  }
  return { ...createGeom(items), width: 100 * k, height: src.height * k };
}
```
