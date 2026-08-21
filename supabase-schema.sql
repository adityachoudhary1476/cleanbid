-- ====================================================================
-- CLEANBID SUPABASE SCHEMA
-- Free-tier compatible. All tables workspace-scoped with RLS.
-- ====================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ====================================================================
-- WORKSPACES
-- ====================================================================
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  branding JSONB DEFAULT '{}',
  pricing_defaults JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ====================================================================
-- USERS (mirrors Supabase Auth users)
-- ====================================================================
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ====================================================================
-- WORKSPACE MEMBERS
-- ====================================================================
CREATE TABLE workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'estimator',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, user_id)
);

-- ====================================================================
-- CUSTOMERS
-- ====================================================================
CREATE TABLE customers (
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

-- ====================================================================
-- PROPERTIES
-- ====================================================================
CREATE TABLE properties (
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

-- ====================================================================
-- QUOTES
-- ====================================================================
CREATE TABLE quotes (
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

-- ====================================================================
-- PRICING PROFILES
-- ====================================================================
CREATE TABLE pricing_profiles (
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

-- ====================================================================
-- ACTIVITY LOG
-- ====================================================================
CREATE TABLE activity_log (
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
-- INDEXES
-- ====================================================================
CREATE INDEX idx_customers_workspace ON customers(workspace_id);
CREATE INDEX idx_properties_workspace ON properties(workspace_id);
CREATE INDEX idx_properties_customer ON properties(customer_id);
CREATE INDEX idx_quotes_workspace ON quotes(workspace_id);
CREATE INDEX idx_quotes_property ON quotes(property_id);
CREATE INDEX idx_pricing_profiles_workspace ON pricing_profiles(workspace_id);
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);
CREATE INDEX idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX idx_activity_log_workspace ON activity_log(workspace_id);

-- ====================================================================
-- ROW LEVEL SECURITY
-- ====================================================================
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- ====================================================================
-- HELPER FUNCTION (avoids RLS recursion on workspace_members)
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
-- RLS POLICIES
-- ====================================================================

-- Workspaces: members can view their workspaces
CREATE POLICY "Users can view their workspaces" ON workspaces
  FOR SELECT USING (
    public.is_workspace_member(id)
  );

-- Workspaces: authenticated users can create workspaces
CREATE POLICY "Users can create workspaces" ON workspaces
  FOR INSERT WITH CHECK (true);

-- Users: can insert own profile
CREATE POLICY "Users can insert own profile" ON users
  FOR INSERT WITH CHECK (id = auth.uid());

-- Users: can update own profile
CREATE POLICY "Users can update own profile" ON users
  FOR UPDATE USING (id = auth.uid());

-- Workspace members: users can always see their own memberships.
-- Self-contained on purpose -- calling is_workspace_member() here would
-- re-query this same table inside policy evaluation and recurse.
CREATE POLICY "Members can view workspace members" ON workspace_members
  FOR SELECT USING (
    user_id = (SELECT auth.uid())
  );

-- Workspace members: users can join workspaces
CREATE POLICY "Users can join workspaces" ON workspace_members
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Customers: CRUD for workspace members
CREATE POLICY "Members can view customers" ON customers
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can create customers" ON customers
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can update customers" ON customers
  FOR UPDATE USING (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can delete customers" ON customers
  FOR DELETE USING (
    public.is_workspace_member(workspace_id)
  );

-- Properties: CRUD for workspace members
CREATE POLICY "Members can view properties" ON properties
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can create properties" ON properties
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can update properties" ON properties
  FOR UPDATE USING (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can delete properties" ON properties
  FOR DELETE USING (
    public.is_workspace_member(workspace_id)
  );

-- Quotes: CRUD for workspace members
CREATE POLICY "Members can view quotes" ON quotes
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can create quotes" ON quotes
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can update quotes" ON quotes
  FOR UPDATE USING (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can delete quotes" ON quotes
  FOR DELETE USING (
    public.is_workspace_member(workspace_id)
  );

-- Pricing profiles: CRUD for workspace members
CREATE POLICY "Members can view pricing profiles" ON pricing_profiles
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can create pricing profiles" ON pricing_profiles
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can update pricing profiles" ON pricing_profiles
  FOR UPDATE USING (
    public.is_workspace_member(workspace_id)
  );
CREATE POLICY "Members can delete pricing profiles" ON pricing_profiles
  FOR DELETE USING (
    public.is_workspace_member(workspace_id)
  );

-- Activity log: viewable by workspace members
CREATE POLICY "Members can view activity log" ON activity_log
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
  );

-- Activity log: insertable by workspace members
CREATE POLICY "Members can create activity log" ON activity_log
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
  );
