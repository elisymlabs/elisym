import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    node: 'src/node.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: [
    'nostr-tools',
    'nostr-tools/nip44',
    '@solana/web3.js',
    'decimal.js-light',
    'node:crypto',
    'node:buffer',
  ],
});
