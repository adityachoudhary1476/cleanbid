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

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed===0 ? 0 : 1);
