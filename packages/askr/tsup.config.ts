import { defineConfig } from 'tsup';

export default defineConfig({
  // `chat` alone for the widget bundle (4.1): wraps and message schemas, nothing of sync or config.
  entry: { index: 'src/index.ts', chat: 'src/chat/index.ts' },
  splitting: true,
  // ESM only, like @elisym/commerce: the widget, the agent and the server are all ESM.
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
