/**
 * CleanBid — Quote Editing logic (engine-backed, single source of truth).
 *
 * DOM-free, dependency-free. This module converts an existing saved quote +
 * a set of user-edited input fields into (a) a live recalculation through the
 * CANONICAL pricing engine and (b) a revised quote object.
 *
 * CRITICAL: there is NO pricing arithmetic in this file. Every dollar figure
 * comes from `CleanBidPricing.calculatePricing()` (the same engine the builder
 * and proposals use). Editing a quote is exactly:
 *
 *     edited fields -> buildEditEngineInput() -> calculatePricing() -> patch
 *
 * The only value added here is an OPTIONAL post-engine discount, applied the
 * same way the builder applies its manual `override` (after canonical math),
 * so the engine stays authoritative and no second formula is introduced.
 */

import { calculatePricing } from '../01-pricing-engine.js';

/**
 * Build the canonical engine input from an existing quote + edited fields.
 * Mirrors computeQuoteTierPrices() in the app shell so historical quotes keep
 * their own pricing snapshot, then overlays the edited labor/cost fields.
 *
 * @param {object} quote  saved quote (needs priceSnap/productivitySnap)
 * @param {object} fields editable field values from the edit form
 * @param {object} [pricingDefaults] global fallback pricing
 */
export function buildEditEngineInput(quote, fields, pricingDefaults) {
  const P = quote?.priceSnap || pricingDefaults || {};
  const prod = quote?.productivitySnap || pricingDefaults?.productivity || {};
  const areas = quote?.areas || [];
  const totalArea = fieldNum(fields.sqft, quote?.sqft ?? 0) ||
    areas.reduce((s, a) => s + (Number(a.sqft) || 0), 0);

  const profile = {
    wage: fieldNum(fields.wage, P.wage),
    burden: fieldNum(fields.burden, P.burden),
    overhead: fieldNum(fields.overhead, P.overhead),
    margin: fieldNum(fields.margin, P.margin),
    minPrice: fieldNum(fields.minPrice, P.minPrice ?? pricingDefaults?.minPrice ?? 800),
    supplies: fieldNum(fields.supplies, P.supplies ?? pricingDefaults?.supplies ?? 8),
    productivity: prod,
  };

  return {
    totalArea,
    buildingType: quote?.type || 'office',
    baseFrequency: fieldNum(fields.frequency, quote?.frequency || 1),
    areas,
    tasks: quote?.tasks || [],
    profile,
    addons: quote?.addons || [],
    package: quote?.package || 'professional',
  };
}

/**
 * Recalculate an edited quote through the canonical engine.
 *
 * Returns { ok, calc, error } where `calc` is the raw engine result (with the
 * optional post-engine discount folded into `finalMonthly`/`finalAnnual`).
 * Never throws — callers render the error instead of crashing.
 */
export function recalculateQuote(quote, fields, pricingDefaults) {
  const input = buildEditEngineInput(quote, fields, pricingDefaults);
  let calc;
  try {
    calc = calculatePricing(input);
  } catch (err) {
    return { ok: false, calc: null, error: 'Pricing inputs are invalid: ' + err.message };
  }
  if (!calc || calc.error) {
    return { ok: false, calc: null, error: 'Pricing error: ' + (calc?.error || 'unknown') };
  }

  // Optional post-engine discount (applied after canonical math, like override).
  const discountPct = normalizeDiscount(fields.discount);
  const baseMonthly = Math.round(calc.monthly);
  const finalMonthly = Math.round(baseMonthly * (1 - discountPct / 100));
  const finalAnnual = finalMonthly * 12;

  return {
    ok: true,
    calc,
    discountPct,
    finalMonthly,
    finalAnnual,
    error: null,
  };
}

/**
 * Produce the price/patch fields (the numeric snapshot) for a revised quote,
 * mirroring the fields saved in saveDraft(). Keeps the stored shape identical
 * so proposals, dashboard and version history keep working untouched.
 */
export function quotePriceFields(calc, recalcResult, fields) {
  const dm = recalcResult.finalMonthly;
  const da = recalcResult.finalAnnual;
  const c = calc;
  return {
    calcMonthly: Math.round(c.monthly),
    override: null, // edits go through the engine, not a manual override
    discountPct: recalcResult.discountPct,
    cleaners: c.visitCleaners,
    hoursPerVisit: Number(c.visitCrewHours.toFixed(1)),
    visitsPerMonth: Number(c.monthlyVisits.toFixed(1)),
    monthly: dm,
    annual: da,
    margin: c.targetMargin,
    costPerVisit: Math.round(c.costPerVisit),
    laborPerVisit: Math.round(c.laborPerVisit),
    burdenPerVisit: Math.round(c.burdenPerVisit),
    suppliesPerVisit: Math.round(c.suppliesPerVisit),
    overheadPerVisit: Math.round(c.overheadPerVisit),
    addonsPerVisit: Math.round(c.addonPerVisit),
    annualLabor: Math.round(c.annualLabor),
    annualBurden: Math.round(c.annualBurden),
    annualSupplies: Math.round(c.annualSupplies),
    annualOverhead: Math.round(c.annualOverhead),
    annualAddons: Math.round(c.annualAddons),
    annualDirectCost: Math.round(c.annualDirectCost),
  };
}

/**
 * Apply an edit to a saved quote, returning a NEW quote object (immutable
 * update — the caller replaces the array entry). Bumps `version`, appends a
 * proper `versions[]` entry (matching commitRevise's shape), and stamps edit
 * tracking fields. Does NOT touch the quota — the caller does that separately
 * after the persist succeeds.
 *
 * @returns {{ quote:object, error:string|null }}
 */
export function applyEditToQuote(quote, fields, pricingDefaults, opts = {}) {
  const recalcResult = recalcResultFor(quote, fields, pricingDefaults);
  if (!recalcResult.ok) return { quote: null, error: recalcResult.error };

  const calc = recalcResult.calc;
  const pf = quotePriceFields(calc, recalcResult, fields);
  const curVer = Number(quote.version) || quote.versions?.length || 1;
  const nextVer = curVer + 1;
  const nowIso = new Date().toISOString();
  const reason = (fields.editReason || '').trim();

  const versions = Array.isArray(quote.versions) ? quote.versions.map((v) => ({ ...v })) : [];
  versions.push({
    v: nextVer,
    total: pf.monthly,
    date: 'Today',
    iso: nowIso,
    monthly: pf.monthly,
    annual: pf.annual,
    calcMonthly: pf.calcMonthly,
    override: null,
    discountPct: pf.discountPct,
    cleaners: pf.cleaners,
    hoursPerVisit: pf.hoursPerVisit,
    profileId: quote.profileId,
    margin: pf.margin,
    workspaceId: quote.workspaceId,
  });

  // Non-price fields the user may have changed.
  const next = { ...quote };
  if (fields.propertyName !== undefined) next.propertyName = String(fields.propertyName).trim();
  if (fields.companyName !== undefined) next.companyName = String(fields.companyName);
  if (fields.propertyAddress !== undefined) next.propertyAddress = String(fields.propertyAddress);
  if (fields.type !== undefined) next.type = String(fields.type);
  if (fields.frequency !== undefined) next.frequency = fieldNum(fields.frequency, quote.frequency);
  if (fields.sqft !== undefined) next.sqft = fieldNum(fields.sqft, quote.sqft);
  if (fields.floors !== undefined) next.floors = fieldNum(fields.floors, quote.floors);
  if (fields.package !== undefined) next.package = String(fields.package);
  if (fields.addons !== undefined) next.addons = fields.addons; // array passthrough (UI edits add-ons)

  // Price/patch snapshot.
  Object.assign(next, pf);

  next.status = quote.status || 'draft';
  next.version = nextVer;
  next.versions = versions;
  next.discountPct = pf.discountPct;
  next.editReason = reason || quote.editReason || null;
  next.modified = 'Just now';
  next.modifiedIso = nowIso;

  // Edit tracking metadata (separate from version history).
  const edits = Array.isArray(quote.editHistory) ? quote.editHistory.map((e) => ({ ...e })) : [];
  edits.push({
    at: nowIso,
    version: nextVer,
    reason: reason || null,
    by: opts.actor || null,
  });
  next.editHistory = edits;

  return { quote: next, error: null };
}

// ---- internal helpers ------------------------------------------------------

function recalcResultFor(quote, fields, pricingDefaults) {
  // recalculateQuote returns { ok, calc, error, finalMonthly, finalAnnual, discountPct }
  return recalculateQuote(quote, fields, pricingDefaults);
}

function normalizeDiscount(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return 0;
  return n;
}

function fieldNum(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback ?? 0);
}
