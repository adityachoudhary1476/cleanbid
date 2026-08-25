import { defineConfig } from 'vite';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
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
    // Vite 6: `closeBundle` can fire before the HTML asset is flushed to
    // disk (and `emptyOutDir` runs around the same time), so the copied
    // source is occasionally missing and the deploy build fails. Use
    // `writeBundle`, which runs AFTER all assets are written to dist.
    writeBundle() {
      const src = resolve(process.cwd(), 'dist', '03-app-shell.html');
      const dst = resolve(process.cwd(), 'dist', 'index.html');
      if (!existsSync(src)) {
        // Fallback: the entry HTML may have been emitted under a hashed or
        // transformed name. Find any *.html that references the app shell.
        const dir = resolve(process.cwd(), 'dist');
        const candidates = readdirSync(dir).filter((f) => f.endsWith('.html'));
        if (candidates.length === 1 && candidates[0] !== 'index.html') {
          copyFileSync(resolve(dir, candidates[0]), dst);
          console.log('[emit-root-index] dist/index.html written from', candidates[0]);
          return;
        }
        throw new Error('[emit-root-index] could not locate built shell (dist/03-app-shell.html missing)');
      }
      copyFileSync(src, dst);
      console.log('[emit-root-index] dist/index.html written from built shell');
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
