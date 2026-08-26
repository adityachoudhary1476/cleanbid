/**
 * Unit tests for the quote-editing logic + edit-quota core.
 * No DOM, no Supabase — exercises the pure modules (src/quota-core.js,
 * src/quote-edit.js) so we can assert the pricing engine stays the single
 * source of truth and that quota math is correct.
 *
 * Run with:  npx vitest run
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeQuota, previewConsume, consumeOne, validateEditFields,
  buildEditProfile,
} from '../src/quota-core.js';
import {
  buildEditEngineInput, recalculateQuote, quotePriceFields, applyEditToQuote,
} from '../src/quote-edit.js';
import { calculatePricing } from '../01-pricing-engine.js';

// A representative saved quote (mirrors what mapQuoteToDb produces).
function makeQuote(over = {}) {
  return {
    id: 'Q-1', workspaceId: 'ws-1', propertyName: 'Westbrook', companyName: 'Acme',
    sqft: 50000, floors: 1, type: 'office', frequency: 2, package: 'professional',
    profileId: 'std', areas: [], tasks: [],
    cleaners: 4, hoursPerVisit: 10, visitsPerMonth: 8.7, monthly: 4000, annual: 48000,
    margin: 25, status: 'sent', version: 1,
    versions: [{ v: 1, total: 4000, monthly: 4000, annual: 48000 }],
    priceSnap: { wage: 18, burden: 15, overhead: 12, margin: 25, minPrice: 800, supplies: 8 },
    productivitySnap: { office: 2800 },
    addons: [],
    ...over,
  };
}

const PRICING = { wage: 18, burden: 15, overhead: 12, margin: 25, minPrice: 800, supplies: 8, productivity: { office: 2800 } };

describe('quota-core: normalize + consume', () => {
  it('normalizes missing/null quota to a safe default', () => {
    const q = normalizeQuota(null);
    expect(q.quota).toBe(10); // DEFAULT_EDIT_QUOTA
    expect(q.used).toBe(0);
    expect(q.remaining).toBe(10);
    expect(q.exhausted).toBe(false);
  });

  it('never reports more used than quota', () => {
    const q = normalizeQuota({ used: 99, quota: 10 });
    expect(q.used).toBe(10);
    expect(q.remaining).toBe(0);
    expect(q.exhausted).toBe(true);
  });

  it('previewConsume returns wouldConsume=false when exhausted', () => {
    const p = previewConsume({ used: 10, quota: 10 });
    expect(p.wouldConsume).toBe(false);
    expect(p.exhausted).toBe(true);
  });

  it('consumeOne returns null when exhausted (cannot go negative)', () => {
    expect(consumeOne({ used: 10, quota: 10 })).toBeNull();
  });

  it('consumeOne increments by exactly one when remaining', () => {
    const n = consumeOne({ used: 3, quota: 10 });
    expect(n.used).toBe(4);
    expect(n.remaining).toBe(6);
  });
});

describe('quote-edit: engine recalculation (single source of truth)', () => {
  it('recalculates through the canonical engine (not a second formula)', () => {
    const q = makeQuote();
    const fields = { sqft: 50000, frequency: 2, cleaners: 4, hoursPerVisit: 10, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25 };
    const res = recalculateQuote(q, fields, PRICING);
    expect(res.ok).toBe(true);
    // Cross-check: the recalculation must equal calculatePricing() directly.
    const input = buildEditEngineInput(q, fields, PRICING);
    const direct = calculatePricing(input);
    expect(res.calc.monthly).toBeCloseTo(direct.monthly, 5);
    expect(res.calc.annual).toBeCloseTo(direct.annual, 5);
  });

  it('changing cleaners/hours/frequency changes the price', () => {
    const q = makeQuote();
    const base = recalculateQuote(q, { sqft: 50000, frequency: 2, cleaners: 4, hoursPerVisit: 10, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25 }, PRICING);
    const cheaper = recalculateQuote(q, { sqft: 50000, frequency: 1, cleaners: 2, hoursPerVisit: 5, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25 }, PRICING);
    expect(cheaper.finalMonthly).toBeLessThan(base.finalMonthly);
  });

  it('applies an optional discount after canonical math', () => {
    const q = makeQuote();
    const noDisc = recalculateQuote(q, { sqft: 50000, frequency: 2, cleaners: 4, hoursPerVisit: 10, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25, discount: 0 }, PRICING);
    const disc = recalculateQuote(q, { sqft: 50000, frequency: 2, cleaners: 4, hoursPerVisit: 10, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25, discount: 10 }, PRICING);
    expect(disc.finalMonthly).toBe(Math.round(noDisc.finalMonthly * 0.9));
  });

  it('returns ok=false for invalid pricing inputs', () => {
    const q = makeQuote();
    const res = recalculateQuote(q, { sqft: 50000, frequency: 2, cleaners: 4, hoursPerVisit: 10, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 105 }, PRICING);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/margin/i);
  });
});

describe('quote-edit: applyEditToQuote (versioning + tracking)', () => {
  it('bumps version and appends a proper versions[] entry', () => {
    const q = makeQuote();
    const { quote, error } = applyEditToQuote(q, { sqft: 60000, frequency: 3, cleaners: 5, hoursPerVisit: 12, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25 }, PRICING);
    expect(error).toBeNull();
    expect(quote.version).toBe(2);
    expect(quote.versions.length).toBe(2);
    expect(quote.versions[1].v).toBe(2);
    expect(quote.modifiedIso).toBeTruthy();
    // original object is NOT mutated (immutable update)
    expect(q.version).toBe(1);
  });

  it('records edit history metadata', () => {
    const q = makeQuote();
    const { quote } = applyEditToQuote(q, { sqft: 60000, frequency: 3, cleaners: 5, hoursPerVisit: 12, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25, editReason: 'Customer cut frequency' }, PRICING);
    expect(quote.editHistory.length).toBe(1);
    expect(quote.editHistory[0].reason).toBe('Customer cut frequency');
  });

  it('produces price fields matching the recalculated engine output', () => {
    const q = makeQuote();
    const fields = { sqft: 60000, frequency: 3, cleaners: 5, hoursPerVisit: 12, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25 };
    const { quote } = applyEditToQuote(q, fields, PRICING);
    const res = recalculateQuote(q, fields, PRICING);
    expect(quote.monthly).toBe(res.finalMonthly);
    expect(quote.annual).toBe(res.finalAnnual);
    expect(quote.margin).toBeCloseTo(res.calc.targetMargin, 5);
  });
});

describe('quota-core: validateEditFields', () => {
  it('accepts a fully valid field set', () => {
    const errs = validateEditFields({ propertyName: 'X', sqft: 1000, frequency: 2, cleaners: 2, hoursPerVisit: 5, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25 });
    expect(Object.keys(errs).length).toBe(0);
  });
  it('rejects negative sqft, zero cleaners, bad margin', () => {
    const errs = validateEditFields({ sqft: -5, cleaners: 0, margin: 120 });
    expect(errs.sqft).toBeTruthy();
    expect(errs.cleaners).toBeTruthy();
    expect(errs.margin).toBeTruthy();
  });
  it('rejects non-integer cleaners', () => {
    const errs = validateEditFields({ cleaners: 2.5 });
    expect(errs.cleaners).toBeTruthy();
  });
});
