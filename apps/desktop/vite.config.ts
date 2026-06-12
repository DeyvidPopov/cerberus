import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite config for the Tauri webview frontend.
// The Tauri-specific dev server settings (fixed port, IPC) are finalised when
// the Tauri runtime is wired in Phase 1.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
