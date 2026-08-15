import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = process.env.SERVER_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Use the shared package's sources so edits hot-reload without a build.
      '@earnings/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/events': { target, changeOrigin: true },
      '/debug': { target, changeOrigin: true },
      '/health': { target, changeOrigin: true },
      '/meta': { target, changeOrigin: true },
      // SSE: no buffering, and a long timeout so the stream is not cut short.
      '/live_events': { target, changeOrigin: true, timeout: 0, proxyTimeout: 0 },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
