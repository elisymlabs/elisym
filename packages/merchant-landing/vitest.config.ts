import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: {
        settings: {
          // The widget loader must never be fetched from pay.elisym.network in a test.
          disableJavaScriptFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
          disableIframePageLoading: true,
        },
      },
    },
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
