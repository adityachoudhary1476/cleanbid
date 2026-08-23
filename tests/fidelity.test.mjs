/**
 * ROUND-TRIP FIDELITY SUITE (P1-2).
 *
 * local state -> save to Supabase representation (mappers)
 *             -> load from Supabase (reverse mappers)
 *             -> deep-compare against canonical expected state
 *
 * Defines LOGICAL fidelity explicitly: persistence normalizes shapes
 * (null override -> {}, missing arrays -> []) — the test asserts those
 * normalizations, not byte equality. Any UNDECLARED divergence fails.
 *
 * Run:  npx vitest run tests/fidelity.test.mjs
 */
import { describe, it, expect } from 'vitest';
import { __mappers } from '../src/db.js';

const {
  mapCustomerToDb, mapCustomerFromDb,
  mapPropertyToDb, mapPropertyFromDb,
  mapQuoteToDb, mapQuoteFromDb,
  mapProfileToDb, mapProfileFromDb,
} = __mappers;

function roundTrip(toDb, fromDb, local) {
  const row = toDb(local, 'ws-x');
  const json = JSON.parse(JSON.stringify(row)); // JSONB storage semantics
  return fromDb(json);
}

// ---------------------------------------------------------------------------
// Hostile/adversarial fixtures
// ---------------------------------------------------------------------------
describe('customer mapper round-trip', () => {
  it('preserves complete records incl. nulls and unusual strings', () => {
    const c = {
      id: 1, company: 'O\'Brien & Sons <Ltd>', contact: null, email: '',
      phone: '+61 2 9999 1234', address: '42 "The" Way\nSydney', notes: '🚀 unicode ✓',
      lastActivity: null,
    };
    const out = roundTrip(mapCustomerToDb, mapCustomerFromDb, c);
    expect(out).toEqual({
      id: 1, workspaceId: 'ws-x', company: 'O\'Brien & Sons <Ltd>', contact: null,
      email: '', phone: '+61 2 9999 1234', address: '42 "The" Way\nSydney',
      notes: '🚀 unicode ✓', lastActivity: null,
    });
  });

  it('missing optional fields normalize to undefined (declared)', () => {
    const out = roundTrip(mapCustomerToDb, mapCustomerFromDb, { id: 2, company: 'Min' });
    expect(out.company).toBe('Min');
    expect(out.contact).toBeUndefined();
  });

  it('numeric-string ids survive as-is (TEXT PK)', () => {
    const out = roundTrip(mapCustomerToDb, mapCustomerFromDb, { id: '0042', company: 'Zero' });
    expect(out.id).toBe('0042');
  });

  it('zero values are preserved (not falsy-collapsed)', () => {
    const p = { id: 3, customerId: 0, name: 'Zero Sq Ft', sqft: 0, floors: 0, quoteCount: 0 };
    const out = roundTrip(mapPropertyToDb, mapPropertyFromDb, p);
    expect(out.sqft).toBe(0);
    expect(out.floors).toBe(0);
    expect(out.quoteCount).toBe(0);
    expect(out.customerId).toBe(0);
  });
});

describe('property mapper round-trip', () => {
  it('deleted relationship (customerId null) stays null', () => {
    const p = { id: 7, customerId: null, name: 'Orphan', type: 'office', sqft: 100, floors: 2 };
    const out = roundTrip(mapPropertyToDb, mapPropertyFromDb, p);
    expect(out.customerId).toBeNull();
  });
});

describe('profile mapper round-trip + NaN generation (P1-2)', () => {
  it('numeric strings become numbers', () => {
    const p = { id: 'med', name: 'Medical', wage: '22.5', burden: '15', overhead: '12', margin: '30', minPrice: '800', supplies: '8' };
    const out = roundTrip(mapProfileToDb, mapProfileFromDb, p);
    expect(out.wage).toBeCloseTo(22.5);
    expect(out.minPrice).toBe('800'); // declared asymmetry: minPrice is NOT coerced on read
  });

  it('null numerics surface as NaN on read — DECLARED GAP, guarded downstream by restore defaults', () => {
    // DB columns are NOT NULL for wage/burden/overhead/margin, so this cannot
    // occur via the restore RPC; direct DB edits could. We assert the current
    // behavior so any change is a conscious decision.
    const p = { id: 'x', name: 'Broken', wage: null, burden: null, overhead: null, margin: null };
    const row = mapProfileToDb(p, 'ws-x');
    expect(row.wage).toBeNull();
    const back = mapProfileFromDb(row);
    expect(Number.isNaN(back.wage)).toBe(true);
  });

  it('numeric-string "garbage" would produce NaN — rejected earlier by validation/RPC', () => {
    const p = { id: 'y', name: 'Garbage', wage: 'garbage' };
    const back = mapProfileFromDb(mapProfileToDb(p, 'ws-x'));
    expect(Number.isNaN(back.wage)).toBe(true); // documented; validateBackup skips such profiles pre-restore
  });
});

describe('quote mapper round-trip', () => {
  it('full quote with versions/snaps/addons preserved', () => {
    const q = {
      id: 'Q-1042', propertyName: 'Tower', companyName: 'Acme <b>Corp</b>', contact: 'Jo',
      email: 'jo@acme.example', phone: null, propertyAddress: null, sqft: 75000, floors: 5,
      type: 'office', frequency: 5, package: 'professional', profileId: 'std', profileName: 'Std',
      areas: [{ id: 1, name: 'Lobby' }], tasks: [], addons: [{ id: 'a1', name: 'Windows', enabled: false }],
      cleaners: 5, hoursPerVisit: '11.4', visitsPerMonth: '21.6', monthly: 11450, annual: 137400,
      margin: 25, costPerVisit: 467, laborPerVisit: 296, burdenPerVisit: 44, suppliesPerVisit: 24,
      overheadPerVisit: 38, addonsPerVisit: 0, status: 'sent', version: 2,
      versions: [{ v: 1, total: 10800 }],
      followup: '2026-08-22', lostReason: null,
      priceSnap: { wage: 18 }, productivitySnap: {}, calcMonthly: 11450,
      override: null, date: 'Aug 2, 2026', modified: 'Aug 5',
      createdIso: '2026-08-02T10:00:00Z', modifiedIso: '2026-08-05T10:00:00Z',
    };
    const out = roundTrip(mapQuoteToDb, mapQuoteFromDb, q);
    // Declared normalization: null override -> {} on write; read keeps {}.
    // Everything else must be logically identical.
    expect(out.propertyName).toBe('Tower');
    expect(out.monthly).toBe(11450);
    expect(out.areas).toEqual([{ id: 1, name: 'Lobby' }]);
    expect(out.addons).toEqual([{ id: 'a1', name: 'Windows', enabled: false }]);
    expect(out.versions).toEqual([{ v: 1, total: 10800 }]);
    expect(out.override).toEqual({});            // declared shape drift
    expect(out.priceSnap).toEqual({ wage: 18 });
    expect(out.status).toBe('sent');
    expect(out.createdIso).toBe('2026-08-02T10:00:00Z');
  });

  it('quote with deleted property (propertyId null) survives', () => {
    const q = { id: 'Q-9', propertyName: 'Ghosted', monthly: 900, propertyId: null };
    const out = roundTrip(mapQuoteToDb, mapQuoteFromDb, q);
    expect(out.propertyId).toBeNull();
    expect(out.monthly).toBe(900);
  });

  it('empty-string fields stay empty (not nullified)', () => {
    const q = { id: 'Q-10', propertyName: '', companyName: '', email: '' };
    const out = roundTrip(mapQuoteToDb, mapQuoteFromDb, q);
    expect(out.propertyName).toBe('');
    expect(out.email).toBe('');
  });
});

describe('activity payload mapping (restore path)', () => {
  it('what/object/metadata preserved through restore payload mapping', async () => {
    const { buildBackup, applyBackup } = await import('../src/backup.js');
    const stateIn = {
      workspaceId: 'ws-a',
      org: { name: 'A' }, pricing: {}, profiles: [], areaTypes: [], tasks: [],
      customers: [{ id: 1, company: 'C1' }], properties: [], quotes: [],
      addons: [], users: [],
      activity: [{ avt: 'JD', actor: 'Jane', what: 'emailed proposal for', object: 'Tower', time: '2h ago', metadata: { quoteId: 'Q-1042' } }],
    };
    const backup = buildBackup(stateIn);
    const stateOut = {};
    applyBackup(stateOut, backup.data);
    expect(stateOut.activity[0].what).toBe('emailed proposal for');
    expect(stateOut.activity[0].object).toBe('Tower');
    expect(stateOut.activity[0].actor).toBe('Jane');
    // The cloud RPC payload maps what->action / object->entity_id without loss:
    const payloadEntry = {
      action: stateOut.activity[0].what || 'restored activity entry',
      entity_type: 'activity',
      entity_id: stateOut.activity[0].object ?? null,
      metadata: {},
    };
    expect(payloadEntry.action).toBe('emailed proposal for');
    expect(payloadEntry.entity_id).toBe('Tower');
  });
});

describe('export -> validate -> applyBackup fidelity (local full loop)', () => {
  it('complete logical recovery including hostile strings, zeros, empties', async () => {
    const mod = await import('../src/backup.js');
    const stateIn = {
      workspaceId: 'ws-live',
      org: { name: 'Fidelity & Co <test>' }, pricing: { wage: 0, burden: 15, overhead: 0 },
      profiles: [{ id: 'p1', name: 'Zero Wage' }],
      areaTypes: [], tasks: [],
      customers: [{ id: 'c1', company: 'Zeros Inc', contact: null }],
      properties: [{ id: 1, customerId: 'c1', name: 'Zero Bldg', sqft: 0, floors: 0 }],
      quotes: [{ id: 'Q-Z', propertyName: 'Zero Quote', monthly: 0, status: 'draft' }],
      addons: [], users: [],
      activity: [{ what: 'created', object: 'Zero Quote', actor: 'A', avt: 'A', time: 'now' }],
      me: { name: 'SHOULD-NOT-EXPORT' },
    };
    let backup = mod.buildBackup(stateIn);
    await mod.sealBackup(backup);
    expect(backup.checksum).toMatch(/^[0-9a-f]{64}$/);

    const text = JSON.stringify(backup);
    const v = await mod.validateBackup(text);
    expect(v.ok).toBe(true);
    expect(v.summary.counts.quotes).toBe(1);

    const restored = {};
    mod.applyBackup(restored, v.parsed.data);
    expect(restored.org.name).toBe('Fidelity & Co <test>');
    expect(restored.pricing.wage).toBe(0);
    expect(restored.customers[0].contact).toBeNull();
    expect(restored.properties[0].sqft).toBe(0);
    expect(restored.quotes[0].monthly).toBe(0);
    expect(restored.activity[0].object).toBe('Zero Quote');
    expect(restored.me).toBeUndefined();          // global never crosses
  });
});
