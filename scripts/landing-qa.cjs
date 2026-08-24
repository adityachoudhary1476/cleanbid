/**
 * landing-qa.cjs — DOM-level smoke test for the new landing page.
 * Loads the BUILT shell (dist/index.html) in jsdom with scripts enabled,
 * then asserts structure, handlers, links, FAQ behavior, and metadata.
 * Usage: node scripts/landing-qa.cjs
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');

// Virtual console: collect errors instead of dying on them
const problems = [];
const { VirtualConsole } = require('jsdom');
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  // resource loads (fonts, module scripts) will fail offline — record but classify
  problems.push('resource: ' + (e.message || String(e)).slice(0, 140));
});
vc.on('error', (m) => problems.push('console.error: ' + String(m).slice(0, 200)));

const dom = new JSDOM(html, {
  url: 'https://cleanbid-phi.vercel.app/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;
const doc = window.document;

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name); }
}

// jsdom runs inline scripts synchronously during parse; give microtasks a beat.
setTimeout(() => {
  // --- Structure -----------------------------------------------------
  t('nav renders', !!doc.querySelector('.lnav'));
  t('hero headline present', /Quote the building/.test(doc.querySelector('.lhero h1')?.textContent || ''));
  t('primary CTA exists', !!doc.querySelector('.lhero .btn-hero'));
  t('secondary CTA anchors to #how', doc.querySelector('.lhero .btn-hero-o')?.getAttribute('href') === '#how');
  t('browser mockup present', !!doc.querySelector('.mock-pricecard'));
  t('workflow has 5 steps', doc.querySelectorAll('.flow-step').length === 5);
  t('sample estimate section tagged as sample', /Sample data/.test(doc.querySelector('#sample .sample-tag')?.textContent || ''));
  t('engine figures shown ($19,040)', /19,040/.test(doc.querySelector('#sample')?.textContent || ''));
  t('before/after grid present', !!doc.querySelector('.ba-grid'));
  t('5 outcome cards', doc.querySelectorAll('.out-card').length === 5);
  t('3 who-it-is-for cards', doc.querySelectorAll('.for-card').length === 3);
  t('proof placeholder present (no fake logos)', !!doc.querySelector('.proof-slot'));
  t('pricing panel says Custom quoted', /Custom quoted/.test(doc.querySelector('.price-panel')?.textContent || ''));
  t('FAQ has 8 questions', doc.querySelectorAll('.faq').length === 8);
  t('final CTA present', !!doc.querySelector('.finalcta'));
  t('footer legal links', [...doc.querySelectorAll('.lfoot a[href^="/legal/"]')].length >= 3);

  // --- No fake proof anywhere -----------------------------------------
  const text = doc.body.textContent || '';
  t('no "500+ companies" style claims', !/\b\d+\+ (companies|customers|teams)/i.test(text));
  t('no testimonial quotes fabricated', !/"(Love|Amazing|Best software)/i.test(text));
  t('no SOC2/security-cert claims', !/SOC\s?2/i.test(text));

  // --- v1.0 removed from public view ----------------------------------
  const loginView = doc.querySelector('#view-login');
  t('v1.0 absent from landing markup', !(loginView?.textContent || '').includes('v1.0'));

  // --- Handlers defined -------------------------------------------------
  for (const fn of ['enterDemo', 'showAuthForms', 'toggleLandingNav', 'closeLandingNav']) {
    t(`window.${fn} defined`, typeof window[fn] === 'function');
  }

  // --- FAQ interaction ----------------------------------------------------
  const q = doc.querySelector('.faq-q');
  q.click();
  t('FAQ expands on click', doc.querySelector('.faq').classList.contains('open'));
  t('aria-expanded toggled', q.getAttribute('aria-expanded') === 'true');

  // --- Auth modal opens (sign-in path intact) -----------------------------
  window.showAuthForms();
  t('sign-in modal opens', !doc.getElementById('authForms').classList.contains('hidden'));
  t('sign-in form visible', !doc.getElementById('signinForm').classList.contains('hidden'));

  // --- Metadata ------------------------------------------------------------
  t('title updated', /Commercial Cleaning Estimating Software/.test(doc.title));
  t('meta description present', !!doc.querySelector('meta[name="description"][content]'));
  t('canonical link', !!doc.querySelector('link[rel="canonical"]'));
  t('og tags', !!doc.querySelector('meta[property="og:title"]'));

  // --- Console errors (excluding expected offline resources) ----------------
  const realErrors = problems.filter(p => !/^resource:/i.test(p));
  t('no JS runtime errors (' + realErrors.length + ')', realErrors.length === 0);
  if (realErrors.length) console.log(realErrors.slice(0, 10).join('\n'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 300);
