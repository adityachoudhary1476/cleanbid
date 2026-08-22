import { defineConfig } from 'vite';

export default defineConfig({
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
    open: '/03-app-shell.html',
  },
  test: {
    globals: true,
    environment: 'node',
    // Only collect the ES-module suite; the root *.test.cjs files are run
    // directly with `node` (they call process.exit and are not vitest specs).
    include: ['tests/**/*.{test,spec}.{js,mjs}'],
  },
});
