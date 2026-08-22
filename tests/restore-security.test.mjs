/**
 * RESTORE SECURITY SUITE (P0-1 / P0-2).
 *
 * Models REAL Supabase semantics after the fix: global TEXT primary keys,
 * RLS USING+WITH CHECK, workspace_id-immutability triggers, and the atomic
 * `restore_workspace_backup` RPC (shadow-copy commit/rollback).
 *
 * Run:  npx vitest run tests/restore-security.test.mjs
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/supabase.js', () => {
  let currentMock = null;
  return {
    __setSupabaseMock: (m) => { currentMock = m; },
    get supabase() { if (!currentMock) throw new Error('no supabase mock installed'); return currentMock; },
    isSupabaseConfigured: true,
  };
});
import { __setSupabaseMock } from '../src/supabase.js';
import { initDb, setCurrentWorkspaceId, restoreStateToSupabase } from '../src/db.js';

// ---------------------------------------------------------------------------
// Postgres-faithful in-memory model
// ---------------------------------------------------------------------------
function makePg() {
  const t = {
    workspaces: new Map(), customers: new Map(), properties: new Map(),
    quotes: new Map(), pricing_profiles: new Map(), activity_log: new Map(),
    workspace_members: new Map(),
  };
  const authUser = { uid: null };
  const isMember = (ws) => !!ws && [...t.workspace_members.values()].some((m) => m.workspace_id === ws && m.user_id === authUser.uid);
  let actSeq = 0;
  const filterByWs = (table, ws) => [...t[table]].filter(([, r]) => r.workspace_id !== ws).reduce((m, [k, v]) => (m.set(k, v), m), new Map());

  const api = {
    tables: t,
    auth: authUser,
    seedWorkspace(id, name = id) { t.workspaces.set(id, { id, name }); },
    addMember(ws, user) { t.workspace_members.set(ws + ':' + user, { workspace_id: ws, user_id: user }); },
    login(uid) { authUser.uid = uid; },
    insert(table, rows) { for (const r of rows) t[table].set(r.id ?? 'act-' + (++actSeq), structuredClone(r)); },
    snapshot(table) { return JSON.stringify([...t[table].entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))); },
    counts(table, ws) { return [...t[table].values()].filter((r) => r.workspace_id === ws).length; },

    from(table) {
      const q = {
        upsert(rows) {
          for (const r of rows) {
            const existing = t[table].get(r.id);
            if (existing) {
              if (!isMember(existing.workspace_id)) return Promise.resolve({ error: { message: 'RLS UPDATE blocked (USING)' } });
              if (!isMember(r.workspace_id)) return Promise.resolve({ error: { message: 'RLS UPDATE blocked (WITH CHECK)' } });
              if (r.workspace_id !== existing.workspace_id) return Promise.resolve({ error: { message: 'workspace_id is immutable' } });
              t[table].set(r.id, { ...existing, ...r });
            } else {
              if (!isMember(r.workspace_id)) return Promise.resolve({ error: { message: 'RLS INSERT blocked (WITH CHECK)' } });
              t[table].set(r.id, structuredClone(r));
            }
          }
          return Promise.resolve({ error: null });
        },
        select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        delete() {
          return { eq(col, val) {
            for (const [id, row] of [...t[table]]) if (row[col] === val && isMember(val)) t[table].delete(id);
            return Promise.resolve({ error: null });
          } };
        },
      };
      return q;
    },

    async rpc(fn, args) { return pgRpc(api, fn, args, filterByWs); },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Faithful port of supabase-restore-rpc.sql: server-side identity gate,
// workspace-scoped deletes + inserts, atomic commit-or-rollback.
// ---------------------------------------------------------------------------
function pgRpc(api, fn, args, filterByWs) {
  const t = api.tables;
  if (fn !== 'restore_workspace_backup') return Promise.resolve({ data: null, error: { message: 'unknown function ' + fn } });
  const { p_target_workspace, p_payload } = args;
  if (!api.auth.uid) return Promise.resolve({ data: null, error: { message: 'restore refused: caller is not authenticated' } });
  if (!t.workspaces.has(p_target_workspace)) return Promise.resolve({ data: null, error: { message: 'restore refused: target workspace does not exist' } });
  const member = [...t.workspace_members.values()].some((m) => m.workspace_id === p_target_workspace && m.user_id === api.auth.uid);
  if (!member) return Promise.resolve({ data: null, error: { message: 'restore refused: caller is not a member of the target workspace' } });

  const num = (j, k) => {
    if (j?.[k] === null || j?.[k] === undefined || j?.[k] === '') return null;
    const v = Number(j[k]);
    if (Number.isNaN(v)) throw new Error('invalid input syntax for type numeric: "' + String(j[k]) + '"'); // Postgres-faithful
    return v;
  };
  const int = (j, k) => { const v = num(j, k); return v === null || Number.isNaN(v) ? null : Math.trunc(v); };
  const txt = (j, k) => (j?.[k] === null || j?.[k] === undefined || j?.[k] === '') ? null : String(j[k]);
  const ts = (j, k) => (j?.[k] ? new Date(j[k]).toISOString() : null);
  const uid = () => globalThis.crypto.randomUUID();

  const P = JSON.parse(JSON.stringify(p_payload)); // JSONB round-trip
  const ws = p_target_workspace;

  // Atomicity: mutate a SHADOW copy; commit only on full success.
  let shadow;
  try {
    shadow = {};
    for (const k of Object.keys(t)) shadow[k] = new Map(t[k]);

    shadow.activity_log = filterByWs('activity_log', ws);
    shadow.quotes = filterByWs('quotes', ws);
    shadow.pricing_profiles = filterByWs('pricing_profiles', ws);
    shadow.properties = filterByWs('properties', ws);
    shadow.customers = filterByWs('customers', ws);

    const wrow = shadow.workspaces.get(ws);
    shadow.workspaces.set(ws, { ...wrow,
      branding: P.org ?? {}, pricing_defaults: P.pricing ?? {},
      addons: P.addons ?? [], tasks: P.tasks ?? [], area_types: P.area_types ?? [],
    });

    let actSeq = 0;
    const sid = () => 'act-' + (++actSeq);

    // Shared ID policy across all entity kinds (mirrors the RPC exactly):
    // free id -> keep; own-workspace id -> keep (its row was just replaced);
    // foreign-owned id -> fresh identity so B's key is never stolen.
    const resolveId = (shadowMap, rawId) => {
      let id = String(rawId ?? uid());
      const owner = [...shadowMap.values()].find((x) => x.id === id);
      if (owner && owner.workspace_id !== ws) id = uid();
      return id;
    };

    for (const r of P.customers || []) {
      const id = resolveId(shadow.customers, r.id);
      shadow.customers.set(id, {
        id, workspace_id: ws, // SERVER-derived identity; payload ids never trusted
        company: r.company ?? '(unnamed customer)',
        contact: txt(r, 'contact'), email: txt(r, 'email'), phone: txt(r, 'phone'),
        address: txt(r, 'address'), notes: txt(r, 'notes'), last_activity: txt(r, 'lastActivity'),
      });
    }
    // Properties ------------------------------------------------------
    for (const r of P.properties || []) {
      const id = resolveId(shadow.properties, r.id);
      shadow.properties.set(id, {
        id, workspace_id: ws, customer_id: txt(r, 'customerId'),
        name: r.name ?? '(unnamed property)', address: txt(r, 'address'),
        type: txt(r, 'type') ?? 'office', sqft: int(r, 'sqft'), floors: int(r, 'floors') ?? 1,
        quote_count: int(r, 'quoteCount') ?? 0, last_quoted: txt(r, 'lastQuoted'),
      });
    }
    for (const r of P.profiles || []) {
      const id = resolveId(shadow.pricing_profiles, r.id);
      shadow.pricing_profiles.set(id, {
        id, workspace_id: ws, name: r.name ?? '(unnamed profile)',
        wage: num(r, 'wage') ?? 0, burden: num(r, 'burden') ?? 0,
        overhead: num(r, 'overhead') ?? 0, margin: num(r, 'margin') ?? 0,
        min_price: int(r, 'minPrice') ?? 800, supplies: num(r, 'supplies') ?? 8,
        productivity: r.productivity ?? {}, is_default: !!r.is_default,
      });
    }
    for (const r of P.quotes || []) {
      const id = resolveId(shadow.quotes, r.id);
      shadow.quotes.set(id, {
        id, workspace_id: ws, property_id: txt(r, 'propertyId'),
        property_name: r.propertyName ?? r.property_name ?? '(unnamed property)',
        company_name: r.companyName ?? r.company_name ?? '(unknown company)',
        contact: txt(r, 'contact'), email: txt(r, 'email'), phone: txt(r, 'phone'),
        property_address: txt(r, 'propertyAddress'), sqft: int(r, 'sqft'),
        floors: int(r, 'floors') ?? 1, type: txt(r, 'type') ?? 'office',
        frequency: num(r, 'frequency') ?? 2, package: txt(r, 'package') ?? 'professional',
        profile_id: txt(r, 'profileId'), profile_name: txt(r, 'profileName'),
        areas: r.areas ?? [], tasks: r.tasks ?? [], addons: r.addons ?? [],
        cleaners: int(r, 'cleaners'), hours_per_visit: num(r, 'hoursPerVisit'),
        visits_per_month: num(r, 'visitsPerMonth'), monthly: int(r, 'monthly'), annual: int(r, 'annual'),
        margin: num(r, 'margin'), cost_per_visit: int(r, 'costPerVisit'),
        labor_per_visit: int(r, 'laborPerVisit'), burden_per_visit: int(r, 'burdenPerVisit'),
        supplies_per_visit: int(r, 'suppliesPerVisit'), overhead_per_visit: int(r, 'overheadPerVisit'),
        addons_per_visit: int(r, 'addonsPerVisit'),
        status: txt(r, 'status') ?? 'draft', version: int(r, 'version') ?? 1,
        versions: r.versions ?? [], followup: ts(r, 'followup'),
        lost_reason: txt(r, 'lostReason'), price_snap: r.priceSnap ?? {},
        productivity_snap: r.productivitySnap ?? {}, calc_monthly: int(r, 'calcMonthly'),
        override: r.override ?? {}, date: txt(r, 'date'), modified: txt(r, 'modified'),
        created_iso: ts(r, 'createdIso') ?? new Date().toISOString(),
        modified_iso: ts(r, 'modifiedIso') ?? new Date().toISOString(),
      });
    }
    for (const r of P.activity || []) {
      shadow.activity_log.set(sid(), {
        workspace_id: ws, user_id: null,
        action: r.action ?? r.what ?? 'restored activity entry',
        entity_type: r.entity_type ?? 'activity', entity_id: r.entity_id ?? null,
        metadata: r.metadata ?? {},
        created_at: ts(r, 'created_at') ?? new Date().toISOString(),
      });
    }

    // COMMIT
    for (const k of Object.keys(shadow)) t[k] = shadow[k];
    return Promise.resolve({ data: { workspace_id: ws, counts: {
      customers: P.customers?.length ?? 0, properties: P.properties?.length ?? 0,
      quotes: P.quotes?.length ?? 0, profiles: P.profiles?.length ?? 0,
      activity: P.activity?.length ?? 0,
    } }, error: null });
  } catch (e) {
    // ROLLBACK — shadow discarded, live tables untouched.
    return Promise.resolve({ data: null, error: { message: 'restore failed atomically: ' + e.message } });
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const WSA = '11111111-1111-1111-1111-111111111111';
const WSB = '22222222-2222-2222-2222-222222222222';
const WSC = '33333333-3333-3333-3333-333333333333';
const USER = '99999999-9999-9999-9999-999999999999';

let pg;
beforeEach(() => {
  pg = makePg();
  pg.seedWorkspace(WSA, 'A');
  pg.seedWorkspace(WSB, 'B');
  pg.seedWorkspace(WSC, 'C');
  pg.login(USER);
  pg.addMember(WSA, USER);
  pg.addMember(WSB, USER); // user is a member of BOTH A and B — the dangerous case
});

async function cloudRestore(state, targetWs) {
  __setSupabaseMock(pg);
  await initDb();
  setCurrentWorkspaceId(targetWs);
  return restoreStateToSupabase(state, targetWs);
}

describe('P0-1 Test A — B backup into A must never touch B (overlapping IDs)', () => {
  it('restores into A only; B stays byte-for-byte identical', async () => {
    pg.insert('customers', [{ id: 'c1', workspace_id: WSB, company: 'B original' }]);
    pg.insert('quotes', [{ id: 'Q-1042', workspace_id: WSB, property_name: 'B tower', monthly: 7000 }]);
    const bBefore = { c: pg.snapshot('customers'), q: pg.snapshot('quotes') };

    await cloudRestore({
      org: { name: 'B Co' }, pricing: { wage: 20 },
      customers: [{ id: 'c1', company: 'B restored into A', contact: null }],
      properties: [], quotes: [{ id: 'Q-1042', propertyName: 'UPDATE-attempt-on-B-row', monthly: 111 }],
      profiles: [], areaTypes: [], tasks: [], addons: [], users: [], activity: [],
    }, WSA);

    // A now contains the restored records under A's ownership.
    // NOTE: because customers.id / quotes.id are GLOBAL primary keys, an id
    // owned by B physically cannot be reused by A. The server therefore mints
    // a fresh id for A's copy (remap) — the LOGICAL record is restored, the
    // colliding identifier is not stolen. This is the only correct outcome
    // compatible with the existing schema.
    const aCust = [...pg.tables.customers.values()].find((r) => r.workspace_id === WSA);
    expect(aCust.company).toBe('B restored into A');
    expect(aCust.id).not.toBe('c1');            // fresh identity, no theft of B's key
    const aQuote = [...pg.tables.quotes.values()].find((r) => r.workspace_id === WSA);
    expect(aQuote.monthly).toBe(111);
    expect(aQuote.id).not.toBe('Q-1042');
    // B's ORIGINAL rows remain untouched (the old code would have stolen them).
    expect(pg.counts('customers', WSB)).toBe(1);
    expect(pg.counts('quotes', WSB)).toBe(1);
    const bCust = [...pg.tables.customers.values()].find((r) => r.workspace_id === WSB);
    expect(bCust.company).toBe('B original');
    expect(bCust.id).toBe('c1');                // same key AND same values as before
    const bQuote = [...pg.tables.quotes.values()].find((r) => r.workspace_id === WSB);
    expect(bQuote.monthly).toBe(7000);
    // C untouched entirely.
    expect(pg.counts('customers', WSC)).toBe(0);
    expect(pg.counts('quotes', WSC)).toBe(0);
  });
});

describe('P0-1 Test B — replace semantics inside A (ghost deletion)', () => {
  it('Q1 kept/restored, Q2/Q3 deleted, reload matches', async () => {
    pg.insert('quotes', [
      { id: 'Q-1', workspace_id: WSA, property_name: 'one', monthly: 100 },
      { id: 'Q-2', workspace_id: WSA, globalThis: undefined, monthly: 200 },
      { id: 'Q-3', workspace_id: WSA, property_name: 'three', monthly: 300 },
    ]);
    await cloudRestore({
      org: { name: 'A' }, pricing: {},
      customers: [], properties: [], profiles: [],
      quotes: [{ id: 'Q-1', propertyName: 'kept-restored', monthly: 555 }],
      areaTypes: [], tasks: [], addons: [], users: [], activity: [],
    }, WSA);

    const ids = [...pg.tables.quotes.values()].filter((r) => r.workspace_id === WSA).map((r) => r.id);
    expect(ids.sort()).toEqual(['Q-1']);          // ghosts gone
    expect(pg.tables.quotes.get('Q-1').monthly).toBe(555);
    expect(pg.counts('quotes', WSA)).toBe(1);     // reload would read exactly this
  });
});

describe('P0-1 Test C — foreign workspace_id smuggled in payload is ignored', () => {
  it('server stamps rows with the verified active workspace', async () => {
    await cloudRestore({
      org: { name: 'A' }, pricing: {},
      customers: [{ id: 'cX', workspaceId: WSB, company: 'smuggled' }],
      quotes: [{ id: 'Q-X', workspaceId: WSC, propertyName: 'x', monthly: 1 }],
      properties: [], profiles: [], areaTypes: [], tasks: [], addons: [], users: [], activity: [],
    }, WSA);

    expect(pg.tables.customers.get('cX').workspace_id).toBe(WSA);
    expect(pg.tables.quotes.get('Q-X').workspace_id).toBe(WSA);
    expect(pg.counts('customers', WSB)).toBe(0);
    expect(pg.counts('quotes', WSC)).toBe(0);
  });

  it('non-member and unauthenticated callers are refused outright', async () => {
    pg.login('88888888-8888-8888-8888-888888888888'); // member of nothing
    await expect(cloudRestore({ org: {}, pricing: {}, customers: [], properties: [], quotes: [], profiles: [], areaTypes: [], tasks: [], addons: [], users: [], activity: [] }, WSA))
      .rejects.toThrow(/member/i);
    pg.login(null);
    await expect(cloudRestore({ org: {}, pricing: {}, customers: [], properties: [], quotes: [], profiles: [], areaTypes: [], tasks: [], addons: [], users: [], activity: [] }, WSA))
      .rejects.toThrow(/authenticated/i);
  });
});

describe('P0-1 Test D — failure mid-restore leaves DB in original state', () => {
  it('rolls back everything (no half-restored workspace)', async () => {
    pg.insert('customers', [{ id: 'old-c', workspace_id: WSA, company: 'before' }]);
    const beforeAll = pg.snapshot('customers');

    // numeric garbage aborts the RPC transaction
    await expect(cloudRestore({
      org: { name: 'A' }, pricing: {},
      customers: [{ id: 'new-c', company: 'after' }],
      quotes: [{ id: 'Q-bad', propertyName: 'x', monthly: 'garbage' }],
      properties: [], profiles: [], areaTypes: [], tasks: [], addons: [], users: [], activity: [],
    }, WSA)).rejects.toThrow();

    expect(pg.snapshot('customers')).toBe(beforeAll.c || beforeAll); // old-c intact, no new-c
    expect(pg.tables.customers.has('new-c')).toBe(false);
  });

  it('network-level rpc failure also leaves state untouched', async () => {
    pg.insert('customers', [{ id: 'keep-me', workspace_id: WSA, company: 'intact' }]);
    const before = pg.snapshot('customers');
    __setSupabaseMock({ from() { throw new Error('socket hang up'); }, async rpc() { throw new Error('network down'); } });
    await initDb();
    setCurrentWorkspaceId(WSA);
    await expect(restoreStateToSupabase({
      org: {}, pricing: {}, customers: [{ id: 'n1', company: 'x' }],
      properties: [], quotes: [], profiles: [], areaTypes: [], tasks: [], addons: [], users: [], activity: [],
    }, WSA)).rejects.toThrow(/network down/);
    expect(pg.snapshot('customers')).toBe(before);
  });
});

describe('P0-1 hard fences (defense in depth)', () => {
  it('plain client-side upsert cannot move a row between workspaces', async () => {
    pg.insert('quotes', [{ id: 'Q-shared', workspace_id: WSB, monthly: 1 }]);
    __setSupabaseMock(pg);
    await initDb();
    setCurrentWorkspaceId(WSA);
    const res = await pg.from('quotes').upsert([{ id: 'Q-shared', workspace_id: WSA, monthly: 9 }]);
    expect(res.error).toBeTruthy(); // immutability trigger / WITH CHECK fires
    expect(pg.tables.quotes.get('Q-shared').workspace_id).toBe(WSB);
    expect(pg.tables.quotes.get('Q-shared').monthly).toBe(1);
  });

  it('plain client-side upsert cannot write rows into a non-member workspace', async () => {
    __setSupabaseMock(pg);
    await initDb();
    setCurrentWorkspaceId(WSA);
    const res = await pg.from('quotes').upsert([{ id: 'Q-newB', workspace_id: WSC, monthly: 5 }]);
    expect(res.error).toBeTruthy(); // INSERT WITH CHECK blocks
    expect(pg.tables.quotes.has('Q-newB')).toBe(false);
  });
});
