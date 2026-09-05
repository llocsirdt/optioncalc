'use strict';
// Adaptive (time-of-day) strike placement: most-ITM placement still inside the price ceiling.
const assert = require('assert');
const { makeAdaptiveGeo } = require('../../scripts/candle-spread/backtest-width');
const eng = require('../../scripts/candle-spread/backtest-v4');

let passed = 0;
const t = (n, f) => { try { f(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n     ' + e.message); process.exitCode = 1; } };
const S = 20000, IV = 0.20, hrs = h => h / (365 * 24);

console.log('\nadaptive strike placement');

t('never exceeds the price ceiling', () => {
  const g = makeAdaptiveGeo({ width: 20, incr: 10, maxDebitFrac: 0.65 });
  for (const h of [6.4, 5, 4, 3, 2, 1, 0.5, 0.25]) for (const side of ['bull', 'bear']) {
    const o = g.buildOpen(side, S, hrs(h), IV);
    if (o.skip) continue;
    assert.ok(o.limit <= 0.65 * 20 + 0.05, `${side} @${h}h: paid ${o.limit} > 65% of 20`);
  }
});

t('placement walks ITM -> straddle as expiry approaches (monotone, no time input)', () => {
  const g = makeAdaptiveGeo({ width: 20, incr: 10, maxDebitFrac: 0.65 });
  const seq = [6.4, 5, 4, 3, 2, 1, 0.5].map(h => { const o = g.buildOpen('bull', S, hrs(h), IV); return o.skip ? null : o.itmStrikes; }).filter(x => x != null);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] <= seq[i - 1], `not monotone: ${JSON.stringify(seq)}`);
  assert.ok(seq[0] > seq[seq.length - 1], `expected ITM early (${seq[0]}) and closer to the money late (${seq[seq.length - 1]})`);
});

t('never opens a fully OTM spread (the long leg stays at/in the money)', () => {
  for (const W of [10, 20, 40]) {
    const g = makeAdaptiveGeo({ width: W, incr: 10, maxDebitFrac: 0.65 });
    for (const h of [6, 3, 1, 0.3]) {
      const b = g.buildOpen('bull', S, hrs(h), IV);
      if (!b.skip) assert.ok(b.legs[0].strike <= S, `W${W} @${h}h bull long ${b.legs[0].strike} must be <= spot`);
      const r = g.buildOpen('bear', S, hrs(h), IV);
      if (!r.skip) assert.ok(r.legs[0].strike >= S, `W${W} @${h}h bear long ${r.legs[0].strike} must be >= spot`);
    }
  }
});

t('prices at the REAL mark — never books below market', () => {
  const g = makeAdaptiveGeo({ width: 20, incr: 10, maxDebitFrac: 0.65 });
  for (const h of [6, 3, 1]) {
    const o = g.buildOpen('bull', S, hrs(h), IV);
    if (o.skip) continue;
    const mark = eng.legsMark(o.legs, S, hrs(h), IV);
    assert.ok(Math.abs(o.limit - mark) <= 0.05 + 1e-9, `limit ${o.limit} should equal the mark ${mark.toFixed(2)} (tick rounding only)`);
  }
});

t('DECLINES rather than overpaying when even the straddle is too expensive', () => {
  // an absurdly tight ceiling: no placement can satisfy it
  const g = makeAdaptiveGeo({ width: 20, incr: 10, maxDebitFrac: 0.01 });
  const o = g.buildOpen('bull', S, hrs(3), IV);
  assert.strictEqual(o.skip, true, 'expected a decline');
  assert.strictEqual(o.limit, 0);
  assert.ok(/within 1% of width/.test(o.reason), `reason should name the ceiling: ${o.reason}`);
});

t('a looser ceiling permits a deeper ITM placement', () => {
  const tight = makeAdaptiveGeo({ width: 20, incr: 10, maxDebitFrac: 0.55 }).buildOpen('bull', S, hrs(5), IV);
  const loose = makeAdaptiveGeo({ width: 20, incr: 10, maxDebitFrac: 0.75 }).buildOpen('bull', S, hrs(5), IV);
  assert.ok(!tight.skip && !loose.skip, 'both should find a placement');
  assert.ok(loose.itmStrikes >= tight.itmStrikes, `looser ceiling should allow >= ITM depth (${loose.itmStrikes} vs ${tight.itmStrikes})`);
});

t('cover geometry is unchanged (tent off the short strike)', () => {
  const g = makeAdaptiveGeo({ width: 20, incr: 10 });
  const cov = g.coverLegs('bull', 20000);
  assert.deepStrictEqual(cov.map(l => l.type + l.strike), ['P20000', 'P20020']);
});

console.log(`\n${passed} passed\n`);
