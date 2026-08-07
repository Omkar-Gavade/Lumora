import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Route-level React.lazy does the splitting (docs/02-frontend.md §8).
    // No manualChunks: naming an entry package does not pull in its internal
    // modules, which silently left react-dom in the main chunk and made the
    // vendor chunk look 3x smaller than it was.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // zod + resolvers are only reachable from auth routes; keeping them
          // out of `vendor` stops the marketing entry paying for them.
          if (/[\\/]node_modules[\\/](zod|@hookform|react-hook-form)[\\/]/.test(id)) {
            return 'forms';
          }
          return 'vendor';
        },
      },
    },
  },
});
