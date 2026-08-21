# CleanBid — source package

## What is in this repo

| File | Status | What it is |
|------|--------|------------|
| 01-pricing-engine.js | CANONICAL | Pure pricing function. No DOM. Single source of truth for all quote math. |
| 02-pricing-tests.js  | 103 checks | Plain Node, zero dependencies. Engine unit tests + application-path regression tests. |
| 03-app-shell.html    | WIRED | Full Finova-styled UI. ALL pricing flows through CleanBidPricing.calculatePricing(). |
| README.md            | this file | |

## How to run

```bash
# run the full test suite (engine + app-path regressions)
node 02-pricing-tests.js
```

Open `03-app-shell.html` directly in a browser — no build step, no server,
no dependencies. Click **Try Demo** to explore with seeded data.

## Architecture: single source of truth

```
UI inputs → buildEngineInput()      (normalization ONLY — no math)
          → CleanBidPricing.calculatePricing()   (ALL pricing arithmetic)
          → qb.calc mapping       (field renaming ONLY)
          → DOM bindings / saved quotes / proposal / G-B-B tiers
```

Package tiers (Good/Better/Best) are produced by calling the same engine
three times with only `package` varied (`computeTierPrices()` for the
builder, `computeQuoteTierPrices()` for saved-quote proposals from their
pricing snapshots).

Calculations that intentionally live OUTSIDE the engine (none of them price):

- `recalc()` per-area drill-down (`areaHours`) — display-only hours/month per area.
- Weighted `baseProd` — display-only average productivity shown in Why drawer.
- Proposal economics rows — presentation arithmetic on an already-canonical price.
- Demo seed records — static historical numbers, not computed.

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
