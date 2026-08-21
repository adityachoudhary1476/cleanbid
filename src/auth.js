/**
 * CleanBid Authentication Module
 * 
 * Supports two modes:
 * 1. Supabase Auth (production) - when VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are configured
 * 2. Local/Demo mode (development) - when Supabase is not configured
 * 
 * IMPORTANT: Never silently fall back from authenticated cloud mode to localStorage.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

let supabase = null;
let isCloudMode = false;
let currentSession = null;
let authStateCallbacks = [];

/**
 * Initialize the auth module.
 * Call this once at app startup.
 */
export async function initAuth() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    console.log('[CleanBid Auth] Initializing Supabase:', SUPABASE_URL);
    try {
      supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      isCloudMode = true;

      // Check for existing session
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        currentSession = session;
        await fetchUserProfile(session.user);
      }

      // Listen for auth changes
      supabase.auth.onAuthStateChange(async (event, session) => {
        currentSession = session;
        if (event === 'SIGNED_IN' && session) {
          await fetchUserProfile(session.user);
        } else if (event === 'SIGNED_OUT') {
          currentSession = null;
          window.__cleanbid_user = null;
        }
        notifyAuthStateChange(event, session);
      });

      console.log('[CleanBid Auth] Initialized in cloud mode');
      return true;
    } catch (error) {
      console.error('[CleanBid Auth] Failed to initialize Supabase:', error);
      console.error('[CleanBid Auth] Error details:', {
        message: error.message,
        name: error.name,
        cause: error.cause,
      });
      throw new Error('Failed to initialize Supabase. Cannot fall back to local mode when Supabase is configured.');
    }
  }

  // Local/demo mode
  isCloudMode = false;
  console.log('[CleanBid Auth] Initialized in local/demo mode');
  return false;
}

/**
 * Check if we're in cloud (Supabase) mode.
 */
export function isCloud() {
  return isCloudMode;
}

/**
 * Get current auth session.
 */
export function getSession() {
  return currentSession;
}

/**
 * Sign up a new user with email and password.
 * Creates the auth user, a default workspace, and admin membership.
 */
export async function signUp(email, password, fullName) {
  if (!isCloudMode) {
    throw new Error('Sign up requires Supabase configuration');
  }

  console.log('[CleanBid Auth] Attempting sign up for:', email);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
      },
    },
  });

  if (error) {
    console.error('[CleanBid Auth] Sign up error:', error);
    throw error;
  }

  // When email confirmation is required, Supabase returns no session.
  // Any table writes we attempted here would run as anon and fail
  // (or half-fail, leaving orphan workspaces behind) -- so profile and
  // workspace setup is left to the authenticated flow after sign-in.
  const emailConfirmationRequired = !data.session;

  if (!emailConfirmationRequired) {
    await fetchUserProfile(data.user);
  }

  return { user: data.user, workspace: null, emailConfirmationRequired };
}

/**
 * Sign in with email and password.
 */
export async function signIn(email, password) {
  if (!isCloudMode) {
    throw new Error('Sign in requires Supabase configuration');
  }

  console.log('[CleanBid Auth] Attempting sign in for:', email);
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    console.error('[CleanBid Auth] Sign in error:', error);
    throw error;
  }

  await fetchUserProfile(data.user);
  return { user: data.user, session: data.session };
}

/**
 * Sign out the current user.
 */
export async function signOut() {
  if (!isCloudMode) {
    return;
  }

  await supabase.auth.signOut();
  currentSession = null;
  window.__cleanbid_user = null;
}

/**
 * Fetch or create user profile from auth user metadata.
 */
async function fetchUserProfile(authUser) {
  // In Supabase, we can use the auth user directly
  // The users table is mainly for additional profile data
  const user = {
    id: authUser.id,
    email: authUser.email,
    full_name: authUser.user_metadata?.full_name || authUser.email?.split('@')[0],
    avatar_url: authUser.user_metadata?.avatar_url,
  };

  window.__cleanbid_user = user;

  // Try to upsert into users table
  if (isCloudMode) {
    await supabase.from('users').upsert({
      id: user.id,
      email: user.email,
      full_name: user.full_name,
    });
  }
}

/**
 * Get the current user.
 */
export function getCurrentUser() {
  return window.__cleanbid_user || null;
}

/**
 * Subscribe to auth state changes.
 */
export function onAuthStateChange(callback) {
  authStateCallbacks.push(callback);
  return () => {
    authStateCallbacks = authStateCallbacks.filter(cb => cb !== callback);
  };
}

function notifyAuthStateChange(event, session) {
  authStateCallbacks.forEach(cb => {
    try { cb(event, session); } catch (e) { console.error('[CleanBid Auth] Callback error:', e); }
  });
}

/**
 * Get the current user's workspaces.
 */
export async function getUserWorkspaces() {
  if (!isCloudMode || !currentSession) return [];

  const { data, error } = await supabase
    .from('workspace_members')
    .select('*, workspaces(*)')
    .eq('user_id', currentSession.user.id);

  if (error) {
    console.error('[CleanBid Auth] Failed to get workspaces:', error);
    return [];
  }

  return data.map(m => ({
    ...m.workspaces,
    role: m.role,
    membership_id: m.id,
  }));
}

/**
 * Create a new workspace for the current user.
 */
export async function createWorkspace(name) {
  if (!isCloudMode || !currentSession) {
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
      role: 'admin',
    });

  if (memberError) throw memberError;

  return workspace;
}
