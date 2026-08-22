/* Workspace isolation — regression test against the REAL app shell.
 *
 * Loads 03-app-shell.html's inline script into a vm with a DOM/localStorage
 * stub, then drives the actual workspace-switching code paths
 * (selectWorkspace -> applyWorkspace -> loadStateFromDb) to prove that
 * stale workspace data cannot survive a switch.
 *
 * Run with:  node 05-workspace-isolation.test.cjs
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { pathToFileURL } = require('url');

const html = fs.readFileSync(__dirname + '/03-app-shell.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// ---- sandbox ---------------------------------------------------------------
function makeEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); return this._s.has(c); },
      contains(c) { return this._s.has(c); } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getAttribute() { return null; }, setAttribute() {},
  };
}
const els = {};
const documentStub = {
  getElementById: (id) => (els[id] = els[id] || makeEl(id)),
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, body: makeEl('body'),
  documentElement: Object.assign(makeEl('html'), { style: { setProperty() {} } }),
  createElement: (t) => makeEl('dyn-' + t),
};
const store = {};
const sandbox = {
  console: { log() {}, error() {}, warn() {} },
  document: documentStub,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }, clear: () => { for (const k in store) delete store[k]; } },
  Date, Math, JSON, Number, String, Array, Object, RegExp, Boolean,
  parseFloat, parseInt, isNaN, Error, Set, Map, structuredClone,
  setTimeout, clearTimeout, setInterval, clearInterval,
  confirm: () => true, prompt: () => null, alert: () => {}, scrollTo() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
vm.createContext(sandbox);

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}
const get = (expr) => vm.runInContext(expr, sandbox);
const call = async (expr) => await vm.runInContext(expr, sandbox);

(async () => {
  // Inject the canonical state-boundary helpers so the app uses the same
  // implementation that the vitest suite validates.
  const stateApi = await import(pathToFileURL(path.join(__dirname, 'src/state.js')).href);
  sandbox.__cleanbid_stateapi = stateApi;

  try {
    vm.runInContext(script, sandbox, { filename: 'shell.js' });
  } catch (e) {
    console.log('LOAD FAILED:', e.message);
    process.exit(1);
  }

  // Helper to populate the active workspace (in memory) and persist it.
  async function seedWorkspace(id, label) {
    await call(`selectWorkspace(${JSON.stringify(id)})`);
    const wage = (label === 'Alpha') ? 25 : 30;
    vm.runInContext(
      `state.customers.push({id:1,company:${JSON.stringify(label + ' Customer')}});` +
      `state.properties.push({id:1,customerId:1,name:${JSON.stringify(label + ' Property')}});` +
      `state.quotes.push({id:${JSON.stringify('Q-' + id)},customerId:1,propertyId:1,versions:[{v:1,total:100}]});` +
      `state.org.name=${JSON.stringify(label + ' Org')};` +
      `state.pricing.wage=${wage};`,
      sandbox
    );
    vm.runInContext('saveState();', sandbox);
  }

  // ===== 1. Switch A -> B -> A -> B isolation =====
  console.log('\n[1] Workspace switch isolation (A -> B -> A -> B)');
  await seedWorkspace('A', 'Alpha');
  await seedWorkspace('B', 'Beta');               // switch away from A
  // After switching to B, A must not be visible.
  check('B: Alpha customer absent', !get('state.customers.some(c=>c.company==="Alpha Customer")'));
  check('B: Alpha quote absent', !get('state.quotes.some(q=>q.id==="Q-A")'));
  check('B: Beta customer present', get('state.customers.some(c=>c.company==="Beta Customer")'));
  check('B: org is Beta', get('state.org.name') === 'Beta Org');
  check('B: pricing.wage is Beta own value (30, not Alpha 25)', get('state.pricing.wage') === 30);

  await call(`selectWorkspace("A")`);            // switch back to A
  check('A: Alpha customer present', get('state.customers.some(c=>c.company==="Alpha Customer")'));
  check('A: Alpha quote present', get('state.quotes.some(q=>q.id==="Q-A")'));
  check('A: Beta customer absent', !get('state.customers.some(c=>c.company==="Beta Customer")'));
  check('A: org is Alpha', get('state.org.name') === 'Alpha Org');

  await call(`selectWorkspace("B")`);            // switch to B again
  check('B(2): Beta customer present', get('state.customers.some(c=>c.company==="Beta Customer")'));
  check('B(2): Alpha customer absent', !get('state.customers.some(c=>c.company==="Alpha Customer")'));

  // ===== 2. Direct loads (no UI switch) =====
  console.log('\n[2] Direct loads');
  await call(`selectWorkspace("A")`);
  check('Direct A: only Alpha', get('state.customers.length') === 1 && get('state.customers[0].company') === 'Alpha Customer');
  await call(`selectWorkspace("B")`);
  check('Direct B: only Beta', get('state.customers.length') === 1 && get('state.customers[0].company') === 'Beta Customer');

  // ===== 3. Missing / empty / partial / malformed =====
  console.log('\n[3] Missing / empty / partial / malformed workspaces');
  await call(`selectWorkspace("WS-NEVER-SAVED")`);
  check('Missing workspace -> clean state', get('state.customers.length') === 0 && get('state.quotes.length') === 0);
  check('Missing workspace -> default pricing object', typeof get('state.pricing') === 'object' && get('state.pricing.wage') === 18);

  store['cleanbid_v3_PARTIAL'] = JSON.stringify({ customers: [{ id: 9, company: 'Partial Co' }] });
  await call(`selectWorkspace("PARTIAL")`);
  check('Partial: customers loaded', get('state.customers.length') === 1 && get('state.customers[0].company') === 'Partial Co');
  check('Partial: missing keys defaulted (quotes [])', get('state.quotes.length') === 0);

  store['cleanbid_v3_MALFORMED'] = JSON.stringify({ customers: 'not-an-array', pricing: 42, org: 'nope', quotes: null });
  await call(`selectWorkspace("MALFORMED")`);
  check('Malformed: customers -> default []', get('state.customers.length') === 0);
  check('Malformed: pricing -> default object', typeof get('state.pricing') === 'object' && get('state.pricing.wage') === 18);
  check('Malformed: org -> default object', typeof get('state.org') === 'object');
  check('Malformed: quotes -> default []', get('state.quotes.length') === 0);

  // ===== 4. Quote-version isolation through real load path =====
  console.log('\n[4] Quote/version isolation (revision + restore ops)');
  await seedWorkspace('A', 'Alpha');
  await call(`selectWorkspace("A")`);
  vm.runInContext('state.quotes[0].versions.push({v:2,total:200}); saveState();', sandbox); // revise A
  await call(`selectWorkspace("B")`);
  vm.runInContext('state.quotes[0].versions.push({v:2,total:300}); saveState();', sandbox); // revise B
  await call(`selectWorkspace("A")`);
  check('A version count preserved (2)', get('state.quotes[0].versions.length') === 2);
  check('A version has only its own totals (no B 300)', !get('state.quotes[0].versions.some(v=>v.total===300)'));
  // restore-like op on A, ensure B unaffected
  vm.runInContext('state.quotes[0].versions.push({v:3,total:111}); saveState();', sandbox);
  await call(`selectWorkspace("B")`);
  check('B version count still its own (2)', get('state.quotes[0].versions.length') === 2);
  check('B version unaffected by A restore (no 111)', !get('state.quotes[0].versions.some(v=>v.total===111)'));

  // ===== 5. Demo isolation (Demo -> A -> B) =====
  console.log('\n[5] Demo data isolation');
  await call(`enterDemo()`);
  check('Demo seeded (Westbrook present)', get('state.customers.some(c=>c.company && c.company.indexOf("Westbrook")===0)'));
  await call(`selectWorkspace("A")`);
  check('After Demo->A: Westbrook (demo) absent', !get('state.customers.some(c=>c.company && c.company.indexOf("Westbrook")===0)'));
  check('After Demo->A: A retains its OWN data (Alpha), not demo', get('state.customers.some(c=>c.company==="Alpha Customer")'));
  check('After Demo->A: A has no Beta either', !get('state.customers.some(c=>c.company==="Beta Customer")'));
  await call(`selectWorkspace("B")`);
  check('After A->B: still no demo residue', !get('state.customers.some(c=>c.company && c.company.indexOf("Westbrook")===0)'));
  check('After A->B: B retains its OWN data (Beta)', get('state.customers.some(c=>c.company==="Beta Customer")'));

  // ===== 6. No shared references between workspaces =====
  console.log('\n[6] No shared object references');
  await call(`selectWorkspace("A")`);
  vm.runInContext('state.customers.push({id:1,company:"RefCo"}); saveState();', sandbox);
  await call(`selectWorkspace("B")`);
  vm.runInContext('state.customers.push({id:2,company:"OtherCo"}); saveState();', sandbox);
  await call(`selectWorkspace("A")`);
  vm.runInContext('state.customers.push({id:99,company:"Mutated"});', sandbox); // mutate active copy
  await call(`selectWorkspace("B")`);
  check('B not polluted by A mutation', !get('state.customers.some(c=>c.company==="Mutated")'));

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('TEST HARNESS ERROR:', e && e.message);
  console.log(e && e.stack);
  process.exit(1);
});
