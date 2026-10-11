'use strict';
// TREND-SIDE FLOOR (2026-10-11) — "risk should never be biased in the direction of the trend" (user). Pins the
// trigger (trend floor below the counter floor OR below zero), the guardrails (lift >= cost, not past the cap,
// not losing a locked profit) and the two orderings.
//
// Run: node server/tests/unit/candle-spread-trend-floor.test.js
const TF = require('../../src/candle-spread/trend-floor');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const xs = [80, 90, 100, 110, 120];
const spot = 100;
// A book that loses if price RISES (bear risk): -500 above spot, +200 below.
const bearish = [200, 200, 0, -500, -500];

ok(TF.bias(1, xs, bearish, spot) && TF.bias(1, xs, bearish, spot).trend === -500, 'bull trend + upside loss = biased into the trend');
ok(TF.bias(-1, xs, bearish, spot) === null, 'bear trend + upside loss = not biased (the risk is AWAY from the trend)');
ok(TF.bias(1, xs, [-300, -300, 0, -100, -100], spot) && true, 'trend side above the other side but below zero still counts (the user\'s "either")');
ok(TF.bias(0, xs, bearish, spot) === null, 'no trend, no action');

// candidates: a cover that lifts the upside by 600 for 400, an open that lifts it by 900 for 500
const cover = { kind: 'cover', cost: 400, pay: (x) => (x > spot ? 600 : -400) };
const open = { kind: 'open', cost: 500, pay: (x) => (x > spot ? 900 : -500) };
{
  const r = TF.pick({ dir: 1, xs, base: bearish, spot, cands: [open, cover], order: 'coverFirst' });
  ok(r.best && r.best.kind === 'cover', 'coverFirst takes the qualifying cover even when the open has the better ratio');
  const c = TF.pick({ dir: 1, xs, base: bearish, spot, cands: [open, cover], order: 'cheapest' });
  ok(c.best && c.best.kind === 'open' && c.best.ratio === 1.8, `cheapest takes the best ratio (${c.best && c.best.kind} ${c.best && c.best.ratio})`);
}
{
  const dear = { kind: 'cover', cost: 1000, pay: (x) => (x > spot ? 600 : -1000) };
  const r = TF.pick({ dir: 1, xs, base: bearish, spot, cands: [dear] });
  ok(!r.best && /ratio/.test(r.scored[0].why), 'a lift smaller than its cost is refused (ratio < 1)');
}
{
  // global floor -150 now; the open would take it to -500, past a -400 cap (an already-breached book is not blocked
  // from an action that does not make it worse — that is floor raise's rule too)
  const r = TF.pick({ dir: 1, xs, base: [200, 200, 0, -150, -150], spot, cands: [open], floorMin: -400 });
  ok(!r.best && /cap/.test(r.scored[0].why), 'an action that pushes the book past the loss cap is refused');
}
{
  const locked = [200, 200, 300, 0, 0];          // global floor 0: locked; trend side = 0 < counter 200
  const r = TF.pick({ dir: 1, xs, base: locked, spot, cands: [cover] });
  ok(!r.best && /locked/.test(r.scored[0].why), 'never trades a locked profit for a possible loss');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
