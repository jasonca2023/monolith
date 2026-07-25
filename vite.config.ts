import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: path.join(__dirname, 'renderer'),
  // Electron loads the built bundle over file://, which cannot resolve the
  // absolute /assets/* URLs Vite emits by default.
  base: './',
  plugins: [react()],
  css: {
    // The Vite root is renderer/, but the PostCSS and Tailwind configs live at
    // the repo root alongside package.json.
    postcss: __dirname,
  },
  build: {
    outDir: path.join(__dirname, 'dist', 'renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
