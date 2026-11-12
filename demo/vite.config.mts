import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const packageSource = (path: string) => resolve(import.meta.dirname, '../packages', path);

export default defineConfig({
  resolve: {
    alias: {
      '@drawir/core': packageSource('core/src/index.ts'),
      '@drawir/parser-dxf': packageSource('parser/dxf/src/index.ts'),
      '@drawir/parser-visio': packageSource('parser/visio/src/index.ts'),
      '@drawir/render-core': packageSource('render/core/src/index.ts'),
      '@drawir/render-canvas': packageSource('render/canvas/src/index.ts'),
      '@drawir/render-svg': packageSource('render/svg/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
