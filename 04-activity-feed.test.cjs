/* Activity feed render verification — headless DOM-stub harness.
   Verifies: (1) renderDash writes timeline HTML into #dashActivity,
   (2) empty state renders when no activity, (3) hostile strings are escaped. */
const fs = require('fs'), vm = require('vm');

const html = fs.readFileSync(__dirname + '/03-app-shell.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeEl(id){
  return { id, value:'', textContent:'', innerHTML:'', style:{}, dataset:{},
    classList:{ _s:new Set(),
      add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
      toggle(c,f){ f===undefined ? (this._s.has(c)?this._s.delete(c):this._s.add(c))
                                 : (f?this._s.add(c):this._s.delete(c)); return this._s.has(c); },
      contains(c){ return this._s.has(c); } },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, remove(){}, focus(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    getAttribute(){ return null; }, setAttribute(){} };
}
const els = {};
const documentStub = {
  getElementById: id => (els[id] = els[id] || makeEl(id)),
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener(){}, body: makeEl('body'),
  documentElement: Object.assign(makeEl('html'), { style:{ setProperty(){} } }),
  createElement: t => makeEl('dyn-'+t),
};
const store = {};
const sandbox = {
  console: { log(){}, error(){}, warn(){} },
  document: documentStub,
  localStorage: { getItem: k => store[k] ?? null, setItem: (k,v)=>{ store[k]=String(v); } },
  Date, Math, JSON, Number, String, Array, Object, RegExp, Boolean,
  parseFloat, parseInt, isNaN, Error, Set, Map, setTimeout, clearTimeout, setInterval, clearInterval,
  confirm: () => true, prompt: () => null, alert: () => {}, scrollTo(){},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){} });
vm.createContext(sandbox);

let pass=0, fail=0;
function check(name, cond){
  if(cond){ pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

try {
  vm.runInContext(script, sandbox, { filename:'shell.js' });
} catch(e) {
  console.log('LOAD FAILED:', e.message);
  process.exit(1);
}

// Enter the app so state + renderers exist
try { vm.runInContext('enterApp(true)', sandbox); } catch(e) { /* may not exist */ }
try { vm.runInContext('bootApp()', sandbox); } catch(e) { console.log('bootApp err:', e.message); }

// Test 1: with seeded activity, renderDash populates dashActivity
const actCount = vm.runInContext('(state.activity||[]).length', sandbox);
console.log('seeded activity entries:', actCount);
try {
  vm.runInContext('renderDash()', sandbox);
  const host = els['dashActivity'];
  check('renderDash ran without throwing', true);
  check('#dashActivity host exists in DOM stubs', !!host);
  const rendered = host ? host.innerHTML : '';
  check('activity rendered as timeline items', rendered.includes('tl-item'));
  check('actor names rendered', rendered.includes('Jane') || rendered.includes('Carlos') || rendered.includes('Priya'));
  check('no raw "No activity yet" empty-state while data exists', !rendered.includes('No activity yet'));
} catch(e) {
  check('renderDash threw: ' + e.message, false);
}

// Test 2: empty activity -> empty state message
try {
  vm.runInContext('state.activity = []; renderDash()', sandbox);
  const rendered2 = els['dashActivity'].innerHTML;
  check('empty state shown when activity is []', rendered2.includes('No activity yet'));
} catch(e) {
  check('empty-activity render threw: ' + e.message, false);
}

// Test 3: hostile strings must be escaped through the renderer
try {
  const payload = JSON.stringify('<img src=x onerror=alert(1)>');
  vm.runInContext(`state.activity = [{avt:'XX',actor:${payload},what:'did',object:${payload},time:'now'}]; renderDash()`, sandbox);
  const rendered3 = els['dashActivity'].innerHTML;
  check('XSS payload escaped (no <img tag survives)', !rendered3.includes('<img'));
  check('payload present only in escaped form (&lt;img)', rendered3.includes('&lt;img'));
} catch(e) {
  check('XSS render threw: ' + e.message, false);
}

// Restore normal activity for subsequent manual checks
try { vm.runInContext('seedDemoData&&0', sandbox); } catch(e){}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
