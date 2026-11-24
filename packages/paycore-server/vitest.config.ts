import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@merchant-node': fileURLToPath(new URL('../merchant-node/src', import.meta.url)),
      // Test only: the hosted admin's browser client, driven against the real admin API.
      '@hosted-admin': fileURLToPath(new URL('../merchant-admin/src/hosted/lib', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
  },
});
