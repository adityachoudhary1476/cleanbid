/* ====================================================================
   CLEANBID — Pricing Engine Test Suite
   Runs on plain Node with zero test-framework dependency.

   How to run:
       node pricing.test.js

   Expected output: every assertion prints PASS. Any FAIL line is a real
   bug in the pricing engine (or in the test expectations if the math
   changed but tests weren't updated).

   These expected values were computed by hand from the documented pricing
   rules:
       cost_per_visit = labor + labor*burden% + labor*supplies% + (labor+labor*burden%)*overhead% + addons
   where:
       labor = visit_crew_hours * wage
       visit_crew_hours = Σ (area.sqft / area.productivity + minutes/60)  [one visit]
   and monthly = selling_per_visit × monthly_visits,
   where:
       selling_per_visit = cost_per_visit / (1 - target_margin_pct) × pkg_mult
       monthly_visits  = Σ (area.freq × 52/12)
   ==================================================================== */

const { calculatePricing, CLEANBIRD_CONSTANTS } = require('./01-pricing-engine.js');

let passed = 0, failed = 0;
function expect(name, got, want, tol) {
  tol = (tol === undefined) ? 0.005 : tol;
  // Bulk-comparison assertions (C7 same costPerVisit) compare two engines, not a single value.
  if (typeof got === 'boolean' || typeof want === 'boolean') {
    const ok = got === want;
    if (ok) {
      console.log(`  PASS  ${name}`);
      passed++;
    } else {
      console.log(`  FAIL  ${name}  got=${got} want=${want}`);
      failed++;
    }
    return;
  }
  const okNum = Math.abs(got - want) <= tol;
  if (okNum) {
    console.log(`  PASS  ${name}  got=${(typeof got === 'number' ? got.toFixed(2) : got)} want=${want.toFixed(2)}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}  got=${(typeof got === 'number' ? got.toFixed(2) : got)} want=${want.toFixed(2)}  Δ=${(got-want).toFixed(2)}`);
    failed++;
  }
}

console.log('Suite: CLEANBID pricing engine\n');

// ---------- 1. 10,000 sq ft single-area office, 1 cleaner ----------
// Outputs: visitCrewHours = 10000/2800 = 3.571h, cleaners = ceil(3.571/2.5)=2
// labor = 3.571 × 18 = 64.28/visit, burden = 64.28×15% = 9.64
// supplies = 64.28×8% = 5.14, overhead = (64.28+9.64)×12% = 8.87
// addon = 0, cost/visit = 87.93, margin 30%, package 1.0
// monthlyVisits = 1×4.33 = 4.33
// selling/visit = 87.93 / 0.7 = 125.61, monthly = 125.61×4.33 = ~$544
// But minPrice floor (800) triggers → monthly = 800.
// This case proves the floor actually catches underpriced quotes.
console.log('Case 1 — 10,000 sq ft office, 1×/week (under min-price floor)');
{
  const r = calculatePricing({
    totalArea: 10000, buildingType: 'office',
    areas: [], baseFrequency: 1, tasks: [],
    package: 'professional',
    profile: profile('std')
  });
  expect('C1 monthly = floor triggered', r.monthly, 800);
  expect('C1 annualLabor',      r.annualLabor,      64.286*12*4.33, 0.1);
  expect('C1 annualSupplies',    r.annualSupplies,    5.143*12*4.33, 0.1);
  expect('C1 annualDirectCost', r.annualDirectCost, (64.286+9.643+5.143+8.871)*12*4.33, 0.2);
  expect('C1 visitCrewHours',   r.visitCrewHours,   3.57, 0.05);
  expect('C1 visitCleaners',    r.visitCleaners,    2);
}

// ---------- 2. 75,000 sq ft single-area office, 5×/week multi-cleaner ----------
// visitCrewHours = 75000/2800 = 26.786, cleaners = ceil(26.786/2.5) = 11
// labor = 26.786 × 18 = 482.14
// burden    = 482.14 × 15% = 72.32
// supplies   = 482.14 × 8% = 38.57          (NOT × cleaners — P0 #2 fix)
// overhead   = (482.14+72.32) × 12% = 66.53
// cost/visit = 482.14+72.32+38.57+66.53 = 659.56
// monthlyVisits = 5 × 4.33 = 21.65
// selling/visit = 659.56 / 0.7 = 942.23
// monthly = 942.23 × 21.65 = 20,402
console.log('\nCase 2 — 75,000 sq ft office, multi-cleaner, 5×/week (the bug-fix demo)');
{
  const r = calculatePricing({
    totalArea: 75000, buildingType: 'office',
    areas: [], baseFrequency: 5, tasks: [],
    package: 'professional',
    profile: profile('std')
  });
  expect('C2 visitCrewHours', r.visitCrewHours, 26.786, 0.05);
  expect('C2 visitCleaners',  r.visitCleaners,  11);
  // P0 #1 fix — labor MUST be visitCrewHours * wage (NOT × cleaners).
  expect('C2 laborPerVisit = crew·wage', r.laborPerVisit, 26.786*18, 0.05);
  expect('C2 burden = labor·burden%',     r.burdenPerVisit, 26.786*18*0.15, 0.02);
  // P0 #2 fix — supplies MUST NOT multiply by cleaners.
  expect('C2 supplies = labor·supplies%', r.suppliesPerVisit, 26.786*18*0.08, 0.02);
  expect('C2 costPerVisit = labor+b+s+o',  r.costPerVisit, (26.786*18)*(1+0.15+0.08+0.12*(1+0.15)), 0.05);
  expect('C2 monthlyVisits',               r.monthlyVisits, 5*4.33, 0.01);
}

// ---------- 3. 120,000 sq ft warehouse, low frequency ----------
// industrial profile (id='ind'): wage 24, burden 18%, overhead 14%, margin 30%.
// essential package: margin -4 → effective margin 26%.
// visitCrewHours = 120000/4200 = 28.571 (id='ind' productivity for warehouse = 4200)
// visitCleaners = ceil(28.571/2.5) = 12
// labor = 28.571 × 24 = 685.71
// burden    = 685.71 × 0.18 = 123.43
// supplies   = 685.71 × 0.08 = 54.86
// overhead   = (685.71+123.43) × 0.14 = 113.28
// cost/visit = 977.28
// monthlyVisits = 2 × 4.33 = 8.66
// essential pkg mult = 0.92, margin 26% → divisor 0.74
// selling/visit = 977.28 / 0.74 × 0.92 = 1,215.18
// monthly = 1,215.18 × 8.66 = 10,521.84
console.log('\nCase 3 — 120,000 sq ft warehouse, 2×/week (industrial+essential)');
{
  const r = calculatePricing({
    totalArea: 120000, buildingType: 'warehouse',
    areas: [], baseFrequency: 2, tasks: [],
    package: 'essential',
    profile: profile('ind')
  });
  expect('C3 visitCrewHours', r.visitCrewHours, 28.571, 0.05);
  expect('C3 visitCleaners',  r.visitCleaners,  12);
  expect('C3 monthlyVisits',  r.monthlyVisits,  2*4.33, 0.01);
  expect('C3 monthly ~10,522',r.monthly, 10521.86, 3);
}

// ---------- 4. multi-area building with different frequencies ----------
// 30000 sq ft offices @ 3×/week, 4000 sq ft restrooms @ 7×/week
// visitCrewHours = 30000/2800 + 4000/800 = 10.714 + 5.000 = 15.714
// visitCleaners = ceil(15.714 / 2.5) = 7
// labor = 15.714 × 18 = 282.86 (NOT ×7)
// burden   = 282.86 × 0.15 = 42.43
// supplies  = 282.86 × 0.08 = 22.63
// overhead  = (282.86+42.43) × 0.12 = 39.04
// cost/visit = 386.95
// monthlyVisits = 3 × 4.33 + 7 × 4.33 = 12.99 + 30.31 = 43.30
// professional pkg mult = 1.0, margin 25% → divisor 0.75
// selling/visit = 386.95 / 0.75 = 515.93
// monthly = 515.93 × 43.30 = 22,339.69  (note: my earlier test 23,938 was math'd wrong)
console.log('\nCase 4 — multi-area with different frequencies (P0 #3 fix)');
{
  const r = calculatePricing({
    totalArea: 34000, buildingType: 'office',
    areas: [
      { sqft: 30000, type: 'office',    freq: 3, minTask: 0 },
      { sqft:  4000, type: 'restroom',  freq: 7, minTask: 0 }
    ], baseFrequency: 1, tasks: [],
    package: 'professional',
    profile: profile('std')
  });
  expect('C4 visitCrewHours',                 r.visitCrewHours,    15.714, 0.05);
  expect('C4 visitCleaners = ceil(ch/2.5)',   r.visitCleaners,     7);
  expect('C4 monthlyVisits = sum(a.freq*4.33)',r.monthlyVisits,     (3+7)*4.33, 0.01);
  expect('C4 laborPerVisit NO cleaners mult',  r.laborPerVisit,     15.714*18, 0.05);
  expect('C4 costPerVisit',                    r.costPerVisit,      (15.714*18)*(1+0.15+0.08+0.12*(1+0.15)), 0.05);
  expect('C4 monthly ~22,340',                r.monthly,           386.95/0.75*43.30, 1);
}

// ---------- 5. hit-the-min-price-floor ----------
// All defaults but tiny job: 100 sq ft office, 1×/week
// visitCrewHours=0.036, labor=0.64. With 25% margin & small cost → below 800 floor -> 800
console.log('\nCase 5 — minimum-price floor triggers');
{
  const r = calculatePricing({
    totalArea: 100, buildingType: 'office',
    areas: [], baseFrequency: 1, tasks: [],
    package: 'professional',
    profile: profile('std')
  });
  expect('C5 monthly = floor', r.monthly, 800);
  expect('C5 annual = floor × 12', r.annual, 9600);
}

// ---------- 6. add-ons priced all four methods ----------
// $40/visit, $0.04/sqft, $35/labor hour, $120 fixed monthly
// 10,000 sq ft @ 1×/week → 4.33 monthlyVisits, visitCrewHours=3.57
// base labor 64.28 + burden 9.64 + supplies 5.14 + overhead 8.87 = 87.93
// addons: 40 (visit) + 0.04*10000=400 (sqft) + 35*3.57=125 (hour) + 120/4.33=27.71 (fixed)
//        = 592.71 per visit total cost
// selling/visit = 592.71/0.7 = 846.73, monthly = 846.73×4.33 = 3666.74
console.log('\nCase 6 — all four add-on pricing methods simultaneously');
{
  const r = calculatePricing({
    totalArea: 10000, buildingType: 'office',
    areas: [], baseFrequency: 1, tasks: [],
    package: 'professional',
    profile: profile('std'),
    addons: [
      { id:'a1', name:'Door-sticker on each visit', method:'visit', value:40,  enabled:true },
      { id:'a2', name:'Per-sqft window wash',       method:'sqft',  value:0.04,enabled:true },
      { id:'a3', name:'Per-hour day porter',        method:'hour',  value:35,  enabled:true },
      { id:'a4', name:'Fixed $120/mo consumables',   method:'fixed', value:120, enabled:true }
    ]
  });
  const expectedAddonPerVisit = 40 + 0.04*10000 + 35*3.57 + 120/4.33;
  expect('C6 addonPerVisit',    r.addonPerVisit,  expectedAddonPerVisit, 0.05);
  expect('C6 supplies still no cleaners mult', r.suppliesPerVisit, 3.57*18*0.08, 0.05);
}

// ---------- 7. high-margin vs low-margin profile on the same building ----------
// 50,000 sq ft @ 2×/week, two configs:
//   cfg-A: std profile (wage 18, burden 15, overhead 12, margin 25)
//   cfg-B: std profile but manual margin 40 (high-margin case)
// Same visit math → higher margin should raise monthly price.
console.log('\nCase 7 — same building, two margin profiles');
{
  const a = calculatePricing({
    totalArea:50000, buildingType:'office', areas:[], baseFrequency:2, tasks:[],
    package:'professional',
    profile: profileHighMargin()
  });
  const b = calculatePricing({
    totalArea:50000, buildingType:'office', areas:[], baseFrequency:2, tasks:[],
    package:'professional',
    profile: profileLowMargin()
  });
  expect('C7 same visit hours',          Math.abs(b.visitCrewHours - a.visitCrewHours), 0, 0.001);
  expect('C7 same costPerVisit',         Math.abs(a.costPerVisit - b.costPerVisit),   0, 0.01);
  // Higher profile margin must yield a higher monthly price.
  expect('C7 higher-margin price > lower-margin price',  a.monthly > b.monthly, true);
}

// helper for "profile('std')" etc. We build the resolved shape inline so the
// test is fully self-contained and there are no JSON fixtures to maintain.
function profile(id) {
  if (id === 'std') return { wage:18, burden:15, overhead:12, margin:25, minPrice:800, supplies:8,
    productivity:{office:2800,private:2200,conference:1800,reception:1600,hallway:3500,lobby:2400,restroom:800,kitchen:900,warehouse:4500,stairwell:1200,medical:600,classroom:2400,retail:3000,other:2000} };
  if (id === 'med') return { wage:22, burden:18, overhead:14, margin:30, minPrice:800, supplies:8,
    productivity:{office:2800,restroom:500,kitchen:900,medical:500,other:2000} };
  if (id === 'ind') return { wage:24, burden:18, overhead:14, margin:30, minPrice:800, supplies:8,
    productivity:{office:2800,warehouse:4200,other:2000} };
  throw new Error('unknown profile '+id);
}
function profileHighMargin(){ return profile('std'); } // 25% margin
function profileLowMargin(){  return Object.assign({}, profile('std'), { margin: 15 }); }
// (low-margin guard kicks in: ceiling/floor, so 15%)

// helper for "profile('std')" etc. We build the resolved shape inline so the
// test is fully self-contained and there are no JSON fixtures to maintain.
function profile(id) {
  // std profile mimics the default seed in the live app
  if (id === 'std') return { wage:18, burden:15, overhead:12, margin:25, minPrice:800, supplies:8,
    productivity:{office:2800,private:2200,conference:1800,reception:1600,hallway:3500,lobby:2400,restroom:800,kitchen:900,warehouse:4500,stairwell:1200,medical:600,classroom:2400,retail:3000,other:2000} };
  if (id === 'med') return { wage:22, burden:18, overhead:14, margin:30, minPrice:800, supplies:8,
    productivity:{office:2800,restroom:500,kitchen:900,medical:500,other:2000} };
  if (id === 'ind') return { wage:24, burden:18, overhead:14, margin:30, minPrice:800, supplies:8,
    productivity:{office:2800,warehouse:4200,other:2000} };
  throw new Error('unknown profile '+id);
}

/* ====================================================================
   P0 REGRESSION SUITE — canonical pricing, add-ons, packages,
   validation guards, application pricing path, version integrity.
   Added during P0 remediation. Zero dependencies beyond Node builtins.
   ==================================================================== */

function expectThrows(name, fn, msgPart){
  try { fn(); }
  catch(e){
    if(!msgPart || String(e.message).includes(msgPart)){
      passed++; console.log(`  PASS  ${name}  (threw: ${e.message})`);
    } else {
      failed++; console.log(`  FAIL  ${name}  threw wrong error: ${e.message}`);
    }
    return;
  }
  failed++; console.log(`  FAIL  ${name}  expected an error, got none`);
}
function check(name, cond, detail){
  if(cond){ passed++; console.log(`  PASS  ${name}${detail?'  ['+detail+']':''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail?'  ['+detail+']':''}`); }
}
function stdProfile(){ return { wage:18, burden:15, overhead:12, margin:25, minPrice:800, supplies:8,
  productivity:{office:2800,private:2200,conference:1800,reception:1600,hallway:3500,lobby:2400,restroom:800,kitchen:900,warehouse:4500,stairwell:1200,medical:600,classroom:2400,retail:3000,other:2000} }; }

// ---------- R1. Validation guards ----------
console.log('\nP0-R1 — validation guards refuse garbage input');
{
  const mk = over => ({ totalArea:10000, buildingType:'office', areas:[], baseFrequency:2,
    tasks:[], package:'professional', profile:Object.assign(stdProfile(), over) });
  expectThrows('negative wage rejected',        ()=>calculatePricing(mk({wage:-5})),      'invalid wage');
  expectThrows('zero wage rejected',            ()=>calculatePricing(mk({wage:0})),       'invalid wage');
  expectThrows('negative margin rejected',      ()=>calculatePricing(mk({margin:-10})),   'invalid gross margin');
  expectThrows('margin >= 100 rejected',        ()=>calculatePricing(mk({margin:100})),   'invalid gross margin');
  expectThrows('burden > 100 rejected',         ()=>calculatePricing(mk({burden:140})),   'invalid burden');
  expectThrows('negative burden rejected',      ()=>calculatePricing(mk({burden:-1})),    'invalid burden');
  expectThrows('overhead > 100 rejected',       ()=>calculatePricing(mk({overhead:101})), 'invalid overhead');
  expectThrows('supplies > 100 rejected',       ()=>calculatePricing(mk({supplies:250})), 'invalid supplies');
  expectThrows('missing profile rejected',
    ()=>calculatePricing({totalArea:1000, areas:[], tasks:[], package:'professional'}), 'profile is required');
  // Invalid productivity must not poison the math (engine divides defensively).
  const r0 = calculatePricing(mk({productivity:{office:0}}));
  check('zero productivity stays finite', Number.isFinite(r0.monthly) && r0.monthly>0, 'monthly='+r0.monthly.toFixed(2));
  const rn = calculatePricing(mk({productivity:{office:-999}}));
  check('negative productivity stays finite', Number.isFinite(rn.monthly) && rn.monthly>0, 'monthly='+rn.monthly.toFixed(2));
}

// ---------- R2. Fixed-monthly add-on (former TDZ crash) ----------
console.log('\nP0-R2 — fixed-monthly add-on calculates without throwing');
{
  let r, threw=null;
  try {
    r = calculatePricing({
      totalArea:50000, buildingType:'office', areas:[], baseFrequency:2, tasks:[],
      package:'professional', profile:stdProfile(),
      addons:[{id:'fx', name:'Consumables', method:'fixed', value:120, enabled:true}]
    });
  } catch(e){ threw=e; }
  check('no exception on fixed add-on', !threw, threw?('THREW: '+threw.message):'');
  // 120/mo ÷ 8.66 visits = $13.86/visit cost
  check('addonPerVisit = value/monthlyVisits', Math.abs(r.addonPerVisit - 120/(2*4.33)) < 0.01, r.addonPerVisit.toFixed(2));
  const base = calculatePricing({ totalArea:50000, buildingType:'office', areas:[], baseFrequency:2,
    tasks:[], package:'professional', profile:stdProfile(), addons:[] });
  // Price impact = addon marked up through margin: (120/8.66)/(1-0.25) × 8.66 = 120/0.75 = 160
  check('monthly rises by addon grossed-up through margin', Math.abs((r.monthly-base.monthly) - 160) < 1,
    'delta='+(r.monthly-base.monthly).toFixed(2));
}

// ---------- R3. Package rules ----------
console.log('\nP0-R3 — Essential / Professional / Premium package rules');
{
  const inp = { totalArea:75000, buildingType:'office', areas:[], baseFrequency:5, tasks:[], profile:stdProfile() };
  const e = calculatePricing({...inp, package:'essential'});
  const p = calculatePricing({...inp, package:'professional'});
  const x = calculatePricing({...inp, package:'premium'});
  check('essential < professional < premium', e.monthly < p.monthly && p.monthly < x.monthly,
    `${Math.round(e.monthly)} < ${Math.round(p.monthly)} < ${Math.round(x.monthly)}`);
  check('essential: mult 0.92, margin offset −4', Math.abs(e.packageMultiplier-0.92)<1e-9 && e.targetMargin===21, 'margin='+e.targetMargin);
  check('professional: mult 1.0, margin unchanged', Math.abs(p.packageMultiplier-1.0)<1e-9 && p.targetMargin===25, 'margin='+p.targetMargin);
  check('premium: mult 1.10, margin offset +6', Math.abs(x.packageMultiplier-1.10)<1e-9 && x.targetMargin===31, 'margin='+x.targetMargin);
  const u = calculatePricing({...inp, package:'not-a-package'});
  check('unknown package falls back to professional', u.monthly===p.monthly && u.targetMargin===25);
  // Margin offsets respect the 15–45 clamp band
  const lo = calculatePricing({...inp, package:'essential', profile:Object.assign(stdProfile(),{margin:16})});
  check('essential margin clamps at floor 15', lo.targetMargin===15, 'margin='+lo.targetMargin);
  const hi = calculatePricing({...inp, package:'premium', profile:Object.assign(stdProfile(),{margin:42})});
  check('premium margin clamps at ceiling 45', hi.targetMargin===45, 'margin='+hi.targetMargin);
}

// ---------- R4. Large commercial building — full component breakdown ----------
console.log('\nP0-R4 — 75,000 sq ft office, 5×/week: every component');
{
  const r = calculatePricing({ totalArea:75000, buildingType:'office', areas:[], baseFrequency:5,
    tasks:[], package:'professional', profile:stdProfile() });
  check('crew hours = 75000/2800',        Math.abs(r.visitCrewHours - 26.786) < 0.05, r.visitCrewHours.toFixed(2));
  check('cleaners = ceil(hours/2.5)',     r.visitCleaners===11, ''+r.visitCleaners);
  check('labor = hours × wage (NO ×cleaners)', Math.abs(r.laborPerVisit - 26.786*18) < 0.05, r.laborPerVisit.toFixed(2));
  check('burden = labor × 15%',           Math.abs(r.burdenPerVisit - 26.786*18*0.15) < 0.02, r.burdenPerVisit.toFixed(2));
  check('supplies = labor × 8%',          Math.abs(r.suppliesPerVisit - 26.786*18*0.08) < 0.02, r.suppliesPerVisit.toFixed(2));
  check('overhead = burdened × 12%',      Math.abs(r.overheadPerVisit - 26.786*18*1.15*0.12) < 0.02, r.overheadPerVisit.toFixed(2));
  check('cost/visit sums',                Math.abs(r.costPerVisit - (r.laborPerVisit+r.burdenPerVisit+r.suppliesPerVisit+r.overheadPerVisit)) < 0.01, r.costPerVisit.toFixed(2));
  check('monthly = sell × visits',        Math.abs(r.monthly - (r.costPerVisit/(1-0.25))*(5*4.33)) < 1, Math.round(r.monthly)+'');
  check('annual = monthly × 12',          Math.abs(r.annual - r.monthly*12) < 0.01, Math.round(r.annual)+'');
  // Package prices for the same building (what G/B/B must show)
  const inp = { totalArea:75000, buildingType:'office', areas:[], baseFrequency:5, tasks:[], profile:stdProfile() };
  const e = calculatePricing({...inp, package:'essential'}).monthly;
  const pr = calculatePricing({...inp, package:'premium'}).monthly;
  check('tier ordering on 75k building', e < r.monthly && r.monthly < pr, `${Math.round(e)} < ${Math.round(r.monthly)} < ${Math.round(pr)}`);
}

// ---------- R5. Application pricing path (the REAL app code) ----------
// Extracts the embedded <script> from 03-app-shell.html and runs it in a VM
// with a minimal DOM stub, proving the UI's calculation path matches the
// standalone engine exactly. Still plain Node, zero dependencies.
console.log('\nP0-R5 — application path (03-app-shell.html) matches engine');
(function(){
  const fs = require('fs'), vm = require('vm'), path = require('path');
  const htmlPath = path.join(__dirname, '03-app-shell.html');
  let html;
  try { html = fs.readFileSync(htmlPath, 'utf8'); }
  catch(e){ check('app shell readable', false, e.message); return; }
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if(!m){ check('embedded <script> found', false); return; }

  function makeEl(id){ return { id, value:'', textContent:'', innerHTML:'', style:{}, dataset:{},
    classList:{_s:new Set(['page']),add(c){this._s.add(c);},remove(c){this._s.delete(c);},toggle(c,f){f===undefined?(this._s.has(c)?this._s.delete(c):this._s.add(c)):(f?this._s.add(c):this._s.delete(c));return this._s.has(c);},contains(c){return this._s.has(c);}},
    addEventListener(){}, appendChild(){}, remove(){}, focus(){}, querySelectorAll(){return [];}, getAttribute(){return null;} }; }
  const els = {};
  const documentStub = { getElementById:id=>(els[id]=els[id]||makeEl(id)), querySelector:()=>null,
    querySelectorAll:()=>[], addEventListener(){}, body:makeEl('body'),
    documentElement:makeEl('html'), createElement:t=>makeEl('dyn-'+t) };
  documentStub.documentElement.style.setProperty = ()=>{};
  const storage = {};
  const sandbox = { console:{log(){}}, document:documentStub,
    localStorage:{getItem:k=>storage[k]??null,setItem:(k,v)=>{storage[k]=String(v);}},
    Date,Math,JSON,Number,String,Array,Object,parseFloat,parseInt,isNaN,Error,Set,setTimeout,clearTimeout,
    confirm:()=>true,prompt:()=>null,alert:()=>{} };
  sandbox.window=sandbox; sandbox.addEventListener=function(){}; sandbox.globalThis=sandbox;
  vm.createContext(sandbox);

  try { vm.runInContext(m[1], sandbox, {filename:'03-app-shell.html#script'}); }
  catch(e){ check('app script executes', false, e.constructor.name+': '+e.message); return; }
  try { vm.runInContext('enterApp(true)', sandbox); }
  catch(e){ check('app boots with demo data', false, e.message); return; }

  const engine = require('./01-pricing-engine.js');

  // R5a: builder recalc() == standalone engine on a multi-area scenario
  const areas = [
    {id:1,name:'Open office',sqft:40000,type:'office',freq:5,minTask:0},
    {id:2,name:'Restrooms',sqft:5000,type:'restroom',freq:7,minTask:0}
  ];
  vm.runInContext(`qb.areas.length=0;`, sandbox);
  areas.forEach(a=>vm.runInContext(`qb.areas.push(${JSON.stringify(a)})`, sandbox));
  documentStub.getElementById('qbSqft').value='';
  vm.runInContext(`recalc()`, sandbox);
  const appCalc = JSON.parse(vm.runInContext('JSON.stringify(qb.calc)', sandbox));
  const engCalc = engine.calculatePricing({
    totalArea:45000, buildingType:'office', baseFrequency:2, areas, tasks:[],
    package:'professional', profile:stdProfile(), addons:[]
  });
  check('app labor == engine labor',        Math.abs(appCalc.laborPerVisit-engCalc.laborPerVisit)<0.01, appCalc.laborPerVisit.toFixed(2));
  check('app burden == engine burden',      Math.abs(appCalc.burdenPerVisit-engCalc.burdenPerVisit)<0.01);
  check('app supplies == engine supplies',  Math.abs(appCalc.suppliesPerVisit-engCalc.suppliesPerVisit)<0.01);
  check('app overhead == engine overhead',  Math.abs(appCalc.overheadPerVisit-engCalc.overheadPerVisit)<0.01);
  check('app monthly == engine monthly',    Math.abs(appCalc.monthly-engCalc.monthly)<0.01, appCalc.monthly.toFixed(2));
  check('app cleaners == engine cleaners',  appCalc.cleaners===engCalc.visitCleaners, ''+appCalc.cleaners);
  check('labor NOT multiplied by cleaners', Math.abs(appCalc.laborPerVisit - appCalc.hoursPerVisit*18)<0.01);

  // R5b: G/B/B professional tier == headline price (single source of truth)
  const tiers = JSON.parse(vm.runInContext('JSON.stringify(computeTierPrices())', sandbox));
  check('GBB professional == headline', Math.abs(tiers.professional-appCalc.monthly)<0.01, tiers.professional.toFixed(2));
  check('GBB essential <= professional <= premium', tiers.essential<=tiers.professional && tiers.professional<=tiers.premium,
    `${Math.round(tiers.essential)} <= ${Math.round(tiers.professional)} <= ${Math.round(tiers.premium)}`);

  // R5c: fixed-monthly add-on through the LIVE recalc() path (TDZ regression)
  let tdzOk=true, tdzErr='';
  try {
    vm.runInContext(`state.addons.push({id:'ad-t',name:'Consumables',method:'fixed',value:120,enabled:true}); recalc();`, sandbox);
  } catch(e){ tdzOk=false; tdzErr=e.message; }
  check('fixed add-on: live recalc() no crash', tdzOk, tdzErr);
  if(tdzOk){
    const ac = JSON.parse(vm.runInContext('JSON.stringify(qb.calc.addonCost)', sandbox));
    check('fixed add-on contributes non-zero cost', ac>0, 'addonCost='+Number(ac).toFixed(2));
    vm.runInContext(`state.addons.pop(); recalc();`, sandbox);
  }

  // R5d: minimum-price floor honored on EVERY customer-facing path
  const tinyQ = { id:'Q-TINY', sqft:100, type:'office', frequency:1, package:'professional',
    areas:[], tasks:[], addons:[],
    priceSnap:{wage:18,burden:15,overhead:12,margin:25,minPrice:800,supplies:8},
    productivitySnap:stdProfile().productivity };
  const tinyTiers = JSON.parse(vm.runInContext(
    `JSON.stringify(computeQuoteTierPrices(${JSON.stringify(tinyQ)}))`, sandbox));
  check('proposal tiers honor floor (E/P/P all = minPrice)',
    tinyTiers.essential===800 && tinyTiers.professional===800 && tinyTiers.premium===800,
    JSON.stringify(tinyTiers));

  // R5e: revision flow keeps versions[] structurally valid (P0-3 regression)
  documentStub.getElementById('qbSqft').value='75000';
  documentStub.getElementById('qbPropName').value='Westbrook Tower';
  documentStub.getElementById('qbCompany').value='Westbrook Real Estate';
  try {
    vm.runInContext('commitRevise()', sandbox); // saves draft + merges as v3 into Q-1042
    const q = JSON.parse(vm.runInContext(`JSON.stringify(state.quotes.find(x=>x.id==='Q-1042'))`, sandbox));
    check('revision merged into parent quote', !!q);
    check('version count incremented', q.versions.length===3, 'count='+q.versions.length);
    check('every version is an object', q.versions.every(v=>typeof v==='object' && v!==null && !Array.isArray(v)));
    check('version numbers sequential from 1', q.versions.every((v,i)=>v.v===i+1), q.versions.map(v=>v.v).join(','));
    check('previous versions intact', q.versions[0].total===10800 && q.versions[1].total===11450);
    check('new version carries new values', typeof q.versions[2].monthly==='number' && q.versions[2].monthly>0, 'v3='+q.versions[2].monthly);
    check('quote.version points at latest', q.version===q.versions.length, 'version='+q.version);
    // diff rendering still works off the merged history
    let diffOk=true, diffLen=0;
    try {
      vm.runInContext(`showDiff(state.quotes.find(x=>x.id==='Q-1042'), state.quotes.find(x=>x.id==='Q-1042').versions.length-2)`, sandbox);
      diffLen = documentStub.getElementById('diffContent').innerHTML.length;
    } catch(e){ diffOk=false; }
    check('diff renders from merged history', diffOk && diffLen>100, 'len='+diffLen);
  } catch(e){ check('revision flow completes', false, e.message); }

  // R5f: proposal renderer produces a document from canonical tiers
  try {
    vm.runInContext(`renderProposal(state.quotes.find(x=>x.id==='Q-1042'))`, sandbox);
    const len = documentStub.getElementById('propHost').innerHTML.length;
    check('renderProposal works post-revision', len>1000, 'len='+len);
  } catch(e){ check('renderProposal works post-revision', false, e.message); }
})();

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed===0 ? 0 : 1);
