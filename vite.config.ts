import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: { output: { entryFileNames: 'assets/game.js', assetFileNames: 'assets/[name][extname]', inlineDynamicImports: true } },
  },
  server: { host: true },
});
