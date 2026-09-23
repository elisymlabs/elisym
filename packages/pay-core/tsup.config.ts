import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    evm: 'src/evm/index.ts',
    internal: 'src/internal.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  // One copy of every module across the entries: `./internal` resets the same
  // caches the root entry reads.
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: [
    '@solana/kit',
    '@solana-program/memo',
    '@solana-program/system',
    '@solana-program/token',
    'decimal.js-light',
    'zod',
  ],
  noExternal: ['@elisym/config-client'],
});
