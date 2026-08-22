/**
 * Workspace isolation — persistence + boundary layer (real modules).
 *
 * Exercises the ACTUAL data-access layer (src/db.js) and the canonical
 * state-boundary helpers (src/state.js) used by the app shell. The local
 * storage backend is namespaced per workspace, so switching must never read
 * another workspace's blob and must never merge stale data.
 *
 * Run with:  npx vitest run  (or `npm test`)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, saveState, loadState, loadDemoState, saveDemoState, setCurrentWorkspaceId, getCurrentWorkspaceId } from '../src/db.js';
import { replaceWorkspaceState, defaultWorkspaceData, WORKSPACE_STATE_KEYS } from '../src/state.js';

// ---- in-memory browser globals ------------------------------------------------
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    _map: m,
  };
}
const storage = makeStorage();
globalThis.localStorage = storage;
globalThis.window = globalThis; // db.js assigns window.__cleanbid_state

// A representative, fully-populated workspace blob.
function makeWorkspaceBlob(prefix, versionCount = 1) {
  const versions = [];
  for (let i = 1; i <= versionCount; i++) {
    versions.push({ v: i, total: 100 * i, date: `2026-0${i}-01` });
  }
  return {
    workspaceId: prefix,
    org: { name: `${prefix} Co`, initial: prefix[0], workspaceId: prefix },
    pricing: { wage: 20, burden: 15, overhead: 12, margin: 25, minPrice: 800, supplies: 8, currency: 'USD', units: 'imperial', productivity: { office: 2800 } },
    profiles: [{ id: 'std', name: 'Standard', wage: 20 }],
    areaTypes: [{ id: 'office', name: 'Office' }],
    tasks: [{ id: 1, name: 'Vacuum' }],
    customers: [{ id: 1, company: `${prefix} Customer`, workspaceId: prefix }],
    properties: [{ id: 1, customerId: 1, name: `${prefix} Property`, workspaceId: prefix }],
    quotes: [{ id: `Q-${prefix}`, customerId: 1, propertyId: 1, versions, workspaceId: prefix }],
    addons: [{ id: 'ad-1', name: 'Window', enabled: false }],
    users: [{ id: 1, name: `${prefix} User`, role: 'admin' }],
    activity: [{ avt: 'X', actor: `${prefix}`, what: 'did', time: 'now' }],
  };
}

beforeEach(() => {
  storage.clear();
  setCurrentWorkspaceId(null);
});

describe('workspace-namespaced persistence (db.js)', () => {
  it('keeps Workspace A and Workspace B data in separate blobs', async () => {
    await initDb(); // local mode (no Supabase env configured)
    expect(getCurrentWorkspaceId()).toBeNull();

    setCurrentWorkspaceId('A');
    await saveState(makeWorkspaceBlob('A', 2));

    setCurrentWorkspaceId('B');
    await saveState(makeWorkspaceBlob('B', 1));

    // Direct load: each workspace returns only its own data.
    setCurrentWorkspaceId('A');
    const a = await loadState();
    expect(a.customers[0].company).toBe('A Customer');
    expect(a.quotes[0].id).toBe('Q-A');
    expect(a.quotes[0].versions.length).toBe(2);

    setCurrentWorkspaceId('B');
    const b = await loadState();
    expect(b.customers[0].company).toBe('B Customer');
    expect(b.quotes[0].id).toBe('Q-B');
    expect(b.quotes[0].versions.length).toBe(1);

    // B must not contain any A residue.
    expect(b.customers.find((c) => c.company === 'A Customer')).toBeUndefined();
    expect(b.quotes.find((q) => q.id === 'Q-A')).toBeUndefined();
  });

  it('returns null (never another workspace) for a missing workspace', async () => {
    await initDb();
    setCurrentWorkspaceId('A');
    await saveState(makeWorkspaceBlob('A'));

    setCurrentWorkspaceId('NEVER-SAVED');
    const missing = await loadState();
    expect(missing).toBeNull();
  });

  it('does not fall back to another workspace key', async () => {
    await initDb();
    setCurrentWorkspaceId('A');
    await saveState(makeWorkspaceBlob('A'));
    // A private key exists; loading a different id must NOT read A's key.
    setCurrentWorkspaceId('B');
    expect(await loadState()).toBeNull();
  });

  it('isolates demo data under its own storage key', async () => {
    await initDb();
    setCurrentWorkspaceId('A');
    await saveState(makeWorkspaceBlob('A'));

    const demo = makeWorkspaceBlob('DEMO');
    await saveDemoState(demo);
    const loaded = await loadDemoState();
    expect(loaded.customers[0].company).toBe('DEMO Customer');

    // Real workspace load must remain unaffected by demo writes.
    setCurrentWorkspaceId('A');
    const a = await loadState();
    expect(a.customers[0].company).toBe('A Customer');
  });
});

describe('state-boundary replacement (state.js)', () => {
  it('fully replaces workspace keys and never merges stale data', () => {
    const state = defaultWorkspaceData();
    state.customers = [{ id: 1, company: 'STALE' }];
    state.quotes = [{ id: 'Q-STALE' }];
    state.pricing = { wage: 999 };

    const fresh = makeWorkspaceBlob('B');
    replaceWorkspaceState(state, fresh, defaultWorkspaceData);

    // Every workspace-owned key (except `workspaceId`, which is CONTEXT and
    // must never be clobbered by the persisted blob) now reflects `fresh`.
    for (const key of WORKSPACE_STATE_KEYS) {
      if (key === 'workspaceId') continue;
      expect(JSON.stringify(state[key])).toBe(JSON.stringify(fresh[key]));
    }
    // `workspaceId` is left as the active context, NOT overwritten by `fresh`.
    expect(state.workspaceId).toBeNull();
    expect(state.customers.find((c) => c.company === 'STALE')).toBeUndefined();
    expect(state.quotes.find((q) => q.id === 'Q-STALE')).toBeUndefined();
  });

  it('preserves global keys (me) across replacement', () => {
    const state = defaultWorkspaceData();
    state.me = { name: 'Current User', email: 'u@x.com', role: 'admin' };
    const saved = makeWorkspaceBlob('B');
    replaceWorkspaceState(state, saved, defaultWorkspaceData);
    expect(state.me).toEqual({ name: 'Current User', email: 'u@x.com', role: 'admin' });
  });

  it('initializes clean workspace state when saved is null', () => {
    const state = defaultWorkspaceData();
    state.customers = [{ id: 1, company: 'STALE' }];
    replaceWorkspaceState(state, null, defaultWorkspaceData);
    expect(state.customers).toEqual([]);
    expect(Array.isArray(state.quotes)).toBe(true);
    expect(state.quotes).toEqual([]);
    expect(typeof state.pricing).toBe('object');
  });

  it('rejects malformed persisted data (wrong types) instead of merging it', () => {
    const state = defaultWorkspaceData();
    const broken = { customers: 'not-an-array', pricing: 42, org: 'nope', quotes: null };
    replaceWorkspaceState(state, broken, defaultWorkspaceData);
    expect(state.customers).toEqual([]);      // fell back to default array
    expect(typeof state.pricing).toBe('object'); // fell back to default object
    expect(typeof state.org).toBe('object');
    expect(state.quotes).toEqual([]);
  });

  it('handles partially-saved workspaces (missing keys -> defaults)', () => {
    const state = defaultWorkspaceData();
    const partial = { customers: [{ id: 1, company: 'Only Cust' }] };
    replaceWorkspaceState(state, partial, defaultWorkspaceData);
    expect(state.customers.length).toBe(1);
    expect(state.customers[0].company).toBe('Only Cust');
    expect(state.quotes).toEqual([]); // default, not stale
    expect(typeof state.pricing).toBe('object');
  });

  it('deep-clones incoming data so workspaces never share references', () => {
    const state = defaultWorkspaceData();
    const saved = makeWorkspaceBlob('A', 1);
    replaceWorkspaceState(state, saved, defaultWorkspaceData);
    // Mutating the live copy must not mutate the source object.
    state.customers.push({ id: 99, company: 'MUT' });
    state.quotes[0].versions.push({ v: 2, total: 5 });
    expect(saved.customers.length).toBe(1);
    expect(saved.quotes[0].versions.length).toBe(1);
  });

  it('keeps quote versions isolated across simulated A->B->A switches (persisted)', async () => {
    await initDb();
    const state = defaultWorkspaceData();

    // Workspace A with one quote version
    setCurrentWorkspaceId('A');
    replaceWorkspaceState(state, makeWorkspaceBlob('A', 1), defaultWorkspaceData);
    await saveState(state);

    // Switch to B and add a quote version there (revision op)
    setCurrentWorkspaceId('B');
    replaceWorkspaceState(state, makeWorkspaceBlob('B', 1), defaultWorkspaceData);
    state.quotes[0].versions.push({ v: 2, total: 200 });
    await saveState(state); // persist B with its own revision

    // Switch back to A — A's quote version must be unchanged
    setCurrentWorkspaceId('A');
    const aReload = await loadState();
    replaceWorkspaceState(state, aReload, defaultWorkspaceData);
    expect(state.quotes[0].versions.length).toBe(1);
    expect(state.quotes[0].versions[0].total).toBe(100);

    // And B still has its own 2 versions when we return
    setCurrentWorkspaceId('B');
    const bReload = await loadState();
    replaceWorkspaceState(state, bReload, defaultWorkspaceData);
    expect(state.quotes[0].versions.length).toBe(2);
    expect(state.quotes[0].versions[1].total).toBe(200);
  });
});

describe('end-to-end switch simulation via db.js + state.js', () => {
  it('A -> B -> A -> B retains correct isolation including versions', async () => {
    await initDb();
    const state = defaultWorkspaceData();

    // --- Workspace A ---
    setCurrentWorkspaceId('A');
    replaceWorkspaceState(state, makeWorkspaceBlob('A', 1), defaultWorkspaceData);
    await saveState(state);

    // --- Workspace B ---
    setCurrentWorkspaceId('B');
    replaceWorkspaceState(state, makeWorkspaceBlob('B', 1), defaultWorkspaceData);
    // simulate a revision/restore op in B
    state.quotes[0].versions.push({ v: 2, total: 222 });
    await saveState(state);

    // --- Back to A ---
    setCurrentWorkspaceId('A');
    const aReload = await loadState();
    replaceWorkspaceState(state, aReload, defaultWorkspaceData);
    expect(state.quotes[0].versions.length).toBe(1); // A untouched by B
    // modify A
    state.quotes[0].versions.push({ v: 2, total: 111 });
    await saveState(state);

    // --- To B ---
    setCurrentWorkspaceId('B');
    const bReload = await loadState();
    replaceWorkspaceState(state, bReload, defaultWorkspaceData);
    expect(state.quotes[0].versions.length).toBe(2); // B's own revisions intact
    expect(state.quotes[0].versions[1].total).toBe(222);
    expect(state.customers[0].company).toBe('B Customer');
    expect(state.customers.find((c) => c.company === 'A Customer')).toBeUndefined();
  });
});
