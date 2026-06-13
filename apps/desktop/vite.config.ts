import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite config for the Tauri webview frontend.
// The dev server is pinned to the port Tauri expects (tauri.conf.json devUrl =
// http://localhost:1420) so `tauri dev` and the standalone webview agree.
// `envDir` points at the repo root so the desktop reads VITE_API_BASE_URL from
// the single root .env (only VITE_-prefixed vars are exposed to the client).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envDir: '../../',
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
