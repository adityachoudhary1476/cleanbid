-- ====================================================================
-- SUPERSEDED — DO NOT RUN
-- Authoritative schema: supabase-schema.sql
-- ====================================================================
-- CLEANBID RLS v2 — fixes workspace creation (INSERT ... RETURNING)
-- Run the WHOLE file in Supabase Dashboard → SQL Editor
-- Project: jydwyzhmlsbckxwshplf
--
-- ROOT CAUSE of the 403:
--   The app calls insert({name}).select() → Postgres runs
--   INSERT ... RETURNING, which requires the NEW row to satisfy the
--   SELECT policy too. Old SELECT policy required membership, but the
--   creator's membership row is only inserted AFTER the workspace,
--   so every create failed with 42501.
--
-- FIX: track the creator on the row (created_by, defaults to auth.uid())
--   SELECT policy: members OR the creator
--   INSERT policy: created_by = auth.uid()  (closes the anon-insert hole)
-- Idempotent: safe to run multiple times.
-- ====================================================================

-- --------------------------------------------------------------------
-- 1) Helper (unchanged role, kept idempotent)
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_workspace_member(workspace_uuid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members m
    WHERE m.workspace_id = workspace_uuid
      AND m.user_id = (SELECT auth.uid())
  );
$$;
ALTER FUNCTION public.is_workspace_member(UUID) OWNER TO postgres;

-- --------------------------------------------------------------------
-- 2) Schema: record who created each workspace
-- --------------------------------------------------------------------
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid();

-- Backfill any legacy rows from their first owner membership (no-op if none)
UPDATE workspaces w
SET created_by = sub.user_id
FROM (
  SELECT DISTINCT ON (workspace_id) workspace_id, user_id
  FROM workspace_members
  ORDER BY workspace_id, created_at ASC
) sub
WHERE w.id = sub.workspace_id AND w.created_by IS NULL;

-- Clean up the probe row created during diagnosis (harmless if absent)
DELETE FROM workspaces WHERE name = 'anon probe';

-- --------------------------------------------------------------------
-- 3) Workspaces policies (v2)
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view their workspaces" ON workspaces;
CREATE POLICY "Users can view their workspaces" ON workspaces
  FOR SELECT USING (
    public.is_workspace_member(id)
    OR created_by = (SELECT auth.uid())
  );

-- Creator-scoped INSERT: replaces old WITH CHECK (true) which allowed
-- anonymous inserts. auth.uid() is NULL for anon -> check fails -> blocked.
DROP POLICY IF EXISTS "Users can create workspaces" ON workspaces;
CREATE POLICY "Users can create workspaces" ON workspaces
  FOR INSERT WITH CHECK (created_by = (SELECT auth.uid()));

-- --------------------------------------------------------------------
-- 4) Users profile policies (unchanged from v1)
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert own profile" ON users;
CREATE POLICY "Users can insert own profile" ON users
  FOR INSERT WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "Users can update own profile" ON users;
CREATE POLICY "Users can update own profile" ON users
  FOR UPDATE USING (id = auth.uid());

-- --------------------------------------------------------------------
-- 5) Workspace membership policies (unchanged from v1)
--    SELECT is deliberately self-contained (no recursion).
--    INSERT lets a user attach themselves as a member.
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS "Members can view workspace members" ON workspace_members;
CREATE POLICY "Members can view workspace members" ON workspace_members
  FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can join workspaces" ON workspace_members;
CREATE POLICY "Users can join workspaces" ON workspace_members
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- --------------------------------------------------------------------
-- 6) Tenant data tables — CRUD gated on membership (unchanged from v1)
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS "Members can view customers" ON customers;
CREATE POLICY "Members can view customers" ON customers
  FOR SELECT USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can create customers" ON customers;
CREATE POLICY "Members can create customers" ON customers
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can update customers" ON customers;
CREATE POLICY "Members can update customers" ON customers
  FOR UPDATE USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can delete customers" ON customers;
CREATE POLICY "Members can delete customers" ON customers
  FOR DELETE USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Members can view properties" ON properties;
CREATE POLICY "Members can view properties" ON properties
  FOR SELECT USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can create properties" ON properties;
CREATE POLICY "Members can create properties" ON properties
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can update properties" ON properties;
CREATE POLICY "Members can update properties" ON properties
  FOR UPDATE USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can delete properties" ON properties;
CREATE POLICY "Members can delete properties" ON properties
  FOR DELETE USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Members can view quotes" ON quotes;
CREATE POLICY "Members can view quotes" ON quotes
  FOR SELECT USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can create quotes" ON quotes;
CREATE POLICY "Members can create quotes" ON quotes
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can update quotes" ON quotes;
CREATE POLICY "Members can update quotes" ON quotes
  FOR UPDATE USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can delete quotes" ON quotes
  ;
CREATE POLICY "Members can delete quotes" ON quotes
  FOR DELETE USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Members can view pricing profiles" ON pricing_profiles;
CREATE POLICY "Members can view pricing profiles" ON pricing_profiles
  FOR SELECT USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can create pricing profiles" ON pricing_profiles;
CREATE POLICY "Members can create pricing profiles" ON pricing_profiles
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can update pricing profiles" ON pricing_profiles;
CREATE POLICY "Members can update pricing profiles" ON pricing_profiles
  FOR UPDATE USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can delete pricing profiles" ON pricing_profiles;
CREATE POLICY "Members can delete pricing profiles" ON pricing_profiles
  FOR DELETE USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Members can view activity log" ON activity_log;
CREATE POLICY "Members can view activity log" ON activity_log
  FOR SELECT USING (public.is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "Members can create activity log" ON activity_log;
CREATE POLICY "Members can create activity log" ON activity_log
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));

-- --------------------------------------------------------------------
-- 7) Refresh PostgREST schema cache so changes take effect immediately
-- --------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- --------------------------------------------------------------------
-- 8) Verify: expect exactly these two rows for workspaces:
--    Users can view their workspaces | SELECT
--    Users can create workspaces     | INSERT
-- --------------------------------------------------------------------
SELECT policyname, cmd, roles, with_check
FROM pg_policies
WHERE tablename = 'workspaces'
ORDER BY cmd;

-- ====================================================================
-- 9) USER PROFILE MIRRORING
-- Fixes: FK violation "workspace_memeber_user_id_fkey" on
--        workspace_members INSERT.
-- Cause: workspace_members.user_id references public.users(id), but
--        signups only create a row in auth.users — nothing populated
--        public.users, so the member insert has no matching parent row.
-- Fix:   backfill existing auth users into public.users, then keep them
--        in sync automatically via a trigger on auth.users.
-- ====================================================================

-- Backfill: every existing auth user gets a public.users row (idempotent)
INSERT INTO public.users (id, email, full_name)
SELECT u.id,
       u.email,
       COALESCE(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- Keep updated_at fresh when profiles are edited (harmless if column absent)
-- NOTE: skipped — column presence varies; core fix below is sufficient.

-- Auto-create the mirror row whenever a new user confirms/signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Verify: you should see YOUR email in this list
SELECT id, email FROM public.users ORDER BY created_at DESC LIMIT 5;
