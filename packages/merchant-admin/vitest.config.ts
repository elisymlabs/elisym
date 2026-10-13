import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { ADMIN_CORE_DIR, DEDUPE } from './vite.config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@merchant-admin-core': ADMIN_CORE_DIR },
    dedupe: DEDUPE,
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Unwrapping gift wraps is crypto-heavy on a shared CI runner.
    testTimeout: 30_000,
  },
});
