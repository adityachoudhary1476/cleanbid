-- ====================================================================
-- CLEANBID — Quote metadata persistence (additive, idempotent)
-- Run in Supabase Dashboard -> SQL Editor AFTER supabase-quota.sql.
-- Safe to re-run (IF NOT EXISTS). Adds the columns that H1 requires so
-- editHistory / discountPct / whyOverrides survive the
-- application -> Supabase -> reload -> application round-trip.
--
-- Existing quotes (NULL columns) continue to load: mapQuoteFromDb falls
-- back to safe defaults (editHistory [], whyOverrides {}, discountPct 0).
-- No pricing semantics change; stored monthly/annual are untouched.
-- ====================================================================

-- Reuse the quotes table already defined in supabase-schema.sql.
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS why_overrides JSONB DEFAULT '{}';

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS edit_history JSONB DEFAULT '[]';

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS discount_pct DECIMAL;

-- Keep PostgREST in sync with the new columns.
NOTIFY pgrst, 'reload schema';
