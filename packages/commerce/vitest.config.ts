import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The buyer tests seal and gift-wrap orders and statuses (NIP-44, Schnorr):
    // quick locally, but a CI runner shared with other packages needs longer.
    testTimeout: 30_000,
  },
});
