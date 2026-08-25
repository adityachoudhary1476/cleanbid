-- ====================================================================
-- SUPERSEDED — DO NOT RUN
-- Authoritative schema: supabase-schema.sql
-- ====================================================================
-- Recreate is_workspace_member as STABLE SECURITY DEFINER
-- owned by postgres, using (SELECT auth.uid()) init-plan form
-- so it bypasses RLS and kills the infinite recursion loop.

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

-- Replace the members SELECT policy with a self-contained check
-- so it never calls the helper and can never re-enter the policy loop.

DROP POLICY IF EXISTS "Members can view workspace members" ON public.workspace_members;

CREATE POLICY "Members can view workspace members" ON public.workspace_members
  FOR SELECT
  USING (
    user_id = (SELECT auth.uid())
  );