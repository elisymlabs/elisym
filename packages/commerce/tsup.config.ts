import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    buyer: 'src/buyer/index.ts',
    // The merchant's webhook receiver: WebCrypto only, nothing else of the protocol.
    webhook: 'src/webhook/index.ts',
  },
  // ESM only: @noble 2.x ships no CommonJS, and every consumer - the checkout
  // iframe, the merchant node, the buyer MCP - is ESM.
  format: ['esm'],
  dts: true,
  // One copy of the shared protocol code for both entries.
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
