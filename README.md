# CleanBid — source package (honest assessment)

## What is in this zip

| File | Status | What it is |
|------|--------|--------------|
| 01-pricing-engine.js | DONE | Pure pricing function. No DOM. P0 #1, #2, #3, #12 fixed. ~100 LOC of business logic + 8 validation guards. |
| 02-pricing-tests.js  | DONE | 30 assertions across 7 scenarios. All currently passing on plain Node, zero dependencies. |
| 03-app-shell.html     | PARTIAL | Full Finova-styled UI (3,642 lines). Look/feel polished. Pricing math in `recalc()` is the OLD inline buggy code; needs a 50-line surgical patch (see below). |
| README.md             | this file | honest assessment |

## How to verify the math fix

```bash
cd cleanbid-package
node 02-pricing-tests.js
```

You should see `30 passed  0 failed`.

To call the engine by hand:

```bash
node -e "const {calculatePricing}=require('./01-pricing-engine'); \
console.log(calculatePricing({ \
  totalArea:75000, baseFrequency:5, areas:[], tasks:[], addons:[], package:'professional', \
  profile:{wage:22,burden:18,overhead:14,margin:30,minPrice:800,supplies:8,productivity:{office:2800}} \
}));"
```

## What the engine fixes

| ID | OLD (buggy) | NEW (correct) |
|----|-------------|--------------|
| P0 #1 | laborPerVisit = hoursPerVisit * wage * cleaners (triple-counted headcount) | laborPerVisit = visitCrewHours * wage |
| P0 #2 | suppliesPerVisit = labor * supplies% * cleaners | suppliesPerVisit = labor * supplies% |
| P0 #3 | Single building-level crew-hours, no per-area freq aggregation | Per-area crew-hours, per-area freq, summed |
| P0 #12 | No validation, could divide by zero or accept negative values | 8 guards run first; refuses with `{error, margin}` |

## Why the engine is not yet wired into the app

I have done many editor reads to confirm the file state but could not complete the surgical patch inside the per-call token limits. The patch needed in `recalc()` at ~line 2125 of 03-app-shell.html is mechanical:

```
// Replace the ~60-line inline math with:
const calc = CleanBidPricing.calculatePricing({
  totalArea, areas,
  tasks: qb.tasks,
  profile: P,
  addons: state.addons || [],
  package: qb.package
});
// Map calc.* into qb.calc.* (which UI already binds to).
```

Every UI binding (`#cArea`, `#cBurden`, `#eL`, etc.) already reads `qb.calc.*`, so the wiring is ~30 min of focused editing, not engineering. The engine is independently verifiable on its own.

## Honest framing

Pure engine + test suite prove the math is now right. UI demo shows roughly the same numbers for default scenarios (the most common single-area office doesn't exercise the cleaned cases). The 75,000 sq ft multi-area case in 02-pricing-tests.js is the one to demo -- that's where the live recalc() diverges from calculatePricing() until the wiring lands.

## File listing

```
cleanbid-source.zip
+- 01-pricing-engine.js   # 172 lines, no deps
+- 02-pricing-tests.js    # 260 lines, plain Node, 30 assertions
+- 03-app-shell.html      # 3642 lines, full UI, last-mile wiring TODO
+- README.md              # this file
```
