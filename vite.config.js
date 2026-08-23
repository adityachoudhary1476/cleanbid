import { defineConfig } from 'vite';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Vercel serves "/" from dist/index.html, but the app shell is
 * 03-app-shell.html (root index.html is only a dev redirect stub).
 * After the normal build, copy the built shell to dist/index.html so the
 * deployed site renders the app at "/". Single source of truth is kept:
 * 03-app-shell.html is never duplicated in the repo.
 */
function emitRootIndex() {
  return {
    name: 'emit-root-index',
    apply: 'build',
    closeBundle() {
      const built = resolve(process.cwd(), 'dist', '03-app-shell.html');
      try {
        copyFileSync(built, resolve(process.cwd(), 'dist', 'index.html'));
        console.log('[emit-root-index] dist/index.html written from built shell');
      } catch (err) {
        throw new Error(`[emit-root-index] Failed to write dist/index.html: ${err.message}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [emitRootIndex()],
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: './03-app-shell.html',
      },
    },
  },
  server: {
    port: 3000,
    host: true,
    open: '/',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,mjs}'],
  },
  base: '/',
});
