import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  treeshake: true,
  // `@merchant-node/*` (tsconfig paths) is bundled; every package it imports stays external.
});
