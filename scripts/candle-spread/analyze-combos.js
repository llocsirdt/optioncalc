#!/usr/bin/env node
'use strict';
/**
 * Which 2- and 3-strategy combinations OPPOSE each other best (low/negative daily-return correlation)
 * and does the opposition actually SMOOTH the portfolio (better ret/maxDD than the parts)? Runs every
 * strategy on the same 5m engine, builds the correlation matrix, then ranks equal-weight (QTY=1 each)
 * combos by correlation and by combined ret/maxDD.
 *
 * Usage: node scripts/candle-spread/analyze-combos.js --dataDir <5m dir>
 */
const eng = require('./backtest-v4');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { runDay9 } = require('./backtest-v9-5m');
const { v5Signal } = require('./v5-signals');
const { v6Signal } = require('./v6-signals');
const { v7Signal } = require('./v7-signals');

const di = process.argv.indexOf('--dataDir');
const days = load5mDays(di >= 0 ? process.argv[di + 1] : eng.DATA_DIR);
const at15 = fn => (A, p, ctx) => ctx.isFifteen === false ? { openSide: null, cover: false } : fn(A, p, { ...ctx, cfg: {} });
const strat = {
  classic: d => runDay5m(d.bars, at15((A, p, c) => eng.classicSignal(A, p, c)), {}).terminal,
  v4: d => runDay5m(d.bars, at15((A, p, c) => eng.v4Signal(A, p, c)), {}).terminal,
  v5: d => runDay5m(d.bars, at15((A, p, c) => v5Signal(A, p, c)), {}).terminal,
  v6: d => runDay5m(d.bars, (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } }), {}).terminal,
  'be-wrong': d => runDay5m(d.bars, (A, p, c) => v7Signal(A, p, { ...c, cfg: { fiveMin: true, beWrong: true } }), { bidirectional: true }).terminal,
  'v8-cap': d => runDay5m(d.bars, (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } }), { softCap: 3000, hardCap: 9000, proactiveCoverFrac: 0.70, exemptTrendStack: true }).terminal,
  v9: d => runDay9(d.bars, { maxImbalance: 5 }).terminal,
};
const names = Object.keys(strat);
const ret = {};   // name -> [daily terminal]
for (const n of names) ret[n] = days.map(strat[n]);

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let c = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return c / Math.sqrt(sa * sb); };
function portfolio(members) {
  const daily = days.map((_, i) => members.reduce((s, n) => s + ret[n][i], 0));
  let t = 0, cum = 0, pk = 0, dd = 0; for (const x of daily) { t += x; cum += x; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); }
  const avgCorr = members.length < 2 ? 0 : (() => { let s = 0, k = 0; for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) { s += corr(ret[members[i]], ret[members[j]]); k++; } return s / k; })();
  return { total: t, mdd: dd, ret: dd > 0 ? t / dd : 0, avgCorr };
}
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

// correlation matrix
console.log(`STRATEGY DAILY-RETURN CORRELATION MATRIX (${days.length} days) — low/negative = opposing\n`);
console.log(''.padEnd(10) + names.map(n => n.slice(0, 8).padStart(9)).join(''));
for (const a of names) console.log(a.padEnd(10) + names.map(b => (a === b ? '1.00' : corr(ret[a], ret[b]).toFixed(2)).padStart(9)).join(''));

// combinations
const combos = (arr, k) => { const out = []; const go = (start, cur) => { if (cur.length === k) { out.push([...cur]); return; } for (let i = start; i < arr.length; i++) { cur.push(arr[i]); go(i + 1, cur); cur.pop(); } }; go(0, []); return out; };
function table(title, k, sortKey) {
  const rows = combos(names, k).map(m => ({ m, ...portfolio(m) }));
  rows.sort((a, b) => sortKey === 'corr' ? a.avgCorr - b.avgCorr : b.ret - a.ret);
  console.log(`\n${title}`);
  console.log('  combo'.padEnd(34) + 'avgCorr'.padEnd(10) + 'total'.padEnd(12) + 'maxDD'.padEnd(11) + 'ret/maxDD');
  for (const r of rows.slice(0, 8)) console.log('  ' + r.m.join(' + ').padEnd(32) + r.avgCorr.toFixed(2).padEnd(10) + usd(r.total).padEnd(12) + usd(r.mdd).padEnd(11) + r.ret.toFixed(1));
}
console.log('\nsingles for reference (ret/maxDD):  ' + names.map(n => { const p = portfolio([n]); return `${n} ${p.ret.toFixed(1)}`; }).join('  ·  '));
table('BEST-OPPOSING PAIRS (lowest correlation):', 2, 'corr');
table('BEST PAIRS by combined ret/maxDD:', 2, 'ret');
table('BEST-OPPOSING TRIOS (lowest avg correlation):', 3, 'corr');
table('BEST TRIOS by combined ret/maxDD:', 3, 'ret');
