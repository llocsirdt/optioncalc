'use strict';
// EVERY ORDER GOES THROUGH THE SAME GATES.
//
// markFill grew three structural gates (verticalSanity, quoteUsable, chainMonotonic) after the 2026-09-16
// broken-chain session, and two of them read their configuration off `deps`: chainMonotonic needs
// deps.strikeIncrement to find each leg's neighbours, and the check result carries deps.underlying.
//
// Five of the seven call sites in trader.js never passed `deps`. Four of those five are the HEDGE paths —
// offset, wing, fly, and the pending-hedge resolver — which are exactly the structures whose entire value
// sits at a single strike, so a chain that lies about one strike misprices them the most. They fell back
// to a hardcoded increment of 10.
//
// Every live variant uses strikeIncrement 10, so the fallback happened to be right and nothing diverged.
// That is the reason this went unseen for as long as it did, and the reason it is pinned here rather than
// left to the next person to re-derive: the gate looked armed on every path and was only armed by luck.
//
// Run: node server/tests/unit/candle-spread-gates-reach-all.test.js
const fs = require('fs');
const path = require('path');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// ── 1. THE GATE ACTUALLY READS deps.strikeIncrement ─────────────────────────────────────────────────
// A chain that is clean on a 10-grid and broken on a 5-grid. If markFill honours the increment it is
// given, the same quote must be refused at 5 and accepted at 10 — which also proves the gate is not
// silently disabled by a bad increment.
{
  const legs = [{ side: 'long', type: 'C', strike: 29390 }, { side: 'short', type: 'C', strike: 29400 }];
  // 10-grid neighbours descend correctly (calls are worth less as strike rises). 29395 does not.
  const mids = { 29380: 22, 29390: 16, 29395: 99, 29400: 11, 29410: 7 };
  const getLeg = (t, k) => (t === 'C' && mids[k] != null ? { mid: mids[k], bid: 0, ask: 200, symbol: `NDX_C${k}` } : null);

  const at10 = trader.markFill(legs, 6.00, getLeg, 0.05, { strikeIncrement: 10, underlying: 29395 });
  ok(at10.fillable, `on the 10-grid the chain is monotonic and the spread fills (mark ${at10.mark})`);
  ok(at10.underlying === 29395, 'and the check carries the underlying off deps');

  const at5 = trader.markFill(legs, 6.00, getLeg, 0.05, { strikeIncrement: 5, underlying: 29395 });
  ok(!at5.fillable, 'on the 5-grid the same quote is refused');
  ok(/not monotonic/.test(at5.badQuote || ''), `and says why (${at5.badQuote})`);

  // The old call shape — no deps at all — silently uses 10 and so cannot see the 5-grid break. Keeping
  // this assertion documents the failure mode rather than just the fix.
  ok(trader.markFill(legs, 6.00, getLeg, 0.05).fillable,
    'omitting deps falls back to an increment of 10 — which is why the hedge paths never tripped');
  ok(trader.markFill(legs, 6.00, getLeg, 0.05).underlying === null,
    'and loses the underlying entirely');
}

// ── 2. NO CALL SITE MAY OMIT deps AGAIN ─────────────────────────────────────────────────────────────
// A behavioural test cannot catch a NEW hedge path added next month with the old 4-argument shape, and
// that is precisely how the first four got there. This reads the source.
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'candle-spread', 'trader.js'), 'utf8');
  const lines = src.split('\n');
  const bad = [];
  let seen = 0;
  lines.forEach((line, i) => {
    if (/^\s*function markFill\(/.test(line)) return;              // the definition
    const m = line.match(/markFill\(([^;]*)\)/);
    if (!m) return;
    seen++;
    // Count top-level commas in the argument list; nested calls like deps.getLeg carry none.
    let depth = 0, args = 1;
    for (const ch of m[1]) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) args++;
    }
    if (args < 5) bad.push(`trader.js:${i + 1}  ${line.trim()}`);
  });
  ok(seen >= 6, `found ${seen} markFill call sites to check (expected at least 6)`);
  ok(!bad.length, `every markFill call passes deps${bad.length ? `\n      ` + bad.join('\n      ') : ''}`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
