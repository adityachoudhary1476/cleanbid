/**
 * CleanBid Authentication Module
 *
 * Supports two modes:
 * 1. Supabase Auth (production) - when VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are configured
 * 2. Local/Demo mode (development) - when Supabase is not configured
 *
 * IMPORTANT RULES:
 * - Never silently fall back from authenticated cloud mode to localStorage.
 * - Never hardcode credentials; the client lives in ./supabase.js.
 * - Supabase Auth is the SOURCE OF TRUTH for identity.
 * - Workspace membership (not a client-supplied id) is the authorization basis.
 */

import { supabase, isSupabaseConfigured } from './supabase.js';

let isCloudMode = false;
let currentSession = null;
let authStateCallbacks = [];

/**
 * Initialize the auth module. Call once at app startup.
 * Returns true if running in cloud (Supabase) mode.
 */
export async function initAuth() {
  if (isCloudMode) return true;

  if (isSupabaseConfigured && supabase) {
    try {
      // Restore an existing session (e.g. page reload while logged in).
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        currentSession = session;
        await fetchUserProfile();
      }

      // Listen for auth changes (sign in / sign out / token refresh).
      supabase.auth.onAuthStateChange(async (event, session) => {
        currentSession = session;
        if (event === 'SIGNED_IN' && session) {
          await fetchUserProfile();
        } else if (event === 'SIGNED_OUT') {
          currentSession = null;
          window.__cleanbid_user = null;
        }
        notifyAuthStateChange(event, session);
      });

      isCloudMode = true;
      console.log('[CleanBid Auth] Initialized in cloud mode');
      return true;
    } catch (error) {
      console.error('[CleanBid Auth] Failed to initialize Supabase:', error);
      // If we were explicitly configured but it failed while a user exists,
      // DO NOT fall back to local mode (that would leak auth context).
      const user = getCurrentUser();
      if (user) {
        throw new Error('Authenticated user but Supabase connection failed. Cannot fall back to local mode.');
      }
      isCloudMode = false;
      console.log('[CleanBid Auth] Falling back to local mode (no authenticated user)');
      return false;
    }
  }

  // Local/demo mode
  isCloudMode = false;
  console.log('[CleanBid Auth] Initialized in local/demo mode');
  return false;
}

/** True when Supabase is the active backend. */
export function isCloud() {
  return isCloudMode;
}

/** Current auth session (or null). */
export function getSession() {
  return currentSession;
}

/**
 * Sign up a new user with email and password.
 * Returns { user, session, emailConfirmationRequired }.
 */
export async function signUp(email, password, fullName) {
  if (!isCloudMode || !supabase) {
    throw new Error('Sign up requires Supabase configuration');
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });

  if (error) throw error;

  // Authoritative session for this client (only present when email
  // confirmation is off). Set it so getUserWorkspaces()/loadState can
  // resolve a workspace after sign-up too.
  const emailConfirmationRequired = !data.session;
  currentSession = data.session || null;
  if (!emailConfirmationRequired && data.user) {
    await fetchUserProfile();
  }

  return { user: data.user, session: data.session, emailConfirmationRequired };
}

/** Sign in with email and password. */
export async function signIn(email, password) {
  if (!isCloudMode || !supabase) {
    throw new Error('Sign in requires Supabase configuration');
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;

  // Authoritative session for this client — required by getUserWorkspaces()
  // (RLS-scoped workspace reads) and loadStateFromSupabase() which both
  // early-return when currentSession is null. Without this, a freshly
  // signed-in user never resolves a workspace and the app stays on the
  // loading/onboarding overlay (cream screen).
  currentSession = data.session;
  await fetchUserProfile();
  return { user: data.user, session: data.session };
}

/** Sign out the current user. */
export async function signOut() {
  if (!isCloudMode || !supabase) return;
  await supabase.auth.signOut();
  currentSession = null;
  window.__cleanbid_user = null;
}

/**
 * Fetch or create the application-level user profile from the auth user.
 * We never duplicate auth credentials — only mirror id/email/name into the
 * `users` table for display and membership purposes.
 *
 * IMPORTANT (production login fix): the profile row's `id` MUST equal the
 * authenticated Supabase user's UUID = auth.uid(). We obtain that id from
 * supabase.auth.getUser(), which (a) returns the authoritative user and
 * (b) forces a token validation/refresh. This prevents a 42501 RLS failure
 * that occurred when the upsert was fired from a stale/restored session
 * whose access token had not yet been re-attached — in that case auth.uid()
 * evaluated to NULL and `id = auth.uid()` failed the INSERT policy.
 */
async function fetchUserProfile() {
  if (!supabase) return;

  // Authoritative user (triggers refresh of an expired access token).
  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !authData?.user) {
    console.error('[CleanBid Auth] Could not resolve authenticated user:', authErr);
    return;
  }
  const authUser = authData.user;

  const user = {
    id: authUser.id,                       // === auth.users.id === auth.uid()
    email: authUser.email,                 // preserved from auth.users.email
    full_name: authUser.user_metadata?.full_name || authUser.email?.split('@')[0],
    avatar_url: authUser.user_metadata?.avatar_url,
  };

  window.__cleanbid_user = user;

  // Mirror into public.users. id is always the real auth UUID, so it
  // satisfies the INSERT/UPDATE RLS policy `id = auth.uid()`.
  const { error } = await supabase.from('users').upsert({
    id: user.id,
    email: user.email,
    full_name: user.full_name,
  });
  if (error) console.error('[CleanBid Auth] Failed to upsert user profile:', error);
}

/** Get the current application user (or null). */
export function getCurrentUser() {
  return window.__cleanbid_user || null;
}

/** Subscribe to auth state changes. Returns an unsubscribe function. */
export function onAuthStateChange(callback) {
  authStateCallbacks.push(callback);
  return () => {
    authStateCallbacks = authStateCallbacks.filter((cb) => cb !== callback);
  };
}

function notifyAuthStateChange(event, session) {
  authStateCallbacks.forEach((cb) => {
    try { cb(event, session); } catch (e) { console.error('[CleanBid Auth] Callback error:', e); }
  });
}

/**
 * Get the current user's workspace memberships, each augmented with the
 * workspace's own fields and the user's role. This is the AUTHORIZATION
 * source of truth — membership is verified server-side via RLS, so a
 * client cannot forge a workspace id it does not belong to.
 */
export async function getUserWorkspaces() {
  if (!isCloudMode || !supabase || !currentSession) return [];

  const { data, error } = await supabase
    .from('workspace_members')
    .select('*, workspaces(*)')
    .eq('user_id', currentSession.user.id);

  if (error) {
    console.error('[CleanBid Auth] Failed to get workspaces:', error);
    return [];
  }

  return (data || []).map((m) => ({
    ...(m.workspaces || {}),
    role: m.role,
    membership_id: m.id,
  }));
}

/** True if the current user is a member of the given workspace id. */
export async function isMember(workspaceId) {
  if (!isCloudMode || !supabase || !currentSession || !workspaceId) return false;
  const { data, error } = await supabase
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', currentSession.user.id)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

/** Get a single workspace membership by id (from the user's memberships). */
export async function getWorkspaceById(workspaceId) {
  const workspaces = await getUserWorkspaces();
  return workspaces.find((w) => w.id === workspaceId) || null;
}

/**
 * Invite a team member to a workspace (F1).
 * Delegates entirely to the SECURITY DEFINER RPC, which enforces that the
 * caller is an admin/owner, blocks role escalation, prevents duplicates, and
 * returns the raw invitation token (delivered out-of-band by the caller).
 *
 * @returns {Promise<{token:string}>}
 */
export async function inviteTeamMember(workspaceId, email, role) {
  if (!isCloudMode || !supabase || !currentSession) {
    throw new Error('Invitations require Supabase configuration');
  }
  if (!workspaceId || !email) throw new Error('Workspace and email are required');
  const { data, error } = await supabase.rpc('create_workspace_invitation', {
    p_workspace: workspaceId,
    p_email: String(email).trim().toLowerCase(),
    p_role: role || 'estimator',
  });
  if (error) throw error;
  return { token: data };
}

/**
 * Accept a workspace invitation by its raw token (F1).
 * The RPC verifies expiry, one-time use, and that the caller's VERIFIED email
 * matches the invited email before creating the membership.
 *
 * @returns {Promise<{workspace_id:string, role:string}>}
 */
export async function acceptInvitation(token) {
  if (!isCloudMode || !supabase || !currentSession) {
    throw new Error('Accepting an invitation requires authentication');
  }
  if (!token) throw new Error('Invitation token is required');
  const { data, error } = await supabase.rpc('accept_workspace_invitation', {
    p_token: String(token),
  });
  if (error) throw error;
  await getUserWorkspaces();
  return data;
}

/**
 * Create a new workspace for the current user with OWNER membership.
 */
export async function createWorkspace(name) {
  if (!isCloudMode || !supabase || !currentSession) {
    throw new Error('Creating a workspace requires authentication');
  }

  const { data: workspace, error: wsError } = await supabase
    .from('workspaces')
    .insert({ name })
    .select()
    .single();

  if (wsError) throw wsError;

  const { error: memberError } = await supabase
    .from('workspace_members')
    .insert({
      workspace_id: workspace.id,
      user_id: currentSession.user.id,
      role: 'owner',
    });

  if (memberError) throw memberError;

  return workspace;
}

/**
 * Ensure the authenticated user has at least one workspace.
 * - If they already belong to workspaces, return them unchanged (no dupes).
 * - Otherwise create a default workspace and return the new membership list.
 *
 * This is safe to call on every startup/sign-in: it only creates when there
 * are zero memberships, so a reload never creates a second workspace.
 */
export async function ensureUserWorkspace() {
  if (!isCloudMode || !currentSession) {
    throw new Error('Workspace setup requires an authenticated user');
  }

  const existing = await getUserWorkspaces();
  if (existing.length > 0) return existing;

  const user = getCurrentUser();
  const base = (user?.full_name || user?.email || 'My').trim();
  const name = `${base}'s Workspace`;
  await createWorkspace(name);
  return await getUserWorkspaces();
}
