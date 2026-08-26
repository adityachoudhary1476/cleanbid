/**
 * Quote-edit quota — persistence + enforcement bridge.
 *
 * Single source of truth for the *client-facing* default quota is
 * DEFAULT_EDIT_QUOTA below. The *authoritative* quota always lives server-side
 * (the quote_edit_usage table + the consume_quote_edit() / get_quote_quota()
 * RPCs in supabase-quota.sql). In cloud mode we read from / write to the
 * server; in local mode we mirror the same shape inside the workspace blob at
 * state.editQuota.
 *
 * IMPORTANT: DEFAULT_EDIT_QUOTA is only a fallback for local mode and for the
 * brief window before the migration exists. In cloud mode the real value is the
 * server's quote_edit_usage.quota (seeded by default_edit_quota() = 10 server-side).
 * We never let the browser raise the limit — setting quota is admin-only and
 * happens via the set_quote_edit_quota() SECURITY DEFINER RPC, not client state.
 */

// **Explicit** initial quota for a NEW workspace (local mode / pre-migration fallback).
// Keep this in sync with default_edit_quota() in supabase-quota.sql.
export const DEFAULT_EDIT_QUOTA = 10;

import { supabase, isSupabaseConfigured } from './supabase.js';

// ----- helpers --------------------------------------------------------------

function normalizeLocal(editQuota) {
  if (editQuota && typeof editQuota === 'object' && typeof editQuota.quota === 'number') {
    const q = editQuota.quota;
    const used = Math.max(0, Math.min(editQuota.used || 0, q));
    const remaining = Math.max(0, q - used);
    return { used, quota: q, remaining, exhausted: remaining <= 0 };
  }
  return { used: 0, quota: DEFAULT_EDIT_QUOTA, remaining: DEFAULT_EDIT_QUOTA, exhausted: false };
}

// ----- read (cloud-first) ---------------------------------------------------

export async function getQuota(state) {
  if (isSupabaseConfigured && supabase && state && state.workspaceId) {
    try {
      // get_quote_quota() seeds the row on first access (used=0, quota=server default)
      // and returns the REAL server value. This is the explicit init path for a
      // new workspace's quota — never a client-side guess.
      const { data, error } = await supabase.rpc('get_quote_quota', { p_workspace: state.workspaceId });
      if (!error && data && data.ok) {
        const q = data.quota || DEFAULT_EDIT_QUOTA;
        const used = data.used || 0;
        const remaining = data.remaining != null ? data.remaining : q - used;
        return { used, quota: q, remaining, exhausted: remaining <= 0 };
      }
      // any error → fail safe to local (enforcement still lives in consume)
    } catch (_) { /* fall through to local */ }
  }
  // Local mode (or cloud read failed): the quota is mirrored in state.editQuota.
  return normalizeLocal(state ? state.editQuota : null);
}

// ----- ensure a local quota row exists (no-op in cloud) ---------------------

export async function ensureQuota(state) {
  if (!state) return;
  if (isSupabaseConfigured && supabase && state.workspaceId) {
    // In cloud mode the row is created lazily by the server on first get/consume.
    return;
  }
  if (!state.editQuota || typeof state.editQuota !== 'object') {
    state.editQuota = { used: 0, quota: DEFAULT_EDIT_QUOTA };
  }
}

// ----- consume (the real gate) ----------------------------------------------

/**
 * Consume exactly one edit quota. In cloud mode this delegates to the atomic
 * consume_quote_edit() RPC (which re-checks used < quota under a row lock) and
 * returns its authoritative result. In local mode it mutates state.editQuota
 * after a pure consumeOne() check.
 *
 * Callers MUST only call this AFTER a successful save. Returns
 * { ok, quota, error }. ok=false means the edit must NOT be counted.
 */
export async function consumeEdit(state) {
  if (isSupabaseConfigured && supabase && state && state.workspaceId) {
    try {
      const { data, error } = await supabase.rpc('consume_quote_edit', { p_workspace: state.workspaceId });
      if (error) return { ok: false, error: error.message, quota: await getQuota(state) };
      if (data && data.ok) {
        const q = data.quota || DEFAULT_EDIT_QUOTA;
        const used = data.used || 0;
        const remaining = data.remaining != null ? data.remaining : q - used;
        return { ok: true, quota: { used, quota: q, remaining, exhausted: remaining <= 0 }, error: null };
      }
      // ok=false (exhausted / not_member): do NOT consume.
      return { ok: false, error: data && data.reason, quota: { used: data.used || 0, quota: data.quota || DEFAULT_EDIT_QUOTA, remaining: data.remaining || 0, exhausted: true } };
    } catch (e) {
      return { ok: false, error: e.message, quota: await getQuota(state) };
    }
  }

  // Local mode: mutate the mirrored blob quota.
  if (!state) return { ok: false, error: 'no state' };
  if (!state.editQuota || typeof state.editQuota !== 'object') {
    state.editQuota = { used: 0, quota: DEFAULT_EDIT_QUOTA };
  }
  if (state.editQuota.used >= state.editQuota.quota) {
    return { ok: false, error: 'exhausted', quota: state.editQuota };
  }
  state.editQuota = { ...state.editQuota, used: state.editQuota.used + 1 };
  const remaining = state.editQuota.quota - state.editQuota.used;
  return { ok: true, quota: { used: state.editQuota.used, quota: state.editQuota.quota, remaining, exhausted: remaining <= 0 } };
}

// ----- admin setter (plan tiers) --------------------------------------------

export async function setQuota(state, quota) {
  if (isSupabaseConfigured && supabase && state && state.workspaceId) {
    const { data, error } = await supabase.rpc('set_quote_edit_quota', { p_workspace: state.workspaceId, p_quota: quota });
    if (!error && data && data.ok) return { ok: true, quota: data.quota };
    return { ok: false, error: error ? error.message : (data && data.reason) };
  }
  if (state) state.editQuota = { used: state.editQuota ? state.editQuota.used : 0, quota };
  return { ok: true, quota };
}

// Re-export for callers that want to write the mirrored local quota directly.
export function saveQuota(state, quotaObj) {
  if (state) state.editQuota = quotaObj;
}
