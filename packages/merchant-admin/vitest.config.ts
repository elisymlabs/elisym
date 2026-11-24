import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { ALIASES, DEDUPE } from './vite.config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: ALIASES,
    dedupe: DEDUPE,
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Unwrapping gift wraps is crypto-heavy on a shared CI runner.
    testTimeout: 30_000,
  },
});
