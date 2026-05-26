import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    node: 'src/node.ts',
    'agent-store': 'src/agent-store/index.ts',
    runtime: 'src/runtime/index.ts',
    skills: 'src/skills/index.ts',
    'llm-health': 'src/llm-health/index.ts',
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
    '@solana/kit',
    '@solana-program/system',
    'decimal.js-light',
    'yaml',
    'zod',
    // Native napi addon, optionalDependency, loaded via dynamic import in
    // transport/iroh.ts (node-only). Never bundle it.
    '@number0/iroh',
    'node:crypto',
    'node:buffer',
    'node:fs',
    'node:fs/promises',
    'node:os',
    'node:path',
  ],
  noExternal: ['@elisym/config-client'],
});
