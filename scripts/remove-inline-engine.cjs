/* One-off: remove the inline duplicate pricing engine from 03-app-shell.html.
 * Lines 2704..2871 (1-indexed, inclusive) are the duplicate engine + its
 * window.CleanBidPricing assignment + boot log. The authoritative engine is
 * now 01-pricing-engine.js (imported in the module script). Keeps the <script>
 * tag and the STATE + PERSISTENCE block that follows. */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', '03-app-shell.html');
const lines = fs.readFileSync(file, 'utf8').split('\n');
const start = 2704, end = 2871; // inclusive
const removed = lines.slice(start - 1, end);
// sanity: confirm we are removing the engine block, not something else
const head = removed.slice(0, 6).join('\n');
const tail = removed[removed.length - 1] || '';
if (!/CLEANBID — Commercial Cleaning Estimator Pricing Engine/.test(head)) {
  console.error('ABORT: start line does not look like engine header:\n' + head);
  process.exit(2);
}
if (!/console\.log\('\[CleanBid\] boot v2'\);/.test(tail)) {
  console.error('ABORT: end line does not look like boot log:\n' + tail);
  process.exit(2);
}
const kept = lines.slice(0, start - 1).concat(lines.slice(end));
fs.writeFileSync(file, kept.join('\n'));
console.log('Removed', removed.length, 'lines (' + start + '..' + end + '). New line count:', kept.length);
