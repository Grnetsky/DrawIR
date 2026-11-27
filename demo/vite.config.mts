import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const packageSource = (path: string) => resolve(import.meta.dirname, '../packages', path);

export default defineConfig({
  resolve: {
    alias: {
      '@drawir/core': packageSource('core/src/index.ts'),
      '@drawir/parser-dxf': packageSource('parser/dxf/src/index.ts'),
      '@drawir/parser-visio': packageSource('parser/visio/src/index.ts'),
      '@drawir/parser-drawio': packageSource('parser/drawio/src/index.ts'),
      '@drawir/parser-figma': packageSource('parser/figma/src/index.ts'),
      '@drawir/parser-sketch': packageSource('parser/sketch/src/index.ts'),
      '@drawir/parser-svg': packageSource('parser/svg/src/index.ts'),
      '@drawir/parser-sym': packageSource('parser/sym/src/index.ts'),
      '@drawir/parser-gencad': packageSource('parser/gencad/src/index.ts'),
      '@drawir/parser-mermaid': packageSource('parser/mermaid/src/index.ts'),
      '@drawir/render-core': packageSource('render/core/src/index.ts'),
      '@drawir/render-canvas': packageSource('render/canvas/src/index.ts'),
      '@drawir/render-svg': packageSource('render/svg/src/index.ts'),
      '@drawir/render-html': packageSource('render/html/src/index.ts'),
      '@drawir/render-meta2d': packageSource('render/meta2d/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
