/* =====================================================================
   CLEANBID — PRICING ENGINE AUDIT (independent hand-derivation)
   ---------------------------------------------------------------------
   Strategy: we RE-DERIVE every formula from scratch in plain JS
   (handMath_*) using only the documented rules, and compare the result
   against CleanBidPricing.calculatePricing() — the engine that ships in
   the app. If the two ever disagree, the engine has a bug. This is an
   independent oracle, not a re-statement of the engine.

   Run: node 07-pricing-audit.test.cjs
   EXIT 0 = all reconcile. EXIT 1 = at least one discrepancy (bug).
   ===================================================================== */

const { calculatePricing, computeAddonCost, buildAreaList, CLEANBIRD_CONSTANTS: K } =
  require('./01-pricing-engine.cjs');

let pass = 0, fail = 0, bugs = [];
function check(name, got, want, tol = 0.02) {
  const ok = Math.abs(got - want) <= tol;
  if (ok) { pass++; console.log(`  PASS  ${name}  (${round(got)} ≈ ${round(want)})`); }
  else { fail++; bugs.push(name); console.log(`  FAIL  ${name}\n        engine=${round(got)}\n        hand =${round(want)}\n        Δ    =${(got-want).toFixed(4)}`); }
}
const round = v => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

/* ---- INDEPENDENT HAND-DERIVED ORACLE -------------------------------- */
function handCalc(input) {
  const { totalArea, tasks, profile, addons, package: pkg } = input;
  const areaList = buildAreaList(input); // builder is shared (pure, trusted)

  let visitCrewHours = 0;
  for (const a of areaList) {
    visitCrewHours += a.sqft / Math.max(1, a.productivity) + a.minTask / 60;
  }
  const globalTaskMin = (tasks || []).reduce((s, t) => s + (t.min || 0), 0);
  visitCrewHours += globalTaskMin / 60;
  if (input.crewHoursOverride != null && input.crewHoursOverride > 0) visitCrewHours = input.crewHoursOverride;

  const visitCleaners = Math.max(1, Math.ceil(visitCrewHours / K.MAX_HOURS_PER_CLEANER_PER_VISIT));
  let monthlyVisits = 0;
  for (const a of areaList) monthlyVisits += a.freq * K.WEEKS_PER_MONTH_APPROX;

  const labor = visitCrewHours * profile.wage;
  const burden = labor * profile.burden / 100;
  const supplies = labor * profile.supplies / 100;
  const overhead = (labor + burden) * profile.overhead / 100;
  const addonPV = computeAddonCost(addons, totalArea, monthlyVisits, visitCrewHours);
  const costPerVisit = labor + burden + supplies + overhead + addonPV;

  const pkgKey = (pkg === 'essential' || pkg === 'premium') ? pkg : 'professional';
  const pkgMul = K.PACKAGE_MULT[pkgKey];
  const targetMargin = Math.max(K.MARGIN_FLOOR, Math.min(K.MARGIN_CEILING, profile.margin + K.PACKAGE_MARGIN_OFFSET[pkgKey]));
  const sellingPerVisit = (costPerVisit / (1 - targetMargin / 100)) * pkgMul;

  let monthly = sellingPerVisit * monthlyVisits;
  if (monthly < profile.minPrice) monthly = profile.minPrice;
  const annual = monthly * 12;
  const psf = totalArea > 0 ? monthly / totalArea : 0;

  const f = n => n * 12 * monthlyVisits;
  return {
    visitCrewHours, visitCleaners, monthlyVisits,
    laborPerVisit: labor, burdenPerVisit: burden, suppliesPerVisit: supplies, overheadPerVisit: overhead, addonPerVisit: addonPV,
    costPerVisit, targetMargin, packageMultiplier: pkgMul, sellingPerVisit,
    monthly, annual, psf,
    annualLabor: f(labor), annualBurden: f(burden), annualSupplies: f(supplies),
    annualOverhead: f(overhead), annualAddons: f(addonPV),
    annualDirectCost: f(labor) + f(burden) + f(supplies) + f(overhead) + f(addonPV),
    totalMonthlyCrewHours: visitCrewHours * monthlyVisits,
  };
}

/* ---- DEFAULT PROFILE (matches app seed) ----------------------------- */
const DEF = {
  wage: 18, burden: 15, overhead: 12, supplies: 8, margin: 25, minPrice: 800,
  productivity: { office: 2800, private: 2200, conference: 1800, reception: 1600, hallway: 3500,
    lobby: 2400, restroom: 800, kitchen: 900, warehouse: 4500, stairwell: 1200, medical: 600, classroom: 2400, retail: 3000, other: 2000 }
};

console.log('=== AUDIT 1: Mixed-area office, 10,000 sf, 3x/week, professional ===');
const mixedAreas = [
  { sqft: 6000, type: 'office',    freq: 3 },
  { sqft: 1500, type: 'restroom',  freq: 3 },
  { sqft: 1000, type: 'kitchen',   freq: 3 },
  { sqft: 1500, type: 'lobby',     freq: 3 },
]; // total = 10000 sf, all 3x/week
const A1 = { totalArea: 10000, areas: mixedAreas, profile: DEF, addons: [], package: 'professional' };
let eng = calculatePricing(A1);
let hand = handCalc(A1);

// Hand trace (single-area hours):
//   office   6000/2800=2.142857
//   restroom 1500/800 =1.875
//   kitchen  1000/900 =1.111111
//   lobby    1500/2400=0.625
check('A1 visitCrewHours', eng.visitCrewHours, 5.753968);          // sum above
check('A1 visitCleaners (ceil 5.754/2.5=3)', eng.visitCleaners, 3);
check('A1 monthlyVisits (4 areas × 3 × 4.33)', eng.monthlyVisits, 51.96);
check('A1 laborPerVisit (5.753968×18)', eng.laborPerVisit, hand.laborPerVisit);
check('A1 burdenPerVisit (labor×15%)', eng.burdenPerVisit, hand.burdenPerVisit);
check('A1 suppliesPerVisit (labor×8%)', eng.suppliesPerVisit, hand.suppliesPerVisit);
check('A1 overheadPerVisit ((labor+burden)×12%)', eng.overheadPerVisit, hand.overheadPerVisit);
check('A1 costPerVisit reconciles', eng.costPerVisit, hand.costPerVisit);
check('A1 targetMargin (25, prof offset 0)', eng.targetMargin, 25);
check('A1 sellingPerVisit (cost/0.75)', eng.sellingPerVisit, hand.sellingPerVisit);
check('A1 monthly (selling×51.96)', eng.monthly, hand.monthly);
check('A1 annual (monthly×12)', eng.annual, hand.annual);
check('A1 psf (monthly/10000)', eng.psf, hand.psf);
check('A1 annualLabor reconciles', eng.annualLabor, hand.annualLabor);
check('A1 annualDirectCost = Σ annual components', eng.annualDirectCost, hand.annualDirectCost);
// EXPECTED (hand) for the report:
console.log('        → monthly = $' + round(eng.monthly) + ', annual = $' + round(eng.annual) + ', $/sf = $' + round(eng.psf));

console.log('\n=== AUDIT 2: Per-area productivity rate (each type × the engine) ===');
// Verify buildAreaList picks the correct productivity per type & laborPerVisit uses IT.
const single = (type, sqft, freq) => ({ totalArea: sqft, areas: [{ sqft, type, freq }], profile: DEF, addons: [], package: 'professional' });
for (const [type, prod] of Object.entries(DEF.productivity)) {
  const e = calculatePricing(single(type, prod, 1)); // 1 visit-equivalent area == 1 hr crew
  check(`prod ${type}: crewHours=${prod}/${prod}=1`, e.visitCrewHours, 1);
  check(`prod ${type}: labor=1×wage=18`, e.laborPerVisit, 18);
}

console.log('\n=== AUDIT 3: Multi-area aggregation — cleaners / hours / visits ===');
// Two offices, 5600 sf each @2800 => 2 hr each => 4 crew-hr, 2 cleaners.
const agg = { totalArea: 11200, areas: [
  { sqft: 5600, type: 'office', freq: 5 },
  { sqft: 5600, type: 'office', freq: 5 },
], profile: DEF, addons: [], package: 'professional' };
const e3 = calculatePricing(agg);
check('A3 visitCrewHours (2+2=4)', e3.visitCrewHours, 4);
check('A3 cleaners (ceil 4/2.5=2)', e3.visitCleaners, 2);
check('A3 monthlyVisits (2×5×4.33=43.3)', e3.monthlyVisits, 43.3);
check('A3 totalMonthlyCrewHours (4×43.3)', e3.totalMonthlyCrewHours, 4 * 43.3);

console.log('\n=== AUDIT 4: Add-on pricing — all FOUR methods ===');
const base4 = { totalArea: 10000, areas: [{ sqft: 10000, type: 'office', freq: 3 }], profile: DEF, package: 'professional' };
// 3x/week office: crewHours = 10000/2800 = 3.5714 ; monthlyVisits = 3×4.33 = 12.99
const e4base = calculatePricing(base4);
const h4 = handCalc(base4);
// visit method: $50/visit
check('ADD-on visit: +50/visit', calculatePricing({ ...base4, addons: [{ method: 'visit', value: 50, enabled: true }] }).addonPerVisit, 50);
// sqft method: $0.01/sf => 0.01 × 10000 = 100 /visit
check('ADD-on sqft: 0.01×10000=100/visit', calculatePricing({ ...base4, addons: [{ method: 'sqft', value: 0.01, enabled: true }] }).addonPerVisit, 100);
// hour method: $10/hr × 3.5714 crew-hr = 35.714/visit
check('ADD-on hour: 10×crewHrs', calculatePricing({ ...base4, addons: [{ method: 'hour', value: 10, enabled: true }] }).addonPerVisit, 10 * h4.visitCrewHours);
// fixed method: $200/mo => 200 / 12.99 = 15.396/visit
check('ADD-on fixed: 200/monthVisits', calculatePricing({ ...base4, addons: [{ method: 'fixed', value: 200, enabled: true }] }).addonPerVisit, 200 / Math.max(1, h4.monthlyVisits));
// disabled add-on contributes 0
check('ADD-on disabled: 0', calculatePricing({ ...base4, addons: [{ method: 'visit', value: 50, enabled: false }] }).addonPerVisit, 0);
// fixed method with 0 visits (div-by-zero guard): must not be Infinity/NaN
const zeroVis = calculatePricing({ totalArea: 10000, areas: [{ sqft: 10000, type: 'office', freq: 0 }], profile: DEF, package: 'professional', addons: [{ method: 'fixed', value: 200, enabled: true }] });
check('ADD-on fixed: 0 visits guard (finite)', isFinite(zeroVis.addonPerVisit) ? 1 : 0, 1);

console.log('\n=== AUDIT 5: Margin / markup application + package tiers ===');
// Essential: margin 25-4=21 (clamp ok), mult 0.92
// Premium : margin 25+6=31, mult 1.10
const e5e = calculatePricing({ ...base4, package: 'essential' });
const e5p = calculatePricing({ ...base4, package: 'premium' });
check('MARGIN essential target = 21', e5e.targetMargin, 21);
check('MARGIN premium target = 31', e5p.targetMargin, 31);
check('MARGIN essential monthly < professional', e5e.monthly < e4base.monthly ? 1 : 0, 1);
check('MARGIN premium monthly > professional', e5p.monthly > e4base.monthly ? 1 : 0, 1);
// margin floor: profile margin 0, essential => max(15, 0-4)=15
const e5f = calculatePricing({ totalArea: 10000, areas: [{ sqft: 10000, type: 'office', freq: 3 }], profile: { ...DEF, margin: 0 }, package: 'essential' });
check('MARGIN floor enforced (min 15)', e5f.targetMargin, 15);
// margin ceiling: profile margin 50, premium => min(45, 56)=45
const e5c = calculatePricing({ totalArea: 10000, areas: [{ sqft: 10000, type: 'office', freq: 3 }], profile: { ...DEF, margin: 50 }, package: 'premium' });
check('MARGIN ceiling enforced (max 45)', e5c.targetMargin, 45);

console.log('\n=== AUDIT 6: "Why this price?" line items reconcile to final ===');
// The drawer shows costPerVisit, then cost×visits, then margin, then recommended monthly.
// Verify: recommended monthly == costPerVisit/(1-margin) × mult × monthlyVisits (no hidden term).
const e6 = calculatePricing(A1);
const recomputedMonthly = (e6.costPerVisit / (1 - e6.targetMargin / 100)) * e6.packageMultiplier * e6.monthlyVisits;
check('WHY recommended monthly = cost/(1-m) × mult × visits', e6.monthly, recomputedMonthly);
// Verify each Why line item equals engine field (UI reads qb.calc.*)
check('WHY laborPerVisit line', e6.laborPerVisit, hand.laborPerVisit);
check('WHY burdenPerVisit line', e6.burdenPerVisit, hand.burdenPerVisit);
check('WHY suppliesPerVisit line', e6.suppliesPerVisit, hand.suppliesPerVisit);
check('WHY overheadPerVisit line', e6.overheadPerVisit, hand.overheadPerVisit);
check('WHY costPerVisit line', e6.costPerVisit, hand.costPerVisit);
// And monthly = annual/12 (the drawer's annual line must agree)
check('WHY annual == monthly×12', e6.annual, e6.monthly * 12);

console.log('\n=== AUDIT 7: Min-price floor ===');
const e7 = calculatePricing({ totalArea: 500, areas: [{ sqft: 500, type: 'office', freq: 1 }], profile: { ...DEF, minPrice: 5000 }, addons: [], package: 'professional' });
check('MIN floor: monthly raised to minPrice', e7.monthly, 5000);

console.log('\n=== AUDIT 8: P0-2 regression — fixed-monthly add-on does not crash ===');
let crashed = false;
try {
  calculatePricing({ totalArea: 10000, areas: [{ sqft: 10000, type: 'office', freq: 3 }], profile: DEF, package: 'professional', addons: [{ method: 'fixed', value: 300, enabled: true }] });
} catch (e) { crashed = true; }
check('P0-2 fixed add-on no crash', crashed ? 0 : 1, 1);

console.log('\n========================================================');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('DISCREPANCIES (engine vs independent hand-derivation):'); bugs.forEach(b => console.log('  - ' + b)); }
process.exit(fail > 0 ? 1 : 0);
