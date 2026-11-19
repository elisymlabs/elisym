import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Gift wraps are two NIP-44 rounds and three Schnorr checks each.
    testTimeout: 30_000,
  },
});
