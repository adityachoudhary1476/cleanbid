-- ====================================================================
-- SUPERSEDED — DO NOT RUN
-- Authoritative schema: supabase-schema.sql
-- ====================================================================
-- CLEANBID — ATOMIC WORKSPACE RESTORE (audit fix P0-1)
-- ====================================================================
-- Deploy via Supabase SQL Editor (service role / postgres connection).
--
-- WHAT THIS FIXES
--   Client-side upserts keyed on GLOBAL TEXT primary keys allowed a restore
--   performed in workspace A to overwrite rows belonging to workspace B
--   (same id, RLS UPDATE policies had USING but no WITH CHECK), and left
--   ghost rows for any record absent from the backup. There was also no
--   deletion path at all, and no atomicity across tables.
--
-- SECURITY MODEL
--   * Workspace identity is resolved SERVER-SIDE: the RPC verifies that
--     auth.uid() is a member of p_target_workspace before touching data.
--   * Record payloads carry NO trusted workspace_id — every inserted row is
--     stamped with the verified workspace UUID. A client cannot smuggle
--     rows into another workspace even by crafting the payload.
--   * Runs as SECURITY DEFINER so the batch operates outside RLS within
--     the single verified workspace only. Membership is re-checked inside
--     this function, not inherited from policies.
--   * ATOMICITY: the entire replace (deletes + inserts) is one implicit
--     transaction. Any error (bad numeric text, constraint violation,
--     network drop mid-call) rolls back EVERYTHING — a failed restore can
--     never leave a half-restored workspace.
--
-- ALSO INCLUDED
--   * workspaces.addons / tasks / area_types JSONB columns. src/db.js has
--     always read/written these (mapWorkspaceSettingsToDb), but
--     supabase-schema.sql never declared them -> every cloud save touched
--     nonexistent columns. Idempotent ADD COLUMN IF NOT EXISTS.
--
-- IDEMPOTENT: safe to run repeatedly (CREATE OR REPLACE / IF NOT EXISTS).
-- ====================================================================

-- --------------------------------------------------------------------
-- 0. Schema drift fix: columns the client layer expects on workspaces.
-- --------------------------------------------------------------------
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS addons JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS tasks JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS area_types JSONB NOT NULL DEFAULT '[]';

-- --------------------------------------------------------------------
-- 1. Null-safe numeric/text extractors (strict: garbage aborts atomically).
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._cb_num(j JSONB, k TEXT)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN j->>k IS NULL OR j->>k = '' THEN NULL ELSE (j->>k)::NUMERIC END;
$$;

CREATE OR REPLACE FUNCTION public._cb_int(j JSONB, k TEXT)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN j->>k IS NULL OR j->>k = '' THEN NULL ELSE (j->>k)::DOUBLE PRECISION::INTEGER END;
$$;

CREATE OR REPLACE FUNCTION public._cb_ts(j JSONB, k TEXT)
RETURNS TIMESTAMPTZ LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN j->>k IS NULL OR j->>k = '' THEN NULL ELSE (j->>k)::TIMESTAMPTZ END;
$$;

CREATE OR REPLACE FUNCTION public._cb_text(j JSONB, k TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN j->>k IS NULL OR j->>k = '' THEN NULL ELSE j->>k END;
$$;

-- --------------------------------------------------------------------
-- 2. The atomic restore function.
-- --------------------------------------------------------------------
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
  -- ID remap tables: when a backup id is owned by a DIFFERENT workspace
  -- (global TEXT PKs make sharing impossible), the incoming row gets a fresh
  -- identity and every inbound reference is rewritten. Nothing is ever
  -- stolen from another workspace and the restore still completes.
  v_map_c  JSONB := '{}'::jsonb;
  v_map_p  JSONB := '{}'::jsonb;
  v_map_pr JSONB := '{}'::jsonb;
  v_in     TEXT;
  v_new    TEXT;
BEGIN
  -- ---------- identity gate (server-authoritative) ----------
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'restore refused: caller is not authenticated';
  END IF;

  SELECT id INTO v_ws FROM public.workspaces WHERE id = p_target_workspace;
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'restore refused: target workspace does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id = v_ws AND m.user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'restore refused: caller is not a member of the target workspace';
  END IF;

  -- ---------- atomic replace begins (single transaction) ----------

  -- Children first; FKs are ON DELETE SET NULL/CASCADE but explicit order
  -- keeps intent obvious.
  DELETE FROM public.activity_log     WHERE workspace_id = v_ws;
  DELETE FROM public.quotes           WHERE workspace_id = v_ws;
  DELETE FROM public.pricing_profiles WHERE workspace_id = v_ws;
  DELETE FROM public.properties       WHERE workspace_id = v_ws;
  DELETE FROM public.customers        WHERE workspace_id = v_ws;

  -- Workspace-scoped config on the workspaces row itself.
  UPDATE public.workspaces SET
    branding         = COALESCE(p_payload->'org', '{}'::jsonb),
    pricing_defaults = COALESCE(p_payload->'pricing', '{}'::jsonb),
    addons           = COALESCE(p_payload->'addons', '[]'::jsonb),
    tasks            = COALESCE(p_payload->'tasks', '[]'::jsonb),
    area_types       = COALESCE(p_payload->'area_types', '[]'::jsonb),
    updated_at       = now()
  WHERE id = v_ws;

  -- Customers -------------------------------------------------------
  -- ID policy: keep the backup id when free, else REUSE the workspace's own
  -- existing row (it is about to be replaced by the same logical record),
  -- else mint a fresh id when a FOREIGN workspace owns the id (never steal).
  FOR v_rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'customers', '[]'::jsonb))
  LOOP
    v_in := v_rec->>'id';
    IF v_in IS NULL OR v_in = '' OR EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = v_in AND c.workspace_id <> v_ws
    ) THEN
      v_new := CASE WHEN v_in IS NULL OR v_in = '' THEN gen_random_uuid()::text ELSE NULL END;
      IF v_new IS NULL THEN
        SELECT c.id INTO v_new FROM public.customers c WHERE c.id = v_in AND c.workspace_id = v_ws;
      END IF;
      v_new := COALESCE(v_new, gen_random_uuid()::text);
      v_map_c := jsonb_set(v_map_c, ARRAY[v_in], to_jsonb(v_new));
    ELSE
      v_new := v_in;
    END IF;
    INSERT INTO public.customers (id, workspace_id, company, contact, email, phone, address, notes, last_activity)
    VALUES (
      v_new,
      v_ws,                                                     -- server-derived identity
      COALESCE(v_rec->>'company', '(unnamed customer)'),
      _cb_text(v_rec, 'contact'),
      _cb_text(v_rec, 'email'),
      _cb_text(v_rec, 'phone'),
      _cb_text(v_rec, 'address'),
      _cb_text(v_rec, 'notes'),
      _cb_text(v_rec, 'lastActivity')
    );
    v_customer := COALESCE(v_customer, 0) + 1;
  END LOOP;

  -- Properties ------------------------------------------------------
  FOR v_rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'properties', '[]'::jsonb))
  LOOP
    v_in := v_rec->>'id';
    IF v_in IS NULL OR v_in = '' OR EXISTS (
      SELECT 1 FROM public.properties p WHERE p.id = v_in AND p.workspace_id <> v_ws
    ) THEN
      v_new := CASE WHEN v_in IS NULL OR v_in = '' THEN gen_random_uuid()::text ELSE NULL END;
      IF v_new IS NULL THEN
        SELECT p.id INTO v_new FROM public.properties p WHERE p.id = v_in AND p.workspace_id = v_ws;
      END IF;
      v_new := COALESCE(v_new, gen_random_uuid()::text);
      v_map_p := jsonb_set(v_map_p, ARRAY[v_in], to_jsonb(v_new));
    ELSE
      v_new := v_in;
    END IF;
    INSERT INTO public.properties (id, workspace_id, customer_id, name, address, type, sqft, floors, quote_count, last_quoted)
    VALUES (
      v_new,
      v_ws,
      CASE WHEN _cb_text(v_rec, 'customerId') IS NULL THEN NULL
           ELSE COALESCE(v_map_c ->> _cb_text(v_rec, 'customerId'), _cb_text(v_rec, 'customerId'))
      END,                                                       -- remapped; may be NULL (deleted relationship)
      COALESCE(v_rec->>'name', '(unnamed property)'),
      _cb_text(v_rec, 'address'),
      COALESCE(_cb_text(v_rec, 'type'), 'office'),
      _cb_int(v_rec, 'sqft'),
      COALESCE(_cb_int(v_rec, 'floors'), 1),
      COALESCE(_cb_int(v_rec, 'quoteCount'), 0),
      _cb_text(v_rec, 'lastQuoted')
    );
    v_property := COALESCE(v_property, 0) + 1;
  END LOOP;

  -- Pricing profiles -------------------------------------------------
  FOR v_rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'profiles', '[]'::jsonb))
  LOOP
    v_in := v_rec->>'id';
    IF v_in IS NULL OR v_in = '' OR EXISTS (
      SELECT 1 FROM public.pricing_profiles pp WHERE pp.id = v_in AND pp.workspace_id <> v_ws
    ) THEN
      v_new := CASE WHEN v_in IS NULL OR v_in = '' THEN gen_random_uuid()::text ELSE NULL END;
      IF v_new IS NULL THEN
        SELECT pp.id INTO v_new FROM public.pricing_profiles pp WHERE pp.id = v_in AND pp.workspace_id = v_ws;
      END IF;
      v_new := COALESCE(v_new, gen_random_uuid()::text);
      v_map_pr := jsonb_set(v_map_pr, ARRAY[v_in], to_jsonb(v_new));
    ELSE
      v_new := v_in;
    END IF;
    INSERT INTO public.pricing_profiles
      (id, workspace_id, name, wage, burden, overhead, margin, min_price, supplies, productivity, is_default)
    VALUES (
      v_new,
      v_ws,
      COALESCE(v_rec->>'name', '(unnamed profile)'),
      COALESCE(_cb_num(v_rec, 'wage'), 0),
      COALESCE(_cb_num(v_rec, 'burden'), 0),
      COALESCE(_cb_num(v_rec, 'overhead'), 0),
      COALESCE(_cb_num(v_rec, 'margin'), 0),
      COALESCE(_cb_int(v_rec, 'minPrice'), 800),
      COALESCE(_cb_num(v_rec, 'supplies'), 8),
      COALESCE(v_rec->'productivity', '{}'::jsonb),
      COALESCE((v_rec->>'is_default')::BOOLEAN, false)
    );
    v_profile := COALESCE(v_profile, 0) + 1;
  END LOOP;

  -- Quotes -----------------------------------------------------------
  FOR v_rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'quotes', '[]'::jsonb))
  LOOP
    v_in := v_rec->>'id';
    IF v_in IS NULL OR v_in = '' OR EXISTS (
      SELECT 1 FROM public.quotes q WHERE q.id = v_in AND q.workspace_id <> v_ws
    ) THEN
      v_new := CASE WHEN v_in IS NULL OR v_in = '' THEN gen_random_uuid()::text ELSE NULL END;
      IF v_new IS NULL THEN
        SELECT q.id INTO v_new FROM public.quotes q WHERE q.id = v_in AND q.workspace_id = v_ws;
      END IF;
      v_new := COALESCE(v_new, gen_random_uuid()::text);
    ELSE
      v_new := v_in;
    END IF;
    INSERT INTO public.quotes (
      id, workspace_id, property_id, property_name, company_name, contact, email, phone,
      property_address, sqft, floors, type, frequency, package, profile_id, profile_name,
      areas, tasks, addons, cleaners, hours_per_visit, visits_per_month, monthly, annual,
      margin, cost_per_visit, labor_per_visit, burden_per_visit, supplies_per_visit,
      overhead_per_visit, addons_per_visit, status, version, versions, followup,
      lost_reason, price_snap, productivity_snap, calc_monthly, override,
      date, modified, created_iso, modified_iso
    ) VALUES (
      v_new,
      v_ws,
      CASE WHEN _cb_text(v_rec, 'propertyId') IS NULL THEN NULL
           ELSE COALESCE(v_map_p  ->> _cb_text(v_rec, 'propertyId'),
                         v_map_c  ->> _cb_text(v_rec, 'propertyId'),
                         _cb_text(v_rec, 'propertyId'))
      END,                                                       -- remapped property ref (customer ids kept for legacy backups)
      COALESCE(v_rec->>'propertyName', v_rec->>'property_name', '(unnamed property)'),
      COALESCE(v_rec->>'companyName', v_rec->>'company_name', '(unknown company)'),
      _cb_text(v_rec, 'contact'),
      _cb_text(v_rec, 'email'),
      _cb_text(v_rec, 'phone'),
      _cb_text(v_rec, 'propertyAddress'),
      _cb_int(v_rec, 'sqft'),
      COALESCE(_cb_int(v_rec, 'floors'), 1),
      COALESCE(_cb_text(v_rec, 'type'), 'office'),
      COALESCE(_cb_num(v_rec, 'frequency'), 2),
      COALESCE(_cb_text(v_rec, 'package'), 'professional'),
      CASE WHEN _cb_text(v_rec, 'profileId') IS NULL THEN NULL
           ELSE COALESCE(v_map_pr ->> _cb_text(v_rec, 'profileId'), _cb_text(v_rec, 'profileId'))
      END,                                                       -- remapped profile ref
      _cb_text(v_rec, 'profileName'),
      COALESCE(v_rec->'areas', '[]'::jsonb),
      COALESCE(v_rec->'tasks', '[]'::jsonb),
      COALESCE(v_rec->'addons', '[]'::jsonb),
      _cb_int(v_rec, 'cleaners'),
      _cb_num(v_rec, 'hoursPerVisit'),
      _cb_num(v_rec, 'visitsPerMonth'),
      _cb_int(v_rec, 'monthly'),
      _cb_int(v_rec, 'annual'),
      _cb_num(v_rec, 'margin'),
      _cb_int(v_rec, 'costPerVisit'),
      _cb_int(v_rec, 'laborPerVisit'),
      _cb_int(v_rec, 'burdenPerVisit'),
      _cb_int(v_rec, 'suppliesPerVisit'),
      _cb_int(v_rec, 'overheadPerVisit'),
      _cb_int(v_rec, 'addonsPerVisit'),
      COALESCE(_cb_text(v_rec, 'status'), 'draft'),
      COALESCE(_cb_int(v_rec, 'version'), 1),
      COALESCE(v_rec->'versions', '[]'::jsonb),
      _cb_ts(v_rec, 'followup')::DATE,
      _cb_text(v_rec, 'lostReason'),
      COALESCE(v_rec->'priceSnap', '{}'::jsonb),
      COALESCE(v_rec->'productivitySnap', '{}'::jsonb),
      _cb_int(v_rec, 'calcMonthly'),
      COALESCE(v_rec->'override', '{}'::jsonb),
      _cb_text(v_rec, 'date'),
      _cb_text(v_rec, 'modified'),
      COALESCE(_cb_ts(v_rec, 'createdIso'), now()),
      COALESCE(_cb_ts(v_rec, 'modifiedIso'), now())
    );
    v_quote := COALESCE(v_quote, 0) + 1;
  END LOOP;

  -- Activity log -----------------------------------------------------
  FOR v_rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'activity', '[]'::jsonb))
  LOOP
    INSERT INTO public.activity_log (workspace_id, user_id, action, entity_type, entity_id, metadata, created_at)
    VALUES (
      v_ws,
      (SELECT u.id FROM public.users u WHERE u.id = v_uid),      -- NULL-safe: never block restore on a broken user mirror
      COALESCE(v_rec->>'action', v_rec->>'what', 'restored activity entry'),
      COALESCE(v_rec->>'entity_type', 'activity'),
      CASE WHEN v_rec->>'entity_id' IS NULL OR v_rec->>'entity_id' = ''
           THEN NULL ELSE v_rec->>'entity_id' END,
      COALESCE(v_rec->'metadata', '{}'::jsonb),
      COALESCE(_cb_ts(v_rec, 'created_at'), now())
    );
    v_activity := COALESCE(v_activity, 0) + 1;
  END LOOP;

  -- ---------- atomic replace ends here ----------

  RETURN jsonb_build_object(
    'workspace_id', v_ws,
    'counts', jsonb_build_object(
      'customers',  COALESCE(v_customer, 0),
      'properties', COALESCE(v_property, 0),
      'quotes',     COALESCE(v_quote, 0),
      'profiles',   COALESCE(v_profile, 0),
      'activity',   COALESCE(v_activity, 0)
    )
  );
END;
$$;

-- --------------------------------------------------------------------
-- 3. Execute permissions: authenticated members only, never anon.
-- --------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.restore_workspace_backup(UUID, JSONB) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restore_workspace_backup(UUID, JSONB) TO authenticated;

-- Helper functions are internal; do not expose them to clients.
REVOKE EXECUTE ON FUNCTION public._cb_num(JSONB, TEXT)  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public._cb_int(JSONB, TEXT)  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public._cb_ts(JSONB, TEXT)   FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public._cb_text(JSONB, TEXT) FROM anon, authenticated, public;

-- ====================================================================
-- 4. HARD FENCES against cross-workspace writes (defense in depth)
-- ====================================================================
-- The entity tables use GLOBAL TEXT primary keys, so a conflicting id could
-- in principle land on another workspace's row during an ordinary client
-- upsert (RLS UPDATE policies had USING but NO WITH CHECK, allowing a row
-- to be rewritten with a DIFFERENT workspace_id). Two fences close that:
--
--   a) WITH CHECK on every UPDATE policy: the modified row must still
--      satisfy membership for the acting user.
--   b) Triggers make workspace_id IMMUTABLE after insert on entity tables.
--      Any attempt to move a row between workspaces now FAILS LOUDLY
--      instead of silently stealing the row. (A failed save surfaces as an
--      error; it can never silently rewrite another workspace's records.)

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

DROP TRIGGER IF EXISTS customers_lock_ws        ON public.customers;
DROP TRIGGER IF EXISTS properties_lock_ws       ON public.properties;
DROP TRIGGER IF EXISTS quotes_lock_ws           ON public.quotes;
DROP TRIGGER IF EXISTS pricing_profiles_lock_ws ON public.pricing_profiles;

CREATE TRIGGER customers_lock_ws        BEFORE UPDATE ON public.customers        FOR EACH ROW EXECUTE FUNCTION public._cb_forbid_workspace_move();
CREATE TRIGGER properties_lock_ws       BEFORE UPDATE ON public.properties       FOR EACH ROW EXECUTE FUNCTION public._cb_forbid_workspace_move();
CREATE TRIGGER quotes_lock_ws           BEFORE UPDATE ON public.quotes           FOR EACH ROW EXECUTE FUNCTION public._cb_forbid_workspace_move();
CREATE TRIGGER pricing_profiles_lock_ws BEFORE UPDATE ON public.pricing_profiles FOR EACH ROW EXECUTE FUNCTION public._cb_forbid_workspace_move();

-- WITH CHECK mirrors for every entity UPDATE policy. Idempotent via DROP+CREATE.
DROP POLICY IF EXISTS "Members can update customers" ON public.customers;
CREATE POLICY "Members can update customers" ON public.customers
  FOR UPDATE USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Members can update properties" ON public.properties;
CREATE POLICY "Members can update properties" ON public.properties
  FOR UPDATE USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Members can update quotes" ON public.quotes;
CREATE POLICY "Members can update quotes" ON public.quotes
  FOR UPDATE USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Members can update pricing profiles" ON public.pricing_profiles;
CREATE POLICY "Members can update pricing profiles" ON public.pricing_profiles
  FOR UPDATE USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));
