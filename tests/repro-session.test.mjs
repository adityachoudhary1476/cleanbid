/* Regression: signIn()/signUp() MUST populate the module's currentSession.
 *
 * ROOT CAUSE of the post-login cream/white screen:
 *   getUserWorkspaces() and loadStateFromSupabase() both early-return when
 *   the module-level `currentSession` is null. signIn() returned the session
 *   but never assigned it, so a freshly signed-in user resolved 0 workspaces
 *   -> routed to the onboarding overlay (cream) and never reached enterApp().
 *
 * FIX: signIn()/signUp() now assign currentSession from the returned session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { getElementById: () => null };

const REAL_UID = '6605527b-f1dd-491c-bdd0-8d9de139b716';
const SESSION = { user: { id: REAL_UID, email: 'a@b.com' } };

function makeFakeSupabase() {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })), // fresh load
      getUser: vi.fn(async () => ({ data: { user: { id: REAL_UID, email: 'a@b.com', user_metadata: { full_name: 'Aditya' } } }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
      signInWithPassword: vi.fn(async () => ({ data: { user: { id: REAL_UID, email: 'a@b.com' }, session: SESSION }, error: null })),
      signUp: vi.fn(async () => ({ data: { user: { id: REAL_UID, email: 'a@b.com' }, session: SESSION }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
    },
    from: vi.fn(() => ({
      upsert: vi.fn(async () => ({ error: null })),
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(() => ({ data: null, error: null })), maybeSingle: vi.fn(() => ({ data: null, error: null })) })) })),
        order: vi.fn(() => ({ range: vi.fn(() => ({ data: [], error: null })) })),
        maybeSingle: vi.fn(() => ({ data: null, error: null })),
      })),
    })),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

vi.mock('../src/supabase.js', () => ({ supabase: makeFakeSupabase(), isSupabaseConfigured: true }));

const { initAuth, signIn, signUp, getSession } = await import('../src/auth.js');

describe('REPRO regression: sign-in populates currentSession', () => {
  beforeEach(() => { window.__cleanbid_user = null; });

  it('initAuth + signIn yields a non-null session (otherwise workspaces never resolve)', async () => {
    await initAuth();           // fresh load: getSession()==null
    expect(getSession()).toBeNull();
    await signIn('a@b.com', 'pw');
    expect(getSession()).not.toBeNull();
    expect(getSession().user.id).toBe(REAL_UID);
  });

  it('signUp with an immediate session also populates currentSession', async () => {
    await initAuth();
    await signUp('a@b.com', 'pw', 'Aditya');
    expect(getSession()).not.toBeNull();
  });
});
