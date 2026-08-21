/* ====================================================================
   CLEANBID — Commercial Cleaning Estimator Pricing Engine
   Pure function. No DOM. No globals. No side-effects.
   Designed to be unit-testable in plain Node (zero deps).
   ==================================================================== */

// Public constants — exposed so the test file can reference them directly.
const CLEANBIRD_CONSTANTS = {
  MAX_HOURS_PER_CLEANER_PER_VISIT: 2.5, // how many visit-hours a single cleaner can log
  WEEKS_PER_MONTH_APPROX: 4.33,        // 52 / 12 — used to convert visits per week → visits per month
  HOURS_PER_TASK_MINUTE_SLOT: 1 / 60,  // minutes → hours
  MIN_PRICE_FLOOR_DEFAULT: 800,
  PACKAGE_MULT: { essential: 0.92, professional: 1.0, premium: 1.10 },
  PACKAGE_MARGIN_OFFSET: { essential: -4, professional: 0, premium: 6 },
  MARGIN_FLOOR: 15,                      // never let adjusted margin drop below this
  MARGIN_CEILING: 45,                    // never let it rise above this
};

/* ---------------------------------------------------------------------
   determineAreasForQuote(input)
   Builds the area list the engine should iterate over. The first path
   (areas[] from the survey) is preferred; the fallback is one implicit
   "whole building" area using the building type's productivity default.
   --------------------------------------------------------------------- */
function buildAreaList(input) {
  const { totalArea, areas, profile } = input;
  const fallbackProductivity =
    (profile.productivity && profile.productivity[input.buildingType || 'office']) ||
    (profile.productivity && profile.productivity.office) ||
    2800;

  if (Array.isArray(areas) && areas.length > 0) {
    return areas.map(a => ({
      sqft: Number(a.sqft) || 0,
      type: a.type || 'office',
      freq: Number(a.freq) || 1,
      minTask: Number(a.minTask) || 0,
      productivity: (profile.productivity && profile.productivity[a.type]) || fallbackProductivity
    }));
  }
  // Single-implicit-area fallback. Production-only field is sqft.
  return [{
    sqft: Number(totalArea) || 0,
    type: input.buildingType || 'office',
    freq: Number(input.baseFrequency) || 1,
    minTask: 0,
    productivity: fallbackProductivity
  }];
}

/* ---------------------------------------------------------------------
   computeAddonCost(addons, totalArea, monthlyVisits, visitCrewHours)
   Returns $/visit impact of every enabled add-on, respecting the 4
   pricing methods (visit, sqft, hour, fixed-monthly-as-rate-per-visit).
   --------------------------------------------------------------------- */
function computeAddonCost(addons, totalArea, monthlyVisits, visitCrewHours) {
  let perVisit = 0;
  const safe = Array.isArray(addons) ? addons : [];
  for (const a of safe) {
    if (!a || !a.enabled) continue;
    const v = Number(a.value) || 0;
    if (a.method === 'visit') perVisit += v;
    else if (a.method === 'sqft') perVisit += v * Math.max(0, totalArea);
    else if (a.method === 'hour') perVisit += v * visitCrewHours;
    else if (a.method === 'fixed') perVisit += v / Math.max(1, monthlyVisits);
    // unknown methods silently contribute zero — fail-safe vs invalid config
  }
  return perVisit;
}

/* ---------------------------------------------------------------------
   calculatePricing(input) — PURE.
   Returns a complete result object every consumer can use.
   --------------------------------------------------------------------- */
function calculatePricing(input) {
  const K = CLEANBIRD_CONSTANTS;
  const { totalArea, tasks, profile, addons, package } = input;

  // Guard rails first (cheaper to refuse than to compute garbage).
  if (!profile) throw new Error('profile is required');
  if (!profile.wage || profile.wage < 0) throw new Error('invalid wage');
  if (profile.margin < 0 || profile.margin >= 100) throw new Error('invalid gross margin (must be 0–99.99%)');
  if (profile.burden < 0 || profile.burden > 100) throw new Error('invalid burden %');
  if (profile.overhead < 0 || profile.overhead > 100) throw new Error('invalid overhead %');
  if (!profile.supplies || profile.supplies < 0 || profile.supplies > 100) throw new Error('invalid supplies %');

  // 1. Determine the area list (real survey areas or one implicit area).
  const areaList = buildAreaList(input);

  // 2. Aggregate labor.
  //    visitCrewHours = total CREW-hours the team needs in ONE visit to
  //    service all areas (a 2-cleaner crew working 2.5 hrs each = 5 crew-hrs).
  let visitCrewHours = 0;
  for (const a of areaList) {
    const productiveHours = a.sqft / Math.max(1, a.productivity);
    const taskBonus = a.minTask * K.HOURS_PER_TASK_MINUTE_SLOT;
    visitCrewHours += productiveHours + taskBonus;
  }
  // visitCleaners = floor(totalCrewHours / maxHoursPerCleaner) so the team can
  // actually finish the visit in a single shift. Using a per-area maximum here
  // would *under-staff* any reasonable single-visit cleanup (Case 4 in tests).
  // Round up: a 15.71-hr job splits cleanly into 7 cleaners at 2.5 hrs each.
  const visitCleaners = Math.max(1, Math.ceil(visitCrewHours / K.MAX_HOURS_PER_CLEANER_PER_VISIT));
  // Also include global ad-hoc tasks added via the Tasks modal (legacy).
  const globalTaskMinutes = (tasks || []).reduce((s, t) => s + (Number(t.min) || 0), 0);
  visitCrewHours += globalTaskMinutes * K.HOURS_PER_TASK_MINUTE_SLOT;

  // 3. Total monthly visits across all areas (drives monthly revenue).
  let monthlyVisits = 0;
  for (const a of areaList) monthlyVisits += a.freq * K.WEEKS_PER_MONTH_APPROX;

  // 4. Per-visit costs.
  //    laborPerVisit intentionally does NOT multiply by cleaners —
  //    visitCrewHours already accounts for headcount. Multiplying again
  //    would inflate cost by the crew size a second time (P0 #1 fix).
  const laborPerVisit = visitCrewHours * profile.wage;
  const burdenPerVisit = laborPerVisit * (profile.burden / 100);
  // P0 #2 fix: supplies as % of labor should not also scale by cleaners.
  const suppliesPerVisit = laborPerVisit * (profile.supplies / 100);
  const overheadPerVisit = (laborPerVisit + burdenPerVisit) * (profile.overhead / 100);

  const addonPerVisit = computeAddonCost(addons, totalArea, monthlyVisits, visitCrewHours);
  const costPerVisit = laborPerVisit + burdenPerVisit + suppliesPerVisit + overheadPerVisit + addonPerVisit;
  const elapsedHoursPerCleaner = visitCrewHours / visitCleaners; // UI-visible "wall-clock" duration

  // 5. Apply package multiplier + target gross margin.
  //    Math: clearing per-visit cost -> gross-margin gate -> package multiplier.
  const pkgKey = (package === 'essential' || package === 'premium') ? package : 'professional';
  const pkgMul = K.PACKAGE_MULT[pkgKey];
  const targetMargin = Math.max(K.MARGIN_FLOOR, Math.min(K.MARGIN_CEILING, profile.margin + K.PACKAGE_MARGIN_OFFSET[pkgKey]));
  const marginFraction = targetMargin / 100;
  if (marginFraction >= 1) {
    // Refuse rather than producing infinity or NaN — caller should showFatal() upstream.
    return { error: 'Margin >= 100%, math invalid', margin: targetMargin };
  }
  const sellingPerVisit = (costPerVisit / (1 - marginFraction)) * pkgMul;

  // 6. Monthly / annual / per-sq-ft outputs (the user's price).
  let monthly = sellingPerVisit * monthlyVisits;
  if (monthly < profile.minPrice) monthly = profile.minPrice;
  const annual = monthly * 12;
  const psf = totalArea > 0 ? monthly / totalArea : 0;

  // 7. Annual cost components (P0 #4 fix: stored separately, used in proposal).
  const annualLabor      = laborPerVisit * 12 * monthlyVisits;
  const annualBurden     = burdenPerVisit * 12 * monthlyVisits;
  const annualSupplies   = suppliesPerVisit * 12 * monthlyVisits;
  const annualOverhead   = overheadPerVisit * 12 * monthlyVisits;
  const annualAddons     = addonPerVisit * 12 * monthlyVisits;
  const annualDirectCost = annualLabor + annualBurden + annualSupplies + annualOverhead + annualAddons;

  return {
    // Visit-level math
    visitCrewHours, visitCleaners, elapsedHoursPerCleaner, monthlyVisits,
    laborPerVisit, burdenPerVisit, suppliesPerVisit, overheadPerVisit, addonPerVisit,
    costPerVisit, sellingPerVisit,
    // Pricing outputs
    targetMargin, packageMultiplier: pkgMul, monthly, annual, psf,
    // Annual-cost components (used in proposal & Why-this-Price)
    annualLabor, annualBurden, annualSupplies, annualOverhead, annualAddons, annualDirectCost,
    // Convenience aggregates
    totalMonthlyCrewHours: visitCrewHours * monthlyVisits
  };
}

// Export for Node (CommonJS) and for browser (global/window).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calculatePricing, buildAreaList, computeAddonCost, CLEANBIRD_CONSTANTS };
}
if (typeof window !== 'undefined') {
  window.CleanBidPricing = { calculatePricing, buildAreaList, computeAddonCost, CLEANBIRD_CONSTANTS };
}
