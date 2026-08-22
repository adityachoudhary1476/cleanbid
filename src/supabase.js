/**
 * CleanBid — Single Supabase Client
 *
 * This module owns the ONE and only Supabase client used by the application.
 * It is deliberately isolated from domain/business logic (auth, db, workspace)
 * so that:
 *   - we never create multiple competing clients, and
 *   - client initialization/configuration lives in exactly one place.
 *
 * Credentials come ONLY from Vite env vars (VITE_SUPABASE_URL /
 * VITE_SUPABASE_ANON_KEY). The anon key is safe for the browser; the
 * service-role key must NEVER be imported or used here.
 *
 * If the env vars are absent, `supabase` is null and `isSupabaseConfigured`
 * is false — the app falls back to local/demo mode.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = !!(
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  String(SUPABASE_URL).startsWith('http')
);

export const supabase = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

if (isSupabaseConfigured) {
  console.log('[CleanBid Supabase] Client initialized for', SUPABASE_URL);
} else {
  console.log('[CleanBid Supabase] Not configured — running in local/demo mode');
}
