# CleanBid — Commercial Cleaning Estimating

## What is in this repo

| File | Status | What it is |
|------|--------|------------|
| 01-pricing-engine.js | CANONICAL | Pure pricing function. No DOM. Single source of truth for all quote math. |
| 02-pricing-tests.js | 103 checks | Plain Node, zero dependencies. Engine unit tests + application-path regression tests. |
| 03-app-shell.html | WIRED | Full Finova-styled UI. ALL pricing flows through CleanBidPricing.calculatePricing(). |
| src/ | NEW | Modular data/auth/workspace layer. Dual-mode: local/demo or Supabase cloud. |
| supabase-schema.sql | NEW | PostgreSQL schema with RLS. Apply to your Supabase project. |
| package.json | NEW | Vite + Vitest + @supabase/supabase-js |
| vite.config.js | NEW | Build/dev config for vanilla JS |
| README.md | this file | |

## Quick start

```bash
# Install dependencies
npm install

# Run the full pricing test suite (must pass 103/103)
node 02-pricing-tests.js

# Start dev server
npm run dev

# Build for production
npm run build
```

Open `http://localhost:3000/03-app-shell.html` in your browser.

## Modes of operation

### Local / Demo mode (default)
- No backend required.
- Data persists in browser localStorage (`cleanbid_v3`).
- Click **Try Demo** for a pre-seeded workspace.
- Demo data lives in a completely separate namespace (`cleanbid_demo_v3`) and is never mixed with real authenticated data.

### Authenticated cloud mode (Supabase)
Set environment variables:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-anon-key
```

When these are present:
- Landing page shows **Sign In** / **Create Account**.
- Sign-up creates a Supabase Auth user, a default workspace, and admin membership.
- Sign-in restores the user's workspace.
- All data is saved to Supabase PostgreSQL with Row Level Security.
- Workspace isolation is enforced server-side by RLS — never rely on frontend filtering for security.

## Architecture

```
UI inputs → buildEngineInput()      (normalization ONLY — no math)
          → CleanBidPricing.calculatePricing()   (ALL pricing arithmetic)
          → qb.calc mapping       (field renaming ONLY)
          → DOM bindings / saved quotes / proposal / G-B-B tiers
```

### Data flow

```
User action
  ↓
state (in-memory)
  ↓
saveStateToDb()
  ↓
[local] localStorage (cleanbid_v3)
[cloud] Supabase client → PostgreSQL (workspace-scoped, RLS-enforced)
```

### Module structure

```
src/
  main.js          — bootstrap: initializes auth, db, workspace modules
  auth.js          — Supabase Auth + local fallback
  db.js            — dual-mode data access layer with mappers
  workspace.js     — workspace creation, switching, membership
  migration.js     — explicit user-initiated localStorage → Supabase migration
  types.js         — JSDoc type definitions
```

## Database schema

Apply `supabase-schema.sql` to your Supabase project via the SQL editor.

Tables:
- `workspaces` — company/workspace metadata
- `users` — mirrored from Supabase Auth
- `workspace_members` — user → workspace role mapping
- `customers` — workspace-scoped
- `properties` — workspace-scoped, references customers
- `quotes` — workspace-scoped, references properties
- `pricing_profiles` — workspace-scoped
- `activity_log` — workspace-scoped audit trail

All tables have Row Level Security enabled. Policies ensure:
- Users can only read/write records in workspaces they belong to
- Workspace membership determines access
- `workspace_id` is never trusted from the browser — derived from `auth.uid()` → `workspace_members`

## Security

- **Never expose service-role keys** in frontend code. Only the public anon/publishable key is used client-side.
- **RLS is the security boundary.** Frontend filtering is UX only.
- **Workspace ID comes from the authenticated session**, not from browser-supplied data.
- **Demo mode is isolated.** Separate localStorage namespace. Never auto-migrated.
- **Migration is explicit.** Users must opt-in to move local data to Supabase.

## Pricing model (as implemented)

- crew_hours = Σ(area_sqft ÷ area_productivity) + task minutes ÷ 60
- cleaners = ceil(crew_hours ÷ 2.5 h)   (crew-hours already include headcount)
- labor = crew_hours × wage  · burden = labor × burden%
- supplies = labor × supplies%  (NOT × cleaners)
- overhead = (labor + burden) × overhead%
- add-ons: $/visit · $/sqft · $/labor-hour · fixed $/month ÷ visits
- price = cost ÷ (1 − target_margin) × pkg_mult,
  target_margin clamped to 15–45 after package offset (−4 / 0 / +6),
  pkg_mult: essential 0.92 · professional 1.00 · premium 1.10
- monthly floored at minPrice (default $800)

## Test coverage

`node 02-pricing-tests.js` runs 103 checks:

- Original engine scenarios C1–C7 (floors, crews, packages, add-ons).
- P0-R1 validation guards · R2 fixed-monthly add-on (former TDZ crash)
- R3 package rules & margin clamp band · R4 75k sqft component breakdown
- R5 application path: extracts the embedded `<script>` from the HTML into
  a Node VM with a minimal DOM stub and proves app recalc == standalone
  engine, GBB professional tier == headline, revision history integrity,
  proposal rendering, floor honored on every customer-facing path.
- R6 escaping: hostile strings through real renderers stay inert text.
- R7 override preserve/clear/persist cycle, deterministic IDs, working
  version picker, ISO timestamps, currency switching.

Any FAIL line is a real bug — the suite exits non-zero.

## What is preserved from the original prototype

- `01-pricing-engine.js` — unchanged, pure, 103/103 tests passing
- `02-pricing-tests.js` — unchanged
- CSS design system — warm cream, forest ink, clay accent, Fraunces/Inter typography
- Pricing formulas — no math changes
- Version history model — `versions[]` structure preserved
- Override workflow — calculated vs effective price preserved
- `esc()` / `escJs()` — security hardening preserved
- Print CSS — visibility isolation preserved
