'use strict';
// UNDER A REAL BROKER, ONLY THE BROKER BOOKS.
//
// This is a STRUCTURAL test, not a behavioural one. The behavioural tests prove the paths we know about
// honour `fillSource === 'broker'`; this proves there are no OTHERS, and that a new one cannot be added
// silently. It exists because the gap it pins was found by asking the question rather than by any test:
// when the closed loop shipped, opens and covers were gated and HEDGES WERE NOT, and applyBrokerFills
// dropped their real fills as 'unhandled-kind' — so the engine booked hedges off its own mark for two weeks
// with every suite green.
//
// THE INVARIANT. Every site that marks a position filled or covered, credits realizedPnl, or moves the cash
// ledger must live in a function that either
//   (a) IS applyBrokerFills — the one place allowed to book from a broker fill, or
//   (b) contains a `fillSource` gate, so it defers when the broker is authoritative.
// A function that books without either is a path that can put something in the book the account does not
// hold. That is the phantom measured on prod v7-10 2026-09-25: 16 opens and 13 covers believed, 0 of 33
// orders filled, 29 of 29 positions phantom.
//
// WHY STRUCTURAL. A call-site guard is a convention; an in-function guard is an invariant. The combo path
// was guarded only at its single call site — but it is exported and the combo unit test calls it directly,
// so a second call site would have reopened the hole with nothing failing. The guard moved inside, and this
// test is what keeps the next one honest.
//
// Run: node server/tests/unit/candle-spread-broker-authority.test.js
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const file = path.join(__dirname, '..', '..', 'src', 'candle-spread', 'trader.js');
const lines = fs.readFileSync(file, 'utf8').split('\n');

// Enclosing TOP-LEVEL function for each line. Nested arrow/inline functions inherit their parent, which is
// what we want: the gate may legitimately sit in the parent's body.
const owner = [];
let cur = '(top level)';
lines.forEach((l, idx) => {
  const m = /^(?:async )?function (\w+)/.exec(l);
  if (m) cur = m[1];
  owner[idx + 1] = cur;
});

// Strip line comments so a line that merely MENTIONS a booking never counts as one.
const codeOf = (l) => {
  const t = l.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  return l.split('//')[0];
};

const BOOKING = [
  ['marks a position filled',   /\.filled\s*=\s*true/],
  ['marks a position covered',  /\.covered\s*=\s*true/],
  ['credits realizedPnl',       /realizedPnl\s*=\s*round2\([^)]*realizedPnl/],
  ['moves the cash ledger',     /(?<!function )noteCash\s*\(/],
];

// Collect booking sites by owning function.
const sites = new Map();          // fn -> [{line, what, text}]
lines.forEach((raw, idx) => {
  const ln = idx + 1;
  const code = codeOf(raw);
  if (!code) return;
  if (/^function noteCash/.test(code.trim())) return;      // the helper's own definition
  for (const [what, re] of BOOKING) {
    if (re.test(code)) {
      if (!sites.has(owner[ln])) sites.set(owner[ln], []);
      sites.get(owner[ln]).push({ line: ln, what, text: code.trim().slice(0, 70) });
    }
  }
});

ok(sites.size > 0, 'the scan found booking sites at all (a scan that finds nothing proves nothing)');

// Does a function body contain a fillSource gate?
const bodyOf = (fn) => {
  const start = lines.findIndex((l) => new RegExp('^(?:async )?function ' + fn + '\\b').test(l));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(?:async )?function |^module\.exports/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
};
const gated = (fn) => /fillSource\s*(===|!==)\s*'broker'/.test(bodyOf(fn));

// THE INVARIANT, asserted per function.
const BROKER_PATH = 'applyBrokerFills';
for (const [fn, found] of [...sites].sort()) {
  if (fn === BROKER_PATH) {
    ok(true, `${fn}: the broker path itself books (${found.length} sites)`);
    continue;
  }
  const why = found.map((f) => `${f.what} @${f.line}`).join('; ');
  ok(gated(fn), `${fn} books (${why}) and MUST contain a fillSource gate`);
}

// THE ROSTER OF BOOKING FUNCTIONS IS PINNED. A new one fails here even if it happens to be gated, because
// a new path into the book deserves a deliberate look rather than an automatic pass.
const EXPECTED = [
  'applyBrokerFills',          // (a) the broker path
  'coverToStackFreeBudget',    // gated: cover-skip-broker
  'processCandleClose',        // gated: cover-skip-broker (assume-fill model)
  'resolvePendingHedges',      // gated 40b1c53: <kind>-mark-fillable
  'resolvePendingOpen',        // gated when the closed loop shipped
  'resolveRestingCovers',      // gated when the closed loop shipped
  'tryComboLockAndOpen',       // gated: combo-skip-broker, INSIDE the function
].sort();
const actual = [...sites.keys()].sort();
ok(JSON.stringify(actual) === JSON.stringify(EXPECTED),
  `the set of functions that book is unchanged\n    expected: ${EXPECTED.join(', ')}\n    actual:   ${actual.join(', ')}`);

// AND THE GATE MUST PRECEDE THE BOOKING IN THE SAME FUNCTION. A gate that sits after the booking, or in an
// unrelated branch, reads as armed and is not.
for (const [fn, found] of sites) {
  if (fn === BROKER_PATH) continue;
  const start = lines.findIndex((l) => new RegExp('^(?:async )?function ' + fn + '\\b').test(l)) + 1;
  const firstGate = lines.findIndex((l, i) => i >= start - 1 && /fillSource\s*(===|!==)\s*'broker'/.test(codeOf(l))) + 1;
  const firstBook = Math.min(...found.map((f) => f.line));
  ok(firstGate > 0 && firstGate < firstBook,
    `${fn}: the gate (line ${firstGate}) comes before its first booking (line ${firstBook})`);
}

// tryComboLockAndOpen is EXPORTED and called directly by its own unit test, which is exactly why its guard
// cannot live at the call site.
const trader = require('../../src/candle-spread/trader');
ok(typeof trader.tryComboLockAndOpen === 'function', 'tryComboLockAndOpen is exported (so a call-site guard is not enough)');
{
  const d = [];
  // No ledger, no positions — it must refuse on the BROKER check first, before any of its own preconditions.
  const out = trader.tryComboLockAndOpen({ positions: [] }, {}, 'bull', { spreadWidth: 20, quantity: 1 },
    { fillSource: 'broker', comboOrders: true }, d, 't');
  Promise.resolve(out).then((r) => {
    // `false` ALONE IS NOT EVIDENCE: this fixture has no ledger and no positions, so the function would
    // return false for its own preconditions even with the gate gone. The DECISION is what proves the
    // broker check ran, and ran FIRST — so that is what is asserted. (Checked by sabotage: removing the
    // gate leaves `r === false` passing and only this assertion failing.)
    ok(d.some((x) => x.action === 'combo-skip-broker'),
      'called directly under broker it refuses FOR THE BROKER REASON, before its own preconditions');
    ok(r === false, 'and returns false, so the caller falls back to the gated sequential path');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
}
