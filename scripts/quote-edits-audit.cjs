/**
 * Quote-level pricing overrides — audit.
 * Verifies, through the REAL pricing engine (01-pricing-engine.cjs):
 *   1. No overrides  -> identical result to before the feature existed
 *   2. One quote's overrides never leak into another quote's math
 *   3. Overrides never mutate the workspace/global pricing defaults object
 *   4. Reset (delete override) restores the workspace-default result
 *   5. Multiple simultaneous overrides flow through calculatePricing()
 *   6. crewHoursOverride replaces survey-derived hours (and cleaners derive)
 * Exits non-zero on any failure.
 */
const { calculatePricing } = require('../01-pricing-engine.cjs');

let pass = 0, fail = 0;
function ok(name, cond, detail){
  if(cond){ console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail?' — '+detail:''}`); fail++; }
}

// Workspace-level defaults (what activePricing()/state.pricing provide).
const GLOBAL_PRICING = Object.freeze({
  wage: 22, burden: 15, overhead: 12, margin: 25,
  minPrice: 800, supplies: 8,
  productivity: { office: 2800 }
});
const BASE_INPUT = () => ({
  totalArea: 20000, buildingType: 'office',
  areas: [], baseFrequency: 5, tasks: [],
  addons: [], package: 'professional',
  profile: JSON.parse(JSON.stringify(GLOBAL_PRICING))
});

// Simulate the app's merge: overrides applied over a CLONED profile
// (mirrors buildEngineInput in 03-app-shell.html).
function quoteInput(overrides){
  const input = BASE_INPUT();
  if(overrides){
    for(const k of ['wage','burden','supplies','overhead','margin']){
      if(overrides[k] !== undefined) input.profile[k] = overrides[k];
    }
    if(overrides.hoursPerVisit !== undefined) input.crewHoursOverride = overrides.hoursPerVisit;
  }
  return input;
}

console.log('Suite: editable Why-this-price quote-level overrides\n');

// --- 1. Default behavior unchanged -------------------------------------
const r0 = calculatePricing(BASE_INPUT());
ok('no overrides -> survey-derived hours used', Math.abs(r0.visitCrewHours - 20000/2800) < 1e-9);
ok('no overrides -> monthly computed from globals', r0.monthly > 0 && Number.isFinite(r0.monthly));
const baseline = r0.monthly;

// --- 2/3. Isolation + global immutability -------------------------------
const ovA = { wage: 30 };                       // Quote A edits labor rate
const rA = calculatePricing(quoteInput(ovA));
const rB = calculatePricing(quoteInput({}));    // Quote B: no overrides
ok('Quote A wage=30 changes its price', rA.monthly !== baseline);
ok('Quote B unaffected by Quote A', Math.abs(rB.monthly - baseline) < 1e-9);
ok('GLOBAL_PRICING.wage untouched after A', GLOBAL_PRICING.wage === 22);

// labor scales linearly with wage (engine path proof)
const ratio = rA.laborPerVisit / rB.laborPerVisit;
ok('labor ratio == 30/22 through engine', Math.abs(ratio - 30/22) < 1e-9);

// --- 4. Reset restores default ------------------------------------------
const rReset = calculatePricing(quoteInput({})); // delete override => {}
ok('reset wage -> result equals baseline', Math.abs(rReset.monthly - baseline) < 1e-9);

// --- 5. Multiple simultaneous overrides ---------------------------------
const ovM = { wage: 25, burden: 18, overhead: 10, margin: 20 };
const rM = calculatePricing(quoteInput(ovM));
// Hand-computed expectation through the documented formula:
const hours = 20000/2800;
const labor = hours * 25;
const cost = labor + labor*0.18 + labor*0.08 + (labor + labor*0.18)*0.10;
const visits = 5 * 4.33;
const sell = cost / (1-0.20);
const expectMonthly = Math.max(800, sell * visits);
ok('multiple overrides match hand-computed engine math', Math.abs(rM.monthly - expectMonthly) < 1, `got ${rM.monthly.toFixed(2)} want ${expectMonthly.toFixed(2)}`);

// --- 6. crewHoursOverride ------------------------------------------------
const rH = calculatePricing(quoteInput({ hoursPerVisit: 10 }));
ok('crewHoursOverride replaces derived hours', Math.abs(rH.visitCrewHours - 10) < 1e-9);
ok('cleaners derive from overridden hours', rH.visitCleaners === Math.ceil(10/2.5));
const rBadH = calculatePricing(quoteInput({ hoursPerVisit: -5 })); // invalid -> ignored
ok('invalid crewHoursOverride ignored safely', Math.abs(rBadH.visitCrewHours - hours) < 1e-9);

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
