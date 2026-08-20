/**
 * Candle-spread trader engine.
 *
 * On each 15-min candle close during RTH it runs the per-tick sequence:
 *   (1) cancel any unfilled prior OPEN order
 *   (2) classify the candle
 *   (3) COVER uncovered spreads if the candle's simple direction reversed
 *   (4) OPEN a new centered spread if the candle strictly qualifies
 * See spread-logic.js for the pure pieces and the project spec for the "why".
 *
 * SAFETY: order placement is INTERNAL (never via the dev-gated HTTP proxy) and is
 * gated by config.dryRun. While dryRun is true we build + log the full Schwab order
 * payload but DO NOT send it, and we assume the order fills at its limit so the day's
 * state machine and log play out and can be reviewed. Flipping real sending on is a
 * deliberate future step (see placeOrder()).
 */
const L = require('./spread-logic');
const store = require('./store');

let nextPositionSeq = 1;
function nextId(prefix) { return `${prefix}-${Date.now()}-${nextPositionSeq++}`; }

// --- Chain quote accessor --------------------------------------------------
// Returns { mid, symbol, bid, ask } for an option leg from a Schwab {call,put} chain,
// or null if not present. mid uses Schwab's `mark` (its mid/mark), matching the rest of
// the app. The exact contract `symbol` is read from the chain so we never hand-build
// OCC symbols.
function makeLegAccessor(chainData, expiration) {
  return function getLeg(type, strike) {
    if (!chainData) return null;
    const map = type === 'C' ? chainData.call : chainData.put;
    if (!map) return null;
    const expKey = Object.keys(map).find(k => k.startsWith(expiration));
    if (!expKey) return null;
    const strikeMap = map[expKey];
    const strikeKey = Object.keys(strikeMap).find(k => parseFloat(k) === strike);
    if (!strikeKey) return null;
    const c = strikeMap[strikeKey][0];
    if (!c) return null;
    const mid = c.mark != null ? c.mark : (c.bid != null && c.ask != null ? (c.bid + c.ask) / 2 : null);
    return mid == null ? null : { mid, symbol: c.symbol, bid: c.bid, ask: c.ask };
  };
}

// --- Order payload (Schwab shape) -----------------------------------------
function buildOrderPayload(resolvedLegs, limit, quantity, net /* 'DEBIT'|'CREDIT' */) {
  return {
    orderType: net === 'CREDIT' ? 'NET_CREDIT' : 'NET_DEBIT',
    session: 'NORMAL',
    price: limit,
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    complexOrderStrategyType: 'VERTICAL',
    orderLegCollection: resolvedLegs.map(l => ({
      instruction: l.side === 'long' ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN',
      quantity,
      instrument: { symbol: l.symbol, assetType: 'OPTION' }
    }))
  };
}

// Resolve abstract legs ({side,type,strike}) to order legs with chain symbols + mids.
// Returns { resolved, longMid, shortMid } or { error }.
function resolveLegs(legs, getLeg) {
  const resolved = [];
  let longMid = null, shortMid = null;
  for (const leg of legs) {
    const q = getLeg(leg.type, leg.strike);
    if (!q || !q.symbol) return { error: `no chain quote/symbol for ${leg.type}${leg.strike}` };
    resolved.push({ ...leg, symbol: q.symbol, mid: q.mid });
    if (leg.side === 'long') longMid = q.mid; else shortMid = q.mid;
  }
  return { resolved, longMid, shortMid };
}

// --- Core per-tick sequence (testable) ------------------------------------
// deps: { getLeg(type,strike), placeOrder(payload, meta)->{status,filled}, dryRun }
function processCandleClose(record, candle, priorCandle, deps) {
  const cfg = record.config;
  const st = record.state;
  const decisions = [];

  const candleTime = candle.timeEST || String(candle.datetime);
  // De-dupe: never act twice on the same candle.
  if (st.lastCandleTime === candleTime) return { skipped: 'already-processed' };
  st.lastCandleTime = candleTime;

  const firstOfDay = !priorCandle;
  const bands = firstOfDay ? bandsFor(candle) : null;
  const priorBands = priorCandle ? bandsFor(priorCandle) : null; // for the cover over-extension override
  const simpleDir = L.simpleDirection(candle);
  const openSide = L.classifyOpen(candle, priorCandle, bands);

  // (1) Cancel any unfilled prior OPEN order before doing anything else.
  if (st.pendingOpenId) {
    const pos = st.positions.find(p => p.id === st.pendingOpenId);
    if (pos && !pos.filled) {
      deps.placeOrder && null; // (cancel path is internal; dry-run just logs)
      pos.orderStatus = 'cancelled';
      decisions.push({ action: 'cancel-open', positionId: pos.id, reason: 'unfilled at next candle' });
      // Remove the never-filled position from the working list.
      st.positions = st.positions.filter(p => p.id !== pos.id);
    }
    st.pendingOpenId = null;
  }

  // Cover evaluation + context (logged so run analysis can show WHY we covered or held:
  // whether the reversal candle broke the prior extreme, and whether the Bollinger override
  // fired). Only meaningful while we hold a position.
  const coverSignal = L.shouldCover(st.direction, candle, priorCandle, priorBands);
  const coverContext = st.direction === 'none' ? null : {
    heldDirection: st.direction,
    reversalDir: simpleDir,
    prior: priorCandle ? { high: priorCandle.high, low: priorCandle.low, close: priorCandle.close } : null,
    priorBands: priorBands ? { upper: priorBands.upper, lower: priorBands.lower } : null,
    brokeNewHigh: priorCandle ? candle.high > priorCandle.high : null,
    brokeNewLow: priorCandle ? candle.low < priorCandle.low : null,
    bbOverride: !!(priorCandle && priorBands && (
      (st.direction === 'bull' && priorBands.upper != null && priorCandle.close > priorBands.upper) ||
      (st.direction === 'bear' && priorBands.lower != null && priorCandle.close < priorBands.lower)
    )),
    covered: coverSignal
  };

  // (3) COVER — only on a CONFIRMED reversal (see spread-logic.shouldCover): a candle
  // closing opposite our held direction that FAILED to extend the prior candle's extreme
  // (or where the prior trend candle closed outside its Bollinger band). Covers every
  // filled, uncovered spread 1:1. Can happen in the same candle that also opens (step 4).
  //
  // WHICH cover geometry is chosen is delegated to a pluggable selector (cfg.coverSelector:
  // 'fixed' = current tent | 'greedy' = best per-position candidate | 'joint' = basket
  // optimization). This is the seam the 3 shadow variants differ on; everything else is shared.
  if (coverSignal) {
    const uncovered = st.positions.filter(p => p.filled && !p.covered);
    const plans = selectCovers(uncovered, cfg, deps.getLeg, { underlying: candle.close, reversedDir: simpleDir, bbOverride: !!(coverContext && coverContext.bbOverride) });
    for (const plan of plans) {
      if (plan.error) { decisions.push({ action: 'cover-skip', positionId: plan.positionId, error: plan.error }); continue; }
      const pos = uncovered.find(p => p.id === plan.positionId);
      const placed = deps.placeOrder(plan.payload, { kind: 'cover', of: pos.id, legs: plan.legs, limit: plan.limit, mark: plan.mark });
      pos.covered = true;
      pos.coverId = nextId('cov');
      pos.coverLimit = plan.limit;
      pos.coverLegs = plan.legs;      // kept for EOD terminal-settlement P/L + offline replay
      pos.coverStatus = placed.status;
      pos.coverGeometry = plan.geometry;
      // Running LOCKED P&L uses the candidate's guaranteed floor (width − open − cover),
      // valid for every candidate since value >= width everywhere. Retained upside
      // (plan.peakExtra) is tracked separately, not counted in the locked figure.
      st.realizedPnl = round2(st.realizedPnl + plan.floor);
      decisions.push({ action: 'cover', positionId: pos.id, coverId: pos.coverId, legs: plan.legs, mark: plan.mark, limit: plan.limit, geometry: plan.geometry, longStrike: plan.longStrike, peakExtra: plan.peakExtra, lockedFloor: plan.floor });
    }
    // Cover-only reversal leaves us flat unless step 4 opens a new side below.
    st.direction = 'none';
  }

  // (4) OPEN — if the candle strictly qualifies. Neutral (openSide === null) intentionally
  // does nothing for now; this is the isolated branch to extend later.
  //
  // Conflict guard: with the confirmed-reversal cover rule, a candle can signal the OPPOSITE
  // side while we still hold an uncovered position (because the reversal wasn't confirmed, so
  // step 3 didn't cover). In that case stay in the trend — don't open a counter-position. A
  // real flip only happens after a cover (which sets direction to 'none').
  if (openSide && openSide !== st.direction && st.direction !== 'none') {
    decisions.push({ action: 'open-skip-conflict', side: openSide, heldDirection: st.direction });
  } else if (openSide) {
    const res = buildOpen(openSide, candle, cfg, deps.getLeg);
    if (res.error) {
      decisions.push({ action: 'open-skip', side: openSide, error: res.error });
    } else if (!(res.limit > 0)) {
      decisions.push({ action: 'open-skip', side: openSide, error: `non-positive limit (${res.limit}) — bad quotes`, mark: res.mark });
    } else {
      const placed = deps.placeOrder(res.payload, { kind: 'open', side: openSide, legs: res.legs, limit: res.limit, mark: res.mark });
      const pos = {
        id: nextId('pos'), side: openSide, legs: res.legs, quantity: cfg.quantity,
        shortStrike: res.shortStrike, mark: res.mark, cap: res.cap, limit: res.limit,
        orderStatus: placed.status, filled: !!placed.filled, covered: false, coverId: null,
        openedAt: new Date().toISOString()
      };
      st.positions.push(pos);
      // In dry-run we assume the fill; a filled open is NOT pending-cancel. If a real
      // (future) fill hasn't happened, it stays pending so the next candle cancels it.
      st.pendingOpenId = pos.filled ? null : pos.id;
      st.direction = openSide;
      decisions.push({ action: 'open', positionId: pos.id, side: openSide, legs: res.legs, mark: res.mark, cap: res.cap, limit: res.limit, filled: pos.filled });
    }
  } else {
    // PLACEHOLDER: neutral candle handling — no trade today; likely to add logic here.
    decisions.push({ action: 'neutral', simpleDir });
  }

  // PLACEHOLDER: coverTiming === 'each-candle' — cover the prior uncovered position on every
  // candle (not just reversals). Exact semantics (which side, continuing vs reversing) TBD.
  // if (cfg.coverTiming === 'each-candle') { ... }

  // Snapshot the strike window around the underlying so past days can be replayed and new
  // cover geometries re-scored offline (we don't store historical option chains anywhere else).
  const chainSnapshot = cfg.captureChain === false ? null
    : snapshotChain(deps.getLeg, candle.close, cfg.strikeIncrement, cfg.snapshotStrikes || 16);

  store.appendEvent(record, {
    type: 'candle_close',
    candle: { time: candle.timeEST, open: candle.open, high: candle.high, low: candle.low, close: candle.close },
    bands,
    coverContext,
    classification: { simpleDir, openSide, firstOfDay },
    direction: st.direction,
    realizedPnl: st.realizedPnl,
    decisions,
    chainSnapshot
  });
  return { decisions };
}

// Bollinger bands for the first candle of the day from its own indicator payload.
function bandsFor(candle) {
  const bb = candle.indicators && candle.indicators.bollinger20_2;
  if (!bb) return null;
  return { upper: bb.upper, lower: bb.lower, middle: bb.middle };
}

function buildOpen(side, candle, cfg, getLeg) {
  const center = L.centerStrike(candle.close, cfg.strikeIncrement);
  const { lower, upper } = L.spreadStrikes(center, cfg.spreadWidth);
  const legs = L.openLegs(side, lower, upper);
  const { resolved, longMid, shortMid, error } = resolveLegs(legs, getLeg);
  if (error) return { error };
  const { mark, cap, limit } = L.debitLimit(longMid, shortMid, cfg.spreadWidth, cfg.tickIncrement);
  return {
    legs, lower, upper, shortStrike: L.shortStrikeOf(side, lower, upper),
    mark, cap, limit, payload: buildOrderPayload(resolved, limit, cfg.quantity, 'DEBIT')
  };
}

function buildCover(pos, cfg, getLeg) {
  // Default debit-offset cover. (credit style parked — needs its own pricing rule.)
  const legs = L.coverLegs(pos.side, pos.shortStrike, cfg.spreadWidth, cfg.coverStyle || 'debit-offset');
  const { resolved, longMid, shortMid, error } = resolveLegs(legs, getLeg);
  if (error) return { error };
  const { mark, cap, limit } = L.debitLimit(longMid, shortMid, cfg.spreadWidth, cfg.tickIncrement);
  return { legs, mark, cap, limit, payload: buildOrderPayload(resolved, limit, cfg.quantity, 'DEBIT') };
}

// --- Cover selection (the seam the 3 shadow variants differ on) ------------
// selectCovers(uncovered, cfg, getLeg, ctx) -> array of cover PLANS (or {error,positionId}).
// ctx = { underlying (candle close), reversedDir ('bull'|'bear' of the covering candle), bbOverride }.
// A plan: { positionId, legs, resolved, mark, limit, floor($), peakExtra($), geometry, longStrike, payload }.
function selectCovers(uncovered, cfg, getLeg, ctx) {
  const sel = cfg.coverSelector || 'fixed';
  if (sel === 'joint') return selectCoversJoint(uncovered, cfg, getLeg, ctx);
  // 'fixed' and 'greedy' are independent per position.
  return uncovered.map(pos => sel === 'greedy'
    ? selectCoverGreedy(pos, cfg, getLeg, ctx)
    : selectCoverFixed(pos, cfg, getLeg));
}

function coverGeometryLabel(coveredSide, shortStrike, longStrike, width) {
  if (longStrike === shortStrike) return 'box';
  const tentLong = coveredSide === 'bull' ? shortStrike + width : shortStrike - width;
  return longStrike === tentLong ? 'tent' : 'anchor';
}

// Price one candidate cover (skew-aware: real chain mark + 1 tick, no sub-market cap).
function priceCoverCandidate(coveredSide, pos, longStrike, cfg, getLeg) {
  const legs = L.candidateCoverLegs(coveredSide, longStrike, cfg.spreadWidth);
  const { resolved, longMid, shortMid, error } = resolveLegs(legs, getLeg);
  if (error) return { error, positionId: pos.id, longStrike };
  const mark = round2(longMid - shortMid);
  const limit = L.coverLimitFromMark(mark, cfg.spreadWidth, cfg.tickIncrement);
  const floor = round2((cfg.spreadWidth - pos.limit - limit) * 100 * cfg.quantity);
  const peakExtra = round2(L.coverPeakExtra(pos.shortStrike, longStrike, cfg.spreadWidth) * 100 * cfg.quantity);
  return {
    positionId: pos.id, legs, resolved, mark, limit, floor, peakExtra, longStrike,
    geometry: coverGeometryLabel(coveredSide, pos.shortStrike, longStrike, cfg.spreadWidth)
  };
}

// V0 baseline: the current fixed tent, priced with the old debitLimit (so V0 reproduces the
// deployed behavior exactly for a clean A/B against the smarter variants).
function selectCoverFixed(pos, cfg, getLeg) {
  const res = buildCover(pos, cfg, getLeg);
  if (res.error) return { error: res.error, positionId: pos.id };
  const tentLong = pos.side === 'bull' ? pos.shortStrike + cfg.spreadWidth : pos.shortStrike - cfg.spreadWidth;
  return {
    positionId: pos.id, legs: res.legs, mark: res.mark, limit: res.limit,
    floor: round2((cfg.spreadWidth - pos.limit - res.limit) * 100 * cfg.quantity),
    peakExtra: round2(L.coverPeakExtra(pos.shortStrike, tentLong, cfg.spreadWidth) * 100 * cfg.quantity),
    geometry: 'tent', longStrike: tentLong, payload: res.payload
  };
}

// Weight on retained upside vs guaranteed floor; scaled up when the reversal is high-conviction
// (prior candle closed outside its Bollinger band).
function upsideLambda(cfg, ctx) {
  const base = cfg.upsideLambda != null ? cfg.upsideLambda : 0.3;
  return base * (ctx.bbOverride ? (cfg.convictionMult || 1.5) : 1);
}

// V1 phase-1: best candidate per position, score = floor + λ·peakExtra. Naturally picks the
// box for an un-retraced last open (cheap box beats an ATM tent) and the tent/deeper for deep
// stacked opens (both cheap, so the upside bonus tips it).
function selectCoverGreedy(pos, cfg, getLeg, ctx) {
  const longs = L.coverCandidateLongs(pos.side, pos.shortStrike, ctx.underlying, cfg.strikeIncrement, cfg.coverKCap || 5);
  const priced = longs.map(Ls => priceCoverCandidate(pos.side, pos, Ls, cfg, getLeg)).filter(p => !p.error);
  if (!priced.length) return { error: `no chain quotes for any cover candidate of ${pos.id}`, positionId: pos.id };
  const lambda = upsideLambda(cfg, ctx);
  priced.forEach(p => { p.score = round2(p.floor + lambda * p.peakExtra); });
  priced.sort((a, b) => b.score - a.score);
  const best = priced[0];
  best.payload = buildOrderPayload(best.resolved, best.limit, cfg.quantity, 'DEBIT');
  return best;
}

// Terminal-price scenarios for the joint objective: a continued move in the REVERSED direction,
// triangular weights peaking at ~one spread-width drift. (conviction could widen this later.)
function reversalScenarios(underlying, reversedDir, cfg) {
  const drift = cfg.jointDrift != null ? cfg.jointDrift : cfg.spreadWidth;
  const sign = reversedDir === 'bear' ? -1 : 1;
  const pts = [0, 0.5, 1.0, 1.5, 2.0].map(m => ({ price: underlying + sign * m * drift, w: 1 - Math.abs(m - 1.0) }));
  const wsum = pts.reduce((s, p) => s + p.w, 0) || 1;
  pts.forEach(p => { p.w /= wsum; });
  return pts;
}

// Expected aggregate P/L of a chosen combination across the scenarios. Non-separable across
// positions (they share the terminal price), so it rewards LADDERING the covers' long strikes
// across the landing zone rather than stacking identical greedy picks.
function jointScore(chosen, positions, scenarios, cfg) {
  let ev = 0;
  for (const s of scenarios) {
    let agg = 0;
    for (let i = 0; i < chosen.length; i++) {
      const value = L.legsPayoff(positions[i].legs, s.price) + L.legsPayoff(chosen[i].legs, s.price);
      agg += (value - positions[i].limit - chosen[i].limit) * 100 * cfg.quantity;
    }
    ev += s.w * agg;
  }
  return ev;
}

// V2 phase-2: optimize the whole covering basket jointly. Price + prune each position's
// candidates to the top-N by greedy score, take the (capped) cartesian product, and pick the
// combination maximizing expected aggregate P/L under the reversal scenarios. Falls back to
// greedy per position if any position lacks quotes or the product exceeds the cap.
function selectCoversJoint(uncovered, cfg, getLeg, ctx) {
  const topN = cfg.jointTopN || 3;
  const lambda = upsideLambda(cfg, ctx);
  const perPos = uncovered.map(pos => {
    const longs = L.coverCandidateLongs(pos.side, pos.shortStrike, ctx.underlying, cfg.strikeIncrement, cfg.coverKCap || 5);
    const priced = longs.map(Ls => priceCoverCandidate(pos.side, pos, Ls, cfg, getLeg)).filter(p => !p.error);
    priced.forEach(p => { p.gscore = p.floor + lambda * p.peakExtra; });
    priced.sort((a, b) => b.gscore - a.gscore);
    return { pos, priced: priced.slice(0, topN) };
  });
  const combos = perPos.reduce((n, pp) => n * pp.priced.length, 1);
  if (perPos.some(pp => pp.priced.length === 0) || combos > (cfg.jointMaxCombos || 500)) {
    return uncovered.map(pos => selectCoverGreedy(pos, cfg, getLeg, ctx));
  }
  const positions = perPos.map(pp => pp.pos);
  const scenarios = reversalScenarios(ctx.underlying, ctx.reversedDir, cfg);
  const counts = perPos.map(pp => pp.priced.length);
  let best = null, bestScore = -Infinity;
  for (let c = 0; c < combos; c++) {
    let rem = c; const chosen = [];
    for (let i = 0; i < perPos.length; i++) { chosen.push(perPos[i].priced[rem % counts[i]]); rem = Math.floor(rem / counts[i]); }
    const score = jointScore(chosen, positions, scenarios, cfg);
    if (score > bestScore) { bestScore = score; best = chosen; }
  }
  return best.map(p => ({ ...p, payload: buildOrderPayload(p.resolved, p.limit, cfg.quantity, 'DEBIT') }));
}

// Strike-window snapshot around the underlying for offline replay/re-scoring.
function snapshotChain(getLeg, underlying, incr, windowStrikes) {
  const center = L.centerStrike(underlying, incr);
  const half = Math.floor(windowStrikes / 2);
  const strikes = [];
  for (let i = -half; i <= half; i++) {
    const strike = center + i * incr;
    const c = getLeg('C', strike), p = getLeg('P', strike);
    strikes.push({
      strike,
      call: c ? { mid: c.mid, bid: c.bid, ask: c.ask } : null,
      put: p ? { mid: p.mid, bid: p.bid, ask: p.ask } : null
    });
  }
  return { underlying, center, strikes };
}

// --- EOD terminal-settlement P/L ------------------------------------------
// The fair cross-variant metric: value every established position at the day's settle
// price (0DTE => intrinsic). Covered pairs realize their true value INCLUDING the upside
// the floor number ignores (so it doesn't undersell the joint variant); uncovered filled
// spreads settle at their own intrinsic. floor = state.realizedPnl (guaranteed locked sum).
function computeTerminalPnl(state, cfg, settle) {
  const positions = [];
  let total = 0;
  for (const pos of state.positions || []) {
    if (!pos.filled) continue;
    const qty = pos.quantity || cfg.quantity;
    let value = L.legsPayoff(pos.legs, settle);
    let cost = pos.limit;
    if (pos.covered && pos.coverLegs) { value += L.legsPayoff(pos.coverLegs, settle); cost += (pos.coverLimit || 0); }
    const pnl = round2((value - cost) * 100 * qty);
    total = round2(total + pnl);
    positions.push({ id: pos.id, side: pos.side, covered: !!pos.covered, geometry: pos.coverGeometry || null, value: round2(value), cost: round2(cost), pnl });
  }
  return { settle, total, floor: state.realizedPnl, positions };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  processCandleClose,
  makeLegAccessor,
  buildOrderPayload,
  buildOpen,
  buildCover,
  resolveLegs,
  selectCovers,
  selectCoverGreedy,
  selectCoversJoint,
  priceCoverCandidate,
  snapshotChain,
  computeTerminalPnl
};
