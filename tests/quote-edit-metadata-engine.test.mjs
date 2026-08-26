/**
 * Regression tests for the pre-production audit fixes:
 *   H1 — editHistory / discountPct / whyOverrides persist (db.js mappers)
 *   H2 — single pricing engine (edit recalculation == authoritative engine)
 *   C2 — applyEditToQuote never mutates the original quote's add-ons
 *
 * Run with:  npx vitest run
 */
import { describe, it, expect } from 'vitest';
import { __mappers } from '../src/db.js';
const { mapQuoteToDb, mapQuoteFromDb } = __mappers;
import { calculatePricing } from '../01-pricing-engine.js';
import { recalculateQuote, applyEditToQuote, buildEditEngineInput } from '../src/quote-edit.js';

const PRICING = { wage: 18, burden: 15, overhead: 12, margin: 25, minPrice: 800, supplies: 8, productivity: { office: 2800 } };

function baseQuote(over = {}) {
  return {
    id: 'Q-1', workspaceId: 'ws-1', propertyName: 'Westbrook', companyName: 'Acme',
    sqft: 50000, floors: 1, type: 'office', frequency: 2, package: 'professional',
    profileId: 'std', areas: [], tasks: [],
    cleaners: 4, hoursPerVisit: 10, visitsPerMonth: 8.7, monthly: 4000, annual: 48000,
    margin: 25, status: 'sent', version: 1,
    versions: [{ v: 1, total: 4000, monthly: 4000, annual: 48000 }],
    priceSnap: { wage: 18, burden: 15, overhead: 12, margin: 25, minPrice: 800, supplies: 8 },
    productivitySnap: { office: 2800 },
    addons: [{ id: 'ad-win', name: 'Window', method: 'sqft', value: 0.04, enabled: true }],
    ...over,
  };
}

describe('H1 — quote metadata persists through db mappers', () => {
  it('editHistory round-trips', () => {
    const q = baseQuote();
    q.editHistory = [{ at: '2026-08-26T00:00:00Z', version: 2, reason: 'Cut frequency', by: 'Jane' }];
    const row = mapQuoteToDb(q, 'ws-1');
    expect(row.edit_history).toEqual(q.editHistory);
    const back = mapQuoteFromDb({ ...row, id: 'Q-1', workspace_id: 'ws-1' });
    expect(back.editHistory).toEqual(q.editHistory);
  });

  it('discountPct round-trips (including 0)', () => {
    const q = baseQuote();
    q.discountPct = 10;
    const back = mapQuoteFromDb(mapQuoteToDb(q, 'ws-1'));
    expect(back.discountPct).toBe(10);

    const q0 = baseQuote();
    q0.discountPct = 0;
    const back0 = mapQuoteFromDb(mapQuoteToDb(q0, 'ws-1'));
    expect(back0.discountPct).toBe(0);
  });

  it('whyOverrides round-trips', () => {
    const q = baseQuote();
    q.whyOverrides = { wage: 20, crewHoursOverride: 12 };
    const back = mapQuoteFromDb(mapQuoteToDb(q, 'ws-1'));
    expect(back.whyOverrides).toEqual(q.whyOverrides);
  });

  it('existing quotes without these fields still load safely (NULL -> defaults)', () => {
    const row = {
      id: 'Q-OLD', workspace_id: 'ws-1', property_name: 'Legacy', company_name: 'OldCo',
      sqft: 1000, monthly: 100, annual: 1200, version: 1, versions: [],
      // edit_history / discount_pct / why_overrides intentionally absent
    };
    const back = mapQuoteFromDb(row);
    expect(back.editHistory).toEqual([]);
    expect(back.discountPct).toBe(0);
    expect(back.whyOverrides).toEqual({});
  });

  it('mapQuoteToDb emits the new columns (sanity)', () => {
    const row = mapQuoteToDb(baseQuote(), 'ws-1');
    expect('edit_history' in row).toBe(true);
    expect('discount_pct' in row).toBe(true);
    expect('why_overrides' in row).toBe(true);
  });
});

describe('H2 — edit recalculation uses the ONE authoritative engine', () => {
  const fields = {
    sqft: 60000, frequency: 3, cleaners: 5, hoursPerVisit: 12,
    wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25, discount: 0,
  };

  it('recalculateQuote output equals calculatePricing directly', () => {
    const q = baseQuote();
    const res = recalculateQuote(q, fields, PRICING);
    expect(res.ok).toBe(true);
    const input = buildEditEngineInput(q, fields, PRICING);
    const direct = calculatePricing(input);
    expect(res.calc.monthly).toBeCloseTo(direct.monthly, 5);
    expect(res.calc.annual).toBeCloseTo(direct.annual, 5);
  });

  it('changing inputs changes the price through the engine (no second formula)', () => {
    const q = baseQuote();
    const base = recalculateQuote(q, { sqft: 50000, frequency: 2, cleaners: 4, hoursPerVisit: 10, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25, discount: 0 }, PRICING);
    const cheaper = recalculateQuote(q, { sqft: 50000, frequency: 1, cleaners: 2, hoursPerVisit: 5, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25, discount: 0 }, PRICING);
    expect(cheaper.finalMonthly).toBeLessThan(base.finalMonthly);
  });

  it('discount is folded in after canonical math, matching builder override semantics', () => {
    const q = baseQuote();
    const noDisc = recalculateQuote(q, { sqft: 50000, frequency: 2, cleaners: 4, hoursPerVisit: 10, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25, discount: 0 }, PRICING);
    const disc = recalculateQuote(q, { sqft: 50000, frequency: 2, cleaners: 4, hoursPerVisit: 10, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25, discount: 10 }, PRICING);
    expect(disc.finalMonthly).toBe(Math.round(noDisc.finalMonthly * 0.9));
  });
});

describe('C2 — applyEditToQuote never mutates the original quote', () => {
  it('original quote add-ons are unchanged after edit (cancel safety)', () => {
    const q = baseQuote();
    const original = JSON.parse(JSON.stringify(q.addons));
    const fields = {
      sqft: 60000, frequency: 3, cleaners: 5, hoursPerVisit: 12,
      wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25, discount: 0,
      addons: [{ id: 'ad-win', name: 'Window', method: 'sqft', value: 0.09, enabled: false }],
    };
    const { quote } = applyEditToQuote(q, fields, PRICING, { actor: 'Jane' });
    // original untouched
    expect(q.addons).toEqual(original);
    expect(q.addons[0].enabled).toBe(true);
    expect(q.addons[0].value).toBe(0.04);
    // result reflects the edit
    expect(quote.addons[0].enabled).toBe(false);
    expect(quote.addons[0].value).toBe(0.09);
  });

  it('original quote scalar fields are unchanged after edit', () => {
    const q = baseQuote();
    const before = { sqft: q.sqft, monthly: q.monthly, version: q.version };
    applyEditToQuote(q, { sqft: 99999, frequency: 5, cleaners: 9, hoursPerVisit: 20, wage: 30, burden: 20, supplies: 10, overhead: 15, margin: 40, discount: 5 }, PRICING, {});
    expect(q.sqft).toBe(before.sqft);
    expect(q.monthly).toBe(before.monthly);
    expect(q.version).toBe(before.version);
  });

  it('produces exactly one new version (no duplicate revisions)', () => {
    const q = baseQuote();
    const { quote } = applyEditToQuote(q, { sqft: 60000, frequency: 3, cleaners: 5, hoursPerVisit: 12, wage: 18, burden: 15, supplies: 8, overhead: 12, margin: 25, discount: 0 }, PRICING, {});
    expect(quote.version).toBe(2);
    expect(quote.versions.length).toBe(2);
    expect(quote.versions[1].v).toBe(2);
  });
});
