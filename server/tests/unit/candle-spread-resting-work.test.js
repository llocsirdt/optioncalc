'use strict';
// SUB-BAR RESTING WORK. The candle tick prices an open from a chain snapshot and tests it against that
// same snapshot, so it can only ever say "fillable". The live worker re-reads the chain BETWEEN candles,
// which is the only way a resting open or cover gets a real answer. These cover the piece that matters:
// trader.resolvePendingOpen against a chain that has moved.
//
// Run: node server/tests/unit/candle-spread-resting-work.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rw-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const round2 = (n) => Math.round(n * 100) / 100;

const cfg = { symbol: 'NDX', expiration: '2026-08-30', spreadWidth: 20, strikeIncrement: 10, quantity: 1,
  tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', variant: 'rw' };
// A bull call spread 21990/22010, priced so the SPREAD mark is exactly `m`. Moving both legs by the same
// amount would leave the spread unchanged (long - short cancels it), which is why this tilts the chain
// around the short strike — the first version of this fixture made that mistake and every "market moved"
// case silently tested a stationary mark.
//
// It quotes the whole chain, not just the two strikes in the spread, because the engine now checks a
// leg against its NEIGHBOURS: a call mid may not rise as the strike rises, nor a put mid fall. The
// previous version answered 2 for every strike but 21990, so 21990 sat $m above the strike below it —
// free money, and the gate (rightly) refused to fill against it. Interpolating linearly across the
// chain gives the same spread mark with a shape the no-arbitrage condition actually admits.
const legAt = (m) => (type, strike) => {
  const away = (type === 'C' ? 22010 - strike : strike - 21990) / 20;
  const mid = Math.round((2 + m * away) * 100) / 100;
  return { mid, symbol: `NDX_${type}${strike}`, bid: mid - 0.2, ask: mid + 0.2 };
};
const legs = [{ side: 'long', type: 'C', strike: 21990 }, { side: 'short', type: 'C', strike: 22010 }];
function restingOpen(limit) {
  const st = { positions: [], pendingOpenId: 'p1', lastUnderlying: 22000 };
  st.positions.push({ id: 'p1', side: 'bull', legs, quantity: 1, limit, cap: 13, filled: false,
    orderStatus: 'working', openTime: '08/30 10:00', covered: false, pendingCover: null });
  return st;
}

// 1) The market comes to the order -> it fills, at the limit that was working.
{
  const st = restingOpen(10.20), d = [];
  trader.resolvePendingOpen(st, cfg, { getLeg: legAt(10.00), coverLadder: false }, d);   // mark 10.00
  const p = st.positions[0];
  ok(p.filled === true, 'mark at/through the limit fills the resting open');
  ok(st.pendingOpenId === null, 'pendingOpenId cleared on fill');
  ok(d.some(x => x.action === 'open-fill' && x.mark === 10), 'logs open-fill with the mark it saw');
}
// 2) The market runs AWAY -> no fill. This is the case the candle tick can never produce.
{
  const st = restingOpen(10.20), d = [];
  trader.resolvePendingOpen(st, cfg, { getLeg: legAt(10.60), coverLadder: false }, d);  // mark 10.60
  ok(st.positions[0].filled === false, 'a mark above the limit does not fill');
  ok(st.pendingOpenId === 'p1', 'the order keeps working');
  ok(!d.some(x => x.action === 'open-fill'), 'no fill logged');
}
// 3) With the ladder on, the limit walks toward the market — never past it, never past the ceiling.
{
  const st = restingOpen(10.20), d = [];
  const deps = { getLeg: legAt(10.60), coverLadder: true, ladderStepDollars: 0.25 };
  trader.resolvePendingOpen(st, cfg, deps, d);
  ok(st.positions[0].limit === 10.45, `ladder steps 10.20 -> 10.45 (got ${st.positions[0].limit})`);
  ok(d.some(x => x.action === 'open-reprice' && x.to === 10.45), 'logs open-reprice');
  // a second pass reaches the mark and stops there rather than paying through it
  const d2 = [];
  trader.resolvePendingOpen(st, cfg, deps, d2);
  ok(st.positions[0].limit === 10.6, `second step stops AT the mark 10.60 (got ${st.positions[0].limit})`);
  const d3 = [];
  trader.resolvePendingOpen(st, cfg, deps, d3);
  ok(st.positions[0].filled === true, 'once the limit reaches the mark it fills');
}
// 4) The 65% ceiling still binds a working order.
{
  const st = restingOpen(12.95), d = [];
  trader.resolvePendingOpen(st, cfg, { getLeg: legAt(13.50), coverLadder: true, ladderStepDollars: 0.25 }, d);
  ok(st.positions[0].limit <= 13, `ladder never walks past the ceiling (got ${st.positions[0].limit})`);
  ok(d.some(x => x.action === 'open-reprice' || x.action === 'open-rest'), 'ceiling case is logged');
}
// 5) Unquotable legs: no fill, no crash, no phantom position.
{
  const st = restingOpen(10.20), d = [];
  trader.resolvePendingOpen(st, cfg, { getLeg: () => null, coverLadder: true }, d);
  ok(st.positions[0].filled === false, 'an unquotable spread does not fill');
  ok(st.positions[0].limit === 10.20, 'and its limit is not walked on a price we cannot see');
}

// ---- PENDING HEDGES: offsets, wings and flies work like covers now -------------------------------
// Each was previously booked the instant it was priced, against the very marks that priced it — an
// offset from those mids, a wing or fly from the ASK while the test read the MID. None could be refused.
const hLegs = [{ side: 'long', type: 'C', strike: 29100 }, { side: 'short', type: 'C', strike: 29140 }];
// Interpolated across the chain rather than tilting one strike, for the no-arbitrage reason given at legAt.
const hLegAt = (m) => (type, strike) => {
  const away = (type === 'C' ? 29140 - strike : strike - 29100) / 40;
  const mid = Math.round((2 + m * away) * 100) / 100;
  return { mid, symbol: `NDX_${type}${strike}`, bid: mid - 0.2, ask: mid + 0.2 };
};
const pendingHedge = (kind, limit, placedEpoch) => ({ positions: [{
  id: kind + '-1', side: kind === 'offset' ? 'hedge' : kind, legs: hLegs, quantity: 1, limit,
  filled: false, hedge: true, covered: false, pendingCover: null,
  pendingHedge: { limit, kind, markAtPlace: limit, placedEpoch } }] });

{ // the market comes to it -> books, and the SPEND is counted here rather than at placement
  const st = pendingHedge('wing', 1.20, 1000), d = [];
  trader.resolvePendingHedges(st, cfg, { getLeg: hLegAt(1.00), nowMs: 1000 }, d);
  const p = st.positions[0];
  ok(p.filled === true, 'a hedge fills when a later mark reaches its limit');
  ok(p.pendingHedge === null, 'pendingHedge cleared on fill');
  ok(st.wingSpent > 0 && st.wingCount === 1, `spend counted at the FILL (got ${st.wingSpent})`);
  ok(d.some(x => x.action === 'wing-fill' && x.markLow != null), 'logs wing-fill with the low-water mark');
}
{ // the market stays away -> keeps working, nothing booked, no budget consumed
  const st = pendingHedge('fly', 1.20, 1000), d = [];
  trader.resolvePendingHedges(st, cfg, { getLeg: hLegAt(2.00), nowMs: 1000 }, d);
  ok(st.positions[0].filled === false, 'a hedge does NOT book while the mark is above its limit');
  ok(st.positions[0].pendingHedge != null, 'it keeps working');
  ok(!st.flySpent, 'no budget consumed by an unfilled hedge');
  ok(st.positions[0].markLow === 2, `low-water mark recorded even without a fill (got ${st.positions[0].markLow})`);
}
{ // stale: a hedge chosen for a curve shape that is long gone must not fill an hour later
  const st = pendingHedge('offset', 1.20, 0), d = [];
  trader.resolvePendingHedges(st, cfg, { getLeg: hLegAt(2.00), nowMs: 11 * 60 * 1000 }, d);
  ok(st.positions.length === 0, 'an unfilled hedge is dropped once it goes stale');
  ok(d.some(x => x.action === 'offset-expire'), 'and the expiry is logged, not silent');
}
{ // an expired hedge must not be counted as held
  const st = pendingHedge('offset', 1.20, 0), d = [];
  trader.resolvePendingHedges(st, cfg, { getLeg: hLegAt(2.00), nowMs: 11 * 60 * 1000 }, d);
  ok(!st.positions.some(p => p.hedge), 'no phantom hedge left in the book');
}


// ---- THE QUOTE UNDER THE LOW ---------------------------------------------------------------------
// A mid can fall because the market traded down, or because the BID collapsed while the ask never moved.
// Both drag markLow to the same number; only the first was ever tradeable. Recording bid/ask at the
// instant of the low is what tells them apart.
{
  const qLegs = [{ side: 'long', type: 'C', strike: 100 }, { side: 'short', type: 'C', strike: 110 }];
  const qCfg = { spreadWidth: 10, tickIncrement: 0.05, quantity: 1 };
  const book = (lMid, lBid, lAsk) => (ty, k) => k === 100
    ? { mid: lMid, bid: lBid, ask: lAsk, symbol: 'L' } : { mid: 2, bid: 1.95, ask: 2.05, symbol: 'S' };
  const pend = (limit) => ({ positions: [{ id: 'h1', side: 'wing', legs: qLegs, quantity: 1, limit,
    filled: false, hedge: true, covered: false, pendingCover: null,
    pendingHedge: { limit, kind: 'wing', placedEpoch: 1000 } }] });

  const tight = pend(4.00);
  trader.resolvePendingHedges(tight, qCfg, { getLeg: book(6, 5.95, 6.05), nowMs: 1000 }, []);
  const t1 = tight.positions[0];
  ok(t1.markLow === 4 && t1.markLowSpread === 0.2, `tight book records a 0.20 spread (got ${t1.markLowSpread})`);
  ok(t1.markLowAsk === 4.1, 'and the ask it would really have paid');

  const collapsed = pend(4.00);
  trader.resolvePendingHedges(collapsed, qCfg, { getLeg: book(5, 3.00, 6.05), nowMs: 1000 }, []);
  const c1 = collapsed.positions[0];
  ok(c1.markLow === 3, 'a collapsed bid drags the mid DOWN, so markLow alone looks better');
  ok(c1.markLowSpread === 3.15, `but the recorded spread exposes it (got ${c1.markLowSpread})`);
  ok(c1.markLowAsk === 4.1 && c1.markLowAsk > 4.00,
    'and the ask shows buying it still cost MORE than the limit — the low was never tradeable');
  ok(c1.markLowSpread > (4.00 - c1.markLow),
    'spread wider than the distance through: the condition the debug table flags');
}


// ---- OPEN LADDER IS ITS OWN FLAG -----------------------------------------------------------------
// It was gated on coverLadder, so working an OPEN toward the market went live on 74 variants bundled
// into a flag whose evidence (+5 to +16 fill points over 765 days) came entirely from COVERS. Separate
// flag, same default, so it can be isolated and measured without changing anything today.
{
  const base = { getLeg: legAt(10.60), ladderStepDollars: 0.25 };
  const stepTo = (deps) => { const st = restingOpen(10.20), d = [];
    trader.resolvePendingOpen(st, cfg, deps, d); return st.positions[0].limit; };
  ok(stepTo({ ...base, coverLadder: true }) === 10.45, 'unset openLadder follows coverLadder (today unchanged)');
  ok(stepTo({ ...base, coverLadder: true, openLadder: false }) === 10.20, 'openLadder:false opts an open OUT while covers keep laddering');
  ok(stepTo({ ...base, coverLadder: false, openLadder: true }) === 10.45, 'openLadder:true works with the cover ladder OFF');
  // A bigger step is still bounded by the MARK: min(limit + step, ceiling, mark). 10.20 + 0.50 would be
  // 10.70, but the market is at 10.60 and the ladder never pays through it — so this asserts the
  // override is live AND that the bound survives it, which is the pair that matters.
  ok(stepTo({ ...base, coverLadder: true, openLadderStepDollars: 0.50 }) === 10.6,
    'a bigger open step walks further but still stops AT the mark, never through it');
  ok(stepTo({ ...base, coverLadder: true, openLadderStepDollars: 0.10 }) === 10.3,
    'and a smaller one concedes less per step than the cover default');
}


// ---- DWELL: how OFTEN the price was there, not just how low it went ------------------------------
// markLow alone cannot separate a graze from a sit. These count every observation and how many of them
// had the mark at or through the price sent.
{
  const st = pendingHedge('wing', 1.20, 1000);
  const deps = (m) => ({ getLeg: hLegAt(m), nowMs: 1000 });
  trader.resolvePendingHedges(st, cfg, deps(2.00), []);   // away
  trader.resolvePendingHedges(st, cfg, deps(1.80), []);   // away
  trader.resolvePendingHedges(st, cfg, deps(1.50), []);   // away, new low
  const p = st.positions[0];
  ok(p.looks === 3, `counts every observation (got ${p.looks})`);
  ok(!p.atOrThrough, 'none of them reached the limit, so nothing counts as through');
  ok(p.markLow === 1.5, 'and the low still tracks the best seen');
  trader.resolvePendingHedges(st, cfg, deps(1.00), []);   // reaches it -> fills
  ok(p.filled === true && p.atOrThrough === 1, 'the observation that fills is counted as through');
}
{ // a graze and a sit produce the same markLow — only the counters tell them apart
  const graze = pendingHedge('fly', 1.20, 1000), sit = pendingHedge('fly', 1.20, 1000);
  for (const m of [2.0, 2.0, 2.0, 2.0]) trader.resolvePendingHedges(graze, cfg, { getLeg: hLegAt(m), nowMs: 1000 }, []);
  for (const m of [1.1, 1.1, 1.1, 1.1]) trader.resolvePendingHedges(sit, cfg, { getLeg: hLegAt(m), nowMs: 1000 }, []);
  const g = graze.positions[0], si = sit.positions[0];
  ok(g.looks === 4 && !g.atOrThrough, `never reached: 0 of ${g.looks}`);
  ok(si.atOrThrough >= 1, 'sat at the price: counted through on the first look, then filled');
}


// ---- THE LOOP MUST TERMINATE ---------------------------------------------------------------------
// 2026-09-16: making hedges REST killed every exit of the floor-offset loop at once. offCount/offSpent
// stopped advancing (they now move on the FILL), and a pending hedge is filled:false so it is filtered
// out of the book the floor is computed from -- meaning the floor the loop tries to repair never moves
// either. It pushed a position per iteration for hours, logging the same offset once a second, until the
// instance stopped answering. These assert the guards count WORKING orders, not just filled ones.
{
  const legs = [{ side: 'long', type: 'P', strike: 28950 }, { side: 'short', type: 'P', strike: 28930 }];
  const mk = (n) => {
    const st = { positions: [], offCount: 0, offSpent: 0, wingCount: 0, wingSpent: 0, flyCount: 0, flySpent: 0 };
    for (let i = 0; i < n; i++) st.positions.push({ id: 'off-' + i, side: 'hedge', legs, quantity: 1,
      limit: 1.65, filled: false, hedge: true, pendingHedge: { limit: 1.65, kind: 'offset', placedEpoch: 1 } });
    return st;
  };
  // the accounting the guards depend on
  const p3 = trader.pendingHedges(mk(3), 'offset', 1);
  ok(p3.n === 3, `counts working offsets (got ${p3.n})`);
  ok(Math.round(p3.spent) === 495, `and their committed spend, 3 x $165 (got ${p3.spent})`);
  ok(trader.pendingHedges(mk(3), 'wing', 1).n === 0, 'counts only the kind asked for');
  ok(trader.pendingHedges(mk(0), 'offset', 1).n === 0, 'and zero when nothing is working');
}


// ---- WORKING A CREDIT COVER -----------------------------------------------------------------------
// "there's no difference between a debit order and a credit order, we're only using credit to recapture
// capital, the risk is the same, the reward is the same, we want to walk every order, open or cover, debit
// or credit ... debits our price goes up, we're willing to pay more for the fill, credits the price goes
// down, we're accepting less to get the fill" (user, 2026-09-18).
//
// workRestingCovers used to `continue` on any credit cover, so 23 of 174 resting covers on 2026-09-17 and
// 150 of 406 on 09-16 were never worked once between placement and the close.
(async () => {
  const W = 20, cCfg = { ...cfg, spreadWidth: W };
  const bookLegs = legs;                                     // debit-canonical booking: long C21990 / short C22010
  const twinLegs = [{ side: 'short', type: 'P', strike: 21990 }, { side: 'long', type: 'P', strike: 22010 }];
  // target 4.25 with a 12.95 ask is DELIBERATELY not a parity pair (W - 4.25 = 15.75): it is the real shape
  // seen in the store, where the twin is priced off the SENT legs and the booked target off the cover
  // geometry. A ladder that re-derived the credit would jump it 2.80 on the first step.
  const mkPos = (over = {}, pcOver = {}) => ({ id: 'p1', side: 'bull', filled: true, covered: false,
    quantity: 1, limit: 6.0, shortStrike: 22010, ...over,
    pendingCover: { legs: bookLegs, target: 4.25, openCost: 6.0, minLock: 0, placedEpoch: 1,
      placedUnder: 22000, orderId: 'ord-1', sentNet: 'CREDIT', sentCredit: 12.95, sentLegs: twinLegs, ...pcOver } });

  const work = async (pos, m = 18) => {
    const sent = [];
    await trader.workRestingCovers({ positions: [pos] }, cCfg,
      (pos._d = []), { getLeg: legAt(m), coverLadder: true, ladderStepDollars: 0.25, underlying: 22000,
        replaceOrder: async (id, payload, meta) => { sent.push({ payload, meta }); return { orderId: id }; } }, 22000);
    return { d: pos._d, sent, pc: pos.pendingCover };
  };

  const cre = await work(mkPos());
  const rep = cre.d.find(x => x.action === 'cover-reprice');
  ok(!!rep, 'a CREDIT cover is worked at all — the regression this whole block exists for');
  ok(rep && rep.to > rep.from, `the booked debit target walks UP (${rep && rep.from} -> ${rep && rep.to})`);
  ok(rep && rep.sentTo < rep.sentFrom, `and the credit actually asked walks DOWN (${rep && rep.sentFrom} -> ${rep && rep.sentTo})`);
  ok(rep && Math.abs((rep.to - rep.from) - (rep.sentFrom - rep.sentTo)) < 0.001,
    `the credit concedes exactly what the debit ladder conceded (${rep && round2(rep.to - rep.from)} vs ${rep && round2(rep.sentFrom - rep.sentTo)})`);
  ok(cre.pc.sentCredit === (rep && rep.sentTo), 'and the walked price is what now rests on the record');
  ok(Math.abs(cre.pc.sentCredit - (W - cre.pc.target)) > 0.5,
    `NOT re-derived as W - target (${cre.pc.sentCredit} vs ${round2(W - cre.pc.target)}) — that matched on 0 of 173 real covers`);

  // The replace has to reach the broker as the order that is actually resting: the TWIN, priced as a credit.
  ok(cre.sent.length === 1, 'the working order is replaced, once');
  ok(cre.sent[0] && cre.sent[0].payload.orderType === 'NET_CREDIT', 'replaced as a NET_CREDIT order, not a debit');
  ok(cre.sent[0] && cre.sent[0].payload.price === cre.pc.sentCredit, 'at the conceded credit');
  ok(cre.sent[0] && cre.sent[0].meta.legs === twinLegs, 'on the SENT legs (the twin), never the booked debit legs');

  // A debit cover must be untouched by all of this.
  const deb = await work(mkPos({}, { sentNet: 'DEBIT', sentCredit: null, sentLegs: bookLegs }));
  const dRep = deb.d.find(x => x.action === 'cover-reprice');
  ok(!!dRep && dRep.to > dRep.from, 'a DEBIT cover still walks its own limit up');
  ok(dRep && dRep.sentTo === undefined, 'and reports no credit side');
  ok(deb.sent[0] && deb.sent[0].payload.orderType === 'NET_DEBIT', 'replaced as a NET_DEBIT order');
  ok(deb.sent[0] && deb.sent[0].payload.price === deb.pc.target, 'at the laddered debit target');

  // Conceding past zero is not a cheaper order, it is a nonsensical one.
  const tiny = await work(mkPos({}, { sentCredit: 0.10 }));
  ok(tiny.pc.sentCredit >= cCfg.tickIncrement - 1e-9 && tiny.pc.sentCredit > 0,
    `the credit floors at a tick rather than going through zero (got ${tiny.pc.sentCredit})`);

  // A SENT PRICE MUST BE A CLEAN CENT. roundToTick multiplies back out in binary floating point, so 24
  // ticks came back as 12.950000000000001; the fill test compares that against a round2'd market credit,
  // so a market offering exactly 12.95 was refused. 47 of 173 real resting credit covers (27%) carried
  // the hair, always high, so it could only ever cost a fill.
  for (const seed of [12.95, 19.45, 8.15, 3.35, 1.20]) {
    const t = await work(mkPos({}, { sentCredit: seed }));
    const c = t.pc.sentCredit;
    ok(c === Math.round(c * 100) / 100, `a walked credit is an exact cent, not ${c} (from ${seed})`);
  }

  // THE POINT OF ALL OF IT: the conceded price is the price that fills.
  const p2 = mkPos();
  await work(p2);
  const asked = p2.pendingCover.sentCredit;
  // Offer exactly the conceded credit and not a cent more: mark = W - asked on the booked legs.
  const d2 = [];
  trader.resolveRestingCovers({ positions: [p2], realizedPnl: 0 }, cCfg, legAt(round2(W - asked)), d2, {});
  ok(p2.covered === true, `the cover fills at the price it was walked to (asked ${asked})`);
  ok(d2.some(x => x.action === 'cover-fill'), 'and books as a fill');

  // The same order at its ORIGINAL ask would not have filled on that quote — which is what the walk bought.
  const p3 = mkPos();
  const d3 = [];
  trader.resolveRestingCovers({ positions: [p3], realizedPnl: 0 }, cCfg, legAt(round2(W - asked)), d3, {});
  ok(p3.covered === false, 'while the un-walked order at 12.95 would still be resting on the same quote');

  // ---- THE CASH LEDGER BOOKS AT THE FILL, FOR EVERY ORDER TYPE -------------------------------------
  // Opens used to book at PLACEMENT, so an order that never filled and was cancelled next candle left its
  // cash behind forever; hedges never booked at all. Measured on 4 prod days x 80 variants: $147,665 of
  // real hedge debit the ledger never saw, on 354 filled hedges across 144 of 320 runs. /status reports
  // this field as deployed capital, so it has to mean what it says.
  {
    const cCfg = { ...cfg, spreadWidth: 20 };
    // an OPEN that does not fill books nothing
    const noFill = restingOpen(1.00);                      // limit 1.00 against a mark of 10.60
    noFill.cashDeployed = 0;
    trader.resolvePendingOpen(noFill, cCfg, { getLeg: legAt(10.60), coverLadder: false }, []);
    ok(noFill.positions[0].filled === false, 'setup: the open did not fill');
    ok(!noFill.cashDeployed, `an unfilled open books NO cash (got ${noFill.cashDeployed})`);

    // the same open, once it fills, books the debit it paid
    const filled = restingOpen(10.80);
    filled.cashDeployed = 0;
    trader.resolvePendingOpen(filled, cCfg, { getLeg: legAt(10.60), coverLadder: false }, []);
    const p = filled.positions[0];
    ok(p.filled === true, 'setup: the open filled');
    ok(filled.cashDeployed === Math.round(p.limit * 100 * 100) / 100,
      `a filled DEBIT open books +${p.limit * 100} (got ${filled.cashDeployed})`);
    ok(filled.peakCashDeployed === filled.cashDeployed, 'and the peak moves with it');

    // a CREDIT open RECEIVES cash, so the ledger goes negative
    const cred = restingOpen(10.80);
    cred.cashDeployed = 0;
    const cp = cred.positions[0];
    cp.sentNet = 'CREDIT'; cp.sentLimit = 9.20;
    // The credit twin of a LONG call spread K1/K2 is the bull PUT spread: long K1 put, short K2 put.
    // Reversed, it prices as a debit and never fills — spreadQuote signs long +, short -, so the twin
    // must mark NEGATIVE for `credit = -mark` to be the credit received.
    cp.sentLegs = [{ side: 'long', type: 'P', strike: 21990 }, { side: 'short', type: 'P', strike: 22010 }];
    trader.resolvePendingOpen(cred, cCfg, { getLeg: legAt(10.60), coverLadder: false }, []);
    ok(cred.positions[0].filled === true, 'setup: the credit twin filled');
    ok(cred.cashDeployed === -920, `a filled CREDIT open RECLAIMS cash (got ${cred.cashDeployed})`);

    // a HEDGE pays a real debit and the ledger must see it
    const hst = pendingHedge('wing', 1.20, 1000);
    hst.cashDeployed = 0;
    trader.resolvePendingHedges(hst, cCfg, { getLeg: hLegAt(1.00), nowMs: 1000 }, []);
    const h = hst.positions[0];
    ok(h.filled === true, 'setup: the hedge filled');
    ok(hst.cashDeployed === Math.round(h.limit * 100 * 100) / 100,
      `a filled hedge books its debit (got ${hst.cashDeployed}, paid ${h.limit})`);
    ok(hst.wingSpent === hst.cashDeployed, 'and agrees with the wing budget, which already counted at the fill');

    // an unfilled hedge books nothing
    const hno = pendingHedge('fly', 1.20, 1000);
    hno.cashDeployed = 0;
    trader.resolvePendingHedges(hno, cCfg, { getLeg: hLegAt(2.00), nowMs: 1000 }, []);
    ok(hno.positions[0].filled === false && !hno.cashDeployed,
      `an unfilled hedge books NO cash (got ${hno.cashDeployed})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL: threw ->', e && e.message); process.exit(1); });
