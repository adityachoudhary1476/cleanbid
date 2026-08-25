/**
 * Draft persistence — debounce/await contract for src/db.js
 *
 * Drives the REAL module in Supabase mode by stubbing the two upstream
 * modules it depends on (auth.js, supabase.js). No network, no real
 * credentials. Proves:
 *   A. saveState() resolves only AFTER the actual upsert completes.
 *   F. Rapid saves coalesce to a single last-write-wins persistence (no
 *      older state overwrites newer).
 *   flushSave awaits the in-flight write.
 *   A Supabase failure rejects (so the UI can show a real error).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// db.js assigns window.__cleanbid_state — provide a minimal global window.
globalThis.window = globalThis;
globalThis.window.__cleanbid_state = null;

// Record every upsert the fake Supabase receives.
let upserts = [];
let failNext = false;

vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: (table) => ({
      upsert: (rows) => {
        upserts.push({ table, snapshot: rows && rows[0] ? rows[0] : null });
        if (failNext) { failNext = false; return { error: { message: 'forced failure' } }; }
        return { error: null };
      },
      update: () => ({ eq: () => ({ error: null }) }),
    }),
  },
  isSupabaseConfigured: true,
}));

vi.mock('../src/auth.js', () => ({
  isCloud: () => true,
  getCurrentUser: () => ({ id: 'u1' }),
  getUserWorkspaces: async () => [{ id: 'ws_test_1' }],
}));

const db = await import('../src/db.js');

async function initFake() {
  upserts = [];
  await db.initDb();
}

describe('draft persistence — db.js saveState contract', () => {
  beforeEach(async () => { await initFake(); });
  afterEach(() => { failNext = false; });

  it('A: saveState resolves only after the Supabase upsert actually runs', async () => {
    const before = upserts.length;
    const p = db.saveState({ quotes: [{ id: 'q1', monthly: 100 }], customers: [], properties: [], profiles: [] });
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(upserts.length).toBeGreaterThan(before); // upsert happened
  });

  it('F: rapid successive saves coalesce to one final last-write-wins write', async () => {
    const states = [1, 2, 3, 4, 5].map((n) => ({
      quotes: [{ id: 'q1', monthly: n }], customers: [], properties: [], profiles: [],
    }));
    const promises = states.map((s) => db.saveState(s)); // fire synchronously
    await Promise.all(promises);
    const quoteUpserts = upserts.filter((u) => u.table === 'quotes');
    // The final persisted quote must reflect the NEWEST state, not an older one.
    const lastMonthly = quoteUpserts[quoteUpserts.length - 1].snapshot.monthly;
    expect(lastMonthly).toBe(5);
  });

  it('flushSave awaits the in-flight write', async () => {
    db.saveState({ quotes: [{ id: 'q1', monthly: 42 }], customers: [], properties: [], profiles: [] });
    await db.flushSave();
    const quoteUpserts = upserts.filter((u) => u.table === 'quotes');
    expect(quoteUpserts.length).toBeGreaterThan(0);
    expect(quoteUpserts[quoteUpserts.length - 1].snapshot.monthly).toBe(42);
  });

  it('rejects and surfaces a Supabase failure', async () => {
    failNext = true;
    await expect(
      db.saveState({ quotes: [{ id: 'q1', monthly: 1 }], customers: [], properties: [], profiles: [] })
    ).rejects.toBeTruthy();
  });
});
