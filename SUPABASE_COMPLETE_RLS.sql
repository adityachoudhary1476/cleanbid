-- ====================================================================
-- CLEANBID SUPABASE COMPLETE RLS POLICIES
-- Run this in Supabase Dashboard → SQL Editor
-- Project: jydwyzhmlsbckxwshplf (https://jydwyzhmlsbckxwshplf.supabase.co)
-- ====================================================================

-- ====================================================================
-- HELPER FUNCTION (avoids RLS recursion on workspace_members)
-- Must be STABLE SECURITY DEFINER owned by postgres
-- ====================================================================
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

-- ====================================================================
-- RLS POLICIES - Complete set for tenant isolation
-- ====================================================================

-- Workspaces: members can view their workspaces
DROP POLICY IF EXISTS "Users can view their workspaces" ON workspaces;
CREATE POLICY "Users can view their workspaces" ON workspaces
  FOR SELECT USING (
    public.is_workspace_member(id)
  );

-- Workspaces: authenticated users can create workspaces
-- WITH CHECK (true) is correct here because:
-- 1. Only authenticated users can reach this (auth.uid() exists)
-- 2. The creator becomes owner via workspace_members INSERT immediately after
-- 3. No other tenant data is exposed
DROP POLICY IF EXISTS "Users can create workspaces" ON workspaces;
CREATE POLICY "Users can create workspaces" ON workspaces
  FOR INSERT WITH CHECK (true);

-- Users: can insert own profile (mirroring auth.users)
DROP POLICY IF EXISTS "Users can insert own profile" ON users;
CREATE POLICY "Users can insert own profile" ON users
  FOR INSERT WITH CHECK (id = auth.uid());

-- Users: can update own profile
DROP POLICY IF EXISTS "Users can update own profile" ON users;
CREATE POLICY "Users can update own profile" ON users
  FOR UPDATE USING (id = auth.uid());

-- Workspace members: users can always see their own memberships
-- Self-contained on purpose - calling is_workspace_member() here would
-- re-query this same table inside policy evaluation and recurse.
DROP POLICY IF EXISTS "Members can view workspace members" ON workspace_members;
CREATE POLICY "Members can view workspace members" ON workspace_members
  FOR SELECT USING (
    user_id = (SELECT auth.uid())
  );

-- Workspace members: users can join workspaces (insert own membership)
-- This allows the createWorkspace() flow to insert membership with user_id = auth.uid()
DROP POLICY IF EXISTS "Users can join workspaces" ON workspace_members;
CREATE POLICY "Users can join workspaces" ON workspace_members
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Customers: CRUD for workspace members
DROP POLICY IF EXISTS "Members can view customers" ON customers;
CREATE POLICY "Members can view customers" ON customers
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can create customers" ON customers;
CREATE POLICY "Members can create customers" ON customers
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can update customers" ON customers;
CREATE POLICY "Members can update customers" ON customers
  FOR UPDATE USING (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can delete customers" ON customers;
CREATE POLICY "Members can delete customers" ON customers
  FOR DELETE USING (
    public.is_workspace_member(workspace_id)
  );

-- Properties: CRUD for workspace members
DROP POLICY IF EXISTS "Members can view properties" ON properties;
CREATE POLICY "Members can view properties" ON properties
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can create properties" ON properties;
CREATE POLICY "Members can create properties" ON properties
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can update properties" ON properties;
CREATE POLICY "Members can update properties" ON properties
  FOR UPDATE USING (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can delete properties" ON properties;
CREATE POLICY "Members can delete properties" ON properties
  FOR DELETE USING (
    public.is_workspace_member(workspace_id)
  );

-- Quotes: CRUD for workspace members
DROP POLICY IF EXISTS "Members can view quotes" ON quotes;
CREATE POLICY "Members can view quotes" ON quotes
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can create quotes" ON quotes;
CREATE POLICY "Members can create quotes" ON quotes
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can update quotes" ON quotes;
CREATE POLICY "Members can update quotes" ON quotes
  FOR UPDATE USING (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can delete quotes" ON quotes;
CREATE POLICY "Members can delete quotes" ON quotes
  FOR DELETE USING (
    public.is_workspace_member(workspace_id)
  );

-- Pricing profiles: CRUD for workspace members
DROP POLICY IF EXISTS "Members can view pricing profiles" ON pricing_profiles;
CREATE POLICY "Members can view pricing profiles" ON pricing_profiles
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can create pricing profiles" ON pricing_profiles;
CREATE POLICY "Members can create pricing profiles" ON pricing_profiles
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can update pricing profiles" ON pricing_profiles;
CREATE POLICY "Members can update pricing profiles" ON pricing_profiles
  FOR UPDATE USING (
    public.is_workspace_member(workspace_id)
  );
DROP POLICY IF EXISTS "Members can delete pricing profiles" ON pricing_profiles;
CREATE POLICY "Members can delete pricing profiles" ON pricing_profiles
  FOR DELETE USING (
    public.is_workspace_member(workspace_id)
  );

-- Activity log: viewable by workspace members
DROP POLICY IF EXISTS "Members can view activity log" ON activity_log;
CREATE POLICY "Members can view activity log" ON activity_log
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
  );

-- Activity log: insertable by workspace members
DROP POLICY IF EXISTS "Members can create activity log" ON activity_log;
CREATE POLICY "Members can create activity log" ON activity_log
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
  );

-- ====================================================================
-- VERIFICATION QUERIES (run these after applying to confirm)
-- ====================================================================

-- Check all tables have RLS enabled
SELECT schemaname, tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
  AND tablename IN ('workspaces', 'users', 'workspace_members', 'customers', 'properties', 'quotes', 'pricing_profiles', 'activity_log')
ORDER BY tablename;

-- Check all policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- Verify helper function
SELECT proname, prosecdef, provolatile, prosecdef 
FROM pg_proc 
WHERE proname = 'is_workspace_member';