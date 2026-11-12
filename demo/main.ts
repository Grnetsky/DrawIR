import {
  CanvasRenderer,
  VectorPathBuilder,
  createGeom,
  fitViewport,
  parseDxf,
  parseVisio,
  pathItem,
} from '../src';
import type { VectorDocument, VectorItem, Viewport } from '../src';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

function rectangle(x: number, y: number, width: number, height: number) {
  return new VectorPathBuilder()
    .moveTo(x, y)
    .lineTo(x + width, y)
    .lineTo(x + width, y + height)
    .lineTo(x, y + height)
    .close().d;
}

function createSample(): VectorDocument {
  const marker = createGeom([
    pathItem(rectangle(0, 0, 24, 24), { stroke: '#2372d8', fill: '#e8f2ff', lw: 1.5 }),
    pathItem([0, 12, 0, 1, 24, 12, 0, 12, 24, 1, 0, 12], { stroke: '#2372d8', lw: 1 }),
  ]);
  const curves = new VectorPathBuilder()
    .moveTo(82, 398)
    .cubicTo(230, 290, 340, 500, 490, 380)
    .cubicTo(610, 286, 720, 408, 850, 315);
  const ellipse = new VectorPathBuilder().ellipse(730, 175, 92, 62, -0.15, 0, Math.PI * 2);
  const items: VectorItem[] = [
    pathItem(rectangle(34, 32, 892, 526), { stroke: '#dbe3ed', fill: '#ffffff', lw: 1 }),
    pathItem(rectangle(82, 98, 350, 190), { stroke: '#2372d8', fill: '#eaf3ff', lw: 2 }),
    pathItem(ellipse.d, { stroke: '#5c4cc4', fill: '#efedff', lw: 2 }),
    {
      t: 'h',
      d: rectangle(520, 370, 330, 108),
      stroke: '#75a4d8',
      lines: [{ a: Math.PI / 4, x: 520, y: 370, dx: -12, dy: 12 }],
    },
    pathItem(curves.d, { stroke: '#23a783', lw: 3, cap: 'round' }),
    { t: 'r', id: 'marker', m: [1, 0, 0, 1, 466, 92] },
    { t: 'r', id: 'marker', m: [1, 0, 0, 1, 466, 132] },
    { t: 'r', id: 'marker', m: [1, 0, 0, 1, 466, 172] },
    { t: 't', text: '统一矢量中间表示', x: 257, y: 178, h: 26, a: 'center', b: 'middle', fill: '#173c68', bold: true },
    { t: 't', text: 'DXF  /  VSDX  →  Vector IR', x: 257, y: 218, h: 13, a: 'center', b: 'middle', fill: '#6684a6' },
    { t: 't', text: 'ELLIPSE', x: 730, y: 179, h: 15, a: 'center', b: 'middle', fill: '#5c4cc4', bold: true },
    { t: 't', text: 'HATCH', x: 685, y: 428, h: 15, a: 'center', b: 'middle', fill: '#41688f' },
    { t: 't', text: 'path · text · hatch · ref', x: 82, y: 525, h: 12, fill: '#8a99ac', font: 'monospace' },
  ];
  const vectors = { marker };
  return {
    ...createGeom(items, (id) => vectors[id as keyof typeof vectors]),
    vectors,
    width: 960,
    height: 600,
    color: '#24364d',
    background: '#f5f7fa',
    lineWidth: 1,
  };
}

const canvas = element<HTMLCanvasElement>('canvas');
const fileInput = element<HTMLInputElement>('file-input');
const dropZone = element<HTMLDivElement>('drop-zone');
const renderer = new CanvasRenderer(canvas, { autoResize: true });
let currentDocument = createSample();
let currentView: Viewport | undefined;
let dragging = false;
let dragX = 0;
let dragY = 0;

function draw(fit = false) {
  if (fit || !currentView) {
    currentView = fitViewport(currentDocument, canvas.clientWidth, canvas.clientHeight, 30);
  }
  renderer.render(currentDocument, { viewport: currentView });
  element('zoom-reset').textContent = `${Math.round(currentView.scale * 100)}%`;
}

function updateInfo(source: string, fileName: string) {
  element('source').textContent = source;
  element('file-name').textContent = fileName;
  element('item-count').textContent = currentDocument.items.length.toLocaleString();
  element('vector-count').textContent = Object.keys(currentDocument.vectors || {}).length.toLocaleString();
  const ms = currentDocument.stats?.ms;
  element('parse-time').textContent = typeof ms === 'number' ? `${ms} ms` : '—';
}

function showError(error: unknown) {
  const status = element('status');
  status.textContent = error instanceof Error ? error.message : String(error);
  status.classList.add('error');
}

async function openFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const status = element('status');
  try {
    status.classList.remove('error');
    status.textContent = `正在解析 ${file.name}…`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (extension === 'dxf') {
      currentDocument = await parseDxf(bytes);
      updateInfo('DXF', file.name);
    } else if (extension === 'vsdx') {
      currentDocument = await parseVisio(bytes, { pageBorder: true });
      updateInfo('Visio VSDX', file.name);
    } else {
      throw new Error('请选择 .dxf 或 .vsdx 文件');
    }
    const errors = currentDocument.stats?.errors?.length || 0;
    status.textContent = errors ? `已打开，${errors} 条内容未能解析` : '解析完成';
    draw(true);
  } catch (error) {
    showError(error);
  }
}

function zoomAt(factor: number, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
  if (!currentView) return;
  const scale = Math.max(0.02, Math.min(100, currentView.scale * factor));
  const worldX = (x - currentView.x) / currentView.scale;
  const worldY = (y - currentView.y) / currentView.scale;
  currentView = { scale, x: x - worldX * scale, y: y - worldY * scale };
  draw();
}

element('open-file').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
  fileInput.value = '';
});
element('load-sample').addEventListener('click', () => {
  currentDocument = createSample();
  updateInfo('内置示例', 'sample.drawir');
  const status = element('status');
  status.classList.remove('error');
  status.textContent = '已加载内置示例';
  draw(true);
});
element('zoom-in').addEventListener('click', () => zoomAt(1.2));
element('zoom-out').addEventListener('click', () => zoomAt(1 / 1.2));
element('zoom-reset').addEventListener('click', () => {
  currentView = { scale: 1, x: 0, y: 0 };
  draw();
});
element('fit').addEventListener('click', () => draw(true));

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const bounds = canvas.getBoundingClientRect();
  zoomAt(event.deltaY > 0 ? 0.9 : 1.1, event.clientX - bounds.left, event.clientY - bounds.top);
}, { passive: false });
canvas.addEventListener('pointerdown', (event) => {
  dragging = true;
  dragX = event.clientX;
  dragY = event.clientY;
  canvas.classList.add('dragging');
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (!dragging || !currentView) return;
  currentView.x += event.clientX - dragX;
  currentView.y += event.clientY - dragY;
  dragX = event.clientX;
  dragY = event.clientY;
  draw();
});
const stopDragging = () => {
  dragging = false;
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', stopDragging);
canvas.addEventListener('pointercancel', stopDragging);

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragover');
  });
}
dropZone.addEventListener('dragleave', (event) => {
  if (!dropZone.contains(event.relatedTarget as Node | null)) dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragover');
  const file = event.dataTransfer?.files[0];
  if (file) void openFile(file);
});

new ResizeObserver(() => draw()).observe(canvas);
updateInfo('内置示例', 'sample.drawir');
requestAnimationFrame(() => draw(true));
