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
  },
});
