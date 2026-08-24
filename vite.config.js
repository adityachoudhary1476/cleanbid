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

/**
 * Legal pages are linked without extensions (/legal/privacy, /legal/, …).
 * Vercel (cleanUrls) and Netlify (_redirects) resolve those in production;
 * this plugin gives `vite dev` and `vite preview` the same mapping so a
 * policy URL can be opened or refreshed directly during development.
 */
const LEGAL_SLUGS = ['privacy', 'terms', 'disclaimer', 'cookies', 'refunds', 'acceptable-use'];
function legalCleanUrls() {
  const handler = (req, res, next) => {
    const [path] = req.url.split('?');
    let target = null;
    if (path === '/legal' || path === '/legal/') {
      target = '/legal/index.html';
    } else {
      const m = /^\/legal\/([a-z-]+)$/.exec(path);
      if (m && LEGAL_SLUGS.includes(m[1])) target = `/legal/${m[1]}.html`;
    }
    if (target) req.url = target;
    next();
  };
  return {
    name: 'legal-clean-urls',
    // 'pre' is required: Vite's SPA html-fallback middleware would otherwise
    // rewrite bare /legal to /index.html (the app stub) before we run.
    enforce: 'pre',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [emitRootIndex(), legalCleanUrls()],
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: './03-app-shell.html',
        legalIndex: resolve(process.cwd(), 'legal', 'index.html'),
        legalPrivacy: resolve(process.cwd(), 'legal', 'privacy.html'),
        legalTerms: resolve(process.cwd(), 'legal', 'terms.html'),
        legalDisclaimer: resolve(process.cwd(), 'legal', 'disclaimer.html'),
        legalCookies: resolve(process.cwd(), 'legal', 'cookies.html'),
        legalRefunds: resolve(process.cwd(), 'legal', 'refunds.html'),
        legalAcceptableUse: resolve(process.cwd(), 'legal', 'acceptable-use.html'),
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
