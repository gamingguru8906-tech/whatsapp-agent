import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Production build -> dist/ (served by the Worker; readings come from /api/reading).
// Preview build (VITE_LOCAL_ENGINE=1) -> dist-preview/, one file, with the engine bundled in, for an owner-only preview.
export default defineConfig(({ mode }) => {
  const preview = process.env.VITE_LOCAL_ENGINE === '1';
  return {
    root: 'web',
    plugins: [react()],
    build: {
      outDir: preview ? '../dist-preview' : '../dist',
      emptyOutDir: true,
      assetsInlineLimit: preview ? 100000000 : 4096,
      rollupOptions: preview ? { output: { inlineDynamicImports: true } } : {}
    },
    server: { proxy: { '/api': 'http://localhost:8787' } }
  };
});
