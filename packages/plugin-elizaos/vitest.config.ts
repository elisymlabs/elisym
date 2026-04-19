import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/unit/**/*.test.ts', '__tests__/integration/**/*.test.ts'],
    globals: false,
    environment: 'node',
  },
});
