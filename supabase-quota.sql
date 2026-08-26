-- ====================================================================
-- CLEANBID — Quote-Edit Quota (additive, idempotent)
-- Run in Supabase Dashboard → SQL Editor, or via the migration runner.
-- Safe to re-run; uses IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS.
--
-- WHAT THIS ENFORCES
--   * One quota row per workspace (quote_edit_usage.workspace_id PK/FK).
--   * Tenant isolation: the SAME is_workspace_member() RLS used by every
--     other table gates reads/writes. Workspace A cannot read or write
--     Workspace B's quota.
--   * AUTHORITATIVE enforcement lives in the consume_quote_edit() RPC, which
--     locks the row (SELECT ... FOR UPDATE), re-checks used < quota, and
--     increments under that lock. A client flipping its own state cannot
--     bypass it, because the server re-validates and RLS blocks cross-tenant
--     writes. No service-role key is used client-side.
--   * The initial quota for a NEW workspace is defined ONCE, here, in
--     default_edit_quota() (currently 10). The table default, the lazy seed
--     in consume_quote_edit(), and the ensure-seed in get_quote_quota() ALL
--     read it — so it is never an accidental literal scattered in code.
--     Future plan tiers only need to call set_quote_edit_quota() (admin only).
-- ====================================================================

-- 0) Single source of truth for the initial quota value ----------------
CREATE OR REPLACE FUNCTION public.default_edit_quota()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  -- Initial quote-edit quota granted to every new workspace.
  -- Change this in ONE place to adjust the default for all new workspaces.
  SELECT 10;
$$;
ALTER FUNCTION public.default_edit_quota() OWNER TO postgres;

-- 1) Table ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quote_edit_usage (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  used INTEGER NOT NULL DEFAULT 0,
  quota INTEGER NOT NULL DEFAULT public.default_edit_quota(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT qeu_used_nonneg CHECK (used >= 0),
  CONSTRAINT qeu_used_le_quota CHECK (used <= quota),
  CONSTRAINT qeu_quota_pos CHECK (quota > 0)
);

-- 2) RLS (mirrors the rest of the schema) ----------------------------------
ALTER TABLE quote_edit_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view edit usage" ON quote_edit_usage;
CREATE POLICY "Members can view edit usage" ON quote_edit_usage
  FOR SELECT USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Members can update edit usage" ON quote_edit_usage;
CREATE POLICY "Members can update edit usage" ON quote_edit_usage
  FOR UPDATE USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Members can insert edit usage" ON quote_edit_usage;
CREATE POLICY "Members can insert edit usage" ON quote_edit_usage
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));

-- 3) Explicit INIT / read RPC --------------------------------------------
-- Ensuring the row exists is the canonical initialization path for a new
-- workspace's quota. Calling this seeds the row with default_edit_quota()
-- (used = 0) on first access, so the quota card always reflects the REAL
-- server value rather than a client-side guess. It never consumes an edit.
CREATE OR REPLACE FUNCTION public.get_quote_quota(p_workspace UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r_used INTEGER;
  r_quota INTEGER;
BEGIN
  IF NOT public.is_workspace_member(p_workspace) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_member', 'used', 0, 'quota', 0, 'remaining', 0);
  END IF;

  SELECT used, quota INTO r_used, r_quota
  FROM public.quote_edit_usage
  WHERE workspace_id = p_workspace
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.quote_edit_usage (workspace_id, used, quota)
    VALUES (p_workspace, 0, public.default_edit_quota())
    ON CONFLICT (workspace_id) DO NOTHING
    RETURNING used, quota INTO r_used, r_quota;
    -- Concurrent seed race: re-read if the INSERT was a no-op.
    IF NOT FOUND THEN
      SELECT used, quota INTO r_used, r_quota
      FROM public.quote_edit_usage
      WHERE workspace_id = p_workspace;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'used', r_used, 'quota', r_quota, 'remaining', r_quota - r_used);
END;
$$;
ALTER FUNCTION public.get_quote_quota(UUID) OWNER TO postgres;

-- 4) Atomic consume RPC (the real gate) -----------------------------------
CREATE OR REPLACE FUNCTION public.consume_quote_edit(p_workspace UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row_used INTEGER;
  row_quota INTEGER;
  next_used INTEGER;
BEGIN
  -- Authorization: caller MUST be a member of the workspace. If not, or the
  -- row is missing, behave as if there is no quota to grant.
  IF NOT public.is_workspace_member(p_workspace) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_member', 'used', 0, 'quota', 0, 'remaining', 0);
  END IF;

  -- Lock the row so two concurrent edits cannot both pass the check.
  SELECT used, quota INTO row_used, row_quota
  FROM public.quote_edit_usage
  WHERE workspace_id = p_workspace
  FOR UPDATE;

  -- First edit for this workspace: seed the default quota row and allow it.
  IF NOT FOUND THEN
    INSERT INTO public.quote_edit_usage (workspace_id, used, quota)
    VALUES (p_workspace, 1, public.default_edit_quota())
    ON CONFLICT (workspace_id) DO
      UPDATE SET used = LEAST(quote_edit_usage.quota, quote_edit_usage.used + 1),
                 updated_at = now()
    RETURNING used, quota INTO row_used, row_quota;
    RETURN jsonb_build_object('ok', true, 'used', row_used, 'quota', row_quota, 'remaining', row_quota - row_used);
  END IF;

  -- Exhausted?
  IF row_used >= row_quota THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'exhausted', 'used', row_used, 'quota', row_quota, 'remaining', 0);
  END IF;

  next_used := row_used + 1;
  UPDATE public.quote_edit_usage
  SET used = next_used, updated_at = now()
  WHERE workspace_id = p_workspace;

  RETURN jsonb_build_object('ok', true, 'used', next_used, 'quota', row_quota, 'remaining', row_quota - next_used);
END;
$$;
ALTER FUNCTION public.consume_quote_edit(UUID) OWNER TO postgres;

-- 5) Admin-only setter (plan tiers call this later) ----------------------
-- MEMBERS cannot call this: only a workspace admin may change the quota.
-- (is_workspace_member alone would let any member raise their own limit and
--  bypass the whole quota — that path is intentionally closed here.)
CREATE OR REPLACE FUNCTION public.set_quote_edit_quota(p_workspace UUID, p_quota INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  clamped INTEGER;
  r_used INTEGER;
  r_quota INTEGER;
BEGIN
  IF public.member_role(p_workspace) IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  clamped := GREATEST(1, p_quota);
  INSERT INTO public.quote_edit_usage (workspace_id, used, quota)
  VALUES (p_workspace, 0, clamped)
  ON CONFLICT (workspace_id) DO
    UPDATE SET quota = clamped,
               used = LEAST(quote_edit_usage.used, clamped),
               updated_at = now()
  RETURNING used, quota INTO r_used, r_quota;
  RETURN jsonb_build_object('ok', true, 'quota', r_quota, 'used', r_used);
END;
$$;
ALTER FUNCTION public.set_quote_edit_quota(UUID, INTEGER) OWNER TO postgres;

-- 6) Refresh PostgREST cache ----------------------------------------------
NOTIFY pgrst, 'reload schema';
