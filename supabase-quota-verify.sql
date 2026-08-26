-- ====================================================================
-- CLEANBID — verify the quote-edit quota migration (run AFTER supabase-quota.sql)
-- Paste this into Supabase Dashboard -> SQL Editor and Run.
-- It does NOT change data; it only reports whether the objects exist and
-- what the INITIAL quota value for a new workspace is.
-- ====================================================================

-- 1) Table exists?
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='quote_edit_usage'
  ) THEN 'OK  quote_edit_usage table EXISTS'
    ELSE 'MISSING quote_edit_usage table' END AS table_check;

-- 2) RLS policies exist?
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='quote_edit_usage'
  ) THEN 'OK  RLS policies on quote_edit_usage exist'
    ELSE 'MISSING RLS policies' END AS rls_check;

-- 3) RPCs exist?
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='consume_quote_edit')
    THEN 'OK  consume_quote_edit() exists' ELSE 'MISSING consume_quote_edit()' END AS rpc_consume,
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='get_quote_quota')
    THEN 'OK  get_quote_quota() exists' ELSE 'MISSING get_quote_quota()' END AS rpc_get,
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='set_quote_edit_quota')
    THEN 'OK  set_quote_edit_quota() exists' ELSE 'MISSING set_quote_edit_quota()' END AS rpc_set,
  CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='default_edit_quota')
    THEN 'OK  default_edit_quota() exists' ELSE 'MISSING default_edit_quota()' END AS rpc_default;

-- 4) INITIAL QUOTA VALUE for a new workspace (single source of truth).
--    default_edit_quota() is what seeds every new workspace's quota.
SELECT public.default_edit_quota() AS initial_quota_for_new_workspace;
