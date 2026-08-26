/**
 * CleanBid — Quote-Edit Quota: PURE logic.
 *
 * DOM-free, dependency-free. Every function here is a deterministic
 * transformation of plain inputs so it can be unit-tested in plain Node
 * (zero deps) AND run in the browser. This module holds NO I/O — it only
 * computes the *next* quota state. The I/O (localStorage vs Supabase) lives
 * in src/quota.js, which calls these helpers.
 *
 * SECURITY NOTE: the real enforcement happens server-side (the
 * `consume_quote_edit` Postgres SECURITY DEFINER RPC in supabase-quota.sql),
 * which is atomic under a row lock. These pure helpers are the *validation*
 * and *projection* layer that the client uses to (a) decide whether to even
 * call the server and (b) render the quota UI. A user manipulating client
 * state can never increase `remaining` — the server re-checks
 * `used < quota` under lock before incrementing.
 */

export const DEFAULT_EDIT_QUOTA = 10;

/**
 * Normalize whatever the backend hands back into a safe { used, quota }.
 * Never trusts a single value; if quota is missing/default we fall back to
 * DEFAULT_EDIT_QUOTA so the UI always renders real, non-hardcoded figures.
 *
 * @param {object|null|undefined} raw
 * @param {object} [opts]
 * @param {number} [opts.defaultQuota]
 * @returns {{ used:number, quota:number, remaining:number, exhausted:boolean }}
 */
export function normalizeQuota(raw, opts = {}) {
  const defaultQuota = opts.defaultQuota ?? DEFAULT_EDIT_QUOTA;
  const q = typeof raw?.quota === 'number' && raw.quota > 0 ? raw.quota : defaultQuota;
  let used = typeof raw?.used === 'number' && raw.used >= 0 ? raw.used : 0;
  if (used > q) used = q; // never render more used than the cap
  const remaining = Math.max(0, q - used);
  return { used, quota: q, remaining, exhausted: remaining <= 0 };
}

/**
 * Pure projection used to PREVIEW the result of a successful edit (UI only).
 * Does NOT mutate anything. Returns null when the edit would be rejected.
 *
 * @param {{used:number,quota:number}} quota
 * @param {number} [n=1]
 * @returns {{used:number,quota:number,remaining:number,exhausted:boolean,wouldConsume:boolean}|null}
 */
export function previewConsume(quota, n = 1) {
  const { used, quota: q } = normalizeQuota(quota);
  const remaining = q - used;
  if (remaining <= 0) {
    return { used, quota: q, remaining: 0, exhausted: true, wouldConsume: false };
  }
  if (n <= 0) return { used, quota: q, remaining, exhausted: false, wouldConsume: false };
  const nextUsed = Math.min(q, used + n);
  return {
    used: nextUsed,
    quota: q,
    remaining: q - nextUsed,
    exhausted: q - nextUsed <= 0,
    wouldConsume: true,
  };
}

/**
 * Compute the NEXT quota state after exactly one successful edit.
 * Pure: caller is responsible for persisting the returned value.
 * Returns null when the quota is already exhausted (rejected).
 */
export function consumeOne(quota) {
  const cur = normalizeQuota(quota);
  if (cur.remaining <= 0) return null;
  const nextUsed = cur.used + 1;
  return {
    used: nextUsed,
    quota: cur.quota,
    remaining: cur.quota - nextUsed,
    exhausted: cur.quota - nextUsed <= 0,
  };
}

/**
 * Validate a single editable quote field. Returns a map of errors; empty
 * object means all good. Keeps the validation rules in ONE place so the UI,
 * the engine call, and the tests agree.
 *
 * @param {object} fields
 * @returns {Record<string,string>}
 */
export function validateEditFields(fields) {
  const errors = {};
  const num = (k) => (fields[k] === '' || fields[k] === null || fields[k] === undefined ? NaN : Number(fields[k]));

  // Property / job
  if (fields.propertyName !== undefined && !String(fields.propertyName ?? '').trim()) {
    errors.propertyName = 'Property name is required.';
  }
  const sqft = num('sqft');
  if (Number.isNaN(sqft) || sqft < 0) errors.sqft = 'Square footage must be 0 or more.';

  const freq = num('frequency');
  if (Number.isNaN(freq) || freq <= 0) errors.frequency = 'Frequency must be greater than 0 (visits/week).';

  // Labour
  const cleaners = num('cleaners');
  if (Number.isNaN(cleaners) || cleaners < 1 || !Number.isInteger(cleaners)) errors.cleaners = 'Cleaners must be a whole number of 1 or more.';

  const hours = num('hoursPerVisit');
  if (Number.isNaN(hours) || hours <= 0) errors.hoursPerVisit = 'Hours per visit must be greater than 0.';

  const wage = num('wage');
  if (Number.isNaN(wage) || wage < 0) errors.wage = 'Labor rate cannot be negative.';

  const burden = num('burden');
  if (Number.isNaN(burden) || burden < 0 || burden > 100) errors.burden = 'Burden must be 0–100%.';

  // Costs
  const supplies = num('supplies');
  if (Number.isNaN(supplies) || supplies < 0 || supplies > 100) errors.supplies = 'Supplies must be 0–100%.';

  const overhead = num('overhead');
  if (Number.isNaN(overhead) || overhead < 0 || overhead > 100) errors.overhead = 'Overhead must be 0–100%.';

  // Pricing
  const margin = num('margin');
  if (Number.isNaN(margin) || margin < 0 || margin >= 100) errors.margin = 'Target margin must be 0–99.99%.';

  const discount = num('discount');
  if (fields.discount !== undefined && fields.discount !== '' && (Number.isNaN(discount) || discount < 0 || discount > 100)) {
    errors.discount = 'Discount must be 0–100%.';
  }

  const discountAmt = num('discountAmount');
  if (fields.discountAmount !== undefined && fields.discountAmount !== '' && (Number.isNaN(discountAmt) || discountAmt < 0)) {
    errors.discountAmount = 'Discount amount cannot be negative.';
  }

  return errors;
}

/**
 * Build the canonical engine `profile` object for an edited quote from the
 * editable fields. This is INPUT NORMALIZATION ONLY — it never computes a
 * price. The signature pulls from the quote's stored priceSnap so each quote
 * keeps its own baseline (mirrors computeQuoteTierPrices), then overlays the
 * edited values.
 *
 * @param {object} quote  the saved quote (needs priceSnap/productivitySnap)
 * @param {object} fields the editable field values
 * @param {object} [pricingDefaults] global fallback pricing
 */
export function buildEditProfile(quote, fields, pricingDefaults) {
  const snap = quote?.priceSnap || pricingDefaults || {};
  const prod = quote?.productivitySnap || pricingDefaults?.productivity || {};
  return {
    wage: fieldNum(fields.wage, snap.wage),
    burden: fieldNum(fields.burden, snap.burden),
    overhead: fieldNum(fields.overhead, snap.overhead),
    margin: fieldNum(fields.margin, snap.margin),
    minPrice: fieldNum(fields.minPrice, snap.minPrice ?? pricingDefaults?.minPrice ?? 800),
    supplies: fieldNum(fields.supplies, snap.supplies ?? pricingDefaults?.supplies ?? 8),
    productivity: prod,
  };
}

function fieldNum(v, fallback) {
  const n = (v === '' || v === null || v === undefined) ? NaN : Number(v);
  return Number.isFinite(n) ? n : (fallback ?? 0);
}
