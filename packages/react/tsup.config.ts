import { defineConfig } from 'tsup';

const shared = {
  format: ['esm', 'cjs'] as const,
  dts: true,
  sourcemap: true,
  external: ['react'],
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    clean: true,
    // The component runs effects: a React Server Components app must render it on the client.
    banner: { js: "'use client';" },
  },
  {
    // Plain values, usable anywhere (a Server Component, a CSP header): no client directive.
    ...shared,
    entry: { constants: 'src/constants.ts' },
  },
]);
