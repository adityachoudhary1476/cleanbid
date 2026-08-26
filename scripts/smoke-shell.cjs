/* One-off smoke check: confirm the inline app-shell script parses and that
 * our new functions are present in the source. Not a test file. */
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', '03-app-shell.html'), 'utf8');
// The main inline script is the FIRST <script> with no attributes.
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('NO INLINE SCRIPT'); process.exit(1); }
const code = m[1];
try {
  new Function(code);
  console.log('INLINE SCRIPT PARSES OK (' + code.length + ' chars)');
} catch (e) {
  console.log('SYNTAX ERROR:', e.message);
  process.exit(2);
}
const need = ['function openEditQuote', 'function commitQuoteEdit', 'function eqRecalc',
  'function renderQuotaCard', 'function renderQuotesMetrics', 'id="editQuoteModal"', 'id="quotaCard"'];
const missing = need.filter(s => !html.includes(s));
console.log(missing.length ? 'MISSING: ' + missing.join(', ') : 'ALL NEW MARKERS PRESENT');
