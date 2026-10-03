import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Several tests seal and gift-wrap dozens of orders (NIP-44, Schnorr): quick
    // locally, but a CI runner shared with the other packages' tests needs longer.
    testTimeout: 30_000,
  },
});
