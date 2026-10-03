import { copyFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

/** The admin page's static files, copied next to its bundle. */
const ADMIN_STATIC_FILES = ['index.html', 'admin.css'];

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node22',
    splitting: false,
    sourcemap: true,
    // The build script empties `dist` once: a per-entry clean would delete the other entry.
    clean: false,
    treeshake: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: { app: 'src/admin/app.ts' },
    outDir: 'dist/admin',
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    // One self-contained file: the admin server serves nothing else.
    noExternal: [/.*/],
    splitting: false,
    sourcemap: false,
    minify: true,
    clean: false,
    treeshake: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    onSuccess: async () => {
      for (const file of ADMIN_STATIC_FILES) {
        copyFileSync(`src/admin/${file}`, `dist/admin/${file}`);
      }
    },
  },
]);
