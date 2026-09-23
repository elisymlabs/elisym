import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  // ESM only: @noble 2.x ships no CommonJS, and every consumer - the checkout
  // iframe, the merchant node, the buyer MCP - is ESM.
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
