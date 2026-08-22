/* Data & Backups — export / restore regression test against the REAL app shell.
 *
 * Loads 03-app-shell.html's inline script into a vm with a DOM/localStorage/
 * File API stub, wires in the REAL src/state.js and src/backup.js modules
 * (same as the production module bootstrap), then drives the actual flows:
 *
 *   Module unit coverage (src/backup.js):
 *     - buildBackup shape, deep-clone, workspaceId exclusion
 *     - validateBackup rejection paths + warnings
 *     - applyBackup REPLACE semantics, defaults, reference isolation
 *     - full round-trip export -> file -> validate -> restore
 *
 *   Shell integration coverage (03-app-shell.html):
 *     - exportBackup downloads a well-named JSON blob + records timestamp
 *     - card counters render from live state
 *     - restore preview shows summary, hostile strings stay inert
 *     - invalid files are rejected with NO state changes
 *     - confirmed restore REPLACES all workspace keys, preserves context,
 *       logs activity, refreshes UI
 *
 * Run with:  node 06-backup-restore.test.cjs
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { pathToFileURL } = require('url');

const html = fs.readFileSync(__dirname + '/03-app-shell.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

// ---- DOM stubs --------------------------------------------------------------
function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    disabled: false, files: null,
    classList: { _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c))
                                 : (f ? this._s.add(c) : this._s.delete(c)); return this._s.has(c); },
      contains(c) { return this._s.has(c); } },
    listeners: {},
    addEventListener(t, f) { this.listeners[t] = f; }, removeEventListener() {},
    appendChild() {}, remove() {}, focus() {}, click() { el.clicked = true; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getAttribute() { return null; }, setAttribute() {},
  };
  return el;
}
const els = {};
const documentStub = {
  getElementById: (id) => (els[id] = els[id] || makeEl(id)),
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, body: makeEl('body'),
  documentElement: Object.assign(makeEl('html'), { style: { setProperty() {} } }),
  createElement: (t) => { const el = makeEl('dyn-' + t); els[el.id] = el; return el; },
};
const store = {};
class FileReaderStub {
  constructor() { this.result = ''; }
  readAsText(file) { this.result = file.__text || ''; const cb = this.onload; if (typeof cb === 'function') cb(); }
}
class BlobStub {
  constructor(parts, opts) { this.parts = parts; this.type = (opts && opts.type) || ''; this.size = parts.reduce((n, p) => n + String(p).length, 0); createdBlobs.push(this); }
}
let revoked = [];
const createdBlobs = [];
const urlMap = {};
const URLStub = { createObjectURL(b) { const u = 'blob:test-' + Math.random(); urlMap[u] = b; return u; }, revokeObjectURL(u) { revoked.push(u); } };

async function main() {
  // Real canonical modules, same objects the production bootstrap exposes.
  const stateMod = await import(pathToFileURL(path.join(__dirname, 'src', 'state.js')).href);
  const backupMod = await import(pathToFileURL(path.join(__dirname, 'src', 'backup.js')).href);

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    document: documentStub,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => delete store[k] },
    Date, Math, JSON, Number, String, Array, Object, RegExp, Boolean, Promise,
    parseFloat, parseInt, isNaN, Error, Set, Map, setTimeout, clearTimeout, setInterval, clearInterval,
    confirm: () => true, prompt: () => null, alert: () => {}, scrollTo() {},
    FileReader: FileReaderStub, Blob: BlobStub, URL: URLStub,
    __stateMod: stateMod, __backupMod: backupMod,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
  sandbox.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  vm.createContext(sandbox);

  let toasts = [];
  vm.runInContext(script, sandbox, { filename: 'app-shell-inline.js' });
  // Toast capture + module globals AFTER eval (toast is declared by the shell).
  vm.runInContext(`
    window.__cleanbid_backupapi = __backupMod;
    window.__cleanbid_stateapi = __stateMod;
    window.__cleanbid_db = { saveState(){}, loadState(){ return null; }, saveDemoState(){}, loadDemoState(){ return null; },
      setCurrentWorkspaceId(){}, getDbMode(){ return 'local'; }, flushSave(){} };
    window.toast = toast;
    toasts = [];
    window.__captureToast = (m,t)=>toasts.push({m,t});
  `, sandbox);
  // Route toast() output into our capture list without touching the shell.
  const origRunToast = () => {};
  toasts = [];
  vm.runInContext(`window.toast = function(m,t){ toasts.push({m:m,t:t}); };`, sandbox);
  const S = () => vm.runInContext('window.__cleanbid_state_proxy || state', sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  const getToasts = () => run('toasts');

  // ---- helpers --------------------------------------------------------------
  function freshState(seedOverrides) {
    run(`
      state.workspaceId = 'ws-test';
      state.org = { name:'Summit Office Cleaning', initial:'S', phone:'', email:'', web:'', address:'', tagline:'', footer:'', color:'#c46a3a', license:'', trust:'', workspaceId:'ws-test' };
      state.pricing = { wage:18, burden:15, overhead:12, margin:25, minPrice:800, supplies:8, contract:'12 months', payment:'Net 30', currency:'USD', units:'imperial', terms:'', productivity:{} };
      state.customers = [{ id:1, company:'Alpha Corp', contact:'A', email:'a@x.example', phone:'', address:'', notes:'', lastActivity:'' }];
      state.properties = [{ id:1, customerId:1, name:'Alpha Tower', address:'', type:'office', sqft:50, floors:3 }];
      state.quotes = [{ id:'Q-9001', customerId:1, propertyId:1, propertyName:'Alpha Tower', monthly:4200, status:'sent' }];
      state.activity = [{ avt:'JD', actor:'Jane', what:'opened', object:'CleanBid', time:'now' }];
      state.me = { name:'Jane Doe', email:'jane@x.example', role:'admin' };
    `);
  }

  console.log('\n== src/backup.js — buildBackup ==');
  {
    freshState();
    run(`__bk = __backupMod.buildBackup(state);`);
    check('marks payload as CleanBid backup', run('__bk.cleanbid_backup') === true);
    check('format version present', run('__bk.format') === 1);
    check('workspaceId excluded from data', run("Object.prototype.hasOwnProperty.call(__bk.data,'workspaceId')") === false);
    check('customers deep-cloned', JSON.stringify(run('__bk.data.customers')) === '[{"id":1,"company":"Alpha Corp","contact":"A","email":"a@x.example","phone":"","address":"","notes":"","lastActivity":""}]');
    check('counts reflect live records', run('__bk.counts.quotes') === 1 && run('__bk.counts.customers') === 1 && run('__bk.counts.properties') === 1);
    check('orgName carried for humans', run('__bk.orgName') === 'Summit Office Cleaning');
    check('exportedAt is ISO-ish', !Number.isNaN(Date.parse(run('__bk.exportedAt'))));
    check('global me never exported', run("Object.prototype.hasOwnProperty.call(__bk.data,'me')") === false);
    // mutation isolation
    run(`__bk.data.customers[0].company = 'MUTATED';`);
    check('mutating backup does not touch live state', run('state.customers[0].company') === 'Alpha Corp');
  }

  console.log('\n== src/backup.js — summarizeState ==');
  {
    check('summarizeState counts', JSON.stringify(backupMod.summarizeState({ customers: [1, 2], properties: [], quotes: [{}] })) === '{"customers":2,"properties":0,"quotes":1}');
    check('summarizeState tolerates missing keys', JSON.stringify(backupMod.summarizeState({})) === '{"customers":0,"properties":0,"quotes":0}');
  }

  console.log('\n== src/backup.js — validateBackup rejections ==');
  {
    let v = backupMod.validateBackup('not json {{{');
    check('rejects non-JSON text', v.ok === false && v.errors.length > 0 && v.parsed === null);
    v = backupMod.validateBackup('');
    check('rejects empty input', v.ok === false);
    v = backupMod.validateBackup({ hello: 1 });
    check('rejects foreign JSON without signature', v.ok === false && /signature|not an export/i.test(v.errors.join(' ')));
    v = backupMod.validateBackup({ cleanbid_backup: true, format: 99, data: {} });
    check('rejects unsupported format version', v.ok === false && /format/.test(v.errors.join(' ')));
    v = backupMod.validateBackup({ cleanbid_backup: true, format: 1 });
    check('rejects missing data payload', v.ok === false);
    v = backupMod.validateBackup({ cleanbid_backup: true, format: 1, data: { quotes: 'oops' } });
    check('flags corrupted section', v.ok === false && /quotes/.test(v.errors.join(' ')));
    v = backupMod.validateBackup({ cleanbid_backup: true, format: 1, exportedAt: '2030-01-01T00:00:00Z', data: { customers: [], properties: [], quotes: [] } });
    check('warns on future-dated empty backup', v.ok === true && v.warnings.length >= 2);
    v = backupMod.validateBackup({ cleanbid_backup: true, format: 1, data: { customers: [], properties: [], quotes: [] } });
    check('empty backup validates but warns it will clear', v.ok === true && v.warnings.some(w => /clear/i.test(w)));
  }

  console.log('\n== src/backup.js — applyBackup semantics ==');
  {
    const target = {
      workspaceId: 'ws-live',
      org: { name: 'Old Name' }, pricing: { wage: 1 }, profiles: [{ id: 'x' }],
      areaTypes: [], tasks: [], customers: [{ id: 7, company: 'Stale Customer' }],
      properties: [{ id: 7 }], quotes: [{ id: 'Q-OLD' }], addons: [], users: [], activity: [{ n: 1 }],
      me: { name: 'Keep Me' },
    };
    const data = {
      org: { name: 'Restored Co' }, pricing: { wage: 22 },
      customers: [{ id: 1, company: 'New Customer' }],
      properties: [], quotes: [{ id: 'Q-NEW' }],
      rogueKey: { evil: true },
      // profiles/areaTypes/tasks/addons/users/activity deliberately missing -> defaults
    };
    backupMod.applyBackup(target, data);
    check('REPLACES stale customer instead of merging', JSON.stringify(target.customers) === '[{"id":1,"company":"New Customer"}]');
    check('replaces quotes wholesale', JSON.stringify(target.quotes) === '[{"id":"Q-NEW"}]');
    check('active workspace context preserved', target.workspaceId === 'ws-live');
    check('unknown keys dropped', target.rogueKey === undefined);
    check('missing keys fall back to defaults (arrays)', Array.isArray(target.activity) && target.activity.length === 0);
    check('partial object merged onto default shape', typeof target.pricing === 'object' && target.pricing.wage === 22);
    check('global me untouched', target.me.name === 'Keep Me');
    check('throws on non-object state', (() => { try { backupMod.applyBackup(null, {}); return false; } catch (e) { return true; } })());
    // reference isolation both directions
    data.customers[0].company = 'Changed After Apply';
    check('no shared references after apply', target.customers[0].company === 'New Customer');
  }

  console.log('\n== Round trip: export -> file -> validate -> restore ==');
  {
    freshState();
    const exported = backupMod.buildBackup(stateMod.replaceWorkspaceState ? run('state') : run('state'));
    const fileText = JSON.stringify(exported, null, 2);
    // Wipe live data to simulate loss
    run(`state.customers=[]; state.properties=[]; state.quotes=[]; state.org={name:'Lost Everything'};`);
    const v = backupMod.validateBackup(fileText);
    check('round-trip file validates', v.ok === true);
    backupMod.applyBackup(run('state'), v.parsed.data);
    check('records fully recovered', run('state.quotes.length') === 1 && run('state.customers[0].company') === 'Alpha Corp');
    check('org restored verbatim', run('state.org.name') === 'Summit Office Cleaning');
    check('activity history recovered', run('state.activity.length') === 1);
  }

  console.log('\n== Shell: exportBackup() ==');
  {
    freshState();
    run('exportBackup()');
    const dyn = els['dyn-a'];
    check('download anchor created + clicked', !!dyn && dyn.clicked === true && !!dyn.href);
    check('filename follows cleanbid-backup-<slug>-<date>.json', /^cleanbid-backup-summit-office-cleaning-\d{4}-\d{2}-\d{2}\.json$/.test(dyn.download));
    const blob = urlMap[dyn.href];
    let blobJson = null;
    try { blobJson = JSON.parse(blob.parts[0]); } catch (e) {}
    check('payload is JSON with backup signature', !!blobJson && blobJson.cleanbid_backup === true && blobJson.data.quotes.length === 1);
    check('object URL created for download', !!dyn.href && dyn.href.startsWith('blob:'));
    check('last-export timestamp recorded per workspace', /^\d{4}-\d{2}-\d{2}T/.test(store['cleanbid_last_export_ws-test'] || ''));
    check('success toast shown', getToasts().some(t => t.t === 'success' && /backup downloaded/i.test(t.m)));
  }

  console.log('\n== Shell: card counters ==');
  {
    run(`renderDataBackups();`);
    check('customer count rendered', els['bkCountCust'] && els['bkCountCust'].textContent === '1');
    check('quote count rendered', els['bkCountQuote'] && els['bkCountQuote'].textContent === '1');
    check('last-export label appears once recorded', /last export/i.test(els['bkLastExport'].textContent));
    run(`state.customers=[]; state.properties=[]; state.quotes=[]; renderDataBackups();`);
    check('zero state renders zeros', els['bkCountQuote'].textContent === '0');
    freshState();
  }

  console.log('\n== Shell: restore preview (valid file) ==');
  {
    run(`openRestore();`);
    check('modal opens at step 1', els['restoreModal'].classList.contains('show') === true && els['rsStep2'].style.display === 'none');
    const goodBackup = JSON.stringify({
      cleanbid_backup: true, format: 1,
      exportedAt: '2026-08-20T10:00:00.000Z',
      orgName: 'Westbrook <img src=x onerror=alert(1)> Estates',
      counts: { customers: 2, properties: 3, quotes: 4 },
      data: {
        org: { name: 'Westbrook Estates' }, pricing: { wage: 21 }, profiles: [],
        areaTypes: [], tasks: [],
        customers: [{ id: 1, company: 'One' }, { id: 2, company: 'Two' }],
        properties: [{ id: 1 }, { id: 2 }, { id: 3 }],
        quotes: [{ id: 'Q-A' }, { id: 'Q-B' }, { id: 'Q-C' }, { id: 'Q-D' }],
        addons: [], users: [], activity: [],
      },
    });
    els['rsFile'].files = [{ __text: goodBackup }];
    els['rsFile'].listeners['change']();
    check('summary step shown', els['rsStep2'].style.display !== 'none');
    check('counts previewed from file', /<b>2<\/b> customers/.test(els['rsSummary'].innerHTML) && /<b>4<\/b> quotes/.test(els['rsSummary'].innerHTML));
    check('confirm button revealed', els['rsGo'].classList.contains('hidden') === false);
    check('hostile org name rendered inert', els['rsSummary'].innerHTML.includes('&lt;img') === true && els['rsSummary'].innerHTML.includes('<img') === false);
  }

  console.log('\n== Shell: restore commit ==');
  {
    const beforeWorkspace = run('state.workspaceId');
    els['rsGo'].listeners['click']();
    await new Promise(r => setTimeout(r, 30)); // let async commitRestore settle
    check('customers replaced from file', run('state.customers.length') === 2 && run('state.customers[0].company') === 'One');
    check('quotes replaced from file', run('state.quotes.length') === 4 && run('state.quotes[0].id') === 'Q-A');
    check('pricing replaced from file', run('state.pricing.wage') === 21);
    check('active workspace preserved', run('state.workspaceId') === beforeWorkspace);
    check('activity logged', run(`state.activity.some(a=>/restored workspace/.test(a.what))`) === true);
    check('modal closed after success', els['restoreModal'].classList.contains('show') === false);
    check('success toast shown', getToasts().some(t => t.t === 'success' && /restored/i.test(t.m)));
  }

  console.log('\n== Shell: invalid file rejected with NO side effects ==');
  {
    freshState();
    run(`openRestore();`);
    const snapBefore = run(`JSON.stringify({c:state.customers,q:state.quotes,o:state.org})`);
    els['rsFile'].files = [{ __text: '{"this":"is some random json"}' }];
    els['rsFile'].listeners['change']();
    check('errors listed in modal', /✕/.test(els['rsErrors'].innerHTML));
    check('confirm button stays hidden', els['rsGo'].classList.contains('hidden') === true);
    check('recovery hint shown', /No changes were made/i.test(els['rsSummary'].innerHTML));
    els['rsGo'].listeners['click'](); // user cannot proceed; clicking must be a no-op
    await new Promise(r => setTimeout(r, 10));
    check('state untouched after forced click', run(`JSON.stringify({c:state.customers,q:state.quotes,o:state.org})`) === snapBefore);
    // garbage bytes
    els['rsFile'].files = [{ __text: '\x00\x01not-json' }];
    els['rsFile'].listeners['change']();
    check('non-JSON rejected', /valid JSON/i.test(els['rsErrors'].innerHTML));
  }

  console.log('\n== Shell: reopen resets previous attempt ==');
  {
    run(`openRestore();`);
    check('back to step 1 with cleared errors', els['rsStep1'].style.display !== 'none' && els['rsErrors'].innerHTML === '' && els['rsGo'].classList.contains('hidden') === true);
    check('cancel button wired', typeof els['rsCancel'].listeners['click'] === 'function');
    els['rsCancel'].listeners['click']();
    check('cancel closes modal', els['restoreModal'].classList.contains('show') === false);
  }

  console.log('\n== Cleanup: object URL revocation (real 4s timer) ==');
  await new Promise(r => setTimeout(r, 4200));
  check('object URL revoked after grace period', revoked.length > 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
