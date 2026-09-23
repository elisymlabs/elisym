import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    evm: 'src/evm/index.ts',
    internal: 'src/internal.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
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
