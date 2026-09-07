'use strict';
// Named start-of-day setups. These render a badge in the UI, and a badge gets trusted more than its
// evidence warrants — so the tests pin BOTH the firing logic and the honesty metadata that travels with
// it (sample size, the fact that BIG_MOVE is explicitly NOT a direction call).
const assert = require('assert');
const S = require('../../server/src/candle-spread/setups.js');

let passed = 0;
const t = (name, fn) => { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } };

console.log('\ncandle-spread setups');

// A day whose low sits ON the lower band, closing green.
const bigMove = { datetime: 1, open: 100, high: 112, low: 90, close: 110, bbLower: 90, bbMiddle: 105, bbUpper: 120, ema9: 104 };
// A large green body closing in the upper half of the bands, low nowhere near the lower band.
const quiet   = { datetime: 2, open: 100, high: 116, low: 99,  close: 115, bbLower: 90, bbMiddle: 105, bbUpper: 120, ema9: 104 };
const prior   = { datetime: 0, open: 99, high: 101, low: 97, close: 100, bbLower: 90, bbMiddle: 105, bbUpper: 120, ema9: 104 };
const keys = (r) => r.setups.map(s => s.key);

t('BIG_MOVE fires when a green day has its low at the lower band', () => {
  assert.deepStrictEqual(keys(S.evaluate([prior, bigMove])), ['BIG_MOVE']);
});

t('BIG_MOVE does NOT fire when the same shape closes red', () => {
  const red = { ...bigMove, open: 110, close: 100 };
  assert.deepStrictEqual(keys(S.evaluate([prior, red])), [],
    'the colour does real work — red days at the same band favour v4, not v7');
});

t('BIG_MOVE does NOT fire when the low is far from the band', () => {
  const off = { ...bigMove, low: 108 };
  assert.ok(!keys(S.evaluate([prior, off])).includes('BIG_MOVE'));
});

t('QUIET_DAY fires on a large green body in the upper half', () => {
  assert.deepStrictEqual(keys(S.evaluate([prior, quiet])), ['QUIET_DAY']);
});

t('QUIET_DAY does NOT fire on a small body', () => {
  const doji = { ...quiet, open: 114, close: 115 };
  assert.ok(!keys(S.evaluate([prior, doji])).includes('QUIET_DAY'));
});

t('QUIET_DAY does NOT fire when the close is beyond the upper band', () => {
  const beyond = { ...quiet, close: 125, high: 126 };
  assert.ok(!keys(S.evaluate([prior, beyond])).includes('QUIET_DAY'));
});

t('no daily bands yet -> reports why instead of silently firing nothing', () => {
  const cold = { ...bigMove, bbUpper: null, bbLower: null };
  const r = S.evaluate([prior, cold]);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not warm/);
});

t('insufficient history is reported, not treated as "no setups"', () => {
  const r = S.evaluate([bigMove]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.setups.length, 0);
});

t('every setup carries its sample size, caveat and out-of-sample status', () => {
  for (const day of [bigMove, quiet]) {
    for (const s of S.evaluate([prior, day]).setups) {
      assert.ok(s.n > 0, s.key + ' must state n');
      assert.ok(s.firesPct > 0, s.key + ' must state how often it fires');
      assert.ok(s.caveat && s.caveat.length > 40, s.key + ' must carry a real caveat');
      assert.ok(/in-sample/.test(s.tested), s.key + ' must not imply out-of-sample validation');
      assert.ok(Array.isArray(s.favors) && s.favors.length, s.key + ' must name the variants it favours');
    }
  }
});

t('BIG_MOVE does not claim a direction', () => {
  const s = S.evaluate([prior, bigMove]).setups[0];
  assert.match(s.expect, /direction unknown/i);
  assert.match(s.caveat, /NOT a direction call/i,
    'the original hypothesis was directional and measured wrong — the correction must survive in the copy');
});

t('pctB places a close inside, below and above the bands', () => {
  assert.strictEqual(S.pctB(105, 90, 120), 0.5);
  assert.ok(S.pctB(85, 90, 120) < 0);
  assert.ok(S.pctB(125, 90, 120) > 1);
  assert.strictEqual(S.pctB(105, null, 120), null);
});

console.log(`  ${passed} passed`);
