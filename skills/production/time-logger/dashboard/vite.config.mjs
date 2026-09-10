import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev mode proxies data + feedback to the local store server (server.mjs).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/data': 'http://localhost:4680',
      '/api': 'http://localhost:4680',
    },
  },
});
