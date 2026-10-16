#!/usr/bin/env node
'use strict';
/**
 * Manual-trade history -> clean dataset.
 *
 *   node scripts/manual-trades/parse-etrade.js [raw1.csv raw2.csv ...] [--daily <daily-NDX.json>]
 *
 * Default inputs: every *.csv in data/manual-trades/raw/ (git-ignored: it carries the account number —
 * account columns are dropped at parse time and never written anywhere). Both E*TRADE formats are accepted
 * (timed transaction history with order #s, and the date-only account-activity export); overlapping exports
 * are deduped, and per date the timed export wins when it is complete.
 * Writes data/manual-trades/trades.json and data/manual-trades/summary.md.
 *
 * Run order when market data is wanted in the summary:
 *   parse-etrade.js  ->  assemble-market.js  ->  parse-etrade.js   (2nd pass adds the clock-offset check)
 *
 * All computation lives in server/src/manual-trades/ (etrade.js, book.js, time-offset.js) so a server
 * endpoint can reuse it; this file is I/O + report formatting only.
 */
const fs = require('fs');
const path = require('path');
const E = require('../../server/src/manual-trades/etrade');
const B = require('../../server/src/manual-trades/book');
const { scoreOffsets } = require('../../server/src/manual-trades/time-offset');

const ROOT = path.join(__dirname, '..', '..');
const OUTDIR = path.join(ROOT, 'data/manual-trades');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const DAILY = opt('--daily', path.join(ROOT, 'data/sweeps/daily-bb-2026-10-15/daily-NDX.json'));
const ET_OFFSET_H = Number(opt('--et-offset', '3'));
let files = argv.filter(a => !a.startsWith('--'));
if (!files.length) {
  const dir = path.join(OUTDIR, 'raw');
  files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv')).map(f => path.join(dir, f));
}
const r2 = n => Math.round(n * 100) / 100;

// ---- parse + merge ----
const parsed = files.map(f => ({ ...E.parseExport(fs.readFileSync(f, 'utf8')), name: path.basename(f) }));
const C = E.combineExports(parsed);
const { fills, settlements, dropped } = E.extractNdx(C.rows, { etOffsetHours: ET_OFFSET_H });

// ---- validate inferred grouping where both formats cover a day (timed has true order #s) ----
const overlapDates = Object.entries(C.sourceByDate)
  .filter(([, s]) => s.counts.timedTrade > 0 && s.counts.timedTrade === s.counts.datedTrade).map(([d]) => d).sort();
const groupingValidation = overlapDates.length
  ? { dates: overlapDates, ...E.validateInference(E.extractNdx(C.timed).fills, E.extractNdx(C.dated).fills, overlapDates) }
  : null;

// ---- NDX official daily bars ----
const closes = {}, opens = {};
for (const c of JSON.parse(fs.readFileSync(DAILY, 'utf8'))) {
  const d = new Date(c.datetime).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  closes[d] = c.close; opens[d] = c.open;
}

// ---- orders ----
const groups = [];
const timedByOrder = new Map();
for (const f of fills.filter(x => x.format === 'timed')) { if (!timedByOrder.has(f.orderNo)) timedByOrder.set(f.orderNo, []); timedByOrder.get(f.orderNo).push(f); }
for (const [orderNo, g] of timedByOrder) groups.push({ orderNo, inferred: false, fills: g });
const inferred = E.inferOrders(fills.filter(x => x.format === 'dated'));
const perDateN = {};
// the DATED export lists newest first: number inferred orders chronologically (reverse file order)
inferred.sort((a, b) => (a[0].date.localeCompare(b[0].date)) || (Math.max(...b.map(f => f.seq)) - Math.max(...a.map(f => f.seq))));
for (const g of inferred) {
  const d = g[0].date; perDateN[d] = (perDateN[d] || 0) + 1;
  groups.push({ orderNo: `inf-${d}-${String(perDateN[d]).padStart(2, '0')}`, inferred: true, fills: g });
}
const calDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const orders = [];
for (const { orderNo, inferred: inf, fills: fs_ } of groups) {
  fs_.sort((a, b) => (a.etSec ?? 0) - (b.etSec ?? 0) || b.seq - a.seq);
  const expiries = [...new Set(fs_.map(f => f.expiry))];
  const roots = [...new Set(fs_.map(f => f.root))];
  const c = B.classifyOrder(fs_.map(f => ({ right: f.right, strike: f.strike, qty: f.side * f.qty, price: f.price })));
  const opens_ = fs_.filter(f => f.open).length;
  const date = fs_[0].date;
  orders.push({
    orderNo, source: fs_[0].format, groupingInferred: inf, date,
    timeET: fs_[0].timeET, timeRaw: fs_[0].timeRaw,
    fillTimesET: inf ? null : [...new Set(fs_.map(f => f.timeET))],
    seq: inf ? perDateN[date] - Number(orderNo.slice(-2)) : null,
    effect: opens_ === fs_.length ? 'open' : opens_ === 0 ? 'close' : 'mixed',
    root: roots.length === 1 ? roots[0] : roots,
    expiry: expiries.length === 1 ? expiries[0] : expiries,
    dte: calDays(date, expiries[0]), non0DTE: expiries.some(x => x !== date),
    style: c.style, subtype: c.subtype, direction: c.direction, debitCredit: c.debitCredit,
    widths: c.widths, center: c.center, wings: c.wings, lean: c.lean,
    qty: c.unit, ratio: c.ratio,
    legs: c.legs.map(l => ({ type: l.right === 'C' ? 'call' : 'put', strike: l.strike, side: l.qty > 0 ? 'long' : 'short', qty: Math.abs(l.qty), price: l.price })),
    netPerUnit: c.netPerUnit,                              // index points per 1 unit; + debit paid, − credit received
    netPerUnitUsd: r2(c.netPerUnit * 100),
    premium: r2(fs_.reduce((s, f) => s + f.gross, 0)),     // $ premium cash (+ received / − paid), all units
    fees: r2(fs_.reduce((s, f) => s + f.fees, 0)),         // all-in (Fee+Comm listed understate it; derived from Amount)
    total: r2(fs_.reduce((s, f) => s + f.amount, 0)),      // E*TRADE cash Amount = premium − fees
  });
  for (const f of fs_) f.orderNo = orderNo;
}
orders.sort((a, b) => a.date.localeCompare(b.date) || (a.timeET && b.timeET ? a.timeET.localeCompare(b.timeET) : String(a.orderNo).localeCompare(String(b.orderNo))));
for (const o of orders) delete o.seq;

// ---- days ----
const dates = [...new Set([...orders.map(o => o.date), ...fills.map(f => f.expiry)])].sort();
const days = [];
for (const date of dates) {
  // The cached daily bars carry 4 decimals; the official settlement value (and E*TRADE's cash-settle prices) is cents.
  const settle = closes[date] != null ? r2(closes[date]) : null;
  const dayOrders = orders.filter(o => o.date === date);
  const bookFills = fills.filter(f => f.expiry === date);
  const bookOrders = [...new Set(bookFills.map(f => f.orderNo))];
  const carriedIn = orders.filter(o => bookOrders.includes(o.orderNo) && o.date !== date).map(o => o.orderNo);
  const rows = settlements.filter(s => s.expiry === date);
  // Root NDX (monthly, 3rd Friday) is AM-settled on the opening SOQ, not the close. No SOQ history is on
  // hand: take it from E*TRADE's own cash-settle rows when an NDX leg finished ITM, else the daily OPEN as
  // an approximation (flagged) — only matters if a strike sits between the open and the SOQ.
  let settleBy = settle, amSettle = null;
  if (bookFills.some(f => f.root === 'NDX') && settle != null) {
    const imp = B.impliedSettleFromRows(rows.filter(r => r.root === 'NDX'));
    amSettle = imp ? { value: imp.min, source: 'implied by E*TRADE NDX cash-settle rows' } : { value: r2(opens[date]), source: 'APPROX: NDX daily open (true SOQ unavailable)' };
    settleBy = { NDXP: settle, NDX: amSettle.value, default: settle };
  }
  const sb = settle != null ? B.settleBook(bookFills, settleBy) : null;
  // reconciliation (E*TRADE's next-day settlement rows; used ONLY to check)
  let reconcile;
  if (!bookFills.length) reconcile = { status: 'no-book' };
  else if (!rows.length) {
    reconcile = sb && sb.legs.length === 0 ? { status: 'ok', note: 'all positions closed before expiry' }
      : { status: 'unavailable', note: 'settlement rows not in the export (posted the next market day, after the export end)' };
  } else {
    const etSettleCash = r2(rows.reduce((s, r) => s + r.amount, 0));
    const etTradeCash = r2(bookFills.reduce((s, f) => s + f.amount, 0));
    // position-level: E*TRADE rows (net by right|strike) vs our net legs
    const rowPos = new Map();
    for (const r of rows) {
      const k = `${r.root}|${r.right}|${r.strike}`;
      const signed = r.kind === 'cash-settle' ? Math.sign(r.amount) * r.qty : null;
      const p = rowPos.get(k) || { qty: 0, expired: 0 };
      if (signed == null) p.expired += r.qty; else p.qty += signed;
      rowPos.set(k, p);
    }
    const legMismatch = [];
    for (const l of sb.legs) {
      const k = `${l.root}|${l.right}|${l.strike}`; const p = rowPos.get(k) || { qty: 0, expired: 0 };
      const itm = B.intrinsic(l.right, l.strike, l.root === 'NDX' && amSettle ? amSettle.value : settle) > 0;
      const ok = itm ? p.qty === l.qty : p.expired === Math.abs(l.qty);
      if (!ok) legMismatch.push({ leg: `${l.qty > 0 ? '+' : ''}${l.qty} ${l.strike}${l.right}`, itm, etrade: p });
      rowPos.delete(k);
    }
    for (const [k, p] of rowPos) legMismatch.push({ leg: `none ${k}`, etrade: p });
    const implied = B.impliedSettleFromRows(rows.filter(r => r.root !== 'NDX'));
    reconcile = {
      status: 'checked',
      postedDate: [...new Set(rows.map(r => r.postedDate))].join(','),
      etradeSettlementCash: etSettleCash, computedTerminal: sb.terminal, settlementDiff: r2(etSettleCash - sb.terminal),
      etradeRealized: r2(etTradeCash + etSettleCash), computedNet: sb.net, realizedDiff: r2(etTradeCash + etSettleCash - sb.net),
      impliedSettle: implied, settleUsed: settle,
      legMismatches: legMismatch,
    };
    // tolerance: E*TRADE nets small regulatory sale fees (cents) into some cash-settle rows (e.g. 2×141.34 posted as $28,267.99)
    reconcile.ok = Math.abs(reconcile.settlementDiff) <= 2 && Math.abs(reconcile.realizedDiff) <= 2 && !legMismatch.length;
    reconcile.status = reconcile.ok ? 'ok' : 'MISMATCH';
  }
  const styleCounts = {};
  for (const o of dayOrders) { const k = styleKey(o); styleCounts[k] = (styleCounts[k] || 0) + 1; }
  const src = C.sourceByDate[date] || {};
  days.push({
    date, settle, amSettle,
    source: { trades: src.trade || null, settlementRows: src.settle || null, timesKnown: dayOrders.length ? dayOrders.every(o => !o.groupingInferred) : null },
    orders: dayOrders,
    carriedIn, nonZeroDteOrders: dayOrders.filter(o => o.non0DTE).map(o => ({ orderNo: o.orderNo, expiry: o.expiry })),
    styleCounts,
    widthsUsed: [...new Set(dayOrders.flatMap(o => o.style === 'vertical' ? o.widths : o.widths.filter((_, i) => !(o.style.includes('condor') && i === 1))))].sort((a, b) => a - b),
    book: sb ? { legs: sb.legs.map(l => ({ root: l.root, type: l.right === 'C' ? 'call' : 'put', strike: l.strike, qty: l.qty })), profile: sb.profile } : null,
    pnl: sb ? { premium: sb.premiumCash, fees: sb.fees, terminal: sb.terminal, gross: sb.gross, net: sb.net } : null,
    reconcile,
  });
}
function styleKey(o) {
  if (o.style === 'vertical') return `vertical ${o.subtype}`;
  if (o.style === 'asymmetric butterfly') return `asymmetric butterfly ${o.subtype.split(' ')[0]}`;
  if (o.style === 'single') return `single ${o.subtype}`;
  return o.style + (o.direction === 'short' ? ' (short)' : '');
}

// ---- clock-offset verification (needs assemble-market.js output) ----
let timeCheck = null;
const MKT = path.join(OUTDIR, 'market');
if (fs.existsSync(path.join(MKT, 'basis.json'))) {
  const basis = JSON.parse(fs.readFileSync(path.join(MKT, 'basis.json'), 'utf8')).days;
  const nq = {};
  const loadDay = d => {
    if (nq[d] !== undefined) return nq[d];
    const f = path.join(MKT, 'nq-1m', `${d}.json`);
    if (!fs.existsSync(f) || !basis[d] || basis[d].basis == null) return (nq[d] = null);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const m = new Map(); for (const b of j.bars) m.set(b.t, b);
    return (nq[d] = { bars: m, basis: basis[d].basis });
  };
  const etMs = (d, sec) => {           // ET seconds-of-day -> epoch ms (EDT in June; DST-aware via Intl probe)
    const base = Date.parse(`${d}T00:00:00Z`);
    const offH = new Date(base + 12 * 3600e3).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).includes('EDT') ? 4 : 5;
    return base + (sec + offH * 3600) * 1000;
  };
  const underlyingAt = (d, sec) => {
    const D = loadDay(d); if (!D) return null;
    const ms = etMs(d, sec); const start = Math.floor(ms / 60e3) * 60e3;
    const b = D.bars.get(start); if (!b) return null;
    const frac = (ms - start) / 60e3;
    return b.o + (b.c - b.o) * frac - D.basis;
  };
  const timedFills = E.extractNdx(C.timed, { etOffsetHours: ET_OFFSET_H }).fills;
  const tf = timedFills.filter(f => f.expiry === f.date).map(f => ({ date: f.date, secRaw: f.etSec + ET_OFFSET_H * 3600, right: f.right, strike: f.strike, price: f.price }));
  const hours = scoreOffsets(tf, underlyingAt, { candidates: [0, 1, 2, 3, 4, 5] });
  const minutes = scoreOffsets(tf, underlyingAt, { candidates: [-10, -5, -3, -2, -1, 0, 1, 2, 3, 5, 10].map(m => 3 + m / 60) })
    .map(r => ({ ...r, offsetMinutesFrom3h: Math.round((r.offsetHours - 3) * 60) }));
  timeCheck = { hours, minutes, rawRange: [timedFills.map(f => f.timeRaw).sort()[0], timedFills.map(f => f.timeRaw).sort().at(-1)] };
}

// ---- write ----
const out = {
  generatedFrom: files.map(f => path.basename(f)),
  notes: [
    'Account number/name are dropped at parse time and never stored.',
    "Two export formats: 'timed' (clock + true order #) and 'dated' (date only, no order #). Per date the timed export wins when it is complete (row counts equal); 2025-06-06 is partial in the timed export (starts 13:36 ET), so the dated export is used there.",
    "Dated-source orders have orderNo 'inf-<date>-NN', timeET null, groupingInferred true — legs grouped by inferOrders(); see groupingValidation for its measured accuracy. Book and P/L do not depend on grouping.",
    'Root NDX (AM-settled monthly) legs settle at amSettle (see day.amSettle.source), NDXP at the official close.',
    `timeET = export clock − ${ET_OFFSET_H}h (verified; see summary.md). Whether the export time is order placement or execution is unknown.`,
    'netPerUnit: index points per 1 unit of the order (+ debit paid, − credit received). premium/fees/total in $; total = E*TRADE Amount.',
    'fees are all-in, derived as premium − Amount; the listed Fee+Comm columns ($0.69/contract) understate the real $1.26/contract.',
    'book = all fills EXPIRING on the date (incl. legs carried in from earlier trade dates), netted; settled at the official NDX close (PM-settled NDXP).',
    "Settlement rows ('Option Expired', plain 'Sold') are excluded from the trade list and used ONLY for reconciliation.",
  ],
  dropped, settlementRowsUsedForReconcile: settlements.length,
  sourceByDate: C.sourceByDate,
  groupingValidation,
  timeCheck,
  days,
};
fs.writeFileSync(path.join(OUTDIR, 'trades.json'), JSON.stringify(out, null, 1));

// ---- summary.md ----
const L = [];
const $ = n => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));
L.push('# Manual trades — E*TRADE NDXP history', '');
L.push(`Source: ${files.map(f => path.basename(f)).join(', ')} · ${fills.length} NDXP fills · ${orders.length} orders · ${days.filter(d => d.orders.length).length} trading days`, '');
L.push('Generated by `node scripts/manual-trades/parse-etrade.js`. Settle = official NDX close (cached Schwab daily bars). P/L = premium + expiry value − all-in fees.', '');
L.push('| date | src | orders | styles | widths | net premium | fees | settle | terminal | net P/L | reconcile |');
L.push('|---|---|---:|---|---|---:|---:|---:|---:|---:|---|');
let tot = { prem: 0, fees: 0, term: 0, net: 0 };
for (const d of days) {
  if (!d.orders.length && !d.pnl) continue;
  const styles = Object.entries(d.styleCounts).map(([k, n]) => `${n} ${abbr(k)}`).join(', ');
  const rc = d.reconcile.status === 'ok' ? 'ok' : d.reconcile.status === 'MISMATCH' ? `**MISMATCH** (${$(d.reconcile.realizedDiff)})` : d.reconcile.status;
  const carry = d.carriedIn.length ? ` (+${d.carriedIn.length} carried in)` : '';
  const non0 = d.nonZeroDteOrders.length ? ` · ${d.nonZeroDteOrders.length} non-0DTE` : '';
  L.push(`| ${d.date} | ${d.source.trades === 'timed' ? 'T' : d.source.trades === 'dated' ? 'D' : '—'} | ${d.orders.length}${carry} | ${styles}${non0} | ${d.widthsUsed.join('/')} | ${$(d.pnl && d.pnl.premium)} | ${$(d.pnl && d.pnl.fees)} | ${d.settle != null ? d.settle.toFixed(2) : '—'} | ${$(d.pnl && d.pnl.terminal)} | ${$(d.pnl && d.pnl.net)} | ${rc} |`);
  if (d.pnl) { tot.prem += d.pnl.premium; tot.fees += d.pnl.fees; tot.term += d.pnl.terminal; tot.net += d.pnl.net; }
}
L.push(`| **total** | | ${orders.length} | | | ${$(tot.prem)} | ${$(tot.fees)} | | ${$(tot.term)} | **${$(tot.net)}** | |`, '');
L.push('src: T = timed export (clock + true order #s), D = date-only export (orders INFERRED, no times). Style counts on D days inherit the grouping error measured below.', '');
L.push('Premium is + received / − paid. Days are keyed by expiry for the book; orders by trade date (a Friday order in a Monday expiry is counted on Friday and settled in Monday\'s book — "carried in").', '');

L.push('## Style counts (all orders)', '');
const sc = {};
for (const o of orders) { const k = styleKey(o); (sc[k] = sc[k] || []).push(o); }
L.push('| style | n | example |', '|---|---:|---|');
for (const [k, os] of Object.entries(sc).sort((a, b) => b[1].length - a[1].length)) L.push(`| ${k} | ${os.length} | ${example(os[0])} |`);
L.push('');
L.push('Asymmetric butterfly = ratio a:(a+b):b fly with a ≠ b. **balanced** when a·(lower wing) = b·(upper wing): both tails settle at exactly zero, so it is a risk-free-tailed tent whose peak is skewed toward the narrow/heavy wing. **unbalanced** leaves a tail at a loss or gain. Broken-wing butterfly = classic 1:2:1 with unequal wings.', '');

const recon = days.filter(d => d.reconcile.status === 'checked' || d.reconcile.status === 'ok' || d.reconcile.status === 'MISMATCH');
L.push('## Reconciliation vs E*TRADE settlement rows', '');
L.push('| expiry | E*TRADE settle cash | computed expiry value | E*TRADE realized | computed net | diff | settle implied by rows | legs |');
L.push('|---|---:|---:|---:|---:|---:|---|---|');
for (const d of recon) {
  const r = d.reconcile;
  if (r.etradeSettlementCash == null) { L.push(`| ${d.date} | — | — | — | — | — | — | ${r.note} |`); continue; }
  const imp = r.impliedSettle ? (r.impliedSettle.min === r.impliedSettle.max ? r.impliedSettle.min.toFixed(2) : `${r.impliedSettle.min}-${r.impliedSettle.max}`) : '—';
  L.push(`| ${d.date} | ${$(r.etradeSettlementCash)} | ${$(r.computedTerminal)} | ${$(r.etradeRealized)} | ${$(r.computedNet)} | ${r.realizedDiff.toFixed(2)} | ${imp} | ${r.legMismatches.length ? r.legMismatches.map(m => m.leg).join('; ') : 'match'} |`);
}
for (const d of days.filter(x => x.reconcile.status === 'unavailable')) L.push(`| ${d.date} | — | ${$(d.pnl.terminal)} | — | ${$(d.pnl.net)} | n/a | — | ${d.reconcile.note} |`);
L.push('');

if (groupingValidation) {
  const v = groupingValidation;
  L.push('## Order-grouping inference (date-only export) — validation', '');
  L.push(`On ${v.dates.join(', ')} both exports hold the same executions; the timed one has true order numbers. Inferred groups that exactly equal a true order: **${v.exactMatches}/${v.trueOrders} orders (${(v.orderMatchRate * 100).toFixed(0)}%)**, covering ${v.fillsInExactMatches}/${v.fills} fills (${(v.fillMatchRate * 100).toFixed(0)}%).`, '');
  L.push('| date | true orders | inferred | exact matches | fills in matches |', '|---|---:|---:|---:|---:|');
  for (const [d, r] of Object.entries(v.perDay)) L.push(`| ${d} | ${r.trueOrders} | ${r.inferredOrders} | ${r.exactMatches} | ${r.fillsInExactMatches}/${r.fills} |`);
  L.push('', 'Failure mode: the date-only export interleaves legs of orders placed seconds apart, so a leg can be paired with a neighbouring order\'s leg that also balances it.', '');
}

if (timeCheck) {
  L.push('## Clock-offset verification', '');
  L.push(`Export clock range for fills: ${timeCheck.rawRange.join(' .. ')}. Underlying proxy = back-adjusted /NQ 1m (bar interpolated to the second) minus the day's NQ→NDX close basis (no NDX intraday exists for June 2025). 0DTE fills only.`, '');
  L.push('| offset (export − ET) | legs tested | legs outside 9:30-16:15 | sub-intrinsic fills (>5pt) | worst | parity pairs | parity median abs err |');
  L.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const r of timeCheck.hours) L.push(`| ${r.offsetHours}h | ${r.legsTested} | ${r.legsOutsideSession} | ${r.subIntrinsic} | ${r.worstBelowIntrinsic} | ${r.parityPairs} | ${r.parityMedianAbsErr ?? '—'} |`);
  L.push('', 'Fine scan around +3h (minutes):', '');
  L.push('| shift vs 3h | sub-intrinsic | parity median abs err |', '|---:|---:|---:|');
  for (const r of timeCheck.minutes) L.push(`| ${r.offsetMinutesFrom3h > 0 ? '+' : ''}${r.offsetMinutesFrom3h}m | ${r.subIntrinsic} | ${r.parityMedianAbsErr ?? '—'} |`);
  L.push('');
}
L.push('## Market data for later phases', '');
L.push('- **NDX daily** (settle source): data/sweeps/daily-bb-2026-10-15/daily-NDX.json (cached Schwab daily, 2022-06 on). Rounded to cents = official close; matches every E*TRADE cash-settle row.');
L.push('- **/NQ 1m**: ~/Downloads/Dataset_NQ_1min_2022_2025.csv (2022-12-26 .. 2025-12-11, label = bar END, ET). BACK-ADJUSTED continuous: sits ~700-840 pts over cash NDX in Apr-Jun 2025 (real carry is ~150-250), so only use it as NDX + basis(day). Per-day extracts (prior 18:00 .. 17:00 ET, t = bar start): data/manual-trades/market/nq-1m/<date>.json; per-day basis: data/manual-trades/market/basis.json (`node scripts/manual-trades/assemble-market.js`). Basis = NQ@16:00 − NDX close; the NQ@9:30 − NDX open cross-check differs by ~10-30 pt (single-print noise), so treat strike placement on the NQ chart as ±~10 pt.');
L.push('- The same NQ series (5m + multi-TF BB/9EMA analysis) is in tests/backtest/backtest-data-5m-combined (and -5m-nq) for these dates.');
L.push('- **NDX intraday (1m/5m) for Apr-Jun 2025: NONE.** Not on disk (NDX raw 1m starts 2026-07-06), and Schwab price history no longer serves it (probed 2026-10-15: 1m reaches back ~45 days, 5m/30m to ~2026-04; 2025-06 returns 0 bars for $NDX and /NQ).');
L.push('');
fs.writeFileSync(path.join(OUTDIR, 'summary.md'), L.join('\n'));
console.log(L.join('\n'));

function abbr(k) {
  return k.replace('vertical ', 'V-').replace('asymmetric butterfly', 'asymFly').replace('broken-wing butterfly', 'BWfly')
    .replace('butterfly', 'fly').replace('broken-wing condor', 'BWcondor');
}
function example(o) {
  const legs = o.legs.map(l => `${l.side === 'long' ? '+' : '-'}${l.qty} ${l.strike}${l.type[0].toUpperCase()}@${l.price}`).join(' ');
  return `#${o.orderNo} ${o.date} ${o.timeET} ET: ${legs} → ${o.netPerUnit > 0 ? 'debit' : 'credit'} ${Math.abs(o.netPerUnit)}${o.qty > 1 ? ` ×${o.qty}` : ''}${o.lean ? ` (${o.lean})` : ''}`;
}
