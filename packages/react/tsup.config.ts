import { defineConfig } from 'tsup';

const shared = {
  format: ['esm', 'cjs'] as const,
  dts: true,
  sourcemap: true,
  external: ['react'],
};

// No `clean` here: the two builds share `dist/`, and a cleaning build's declaration
// step deletes every `.d.ts`, including the other build's. The build script empties `dist/` first.
export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    // The component runs effects: a React Server Components app must render it on the client.
    banner: { js: "'use client';" },
  },
  {
    // Plain values, usable anywhere (a Server Component, a CSP header): no client directive.
    ...shared,
    entry: { constants: 'src/constants.ts' },
  },
]);
