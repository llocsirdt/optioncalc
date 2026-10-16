'use strict';
// MANUAL-TRADES REVIEW ROUTE (2026-10-15) — the pure computation behind /api/v1/manual-trades: which orders build
// an expiry's book (carried-in first, non-0DTE excluded, time order), the cumulative book + payoff curve after
// each order, and its P&L at settle. Synthetic fixture (no account data); plus, when the private local data is
// present, every real day's final step must reconcile to the day's recorded net P&L.
//
// Run: node server/tests/unit/manual-trades-routes.test.js
const fs = require('fs');
const path = require('path');
const { helpers: H } = require('../../src/manual-trades/routes');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const near = (a, b, m, tol = 0.011) => ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`);

const leg = (type, strike, side, qty, price) => ({ type, strike, side, qty, price });
const order = (orderNo, date, timeET, expiry, legs, total, extra = {}) =>
  ({ orderNo, date, timeET, expiry, root: 'NDXP', legs, total, style: 'vertical', subtype: 'put debit', widths: [10], ...extra });

// carried in: bought 20000/19990 put debit (10 wide) for $500 on the prior day
const carried = order('c1', '2025-06-12', '15:00:00', '2025-06-13', [leg('put', 20000, 'long', 1), leg('put', 19990, 'short', 1)], -502);
// today, out of time order in the array: 10:00 call debit 20050/20060 for $400; 09:45 put CREDIT 19980/19970 x2 for +$300
const callDebit = order('t2', '2025-06-13', '10:00:00', '2025-06-13', [leg('call', 20050, 'long', 1), leg('call', 20060, 'short', 1)], -402, { subtype: 'call debit' });
const putCredit = order('t1', '2025-06-13', '09:45:00', '2025-06-13', [leg('put', 19980, 'short', 2), leg('put', 19970, 'long', 2)], 295, { subtype: 'put credit' });
const later = order('t3', '2025-06-13', '11:00:00', '2025-06-16', [leg('call', 20100, 'long', 1), leg('call', 20110, 'short', 1)], -300);
const day = { date: '2025-06-13', settle: 20055, carriedIn: ['c1'], orders: [callDebit, putCredit, later] };
const byNo = new Map([carried, callDebit, putCredit, later].map(o => [o.orderNo, o]));

// ── bookOrders ──
const seq = H.bookOrders(day, byNo);
ok(seq.map(s => s.order.orderNo).join() === 'c1,t1,t2', `book order sequence carried-first then by time: ${seq.map(s => s.order.orderNo)}`);
ok(seq[0].carried === true && seq[1].carried === false, 'carried flag');
ok(!seq.some(s => s.order.orderNo === 't3'), 'non-0DTE order excluded from this book');

// ── orderLegs: side gives the sign, qty is total contracts ──
const L = H.orderLegs(putCredit);
ok(L.find(l => l.strike === 19980).qty === -2 && L.find(l => l.strike === 19970).qty === 2, 'signed legs');
ok(L.every(l => l.right === 'P' && l.root === 'NDXP'), 'right/root mapped');

// ── payoffCurve: exact breakpoints, endpoints + interior strikes only ──
const c = H.payoffCurve(H.orderLegs(callDebit), -402, 20000, 20100);
ok(c.points.map(p => p.x).join() === '20000,20050,20060,20100', `curve x breakpoints: ${c.points.map(p => p.x)}`);
near(c.points[0].y, -402, 'call debit below long strike');
near(c.points[3].y, 598, 'call debit above short strike (+1000 - 402)');
ok(c.min === -402 && c.max === 598, 'curve min/max');

// ── priceRange: padded, rounded to 10s, includes settle + extras ──
const pr = H.priceRange(H.orderLegs(callDebit), 20200, [19900]);
ok(pr.xMin <= 19900 - 50 && pr.xMax >= 20200 + 50 && pr.xMin % 10 === 0 && pr.xMax % 10 === 0, `priceRange ${JSON.stringify(pr)}`);

// ── cumulativeSteps ──
const steps = H.cumulativeSteps(seq, 19900, 20200, day.settle);
ok(steps.length === 3, 'one step per in-book order');
near(steps[0].cash, -502, 'step0 cash');
near(steps[2].cash, -502 + 295 - 402, 'final cash = Σ totals');
// step 0 at settle 20055: put debit 20000/19990 expires worthless -> -502
near(steps[0].atSettle, -502, 'step0 at settle');
// final at 20055: puts OTM (0), call 20050/20060 worth 5 pts = $500 -> -609 + 500 = -109
near(steps[2].atSettle, -109, 'final at settle');
// final at 19975: put debit 20000/19990 = $1000; put credit 19980/19970 x2 short 5 pts = -$1000; calls 0 -> -609
const at = (st, S) => { const p = st.curve.points; for (let i = 1; i < p.length; i++) if (S <= p[i].x) return p[i - 1].y + (p[i].y - p[i - 1].y) * (S - p[i - 1].x) / (p[i].x - p[i - 1].x); return p[p.length - 1].y; };
near(at(steps[2], 19975), -609, 'final curve interpolated at 19975');
ok(steps[2].legs.length === 6, `final netted legs: ${steps[2].legs.length}`);
ok(steps.every(s => s.curve.xMin === 19900 && s.curve.xMax === 20200), 'all steps share the window');
// netting: buy back the call spread -> legs cancel
const closeCall = order('t4', '2025-06-13', '12:00:00', '2025-06-13', [leg('call', 20050, 'short', 1), leg('call', 20060, 'long', 1)], 450);
const st2 = H.cumulativeSteps([...seq, { order: closeCall }], 19900, 20200, day.settle);
ok(!st2[3].legs.some(l => l.right === 'C'), 'closing order nets the call legs to zero');

// ── etToMs: DST-correct ET ──
ok(H.etToMs('2025-06-13', '09:30') === Date.parse('2025-06-13T13:30:00Z'), 'EDT 09:30 -> 13:30Z');
ok(H.etToMs('2025-01-13', '09:30:15') === Date.parse('2025-01-13T14:30:15Z'), 'EST 09:30:15 -> 14:30:15Z');

// ── tfSeries: 60m uses warmup so bands exist from the first session bar; warmup not returned ──
const t0 = Date.parse('2025-06-12T22:00:00Z');
const bars = Array.from({ length: 180 }, (_, i) => ({ t: t0 + i * 60e3, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1 }));
const warm = Array.from({ length: 25 }, (_, i) => ({ t: t0 - (25 - i) * 3600e3, o: 90, h: 91, l: 89, c: 90 + i * 0.1, v: 1 }));
const s60 = H.tfSeries(bars, '60m', warm);
ok(s60.length === 3 && s60[0].t === t0, `60m series starts at session: ${s60.length}`);
ok(s60[0].bbU != null && s60[0].ema9 != null, '60m bands warm at the first session bar');
const s5 = H.tfSeries(bars, '5m');
ok(s5.length === 36 && s5[18].bbU == null && s5[19].bbU != null, '5m BB warms at bar 20');
ok(H.nqAt(bars, t0 + 90e3 + 5) === bars[1].c && H.nqAt(bars, t0 - 1) === null, 'nqAt picks the bar containing ms');

// ── real data (local only): every day's final cumulative step reconciles to the recorded net ──
const T = path.join(__dirname, '..', '..', '..', 'data', 'manual-trades', 'trades.json');
if (fs.existsSync(T)) {
  const data = JSON.parse(fs.readFileSync(T, 'utf8'));
  const all = new Map(); data.days.forEach(d => d.orders.forEach(o => all.set(o.orderNo, o)));
  let n = 0;
  for (const d of data.days) {
    const sq = H.bookOrders(d, all);
    const st = H.cumulativeSteps(sq, d.settle - 500, d.settle + 500, d.settle);
    const amLegs = d.amSettle && st[st.length - 1].legs.some(l => l.root === 'NDX');
    if (amLegs) continue;                       // AM-settled NDX legs settle at amSettle, not the close
    near(st[st.length - 1].atSettle, d.pnl.net, `${d.date} final step vs pnl.net`, 0.05);
    n++;
  }
  ok(n > 40, `reconciled ${n} real days`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
