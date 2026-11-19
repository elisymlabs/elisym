import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // The library: the chat client, card resolution and the element, for the e2e harness and tests.
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    tsconfig: 'tsconfig.build.json',
    dts: true,
    sourcemap: true,
    clean: false,
    treeshake: true,
  },
  {
    // `widget.js`, the one script a store embeds: self-contained, no globals but the element.
    entry: { widget: 'src/widget.ts' },
    format: ['iife'],
    tsconfig: 'tsconfig.build.json',
    platform: 'browser',
    target: ['chrome100', 'edge100', 'firefox100', 'safari16'],
    noExternal: [/.*/],
    minify: true,
    sourcemap: true,
    clean: false,
    treeshake: true,
    outExtension: () => ({ js: '.js' }),
  },
]);
