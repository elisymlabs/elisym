import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    target: 'es2022',
    sourcemap: false,
    // No inline `<script>` or data: modules: the CSP is `script-src 'self' https://pay.elisym.network`.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
