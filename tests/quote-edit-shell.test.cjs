/* Regression test for the pre-production audit fixes, against the REAL app shell.
 *
 * Loads 03-app-shell.html's inline (classic) <script> into a vm sandbox, then
 * drives the actual openEditQuote / commitQuoteEdit / closeEditQuote /
 * eqAddonToggle / eqAddonChange functions to prove:
 *   C1 — two rapid commitQuoteEdit() calls consume quota EXACTLY once
 *        (the synchronous _editSaving guard prevents the double-click bug).
 *   C2 — toggling/changing an add-on while editing does NOT mutate the saved
 *        quote's add-ons; cancel (closeEditQuote) leaves them byte-for-byte
 *        unchanged.
 *
 * The module-script imports (window.__cleanbid_*) are injected as mocks so the
 * classic script's calls resolve. Pricing is stubbed deterministically; this
 * test targets the save/guard/cancel behaviour, not the engine (covered in the
 * .mjs suite).
 *
 * Run with:  node tests/quote-edit-shell.test.cjs
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(__dirname + '/../03-app-shell.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { _s: new Set(),
      add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
      toggle(c,f){ f===undefined ? (this._s.has(c)?this._s.delete(c):this._s.add(c)) : (f?this._s.add(c):this._s.delete(c)); return this._s.has(c); },
      contains(c){return this._s.has(c);} },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, remove(){}, focus(){},
    querySelector(){return null;}, querySelectorAll(){return [];},
    getAttribute(){return null;}, setAttribute(){},
  };
}
const els = {};
const documentStub = {
  getElementById: (id) => (els[id] = els[id] || makeEl(id)),
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener(){}, body: makeEl('body'),
  documentElement: Object.assign(makeEl('html'), { style: { setProperty(){} } }),
  createElement: (t) => makeEl('dyn-' + t),
};

// --- injected mocks (stand in for the module-script globals) ---
let consumeCalls = 0;
let lastConsumedState = null;
const quoteedit = {
  recalculateQuote: () => ({ ok: true, calc: { costPerVisit: 100, monthly: 1000, annual: 12000, targetMargin: 25, visitCleaners: 4, visitCrewHours: 10, monthlyVisits: 8.7 }, discountPct: 0, finalMonthly: 1000, finalAnnual: 12000, error: null }),
  applyEditToQuote: (q, fields) => {
    return { ok: true, quote: { ...q, monthly: 1000, annual: 12000, version: (q.version||1)+1,
      addons: (fields.addons||q.addons).map(a=>({...a})), editHistory: [...(q.editHistory||[]), { at: 'now', version: (q.version||1)+1 }] } };
  },
  quotePriceFields: () => ({}),
};

const sandbox = {
  console: { log(){}, error(){}, warn(){} },
  document: documentStub,
  localStorage: { _m:{}, getItem(k){return k in this._m?this._m[k]:null;}, setItem(k,v){this._m[k]=String(v);}, removeItem(k){delete this._m[k];}, clear(){this._m={};} },
  Date, Math, JSON, Number, String, Array, Object, RegExp, Boolean,
  parseFloat, parseInt, isNaN, Error, Set, Map, structuredClone,
  setTimeout, clearTimeout, setInterval, clearInterval,
  confirm: () => true, prompt: () => null, alert: () => {}, scrollTo(){},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){} });

// module-provided globals the classic script reads
sandbox.window.__cleanbid_quoteedit = quoteedit;
sandbox.window.__cleanbid_quotacore = { validateEditFields: () => ({}) };
sandbox.window.__cleanbid_quota = {
  getQuota: async () => ({ ok: true, used: 0, quota: 10, remaining: 10, exhausted: false }),
  consumeEdit: async (st) => { consumeCalls++; lastConsumedState = st; return { ok: true, quota: { used: consumeCalls, quota: 10, remaining: 10 - consumeCalls } }; },
};
// saveStateToDb / renderQuotes / etc. are bare globals the classic script defines or calls
sandbox.saveStateToDb = async () => {};
sandbox.renderQuotes = () => {};
sandbox.renderDash = () => {};
sandbox.renderQuotaCard = async () => {};
sandbox.toast = () => {};
sandbox.openModal = () => {};
sandbox.closeModal = () => {};
sandbox.eqRefreshQuotaUi = async () => {};

vm.createContext(sandbox);
vm.runInContext(script, sandbox);

const run = (expr) => vm.runInContext(expr, sandbox);
const runAsync = async (expr) => await vm.runInContext(expr, sandbox);

let pass = 0, fail = 0;
function check(name, cond){ if(cond){pass++;console.log('  PASS', name);} else {fail++;console.log('  FAIL', name);} }

(async () => {
  // Seed a quote with add-ons via the in-context `state` (so lexical `state` resolves).
  const addons = [{ id:'ad-win', name:'Window', method:'sqft', value:0.04, enabled:true },
                  { id:'ad-floor', name:'Floor', method:'sqft', value:0.08, enabled:false }];
  const seededQuote = { id:'Q-TEST', workspaceId:'ws-1', propertyName:'Westbrook', companyName:'Acme',
    sqft:50000, type:'office', frequency:2, package:'professional', cleaners:4, hoursPerVisit:10,
    monthly:4000, annual:48000, margin:25, status:'sent', version:1,
    versions:[{v:1,total:4000,monthly:4000,annual:48000}],
    priceSnap:{wage:18,burden:15,overhead:12,margin:25,minPrice:800,supplies:8},
    productivitySnap:{office:2800}, addons };
  run(`state.quotes = ${JSON.stringify([seededQuote])}`);

  // ---------- C2: open edit, toggle an add-on, CANCEL, assert original unchanged ----------
  run(`openEditQuote('Q-TEST')`);
  run(`eqAddonToggle('ad-win', { textContent:'', style:{} })`);
  run(`eqAddonChange('ad-floor', '0.99')`);
  run(`closeEditQuote()`); // cancel

  const afterCancel = JSON.parse(run(`JSON.stringify(state.quotes.find(q=>q.id==='Q-TEST'))`));
  check('C2: cancel leaves original add-on enabled state untouched', afterCancel.addons[0].enabled === true);
  check('C2: cancel leaves original add-on value untouched', afterCancel.addons[0].value === 0.04);
  check('C2: cancel leaves second add-on value untouched', afterCancel.addons[1].value === 0.08);
  check('C2: cancel leaves add-ons array reference stable', afterCancel.addons.length === 2);

  // ---------- C2: open, modify, SAVE, assert modifications persisted ----------
  consumeCalls = 0;
  run(`openEditQuote('Q-TEST')`);
  run(`eqAddonToggle('ad-win', { textContent:'', style:{} })`);       // turn off
  run(`eqAddonChange('ad-floor', '0.99')`);                            // change value
  await runAsync(`commitQuoteEdit()`);
  const afterSave = JSON.parse(run(`JSON.stringify(state.quotes.find(q=>q.id==='Q-TEST'))`));
  check('C2: save persists add-on toggle', afterSave.addons[0].enabled === false);
  check('C2: save persists add-on value change', afterSave.addons[1].value === 0.99);
  check('C2: save bumped version exactly once', afterSave.version === 2);

  // ---------- C1: two rapid commitQuoteEdit() calls -> exactly one consume ----------
  run(`openEditQuote('Q-TEST')`); // resets _editSaving/_editConsumed
  consumeCalls = 0;
  const p1 = runAsync(`commitQuoteEdit()`); // first call: sets _editSaving synchronously
  const p2 = runAsync(`commitQuoteEdit()`); // second synchronous call: must be blocked by guard
  await Promise.all([p1, p2]);
  check('C1: quota consumed exactly once across two rapid saves', consumeCalls === 1);
  check('C1: only one new revision created (version 3)', JSON.parse(run(`JSON.stringify(state.quotes.find(q=>q.id==='Q-TEST').version)`)) === 3);

  // ---------- C1: guard resets after completion (next save allowed, consumes once) ----------
  run(`openEditQuote('Q-TEST')`);
  consumeCalls = 0;
  await runAsync(`commitQuoteEdit()`);
  check('C1: subsequent save after reset consumes exactly once', consumeCalls === 1);

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
