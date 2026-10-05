import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each DOM test opts into happy-dom; the server-render test runs with no DOM at all.
    environment: 'node',
    environmentOptions: {
      happyDOM: {
        settings: {
          // The injected loader must never be fetched from pay.elisym.network in a test.
          disableJavaScriptFileLoading: true,
          // ...quietly: a skipped script loads as if it ran (it defines nothing).
          handleDisabledFileLoadingAsSuccess: true,
          disableIframePageLoading: true,
        },
      },
    },
    include: ['tests/**/*.test.ts'],
  },
});
