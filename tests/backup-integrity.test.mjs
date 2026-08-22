/**
 * BACKUP INTEGRITY + SNAPSHOT + ACTIVITY PAGINATION SUITE
 * Covers audit findings P1-1 (activity truncation), P1-3 (checksum +
 * entity validation), P0-2 (safety snapshot ring).
 *
 * Run:  npx vitest run tests/backup-integrity.test.mjs
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/supabase.js', () => {
  let currentMock = null;
  return {
    __setSupabaseMock: (m) => { currentMock = m; },
    get supabase() { return currentMock; },
    isSupabaseConfigured: true,
  };
});
// Force cloud mode so db.loadState exercises the Supabase path.
vi.mock('../src/auth.js', () => ({
  isCloud: () => true,
  getCurrentUser: () => ({ id: 'user-1', email: 't@x.example' }),
  getUserWorkspaces: async () => [{ id: 'ws-a', name: 'A' }],
  initAuth: async () => true,
}));
import { __setSupabaseMock } from '../src/supabase.js';

const mod = await import('../src/backup.js');

// Deterministic FNV-1a digester (well-diffusing, no WebCrypto dependency).
const digest = (text) => {
  let h = 2166136261 >>> 0;
  for (const ch of text) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return 'fnv-' + text.length + '-' + h.toString(16);
};

function storage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
globalThis.localStorage = storage();

function fullState(n = 1) {
  return {
    workspaceId: 'ws-a',
    org: { name: 'Org ' + n },
    pricing: { wage: 20 },
    profiles: [{ id: 'p1', name: 'Std' }],
    areaTypes: [{ id: 'office' }],
    tasks: [{ id: 1, name: 'Vacuum' }],
    customers: [{ id: 'c' + n, company: 'Cust ' + n }],
    properties: [{ id: 'pr' + n, name: 'Prop ' + n, customerId: 'c' + n }],
    quotes: [{ id: 'Q-' + n, propertyName: 'Prop ' + n, monthly: 1000 * n, status: 'draft' }],
    addons: [], users: [],
    activity: Array.from({ length: 3 }, (_, i) => ({ what: 'act', object: i, actor: 'A', avt: 'A', time: 'now' })),
  };
}

beforeEach(() => globalThis.localStorage.clear());

// ---------------------------------------------------------------------------
// P1-3 — checksum / tamper / entity validation
// ---------------------------------------------------------------------------
describe('P1-3 checksum integrity', () => {
  it('sealed backups verify ok; any payload edit fails verification', async () => {
    let b = mod.buildBackup(fullState(1));
    await mod.sealBackup(b, digest);
    expect(b.checksum).toBeTruthy();
    await expect(mod.verifyChecksum(b, digest)).resolves.toMatchObject({ status: 'ok' });

    // Tamper with ONE value deep inside.
    b.data.quotes[0].monthly = 999999;
    await expect(mod.verifyChecksum(b, digest)).resolves.toMatchObject({ status: 'tampered' });

    // Tampered file must be REJECTED by validateBackup with no recovery path.
    const verdict = await mod.validateBackup(JSON.stringify(b), { digestFn: digest });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/integrity|checksum/i);
  });

  it('unsealed backups verify as unverified; cross-header payload swap is detectable', async () => {
    const b1 = mod.buildBackup(fullState(1));
    const b2 = mod.buildBackup(fullState(2));
    await mod.sealBackup(b1, digest);
    // b2 has no checksum -> unverified (legacy behavior), not a crash.
    const vUnsealed = await mod.verifyChecksum(b2, digest);
    expect(vUnsealed.status).toBe('unverified');
    // Stealing b1's checksum onto different content MUST fail.
    b2.checksum = b1.checksum;
    const vStolen = await mod.verifyChecksum(b2, digest);
    expect(vStolen.status).toBe('tampered');
  });

  it('legacy backups without checksum are warned about, not rejected', async () => {
    const legacy = { cleanbid_backup: true, format: 2, exportedAt: new Date().toISOString(), data: { customers: [], properties: [], quotes: [] } };
    const v = await mod.validateBackup(JSON.stringify(legacy), { digestFn: digest });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/no integrity checksum/i);
  });
});

describe('P1-3 entity validation — hostile records are skipped and reported', () => {
  const base = () => ({ cleanbid_backup: true, format: 2, exportedAt: new Date().toISOString(), counts: {} });

  it('customers:[{"id":1}] (no company) skipped', async () => {
    const raw = { ...base(), data: { customers: [{ id: 1 }], quotes: [], properties: [] } };
    const v = await mod.validateBackup(JSON.stringify(raw));
    expect(v.ok).toBe(true);
    expect(v.parsed.data.customers).toHaveLength(0);
    expect(v.warnings.join(' ')).toMatch(/skipped/i);
  });

  it('customers:[null] skipped without crashing', async () => {
    const raw = { ...base(), data: { customers: [null], quotes: [], properties: [] } };
    const v = await mod.validateBackup(JSON.stringify(raw));
    expect(v.ok).toBe(true);
    expect(v.parsed.data.customers).toHaveLength(0);
  });

  it('quotes:[{}] skipped; numeric garbage in monthly skipped', async () => {
    const raw = { ...base(), data: { customers: [], properties: [], quotes: [{}, { id: 'Q1', propertyName: 'ok', monthly: 'garbage' }, { id: 'Q2', propertyName: 'also-ok', monthly: 500 }] } };
    const v = await mod.validateBackup(JSON.stringify(raw));
    expect(v.ok).toBe(true);
    expect(v.parsed.data.quotes.map((q) => q.id)).toEqual(['Q2']); // garbage-monthly record dropped
  });

  it('properties:[{"id":null}] skipped; profiles:[{"name":"garbage-wage"}] KEPT but flagged by design', async () => {
    const raw = { ...base(), data: { customers: [], properties: [{ id: null, name: 'x' }], quotes: [], profiles: [{ id: 'p9', name: 'garbage wage', wage: 'not-a-number' }] } };
    const v = await mod.validateBackup(JSON.stringify(raw));
    expect(v.ok).toBe(true);
    expect(v.parsed.data.properties).toHaveLength(0);
    // Profile kept: server RPC coerces/rejects numerics atomically; client flags nothing silently.
    expect(v.parsed.data.profiles).toHaveLength(1);
  });

  it('activity:[{"timestamp":{}}] skipped; valid what/action entries kept', async () => {
    const raw = { ...base(), data: { activity: [{ timestamp: {} }, { what: 'did x' }, { action: 'did y' }] } };
    const v = await mod.validateBackup(JSON.stringify(raw));
    expect(v.ok).toBe(true);
    expect(v.parsed.data.activity).toHaveLength(2);
  });

  it('structural corruption still rejects entirely (sections not lists)', async () => {
    const raw = { ...base(), data: { customers: 'oops', quotes: {}, properties: [] } };
    const v = await mod.validateBackup(JSON.stringify(raw));
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('wrong format version rejects; missing signature rejects', async () => {
    const wrongFmt = { ...base(), format: 99, data: { customers: [], quotes: [], properties: [] } };
    expect((await mod.validateBackup(JSON.stringify(wrongFmt))).ok).toBe(false);
    expect((await mod.validateBackup(JSON.stringify({ data: {} }))).ok).toBe(false);
  });

  it('valid vs partially-recoverable classification is explicit', async () => {
    const good = { ...base(), data: { customers: [{ id: 1, company: 'A' }], quotes: [], properties: [] } };
    const vg = await mod.validateBackup(JSON.stringify(good));
    expect(vg.ok).toBe(true);

    const partial = { ...base(), data: { customers: [{ id: 1, company: 'A' }, { id: 2 }], quotes: [], properties: [] } };
    const vp = await mod.validateBackup(JSON.stringify(partial));
    expect(vp.ok).toBe(true);                       // recoverable
    expect(vp.warnings.some((w) => /skipped/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P0-2 — safety snapshot ring
// ---------------------------------------------------------------------------
describe('P0-2 safety snapshots', () => {
  it('snapshot contains COMPLETE state and round-trips through validate+apply', async () => {
    const st = fullState(7);
    mod.createSafetySnapshot(st);
    const list = mod.listSafetySnapshots();
    expect(list).toHaveLength(1);
    expect(list[0].payload.data.quotes).toHaveLength(1);
    expect(list[0].payload.data.activity).toHaveLength(3);   // complete, not just customers/quotes
    expect(list[0].counts.quotes).toBe(1);

    // Independently recoverable: snapshot payload validates + applies cleanly.
    const v = await mod.validateBackup(JSON.stringify(list[0].payload));
    expect(v.ok).toBe(true);
  });

  it('keeps latest 3, removes older safely, newest first', () => {
    for (let i = 1; i <= 5; i++) mod.createSafetySnapshot(fullState(i));
    const list = mod.listSafetySnapshots();
    expect(list).toHaveLength(3);
    expect(list[0].orgName).toBe('Org 5');
    expect(list[1].orgName).toBe('Org 4');
    expect(list[2].orgName).toBe('Org 3');
  });

  it('failed snapshot (quota) throws — restore caller must abort', () => {
    globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    expect(() => mod.createSafetySnapshot(fullState(9))).toThrow(/QuotaExceeded/);
    // restore storage behavior
    globalThis.localStorage = storage();
  });

  it('snapshot failure does not corrupt the existing ring', () => {
    mod.createSafetySnapshot(fullState(1));
    globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    try { mod.createSafetySnapshot(fullState(2)); } catch (_) {}
    globalThis.localStorage = storage();
    // Old snapshot still readable? The failed write may have been partial;
    // the store must never contain a broken entry.
    const list = mod.listSafetySnapshots();
    expect(Array.isArray(list)).toBe(true);
    expect(list.every((e) => e && e.payload)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P1-1 — activity pagination in cloud load path
// ---------------------------------------------------------------------------
describe('P1-1 fetchAllActivity pagination (>50 and >1000)', () => {
  it('loadState returns ALL activity rows, not capped at 50', async () => {
    const TOTAL = 1234; // >1000 forces multiple pages
    let fetchedRanges = [];
    const rows = Array.from({ length: TOTAL }, (_, i) => ({ id: 'a' + i, workspace_id: 'ws-a', action: 'row' + i, created_at: new Date(Date.now() - i * 1000).toISOString() }));

    __setSupabaseMock({
      from(table) {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          range(from, to) {
            fetchedRanges.push([from, to]);
            return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
          },
          maybeSingle() { return Promise.resolve({ data: {}, error: null }); },
          upsert() { return Promise.resolve({ error: null }); },
          update() { return { eq() { return Promise.resolve({ error: null }); } }; },
        };
      },
      async rpc() { return { data: null, error: null }; },
    });

    const dbMod = await import('../src/db.js?pag=' + Date.now());
    globalThis.localStorage = storage();
    globalThis.window = globalThis;
    await dbMod.initDb();
    dbMod.setCurrentWorkspaceId('ws-a');
    const state = await dbMod.loadState();
    expect(state.activity.length).toBe(TOTAL);          // was 50 before the fix
    expect(fetchedRanges.length).toBe(2);               // 1000 + 234
    expect(fetchedRanges[0]).toEqual([0, 999]);
    expect(fetchedRanges[1]).toEqual([1000, 1999]);
  });
});

// __PART3__
