-- ====================================================================
-- CLEANBID — AUTHORITATIVE SUPABASE SCHEMA (consolidated)
-- ====================================================================
-- Supersedes: SUPABASE_COMPLETE_RLS.sql, fix-rls-recursion.sql,
--             supabase-restore-rpc.sql (all merged + invitation system).
--
-- SAFE TO APPLY TO A FRESH SUPABASE PROJECT. Idempotent: every object
-- uses CREATE OR REPLACE / IF NOT EXISTS / DROP POLICY IF EXISTS.
--
-- WHAT THIS ENFORCES
--   * Multi-tenant isolation on every table (RLS on, membership-gated).
--   * workspaces INSERT is creator-scoped (created_by = auth.uid()).
--   * Entity tables: UPDATE has WITH CHECK; workspace_id is IMMUTABLE.
--   * Atomic, server-authoritative backup restore (restore_workspace_backup).
--   * F1: workspace_members can ONLY be inserted by (a) the workspace
--     creator (owner row) or (b) accepting a valid, email-bound
--     invitation. Self-join by UUID is DENIED.
--   * Invitation system: workspace_invitations table + create/accept RPCs
--     with token hashing, expiry, one-time use, role/escalation guards.
-- ====================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ====================================================================
-- 1) TABLES
-- ====================================================================

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  branding JSONB DEFAULT '{}',
  pricing_defaults JSONB DEFAULT '{}',
  -- F2 hardening: creator tracking so workspace INSERT can be scoped.
  created_by UUID DEFAULT auth.uid(),
  -- F2 hardening: columns the client layer (src/db.js mapWorkspaceSettingsToDb)
  -- expects but the original schema omitted.
  addons JSONB NOT NULL DEFAULT '[]',
  tasks JSONB NOT NULL DEFAULT '[]',
  area_types JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'estimator',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  company TEXT NOT NULL,
  contact TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  notes TEXT,
  last_activity TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  address TEXT,
  type TEXT DEFAULT 'office',
  sqft INTEGER,
  floors INTEGER DEFAULT 1,
  quote_count INTEGER DEFAULT 0,
  last_quoted TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
  property_name TEXT NOT NULL,
  company_name TEXT NOT NULL,
  contact TEXT,
  email TEXT,
  phone TEXT,
  property_address TEXT,
  sqft INTEGER,
  floors INTEGER DEFAULT 1,
  type TEXT DEFAULT 'office',
  frequency DECIMAL DEFAULT 2,
  package TEXT DEFAULT 'professional',
  profile_id TEXT,
  profile_name TEXT,
  areas JSONB DEFAULT '[]',
  tasks JSONB DEFAULT '[]',
  addons JSONB DEFAULT '[]',
  cleaners INTEGER,
  hours_per_visit DECIMAL,
  visits_per_month DECIMAL,
  monthly INTEGER,
  annual INTEGER,
  margin DECIMAL,
  cost_per_visit INTEGER,
  labor_per_visit INTEGER,
  burden_per_visit INTEGER,
  supplies_per_visit INTEGER,
  overhead_per_visit INTEGER,
  addons_per_visit INTEGER,
  status TEXT DEFAULT 'draft',
  version INTEGER DEFAULT 1,
  versions JSONB DEFAULT '[]',
  followup DATE,
  lost_reason TEXT,
  price_snap JSONB DEFAULT '{}',
  productivity_snap JSONB DEFAULT '{}',
  calc_monthly INTEGER,
  override JSONB DEFAULT '{}',
  date TEXT,
  modified TEXT,
  created_iso TIMESTAMPTZ DEFAULT now(),
  modified_iso TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing_profiles (
  id TEXT PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  wage DECIMAL NOT NULL,
  burden DECIMAL NOT NULL,
  overhead DECIMAL NOT NULL,
  margin DECIMAL NOT NULL,
  min_price INTEGER DEFAULT 800,
  supplies DECIMAL DEFAULT 8,
  productivity JSONB DEFAULT '{}',
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ====================================================================
-- F1: INVITATION TABLE
-- ====================================================================
CREATE TABLE IF NOT EXISTS workspace_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'estimator',
  token_hash TEXT NOT NULL,               -- SHA-256 hex of the raw token (no plaintext at rest)
  invited_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at TIMESTAMPTZ,
  accepted_by UUID REFERENCES users(id),
  CONSTRAINT workspace_invitations_role_chk CHECK (role IN ('estimator','sales','admin','owner'))
);

CREATE INDEX IF NOT EXISTS idx_invitations_workspace_email
  ON workspace_invitations (workspace_id, lower(invited_email));
CREATE INDEX IF NOT EXISTS idx_invitations_token
  ON workspace_invitations (token_hash);
-- One active invitation per (workspace, email).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_active
  ON workspace_invitations (workspace_id, lower(invited_email))
  WHERE accepted_at IS NULL;

-- ====================================================================
-- 2b) MIGRATION SAFETY — additive columns + backfills for existing
--     production DBs (so this single file is safe for BOTH fresh and
--     existing projects; all statements are idempotent).
-- ====================================================================
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid();
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS addons JSONB NOT NULL DEFAULT '[]';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS tasks JSONB NOT NULL DEFAULT '[]';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS area_types JSONB NOT NULL DEFAULT '[]';

-- Backfill created_by for any workspace that predates v2 (first owner row).
UPDATE workspaces w
SET created_by = sub.user_id
FROM (
  SELECT DISTINCT ON (workspace_id) workspace_id, user_id
  FROM workspace_members
  ORDER BY workspace_id, created_at ASC
) sub
WHERE w.id = sub.workspace_id AND w.created_by IS NULL;

-- Backfill public.users from auth.users (the trigger only covers NEW signups;
-- pre-trigger accounts would otherwise break invite-accept email lookup).
INSERT INTO public.users (id, email, full_name)
SELECT u.id, u.email,
       COALESCE(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- ====================================================================
-- 2) INDEXES (entity tables)
-- ====================================================================
CREATE INDEX IF NOT EXISTS idx_customers_workspace ON customers(workspace_id);
CREATE INDEX IF NOT EXISTS idx_properties_workspace ON properties(workspace_id);
CREATE INDEX IF NOT EXISTS idx_properties_customer ON properties(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_workspace ON quotes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_quotes_property ON quotes(property_id);
CREATE INDEX IF NOT EXISTS idx_pricing_profiles_workspace ON pricing_profiles(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_workspace ON activity_log(workspace_id);

-- ====================================================================
-- 3) RLS ENABLE
-- ====================================================================
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY;

-- ====================================================================
-- 4) HELPER FUNCTIONS
-- ====================================================================

-- Membership check (SECURITY DEFINER — avoids infinite recursion on
-- workspace_members policies).
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

-- Role of the caller within a workspace (NULL if not a member).
CREATE OR REPLACE FUNCTION public.member_role(workspace_uuid UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.role FROM public.workspace_members m
  WHERE m.workspace_id = workspace_uuid AND m.user_id = (SELECT auth.uid())
  LIMIT 1;
$$;
ALTER FUNCTION public.member_role(UUID) OWNER TO postgres;

-- Null-safe numeric/text extractors for the restore RPC.
CREATE OR REPLACE FUNCTION public._cb_num(j JSONB, k TEXT) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN j->>k IS NULL OR j->>k = '' THEN NULL ELSE (j->>k)::NUMERIC END; $$;
CREATE OR REPLACE FUNCTION public._cb_int(j JSONB, k TEXT) RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN j->>k IS NULL OR j->>k = '' THEN NULL ELSE (j->>k)::DOUBLE PRECISION::INTEGER END; $$;
CREATE OR REPLACE FUNCTION public._cb_ts(j JSONB, k TEXT) RETURNS TIMESTAMPTZ LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN j->>k IS NULL OR j->>k = '' THEN NULL ELSE (j->>k)::TIMESTAMPTZ END; $$;
CREATE OR REPLACE FUNCTION public._cb_text(j JSONB, k TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN j->>k IS NULL OR j->>k = '' THEN NULL ELSE j->>k END; $$;

-- Keep workspace_id immutable on entity tables (defense-in-depth against
-- UPDATE-based cross-workspace moves).
CREATE OR REPLACE FUNCTION public._cb_forbid_workspace_move()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'workspace_id is immutable (attempted % -> % on %.%)',
      OLD.workspace_id, NEW.workspace_id, TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

-- ====================================================================
-- 5) RLS POLICIES
-- ====================================================================

-- ---- workspaces ----
DROP POLICY IF EXISTS "Users can view their workspaces" ON workspaces;
CREATE POLICY "Users can view their workspaces" ON workspaces
  FOR SELECT USING ( public.is_workspace_member(id) OR created_by = (SELECT auth.uid()) );

DROP POLICY IF EXISTS "Users can create workspaces" ON workspaces;
CREATE POLICY "Users can create workspaces" ON workspaces
  FOR INSERT WITH CHECK ( created_by = (SELECT auth.uid()) );

-- ---- users (self only) ----
DROP POLICY IF EXISTS "Users can insert own profile" ON users;
CREATE POLICY "Users can insert own profile" ON users FOR INSERT WITH CHECK (id = auth.uid());
DROP POLICY IF EXISTS "Users can update own profile" ON users;
CREATE POLICY "Users can update own profile" ON users FOR UPDATE USING (id = auth.uid());

-- ---- workspace_members ----
-- SELECT: a user always sees their own membership rows (self-contained, no
-- recursion).
DROP POLICY IF EXISTS "Members can view workspace members" ON workspace_members;
CREATE POLICY "Members can view workspace members" ON workspace_members
  FOR SELECT USING ( user_id = (SELECT auth.uid()) );

-- INSERT (F1): only the workspace CREATOR (owner row) OR a user accepting a
-- VALID, email-bound, already-accepted invitation may insert. A bare
-- self-join by UUID is rejected because no accepted invitation exists.
DROP POLICY IF EXISTS "Membership via invitation or creator" ON workspace_members;
CREATE POLICY "Membership via invitation or creator" ON workspace_members
  FOR INSERT WITH CHECK (
    user_id = (SELECT auth.uid())
    AND (
      EXISTS (
        SELECT 1 FROM public.workspace_invitations i
        WHERE i.workspace_id = workspace_members.workspace_id
          AND i.accepted_by = (SELECT auth.uid())
          AND i.accepted_at IS NOT NULL
      )
      OR EXISTS (
        SELECT 1 FROM public.workspaces w
        WHERE w.id = workspace_members.workspace_id
          AND w.created_by = (SELECT auth.uid())
      )
    )
  );

-- No UPDATE/DELETE policies on workspace_members -> Supabase DENIES both by
-- default. Role changes / removals must go through authorized app flows.

-- ---- customers / properties / quotes / pricing_profiles ----
-- SELECT + INSERT + UPDATE + DELETE, all membership-gated. UPDATE adds
-- WITH CHECK so a modified row must still belong to the caller's workspace,
-- and the immutable-workspace_id trigger blocks workspace reassignment.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers','properties','quotes','pricing_profiles'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Members can view %1$s" ON %1$s;', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members can create %1$s" ON %1$s;', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members can update %1$s" ON %1$s;', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members can delete %1$s" ON %1$s;', t);

    EXECUTE format('CREATE POLICY "Members can view %1$s" ON %1$s FOR SELECT USING (public.is_workspace_member(workspace_id));', t);
    EXECUTE format('CREATE POLICY "Members can create %1$s" ON %1$s FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id));', t);
    EXECUTE format('CREATE POLICY "Members can update %1$s" ON %1$s FOR UPDATE USING (public.is_workspace_member(workspace_id)) WITH CHECK (public.is_workspace_member(workspace_id));', t);
    EXECUTE format('CREATE POLICY "Members can delete %1$s" ON %1$s FOR DELETE USING (public.is_workspace_member(workspace_id));', t);
  END LOOP;
END $$;

-- ---- activity_log ----
DROP POLICY IF EXISTS "Members can view activity log" ON activity_log;
CREATE POLICY "Members can view activity log" ON activity_log
  FOR SELECT USING ( public.is_workspace_member(workspace_id) );
DROP POLICY IF EXISTS "Members can create activity log" ON activity_log;
CREATE POLICY "Members can create activity log" ON activity_log
  FOR INSERT WITH CHECK ( public.is_workspace_member(workspace_id) );

-- ---- workspace_invitations ----
-- Visible only to workspace members (so the admin UI can list them).
DROP POLICY IF EXISTS "Members can view invitations" ON workspace_invitations;
CREATE POLICY "Members can view invitations" ON workspace_invitations
  FOR SELECT USING ( public.is_workspace_member(workspace_id) );
-- Creation/acceptance happen ONLY through SECURITY DEFINER RPCs, never via
-- direct client INSERT/UPDATE (no INSERT/UPDATE policies => denied).

-- ====================================================================
-- 6) IMMUTABLE workspace_id TRIGGERS
-- ====================================================================
DROP TRIGGER IF EXISTS customers_lock_ws        ON public.customers;
DROP TRIGGER IF EXISTS properties_lock_ws       ON public.properties;
DROP TRIGGER IF EXISTS quotes_lock_ws           ON public.quotes;
DROP TRIGGER IF EXISTS pricing_profiles_lock_ws ON public.pricing_profiles;
CREATE TRIGGER customers_lock_ws        BEFORE UPDATE ON public.customers        FOR EACH ROW EXECUTE FUNCTION public._cb_forbid_workspace_move();
CREATE TRIGGER properties_lock_ws       BEFORE UPDATE ON public.properties       FOR EACH ROW EXECUTE FUNCTION public._cb_forbid_workspace_move();
CREATE TRIGGER quotes_lock_ws           BEFORE UPDATE ON public.quotes           FOR EACH ROW EXECUTE FUNCTION public._cb_forbid_workspace_move();
CREATE TRIGGER pricing_profiles_lock_ws BEFORE UPDATE ON public.pricing_profiles FOR EACH ROW EXECUTE FUNCTION public._cb_forbid_workspace_move();

-- ====================================================================
-- 7) USER PROFILE MIRRORING (auth.users -> public.users)
-- ====================================================================
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

-- ====================================================================
-- 8) INVITATION RPCs (F1)
-- ====================================================================

-- Create an invitation. Returns the RAW token exactly once (caller must
-- deliver it). Only admins/owners may invite; nobody may grant 'owner'
-- unless they themselves are an owner. Duplicate active invites reuse the
-- existing token. Inviting an existing member is rejected.
CREATE OR REPLACE FUNCTION public.create_workspace_invitation(
  p_workspace UUID,
  p_email TEXT,
  p_role TEXT DEFAULT 'estimator'
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role TEXT;
  v_token TEXT;
  v_hash  TEXT;
  v_existing_id UUID;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF NOT public.is_workspace_member(p_workspace) THEN
    RAISE EXCEPTION 'not a member of this workspace';
  END IF;
  v_caller_role := public.member_role(p_workspace);
  IF v_caller_role IS DISTINCT FROM 'admin' AND v_caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only admins or owners may invite users';
  END IF;
  IF p_role IS DISTINCT FROM 'estimator' AND p_role IS DISTINCT FROM 'sales'
     AND p_role IS DISTINCT FROM 'admin' AND p_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'invalid role';
  END IF;
  IF p_role = 'owner' AND v_caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only an owner may invite another owner';
  END IF;

  -- Already a member?
  IF EXISTS (
    SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = p_workspace AND lower(u.email) = lower(p_email)
  ) THEN
    RAISE EXCEPTION 'user is already a member of this workspace';
  END IF;

  -- Reuse an existing active invitation by re-issuing a fresh token for it
  -- (the raw token is never persisted, so we cannot return the old one).
  SELECT id INTO v_existing_id FROM workspace_invitations
   WHERE workspace_id = p_workspace AND lower(invited_email) = lower(p_email) AND accepted_at IS NULL
   LIMIT 1;
  v_token := encode(gen_random_bytes(24), 'hex');
  v_hash  := encode(digest(v_token, 'sha256'), 'hex');
  IF v_existing_id IS NOT NULL THEN
    UPDATE workspace_invitations
      SET token_hash = v_hash, role = p_role, invited_by = (SELECT auth.uid()),
          expires_at = now() + interval '7 days', created_at = now()
    WHERE id = v_existing_id;
    RETURN v_token;
  END IF;

  INSERT INTO workspace_invitations (workspace_id, invited_email, role, token_hash, invited_by, expires_at)
  VALUES (p_workspace, lower(p_email), p_role, v_hash, (SELECT auth.uid()), now() + interval '7 days');

  RETURN v_token; -- raw token, returned once
END;
$$;

-- Accept an invitation by raw token. Atomic. Verifies existence, workspace
-- match, expiry, one-time use, and that the caller's VERIFIED email matches
-- the invited email. Inserts the membership with the invitation's role and
-- marks the invitation accepted. All server-derived — client cannot choose
-- workspace, role, or recipient.
CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_email TEXT;
  v_inv workspace_invitations%ROWTYPE;
  v_ws UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  v_email := lower((SELECT email FROM public.users WHERE id = v_uid));
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'user profile missing';
  END IF;

  SELECT * INTO v_inv FROM workspace_invitations
   WHERE token_hash = encode(digest(p_token, 'sha256'), 'hex')
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation not found';
  END IF;
  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'invitation expired';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation already used';
  END IF;
  IF lower(v_inv.invited_email) IS DISTINCT FROM v_email THEN
    RAISE EXCEPTION 'invitation is for a different email address';
  END IF;

  v_ws := v_inv.workspace_id;

  -- Create the membership (role + workspace_id come from the invitation,
  -- never from the client). INSERT policy allows this because the accepted
  -- invitation EXISTS for this user/workspace.
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (v_ws, v_uid, v_inv.role)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  UPDATE workspace_invitations
    SET accepted_at = now(), accepted_by = v_uid
    WHERE id = v_inv.id;

  RETURN jsonb_build_object('workspace_id', v_ws, 'role', v_inv.role);
END;
$$;

-- ====================================================================
-- 9) ATOMIC WORKSPACE RESTORE (P0-1 hardening, carried forward)
-- ====================================================================
CREATE OR REPLACE FUNCTION public.restore_workspace_backup(
  p_target_workspace UUID,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID;
  v_ws       UUID;
  v_rec      JSONB;
  v_customer INT;
  v_property INT;
  v_quote    INT;
  v_profile  INT;
  v_activity INT;
  v_map_c  JSONB := '{}'::jsonb;
  v_map_p  JSONB := '{}'::jsonb;
  v_map_pr JSONB := '{}'::jsonb;
  v_in     TEXT;
  v_new    TEXT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'restore refused: caller is not authenticated'; END IF;
  SELECT id INTO v_ws FROM public.workspaces WHERE id = p_target_workspace;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'restore refused: target workspace does not exist'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = v_ws AND m.user_id = v_uid) THEN
    RAISE EXCEPTION 'restore refused: caller is not a member of the target workspace';
  END IF;

  DELETE FROM public.activity_log     WHERE workspace_id = v_ws;
  DELETE FROM public.quotes           WHERE workspace_id = v_ws;
  DELETE FROM public.pricing_profiles WHERE workspace_id = v_ws;
  DELETE FROM public.properties       WHERE workspace_id = v_ws;
  DELETE FROM public.customers        WHERE workspace_id = v_ws;

  UPDATE public.workspaces SET
    branding         = COALESCE(p_payload->'org', '{}'::jsonb),
    pricing_defaults = COALESCE(p_payload->'pricing', '{}'::jsonb),
    addons           = COALESCE(p_payload->'addons', '[]'::jsonb),
    tasks            = COALESCE(p_payload->'tasks', '[]'::jsonb),
    area_types       = COALESCE(p_payload->'area_types', '[]'::jsonb),
    updated_at       = now()
  WHERE id = v_ws;

  FOR v_rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'customers', '[]'::jsonb)) LOOP
    v_in := v_rec->>'id';
    IF v_in IS NULL OR v_in = '' OR EXISTS (SELECT 1 FROM public.customers c WHERE c.id = v_in AND c.workspace_id <> v_ws) THEN
      v_new := CASE WHEN v_in IS NULL OR v_in = '' THEN gen_random_uuid()::text ELSE NULL END;
      IF v_new IS NULL THEN SELECT c.id INTO v_new FROM public.customers c WHERE c.id = v_in AND c.workspace_id = v_ws; END IF;
      v_new := COALESCE(v_new, gen_random_uuid()::text);
      v_map_c := jsonb_set(v_map_c, ARRAY[v_in], to_jsonb(v_new));
    ELSE v_new := v_in; END IF;
    INSERT INTO public.customers (id, workspace_id, company, contact, email, phone, address, notes, last_activity)
    VALUES (v_new, v_ws, COALESCE(v_rec->>'company', '(unnamed customer)'),
      _cb_text(v_rec, 'contact'), _cb_text(v_rec, 'email'), _cb_text(v_rec, 'phone'),
      _cb_text(v_rec, 'address'), _cb_text(v_rec, 'notes'), _cb_text(v_rec, 'lastActivity'));
    v_customer := COALESCE(v_customer, 0) + 1;
  END LOOP;

  FOR v_rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'properties', '[]'::jsonb)) LOOP
    v_in := v_rec->>'id';
    IF v_in IS NULL OR v_in = '' OR EXISTS (SELECT 1 FROM public.properties p WHERE p.id = v_in AND p.workspace_id <> v_ws) THEN
      v_new := CASE WHEN v_in IS NULL OR v_in = '' THEN gen_random_uuid()::text ELSE NULL END;
      IF v_new IS NULL THEN SELECT p.id INTO v_new FROM public.properties p WHERE p.id = v_in AND p.workspace_id = v_ws; END IF;
      v_new := COALESCE(v_new, gen_random_uuid()::text);
      v_map_p := jsonb_set(v_map_p, ARRAY[v_in], to_jsonb(v_new));
    ELSE v_new := v_in; END IF;
    INSERT INTO public.properties (id, workspace_id, customer_id, name, address, type, sqft, floors, quote_count, last_quoted)
    VALUES (v_new, v_ws,
      CASE WHEN _cb_text(v_rec, 'customerId') IS NULL THEN NULL ELSE COALESCE(v_map_c ->> _cb_text(v_rec, 'customerId'), _cb_text(v_rec, 'customerId')) END,
      COALESCE(v_rec->>'name', '(unnamed property)'), _cb_text(v_rec, 'address'),
      COALESCE(_cb_text(v_rec, 'type'), 'office'), _cb_int(v_rec, 'sqft'), COALESCE(_cb_int(v_rec, 'floors'), 1),
      COALESCE(_cb_int(v_rec, 'quoteCount'), 0), _cb_text(v_rec, 'lastQuoted'));
    v_property := COALESCE(v_property, 0) + 1;
  END LOOP;

  FOR v_rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'profiles', '[]'::jsonb)) LOOP
    v_in := v_rec->>'id';
    IF v_in IS NULL OR v_in = '' OR EXISTS (SELECT 1 FROM public.pricing_profiles pp WHERE pp.id = v_in AND pp.workspace_id <> v_ws) THEN
      v_new := CASE WHEN v_in IS NULL OR v_in = '' THEN gen_random_uuid()::text ELSE NULL END;
      IF v_new IS NULL THEN SELECT pp.id INTO v_new FROM public.pricing_profiles pp WHERE pp.id = v_in AND pp.workspace_id = v_ws; END IF;
      v_new := COALESCE(v_new, gen_random_uuid()::text);
      v_map_pr := jsonb_set(v_map_pr, ARRAY[v_in], to_jsonb(v_new));
    ELSE v_new := v_in; END IF;
    INSERT INTO public.pricing_profiles (id, workspace_id, name, wage, burden, overhead, margin, min_price, supplies, productivity, is_default)
    VALUES (v_new, v_ws, COALESCE(v_rec->>'name', '(unnamed profile)'),
      COALESCE(_cb_num(v_rec, 'wage'), 0), COALESCE(_cb_num(v_rec, 'burden'), 0), COALESCE(_cb_num(v_rec, 'overhead'), 0),
      COALESCE(_cb_num(v_rec, 'margin'), 0), COALESCE(_cb_int(v_rec, 'minPrice'), 800), COALESCE(_cb_num(v_rec, 'supplies'), 8),
      COALESCE(v_rec->'productivity', '{}'::jsonb), COALESCE((v_rec->>'is_default')::BOOLEAN, false));
    v_profile := COALESCE(v_profile, 0) + 1;
  END LOOP;

  FOR v_rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'quotes', '[]'::jsonb)) LOOP
    v_in := v_rec->>'id';
    IF v_in IS NULL OR v_in = '' OR EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = v_in AND q.workspace_id <> v_ws) THEN
      v_new := CASE WHEN v_in IS NULL OR v_in = '' THEN gen_random_uuid()::text ELSE NULL END;
      IF v_new IS NULL THEN SELECT q.id INTO v_new FROM public.quotes q WHERE q.id = v_in AND q.workspace_id = v_ws; END IF;
      v_new := COALESCE(v_new, gen_random_uuid()::text);
    ELSE v_new := v_in; END IF;
    INSERT INTO public.quotes (id, workspace_id, property_id, property_name, company_name, contact, email, phone, property_address, sqft, floors, type, frequency, package, profile_id, profile_name, areas, tasks, addons, cleaners, hours_per_visit, visits_per_month, monthly, annual, margin, cost_per_visit, labor_per_visit, burden_per_visit, supplies_per_visit, overhead_per_visit, addons_per_visit, status, version, versions, followup, lost_reason, price_snap, productivity_snap, calc_monthly, override, date, modified, created_iso, modified_iso)
    VALUES (v_new, v_ws,
      CASE WHEN _cb_text(v_rec, 'propertyId') IS NULL THEN NULL ELSE COALESCE(v_map_p ->> _cb_text(v_rec, 'propertyId'), v_map_c ->> _cb_text(v_rec, 'propertyId'), _cb_text(v_rec, 'propertyId')) END,
      COALESCE(v_rec->>'propertyName', v_rec->>'property_name', '(unnamed property)'),
      COALESCE(v_rec->>'companyName', v_rec->>'company_name', '(unknown company)'),
      _cb_text(v_rec, 'contact'), _cb_text(v_rec, 'email'), _cb_text(v_rec, 'phone'),
      _cb_text(v_rec, 'propertyAddress'), _cb_int(v_rec, 'sqft'), COALESCE(_cb_int(v_rec, 'floors'), 1),
      COALESCE(_cb_text(v_rec, 'type'), 'office'), COALESCE(_cb_num(v_rec, 'frequency'), 2),
      COALESCE(_cb_text(v_rec, 'package'), 'professional'),
      CASE WHEN _cb_text(v_rec, 'profileId') IS NULL THEN NULL ELSE COALESCE(v_map_pr ->> _cb_text(v_rec, 'profileId'), _cb_text(v_rec, 'profileId')) END,
      _cb_text(v_rec, 'profileName'),
      COALESCE(v_rec->'areas', '[]'::jsonb), COALESCE(v_rec->'tasks', '[]'::jsonb), COALESCE(v_rec->'addons', '[]'::jsonb),
      _cb_int(v_rec, 'cleaners'), _cb_num(v_rec, 'hoursPerVisit'), _cb_num(v_rec, 'visitsPerMonth'),
      _cb_int(v_rec, 'monthly'), _cb_int(v_rec, 'annual'), _cb_num(v_rec, 'margin'),
      _cb_int(v_rec, 'costPerVisit'), _cb_int(v_rec, 'laborPerVisit'), _cb_int(v_rec, 'burdenPerVisit'),
      _cb_int(v_rec, 'suppliesPerVisit'), _cb_int(v_rec, 'overheadPerVisit'), _cb_int(v_rec, 'addonsPerVisit'),
      COALESCE(_cb_text(v_rec, 'status'), 'draft'), COALESCE(_cb_int(v_rec, 'version'), 1),
      COALESCE(v_rec->'versions', '[]'::jsonb), _cb_ts(v_rec, 'followup')::DATE, _cb_text(v_rec, 'lostReason'),
      COALESCE(v_rec->'priceSnap', '{}'::jsonb), COALESCE(v_rec->'productivitySnap', '{}'::jsonb),
      _cb_int(v_rec, 'calcMonthly'), COALESCE(v_rec->'override', '{}'::jsonb),
      _cb_text(v_rec, 'date'), _cb_text(v_rec, 'modified'),
      COALESCE(_cb_ts(v_rec, 'createdIso'), now()), COALESCE(_cb_ts(v_rec, 'modifiedIso'), now()));
    v_quote := COALESCE(v_quote, 0) + 1;
  END LOOP;

  FOR v_rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'activity', '[]'::jsonb)) LOOP
    INSERT INTO public.activity_log (workspace_id, user_id, action, entity_type, entity_id, metadata, created_at)
    VALUES (v_ws, (SELECT u.id FROM public.users u WHERE u.id = v_uid),
      COALESCE(v_rec->>'action', v_rec->>'what', 'restored activity entry'),
      COALESCE(v_rec->>'entity_type', 'activity'),
      CASE WHEN v_rec->>'entity_id' IS NULL OR v_rec->>'entity_id' = '' THEN NULL ELSE v_rec->>'entity_id' END,
      COALESCE(v_rec->'metadata', '{}'::jsonb), COALESCE(_cb_ts(v_rec, 'created_at'), now()));
    v_activity := COALESCE(v_activity, 0) + 1;
  END LOOP;

  RETURN jsonb_build_object('workspace_id', v_ws, 'counts', jsonb_build_object(
    'customers', COALESCE(v_customer, 0), 'properties', COALESCE(v_property, 0),
    'quotes', COALESCE(v_quote, 0), 'profiles', COALESCE(v_profile, 0), 'activity', COALESCE(v_activity, 0)));
END;
$$;

-- ====================================================================
-- 10) EXECUTE PERMISSIONS (authenticated only; no anon; helpers internal)
-- ====================================================================
REVOKE EXECUTE ON FUNCTION public.restore_workspace_backup(UUID, JSONB) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restore_workspace_backup(UUID, JSONB) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.create_workspace_invitation(UUID, TEXT, TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.create_workspace_invitation(UUID, TEXT, TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.accept_workspace_invitation(TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.accept_workspace_invitation(TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public._cb_num(JSONB, TEXT)  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public._cb_int(JSONB, TEXT)  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public._cb_ts(JSONB, TEXT)   FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public._cb_text(JSONB, TEXT) FROM anon, authenticated, public;

-- Refresh PostgREST schema cache.
NOTIFY pgrst, 'reload schema';
