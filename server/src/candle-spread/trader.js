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
const CL = require('./capital-legs');   // proven debit/credit leg foundation (capital recapture)
const LL = require('./leg-ledger');     // intraday leg-uniqueness ledger + placement resolver
const CO = require('./combo-order');    // 4-leg atomic cover+open combo (comboNet / mergeLegs / payload)
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

// Place a cover as a REAL resting BUY limit at target (= width − openCost) and mark it pending.
// A resting debit limit fills at market once the ask reaches target (immediately for a cheap
// deep-ITM cover) — the live analog of resolveRestingCovers' mark<=target rule. Shared by the
// reversal cover step and v8's proactive deep-ITM cover. In dry-run this only logs; the state
// machine books the fill via resolveRestingCovers (decoupled); the poller reports the real fill.
async function placeRestingCover(pos, plan, cfg, deps, candleTime, decisions, note) {
  const W = cfg.spreadWidth, tick = cfg.tickIncrement;
  // CAPITAL RECAPTURE: prefer a CREDIT cover on a deep-ITM winner (reclaim ~width cash). LEG-UNIQUENESS:
  // resolve so no cover leg is traded the wrong way — ideal → credit twin (same strikes) → WING-SHIFT
  // (anchor cover: long wing out to a free strike) → skip (leave uncovered). The resting-fill BOOKING stays
  // debit-canonical (pendingCover.legs) so the floor + settlement P&L are right for the position's own
  // style; only the SENT order + the cash ledger differ. Wing-shift books/settles at the wider wing.
  let style = 'debit', wing = W;
  if (deps.capitalRecapture === true) {
    const m = coverMarkNow(pos.legs, deps.getLeg);
    if (m != null && m >= (deps.creditCoverFrac != null ? deps.creditCoverFrac : 0.65) * W) style = 'credit';
  }
  if (deps.enforceLegUniqueness && deps._ledger) {
    const rc = LL.resolveCover(pos.side, pos.shortStrike, W, deps._ledger, { preferStyle: style, incr: cfg.strikeIncrement, maxWingShift: deps.legMaxWing || 8 });
    if (rc.resolution === 'skip') { decisions.push({ action: 'cover-skip-leg', positionId: pos.id }); return; }   // can't place — stays uncovered
    style = rc.style; wing = rc.wing;
    deps._ledger.record(rc.legs);
  }
  // BOOK debit-canonical at the resolved wing (parity for the position's own economics).
  const bookLegs = (wing === W) ? plan.legs : CL.coverLegsFor(pos.side, pos.shortStrike, wing, 'debit');
  const brl = resolveLegs(bookLegs, deps.getLeg);
  const bookMark = brl.error ? null : round2(brl.longMid - brl.shortMid);
  const target = (wing === W) ? round2(W - pos.limit) : (bookMark != null ? round2(Math.max(tick, bookMark)) : round2(W - pos.limit));
  pos.pendingCover = { legs: bookLegs, target, geometry: plan.geometry, longStrike: plan.longStrike, markAtPlace: plan.mark, placedAt: candleTime };
  pos.coverStatus = 'resting';
  // SEND the resolved cover (debit or credit) at the resolved wing.
  const sendLegs = (style === 'debit' && wing === W) ? plan.legs : CL.coverLegsFor(pos.side, pos.shortStrike, wing, style);
  const srl = resolveLegs(sendLegs, deps.getLeg);
  let restOrderId = null, sentNet = 'DEBIT', sentCredit = null, price = 0;
  if (!srl.error) {
    if (style === 'credit') { const cr = round2(srl.shortMid - srl.longMid); if (cr > 0) { sentNet = 'CREDIT'; price = sentCredit = L.roundToTick(Math.min(round2(W - tick), cr), tick); } }
    else { price = (wing === W) ? L.roundToTick(round2(W - pos.limit), tick)   // ideal debit: rest at the floor target (unchanged)
                                : L.roundToTick(Math.max(tick, round2(srl.longMid - srl.shortMid)), tick); }   // wing-shift: the wider cover's mark
    if (price > 0) {
      const payload = buildOrderPayload(srl.resolved, price, cfg.quantity, sentNet);
      const placed = await deps.placeOrder(payload, { kind: 'cover-rest', of: pos.id, legs: sendLegs, limit: price, net: sentNet, mark: plan.mark });
      restOrderId = (placed && placed.orderId) || null;
    }
  }
  pos.pendingCover.orderId = restOrderId;
  pos.pendingCover.sentNet = sentNet;                   // what really rests at the broker
  pos.pendingCover.sentCredit = sentNet === 'CREDIT' ? sentCredit : null;
  decisions.push({ action: 'cover-rest', positionId: pos.id, target, legs: bookLegs, mark: plan.mark, geometry: plan.geometry, longStrike: plan.longStrike, orderId: restOrderId, sentNet, wing: wing !== W ? wing : undefined, note });
}

// v8 risk caps (ported). Returns true if opening `res` (a debit spread, limit=res.limit) stays within
// the run's caps; false (and logs 'open-skip-cap') if it would breach one:
//   riskCap  — legacy total-uncovered-debit ceiling.
//   softCap  — "churn" cap on AT-RISK debit (uncovered AND not deep-ITM). exemptTrendStack skips it
//              when every uncovered position is the SAME side (a trend stack, not chop churn).
//   hardCap  — absolute ceiling on TOTAL uncovered debit (deep-ITM included).
// Marks come from the real chain (coverMarkNow); deep-ITM = mark >= proactiveCoverFrac × width.
// Pure cap evaluation → { ok, nd, totalUncov, atRisk }. Positions flagged `stackLocked` (a cover-to-stack
// lock in progress, see coverToStackFreeBudget) are treated as freed — a deep-ITM cover fills ~immediately
// so its at-risk no longer counts against the budget for THIS candle's open.
function capState(st, res, openSide, cfg, deps) {
  const nd = res.limit * 100 * cfg.quantity;
  const deepFrac = deps.proactiveCoverFrac;
  const isDeep = pos => deepFrac != null && !pos.covered && (coverMarkNow(pos.legs, deps.getLeg) || 0) >= deepFrac * cfg.spreadWidth;
  const uncov = st.positions.filter(p => p.filled && !p.covered && !p.stackLocked);
  let totalUncov = 0, atRisk = 0;
  for (const p of uncov) { const d = p.limit * 100 * (p.quantity || cfg.quantity); totalUncov += d; if (!isDeep(p)) atRisk += d; }
  const stacking = uncov.length > 0 && uncov.every(p => p.side === openSide);
  const softOk = (deps.exemptTrendStack && stacking) ? true : (atRisk + nd <= (deps.softCap != null ? deps.softCap : Infinity));
  const ok = (totalUncov + nd <= (deps.riskCap != null ? deps.riskCap : Infinity)) && softOk && (totalUncov + nd <= (deps.hardCap != null ? deps.hardCap : Infinity));
  return { ok, nd, totalUncov, atRisk };
}
function capAllowsOpen(st, res, openSide, cfg, deps, decisions) {
  if (deps.riskCap == null && deps.softCap == null && deps.hardCap == null) return true;
  const s = capState(st, res, openSide, cfg, deps);
  if (!s.ok) decisions.push({ action: 'open-skip-cap', side: openSide, addDebit: round2(s.nd), totalUncov: round2(s.totalUncov), atRisk: round2(s.atRisk) });
  return s.ok;
}

// COVER-TO-CONTINUE-STACKING (deps.coverToStack): when a cap would block a new open, LOCK the deepest-ITM
// uncovered winner(s) (mark >= coverToStackMinFrac×width, default 0.65) with a resting cover — freeing
// their at-risk from the budget — so the stack continues instead of skipping the open. Mirrors
// backtest-v6-5m's cover-to-stack. The resting cover logs the REAL chain mark (the fill-realism data this
// paper study collects); `stackLocked` frees the budget for THIS candle (a cheap deep-ITM cover fills
// ~immediately — resolveRestingCovers books it later this same candle). Returns how many it locked.
async function coverToStackFreeBudget(st, res, openSide, cfg, deps, decisions, candleTime) {
  const minFrac = deps.coverToStackMinFrac != null ? deps.coverToStackMinFrac : 0.65;
  const lockMin = minFrac * cfg.spreadWidth;
  const tried = new Set();
  let locked = 0;
  while (!capState(st, res, openSide, cfg, deps).ok) {
    const cands = st.positions
      .filter(p => p.filled && !p.covered && !p.pendingCover && !p.stackLocked && !tried.has(p.id))
      .map(p => ({ p, mark: coverMarkNow(p.legs, deps.getLeg) }))
      .filter(x => x.mark != null && x.mark >= lockMin)
      .sort((a, b) => b.mark - a.mark);              // deepest ITM first: cheapest cover, biggest lock
    if (!cands.length) break;                        // no winner deep enough → the open will be skipped
    const { p } = cands[0];
    const plan = selectCoverFixedMark(p, cfg, deps.getLeg);
    if (plan.error) { tried.add(p.id); continue; }   // can't price its cover right now; don't retry it
    if (cfg.coverFillModel === 'resting') {
      await placeRestingCover(p, plan, cfg, deps, candleTime, decisions, 'cover-to-stack');
    } else {
      await deps.placeOrder(plan.payload, { kind: 'cover', of: p.id, legs: plan.legs, limit: plan.limit, mark: plan.mark, note: 'cover-to-stack' });
      p.covered = true; p.coverId = nextId('cov'); p.coverLimit = plan.limit; p.coverLegs = plan.legs;
    }
    p.stackLocked = true; locked++;
  }
  if (locked) decisions.push({ action: 'cover-to-stack', locked, forOpen: openSide, minMark: round2(lockMin) });
  return locked;
}

// FOUR-LEG COMBO (deps.comboOrders): when a cap blocks the open, lock ONE deep-ITM winner AND place the new
// open as a SINGLE atomic Schwab CUSTOM order (fills as a unit or not at all — no half-execution, no cap
// breach; the winner's credit cover nets against the new debit → a small balanced order that fills near
// mid). Only when exactly one winner frees the budget and both spreads resolve leg-uniquely (per the 765-day
// instrumentation: ~98% / 100% of CTS events). Books BOTH the cover and the open on the one fill. Returns
// true if placed; false → caller falls back to the sequential coverToStackFreeBudget path. Marketable
// haircut = deps.comboSlip per leg (default 0.05). See combo-order.js.
async function tryComboLockAndOpen(st, res, openSide, cfg, deps, decisions, candleTime) {
  if (!(deps.enforceLegUniqueness && deps._ledger)) return false;   // combo requires the leg-uniqueness ledger
  const W = cfg.spreadWidth, tick = cfg.tickIncrement, qty = cfg.quantity;
  const minFrac = deps.coverToStackMinFrac != null ? deps.coverToStackMinFrac : 0.65;
  const lockMin = minFrac * W;
  const mid = (type, strike) => { const q = deps.getLeg(type, strike); return q ? q.mid : null; };
  // 1) the single deepest-ITM winner that, covered ALONE, frees enough budget for this open
  const cand = st.positions
    .filter(p => p.filled && !p.covered && !p.pendingCover && !p.stackLocked)
    .map(p => ({ p, m: coverMarkNow(p.legs, deps.getLeg) }))
    .filter(x => x.m != null && x.m >= lockMin)
    .sort((a, b) => b.m - a.m)[0];
  if (!cand) return false;
  const winner = cand.p;
  winner.covered = true;                                            // tentative: does covering just this one fit?
  const fits = capState(st, res, openSide, cfg, deps).ok;
  winner.covered = false;
  if (!fits) return false;                                          // one winner isn't enough → sequential fallback

  // 2) resolve the winner's cover (prefer CREDIT reclaim on a deep-ITM winner; twin → wing-shift → skip)
  const plan = selectCoverFixedMark(winner, cfg, deps.getLeg);
  if (plan.error) return false;
  const wantCredit = cand.m >= (deps.creditCoverFrac != null ? deps.creditCoverFrac : 0.65) * W;
  const rc = LL.resolveCover(winner.side, winner.shortStrike, W, deps._ledger, { preferStyle: wantCredit ? 'credit' : 'debit', incr: cfg.strikeIncrement, maxWingShift: deps.legMaxWing || 8 });
  if (rc.resolution === 'skip') return false;
  const coverSentLegs = (rc.style === 'debit' && rc.wing === W) ? plan.legs : CL.coverLegsFor(winner.side, winner.shortStrike, rc.wing, rc.style);
  const coverBookLegs = (rc.wing === W) ? plan.legs : CL.coverLegsFor(winner.side, winner.shortStrike, rc.wing, 'debit');   // debit-canonical (floor P&L)
  // Booked cover price = min(target = W−openLimit, coverMark+tick) — same as resolveRestingCovers, so the
  // locked floor (W − openLimit − coverLimit) matches the sequential path exactly.
  const coverMark = CO.spreadNet(coverBookLegs, mid);
  const coverLimit = L.roundToTick(Math.max(tick, Math.min(round2(W - winner.limit), coverMark + tick)), tick);

  // 3) re-resolve the open against a TEMP ledger = the real one PLUS the cover, so the open can't net
  // against the lock. Nothing touches the REAL ledger until we commit below → a bail is a clean rollback.
  const tempLedger = LL.makeLegLedger({ ...(st.legLedger || {}) });
  tempLedger.record(rc.legs);
  const wantCreditOpen = deps.capitalRecapture === true && Math.floor((st.openN || 0) / (deps.openAlternateEvery || 3)) % 2 === 1;
  const rr = LL.resolveOpen(openSide, res.lower, res.upper, tempLedger, { incr: cfg.strikeIncrement, maxShift: deps.legMaxShift || 6, preferStyle: wantCreditOpen ? 'credit' : 'debit' });
  if (rr.resolution === 'skip') return false;                      // can't place open cleanly → sequential fallback (real ledger untouched)
  const openBook = rr.resolution === 'shift' ? buildOpenAtStrikes(openSide, rr.lo, rr.hi, cfg, deps.getLeg) : res;
  if (openBook.error) return false;
  const openSentLegs = rr.legs;

  // 4) price + build the atomic CUSTOM order (net mid + marketable slip); merge same-strike legs to qty
  const slip = deps.comboSlip != null ? deps.comboSlip : 0.05;
  const cn = CO.comboNet(coverSentLegs, openSentLegs, mid, slip);
  if (!cn) return false;
  const merged = CO.mergeLegs([...coverSentLegs, ...openSentLegs], qty);
  const resolvedMerged = [];
  for (const l of merged) { const q = deps.getLeg(l.type, l.strike); if (!q || q.symbol == null) return false; resolvedMerged.push({ ...l, symbol: q.symbol }); }
  const price = L.roundToTick(cn.limit, tick);
  const payload = CO.buildComboPayload(resolvedMerged, price, qty, cn.side);
  const placed = await deps.placeOrder(payload, { kind: 'combo-lock-open', winner: winner.id, coverLegs: coverSentLegs, openLegs: openSentLegs, net: cn.side, limit: price, slip });
  deps._ledger.record(rc.legs);   // COMMIT the cover to the real ledger (resolved above vs a temp copy)

  // 5) book the COVER onto the winner (mirrors resolveRestingCovers) — floor from the debit-canonical legs
  winner.covered = true; winner.coverId = nextId('cov'); winner.coverLegs = coverBookLegs; winner.coverLimit = coverLimit;
  winner.coverStatus = 'filled'; winner.coverTime = st.lastCandleTime || null; winner.coverEpoch = st.lastCandleEpoch || null;
  winner.coverSentNet = cn.side; winner.viaCombo = true;
  const floor = round2((W - winner.limit - coverLimit) * 100 * (winner.quantity || qty));
  st.realizedPnl = round2(st.realizedPnl + floor);

  // 6) book the OPEN as a new position (mirrors openPosition, minus the send — the combo already sent)
  const pos = {
    id: nextId('pos'), side: openSide, legs: openBook.legs, quantity: qty,
    shortStrike: openBook.shortStrike, mark: openBook.mark, cap: openBook.cap, limit: openBook.limit,
    orderStatus: placed.status, filled: !!placed.filled, covered: false, coverId: null,
    openedAt: new Date().toISOString(), openTime: st.lastCandleTime || null, openEpoch: st.lastCandleEpoch || null,
    sentNet: cn.side, sentLimit: price, sentLegs: openSentLegs, viaCombo: winner.id
  };
  st.positions.push(pos);
  deps._ledger.record(openSentLegs);
  st.direction = openSide; st.openN = (st.openN || 0) + 1;

  // 7) combo cash: ONE net impact for the whole order (+debit / −credit). Does not touch P&L.
  st.cashDeployed = round2((st.cashDeployed || 0) + cn.net * 100 * qty);
  st.peakCashDeployed = Math.max(st.peakCashDeployed || 0, st.cashDeployed);

  decisions.push({ action: 'combo-lock-open', winner: winner.id, openId: pos.id, coverId: winner.coverId, net: cn.side, limit: price, legs: resolvedMerged.length, lockedFloor: floor, cashDeployed: st.cashDeployed });
  return true;
}

// Build the P&L-equivalent CREDIT open order (parity twin of the debit vertical at the same strikes):
// bull → sell the bull put spread, bear → sell the bear call spread. NET_CREDIT priced at the mid credit
// (short leg richer than long). Used only for capital recapture; returns { legs, limit, credit, payload }.
function buildCreditOpenOrder(side, lower, upper, cfg, getLeg) {
  const legs = CL.openLegsFor(side, lower, upper, 'credit');
  const { resolved, longMid, shortMid, error } = resolveLegs(legs, getLeg);
  if (error) return { error };
  const credit = round2(shortMid - longMid);
  if (!(credit > 0)) return { error: `non-positive credit (${credit}) — bad quotes` };
  const limit = Math.max(cfg.tickIncrement, Math.min(round2(cfg.spreadWidth - cfg.tickIncrement), credit));
  return { legs, limit, credit, payload: buildOrderPayload(resolved, limit, cfg.quantity, 'CREDIT') };
}

// Book a filled/assumed open into state (shared by the normal path and the cover-to-stack rescue path).
// CAPITAL RECAPTURE (deps.capitalRecapture): every openAlternateEvery opens we flip the ORDER SENT between
// the debit vertical and its parity CREDIT twin, so net cash oscillates instead of draining. The position
// RECORD stays debit-CANONICAL (legs/limit) so floor/settlement/cover/cap logic is byte-identical and P&L
// is provably unchanged (see capital-legs parity test); only the actual sent order + the signed cash
// ledger differ. sentNet/sentLegs record what really went to the broker for fill reconciliation.
async function openPosition(st, res, openSide, cfg, deps, decisions, legStyle) {
  const altEvery = deps.openAlternateEvery || 3;
  // Send style: the leg-uniqueness resolver's choice when enforcing (it took the recapture preference but
  // may have flipped to the twin); otherwise the recapture alternation; otherwise debit.
  const style = legStyle || ((deps.capitalRecapture === true && Math.floor((st.openN || 0) / altEvery) % 2 === 1) ? 'credit' : 'debit');
  let payload = res.payload, sentNet = 'DEBIT', sentLegs = res.legs, sentLimit = res.limit;
  if (style === 'credit') {
    const c = buildCreditOpenOrder(openSide, res.lower, res.upper, cfg, deps.getLeg);
    if (!c.error) { payload = c.payload; sentNet = 'CREDIT'; sentLegs = c.legs; sentLimit = c.limit; }
    else if (legStyle) { decisions.push({ action: 'open-skip-leg', side: openSide, error: 'twin credit unquotable' }); return; }  // forced twin: can't fall back to a conflicting debit
    else decisions.push({ action: 'credit-open-fallback', side: openSide, error: c.error });   // recapture-only: fall back to debit
  }
  const placed = await deps.placeOrder(payload, { kind: 'open', side: openSide, legs: sentLegs, limit: sentLimit, net: sentNet, mark: res.mark });
  const pos = {
    id: nextId('pos'), side: openSide, legs: res.legs, quantity: cfg.quantity,   // debit-CANONICAL (drives all strategy logic)
    shortStrike: res.shortStrike, mark: res.mark, cap: res.cap, limit: res.limit,
    orderStatus: placed.status, filled: !!placed.filled, covered: false, coverId: null,
    openedAt: new Date().toISOString(),
    openTime: st.lastCandleTime || null,   // the CANDLE time (for plotting the trade on the NQ chart timeline)
    openEpoch: st.lastCandleEpoch || null, // 5m-mark epoch ms (robust chart-candle match, no ET parsing)
    sentNet, sentLimit, sentLegs: sentNet === 'CREDIT' ? sentLegs : undefined   // what actually hit the broker
  };
  st.positions.push(pos);
  if (deps.enforceLegUniqueness && deps._ledger) deps._ledger.record(sentLegs);   // record the actual played legs
  st.pendingOpenId = pos.filled ? null : pos.id;
  st.direction = openSide;
  st.openN = (st.openN || 0) + 1;
  // Signed cash ledger (+paid debit, -received credit). Does NOT touch P&L — pure capital view.
  const cashDelta = (sentNet === 'CREDIT' ? -sentLimit : res.limit) * 100 * cfg.quantity;
  st.cashDeployed = round2((st.cashDeployed || 0) + cashDelta);
  st.peakCashDeployed = Math.max(st.peakCashDeployed || 0, st.cashDeployed);
  decisions.push({ action: 'open', positionId: pos.id, side: openSide, legs: res.legs, mark: res.mark, cap: res.cap, limit: res.limit, filled: pos.filled, sentNet, cashDeployed: st.cashDeployed });
}

// --- Core per-tick sequence (testable) ------------------------------------
// deps: { getLeg(type,strike), placeOrder(payload, meta)->Promise<{status,filled}>, dryRun }
// async because placeOrder may send a real order to Schwab (awaited network call).
async function processCandleClose(record, candle, priorCandle, deps) {
  const cfg = record.config;
  const st = record.state;
  const decisions = [];

  const candleTime = candle.timeEST || String(candle.datetime);
  // De-dupe: never act twice on the same candle.
  if (st.lastCandleTime === candleTime) return { skipped: 'already-processed' };
  st.lastCandleTime = candleTime;
  st.lastCandleEpoch = (typeof candle.datetime === 'number') ? candle.datetime : null;   // 5m-mark epoch, matches /chartseries
  // LEG-UNIQUENESS (deps.enforceLegUniqueness): a per-day ledger of each leg's traded side, persisted on
  // run state (this run record IS one trade day) so a leg is never both bought- and sold-to-open.
  if (deps.enforceLegUniqueness) { if (!st.legLedger) st.legLedger = {}; deps._ledger = LL.makeLegLedger(st.legLedger); }

  const firstOfDay = !priorCandle;
  const ported = typeof deps.signalFn === 'function';
  const bands = (!ported && firstOfDay) ? bandsFor(candle) : null;
  const priorBands = (!ported && priorCandle) ? bandsFor(priorCandle) : null; // classic cover override
  const simpleDir = L.simpleDirection(candle);

  // DECISION SOURCE.
  //   CLASSIC (v0-v3): close-vs-open + Bollinger/high-low break, via spread-logic.classifyOpen /
  //     shouldCover on the single 15m `candle`.
  //   PORTED (v4-v9): the multi-timeframe signal fn drives openSide + which side(s) to cover, off the
  //     live `A` object (deps.A / deps.priorA from analysis-builder). Mirrors backtest-v6-5m.runDay5m:
  //     per-side held state in, { openSide, cover | coverSide } out. Everything below (open/cover/
  //     resting-fill machinery) is SHARED. See [[project_candle_spread_live_order_wiring]].
  let openSide = null, coverSet = [], portedSig = null;
  if (ported) {
    const heldBull = st.positions.some(p => p.filled && p.side === 'bull' && !p.covered);
    const heldBear = st.positions.some(p => p.filled && p.side === 'bear' && !p.covered);
    portedSig = deps.signalFn(deps.A, deps.priorA, {
      heldDir: st.direction, heldBull, heldBear,
      isFifteen: deps.isFifteen !== false, directionality: deps.directionality,
      cfg: deps.signalCfg || {}
    }) || {};
    openSide = portedSig.openSide || null;
    // coverSide ('bull'|'bear'|'both') covers just that side (v7 per-side); legacy cover:true = both.
    coverSet = portedSig.coverSide
      ? (portedSig.coverSide === 'both' ? ['bull', 'bear'] : [portedSig.coverSide])
      : (portedSig.cover ? ['bull', 'bear'] : []);
  } else {
    openSide = L.classifyOpen(candle, priorCandle, bands);
  }

  // SIGNAL vs PRICING split: `candle` is the SIGNAL instrument (e.g. NQ futures) that drives
  // direction / Bollinger gates / reversal detection; `underlying` is the PRICING instrument's
  // level (e.g. cash NDX) used for STRIKE placement, since the options we trade settle on NDX.
  // Defaults to candle.close (single-instrument mode) when deps.underlying isn't supplied.
  const underlying = deps.underlying != null ? deps.underlying : candle.close;
  st.lastUnderlying = underlying;   // NDX (pricing instrument) — for mark-to-market terminal P&L in status/EOD

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
  const coverSignal = ported ? coverSet.length > 0 : L.shouldCover(st.direction, candle, priorCandle, priorBands);
  const coverContext = ported
    ? (coverSet.length ? { heldDirection: st.direction, coverSide: portedSig.coverSide || (portedSig.cover ? 'both' : null), reason: portedSig.reason, covered: true } : null)
    : (st.direction === 'none' ? null : {
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
    });

  // (3) COVER — only on a CONFIRMED reversal (see spread-logic.shouldCover): a candle
  // closing opposite our held direction that FAILED to extend the prior candle's extreme
  // (or where the prior trend candle closed outside its Bollinger band). Covers every
  // filled, uncovered spread 1:1. Can happen in the same candle that also opens (step 4).
  //
  // WHICH cover geometry is chosen is delegated to a pluggable selector (cfg.coverSelector:
  // 'fixed' = current tent | 'greedy' = best per-position candidate | 'joint' = basket
  // optimization). This is the seam the 3 shadow variants differ on; everything else is shared.
  if (coverSignal) {
    // Exclude positions that already have a resting cover working (don't re-select them). In ported
    // mode cover ONLY the side(s) the signal targeted (v7 per-side coverSide); classic covers all.
    const uncovered = st.positions.filter(p => p.filled && !p.covered && !p.pendingCover && (!ported || coverSet.includes(p.side)));
    const plans = selectCovers(uncovered, cfg, deps.getLeg, { underlying, reversedDir: simpleDir, bbOverride: !!(coverContext && coverContext.bbOverride) });
    for (const plan of plans) {
      if (plan.error) { decisions.push({ action: 'cover-skip', positionId: plan.positionId, error: plan.error }); continue; }
      const pos = uncovered.find(p => p.id === plan.positionId);
      if (cfg.coverFillModel === 'resting') {
        // RESTING model: place a working cover at the ideal target (= width − openCost); don't book
        // the floor yet — resolveRestingCovers fills it when the real mark reaches target.
        await placeRestingCover(pos, plan, cfg, deps, candleTime, decisions);
      } else {
        // ASSUME-FILL model (v0 reference): book the cover immediately at mark+tick.
        const placed = await deps.placeOrder(plan.payload, { kind: 'cover', of: pos.id, legs: plan.legs, limit: plan.limit, mark: plan.mark });
        pos.covered = true;
        pos.coverId = nextId('cov');
        pos.coverLimit = plan.limit;
        pos.coverLegs = plan.legs;      // kept for EOD terminal-settlement P/L + offline replay
        pos.coverStatus = placed.status;
        pos.coverTime = st.lastCandleTime || null;   // CANDLE time of the cover (NQ-chart plotting)
        pos.coverEpoch = st.lastCandleEpoch || null;
        pos.coverGeometry = plan.geometry;
        // Running LOCKED P&L uses the candidate's guaranteed floor (width − open − cover),
        // valid for every candidate since value >= width everywhere. Retained upside
        // (plan.peakExtra) is tracked separately, not counted in the locked figure.
        st.realizedPnl = round2(st.realizedPnl + plan.floor);
        decisions.push({ action: 'cover', positionId: pos.id, coverId: pos.coverId, legs: plan.legs, mark: plan.mark, limit: plan.limit, geometry: plan.geometry, longStrike: plan.longStrike, peakExtra: plan.peakExtra, lockedFloor: plan.floor });
      }
    }
    // Reset the held stance so a flip's opposite open can proceed. Classic always goes flat.
    // Ported mirrors runDay5m: reset only when covering everything / both / the currently-held side
    // (a partial cover of the OTHER side leaves our stance intact).
    if (!ported || portedSig.cover || portedSig.coverSide === 'both' || portedSig.coverSide === st.direction) {
      st.direction = 'none';
    }
  }

  // (3b) v8 PROACTIVE DEEP-ITM COVER (ported, opts.proactiveCoverFrac): rest a tent cover on any
  // uncovered leader whose spread now marks >= frac×width (deep ITM → a good tent locks cheaply).
  // This locks winners and, via the cap logic below, stops them counting toward the at-risk churn cap.
  if (ported && deps.proactiveCoverFrac != null) {
    for (const pos of st.positions) {
      if (!pos.filled || pos.covered || pos.pendingCover) continue;
      const m = coverMarkNow(pos.legs, deps.getLeg);
      if (m != null && m >= deps.proactiveCoverFrac * cfg.spreadWidth) {
        const plan = selectCoverFixedMark(pos, cfg, deps.getLeg);
        if (!plan.error && cfg.coverFillModel === 'resting') await placeRestingCover(pos, plan, cfg, deps, candleTime, decisions, 'proactive-deep-itm');
      }
    }
  }

  // (4) OPEN — if the candle strictly qualifies. Neutral (openSide === null) intentionally
  // does nothing for now; this is the isolated branch to extend later.
  //
  // Conflict guard: with the confirmed-reversal cover rule, a candle can signal the OPPOSITE
  // side while we still hold an uncovered position (because the reversal wasn't confirmed, so
  // step 3 didn't cover). In that case stay in the trend — don't open a counter-position. A
  // real flip only happens after a cover (which sets direction to 'none'). Ported bidirectional
  // runs (v7 "be wrong") deliberately bypass this to open the opposite side while holding.
  const bidir = ported && deps.bidirectional === true;
  if (openSide && !bidir && openSide !== st.direction && st.direction !== 'none') {
    decisions.push({ action: 'open-skip-conflict', side: openSide, heldDirection: st.direction });
  } else if (openSide) {
    let res = buildOpen(openSide, underlying, cfg, deps.getLeg);
    // LEG-UNIQUENESS: resolve strikes + style BEFORE the caps/send so a shifted spread is capped
    // correctly. ideal → parity twin (same strikes) → shift → skip. legStyle drives the actual send.
    let legStyle = null, legSkipped = false;
    if (deps.enforceLegUniqueness && deps._ledger && !res.error && res.limit > 0) {
      const wantCredit = deps.capitalRecapture === true && Math.floor((st.openN || 0) / (deps.openAlternateEvery || 3)) % 2 === 1;
      const rr = LL.resolveOpen(openSide, res.lower, res.upper, deps._ledger, { incr: cfg.strikeIncrement, maxShift: deps.legMaxShift || 6, preferStyle: wantCredit ? 'credit' : 'debit' });
      if (rr.resolution === 'skip') { decisions.push({ action: 'open-skip-leg', side: openSide, lower: res.lower, upper: res.upper }); legSkipped = true; }
      else { if (rr.resolution === 'shift') { res = buildOpenAtStrikes(openSide, rr.lo, rr.hi, cfg, deps.getLeg); } legStyle = rr.style; }
    }
    if (legSkipped) {
      // already logged; the leg constraint blocked every placement
    } else if (res.error) {
      decisions.push({ action: 'open-skip', side: openSide, error: res.error });
    } else if (!(res.limit > 0)) {
      decisions.push({ action: 'open-skip', side: openSide, error: `non-positive limit (${res.limit}) — bad quotes`, mark: res.mark });
    } else if (ported && !capState(st, res, openSide, cfg, deps).ok) {
      // A cap blocks this open. If cover-to-stack is on, try to free budget by locking a deep-ITM winner
      // and open anyway; else skip (existing v8 behavior). capAllowsOpen logs the FINAL 'open-skip-cap'.
      let opened = false;
      // COMBO first (deps.comboOrders): lock 1 winner + open as ONE atomic 4-leg order. Falls back to the
      // sequential cover-to-stack path when a single lock isn't enough or the spreads can't combine cleanly.
      if (deps.comboOrders) opened = await tryComboLockAndOpen(st, res, openSide, cfg, deps, decisions, candleTime);
      if (!opened && deps.coverToStack) {
        await coverToStackFreeBudget(st, res, openSide, cfg, deps, decisions, candleTime);
        if (capState(st, res, openSide, cfg, deps).ok) { await openPosition(st, res, openSide, cfg, deps, decisions, legStyle); opened = true; }
      }
      if (!opened) capAllowsOpen(st, res, openSide, cfg, deps, decisions);   // logs 'open-skip-cap'
    } else {
      // In dry-run/paper we assume the fill; a filled open is NOT pending-cancel. If a real (future)
      // fill hasn't happened, it stays pending so the next candle cancels it (see openPosition).
      await openPosition(st, res, openSide, cfg, deps, decisions, legStyle);
    }
  } else {
    // PLACEHOLDER: neutral candle handling — no trade today; likely to add logic here.
    decisions.push({ action: 'neutral', simpleDir });
  }

  // PLACEHOLDER: coverTiming === 'each-candle' — cover the prior uncovered position on every
  // candle (not just reversals). Exact semantics (which side, continuing vs reversing) TBD.
  // if (cfg.coverTiming === 'each-candle') { ... }

  // Resolve any RESTING cover orders against THIS candle's chain (fills a working cover once its real
  // mark reaches its target). Runs after the cover/open steps so a cover placed this candle can also
  // cross-fill immediately if it's already cheap. Books locked floor at the actual fill price.
  if (cfg.coverFillModel === 'resting') resolveRestingCovers(st, cfg, deps.getLeg, decisions);

  // Snapshot the strike window around the PRICING underlying (NDX) so past days can be replayed
  // and new cover geometries re-scored offline (we don't store historical option chains otherwise).
  const chainSnapshot = cfg.captureChain === false ? null
    : snapshotChain(deps.getLeg, underlying, cfg.strikeIncrement, cfg.snapshotStrikes || 16);

  store.appendEvent(record, {
    type: 'candle_close',
    // `candle` = the SIGNAL instrument's OHLC (e.g. NQ); `underlying` = the PRICING level (NDX)
    // the strikes are placed around. They differ by the basis when signal != price symbol.
    candle: { time: candle.timeEST, open: candle.open, high: candle.high, low: candle.low, close: candle.close },
    underlying,
    signalSymbol: deps.signalSymbol || null,
    priceSymbol: deps.priceSymbol || null,
    bands,
    coverContext,
    classification: { simpleDir, openSide, firstOfDay },
    // Ported (v4-v9) provenance: which signal fired and the 5m/15m cadence flag.
    signal: ported ? { variant: cfg.variant, reason: portedSig.reason, isFifteen: deps.isFifteen !== false, directionality: deps.directionality } : null,
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

function buildOpen(side, underlying, cfg, getLeg) {
  const center = L.centerStrike(underlying, cfg.strikeIncrement);
  // spreadShift (default 0 = ATM) shifts the spread ITM for the $40 short-ATM geometry; capFrac
  // (default 0.525 = the $20 ATM cap) rises for wider/deeper spreads whose long leg costs more.
  const { lower, upper } = L.spreadStrikesShifted(center, cfg.spreadWidth, cfg.spreadShift || 0, side);
  return buildOpenAtStrikes(side, lower, upper, cfg, getLeg);
}

// Build a debit-canonical open at EXPLICIT strikes (used by leg-uniqueness to reprice a shifted spread).
function buildOpenAtStrikes(side, lower, upper, cfg, getLeg) {
  const legs = L.openLegs(side, lower, upper);
  const { resolved, longMid, shortMid, error } = resolveLegs(legs, getLeg);
  if (error) return { error };
  const { mark, cap, limit } = L.debitLimit(longMid, shortMid, cfg.spreadWidth, cfg.tickIncrement, cfg.capFrac);
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
  // 'fixed' / 'fixed-mark' / 'greedy' are independent per position.
  return uncovered.map(pos => {
    if (sel === 'greedy') return selectCoverGreedy(pos, cfg, getLeg, ctx);
    if (sel === 'fixed-mark') return selectCoverFixedMark(pos, cfg, getLeg);
    return selectCoverFixed(pos, cfg, getLeg);
  });
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

// Same fixed TENT geometry as V0, but priced at the realistic mark (mark + 1 tick, no
// sub-market cap) instead of the 0.525×width cap. Isolates the fill-price effect from the
// geometry: v3 vs v1/v2 is an apples-to-apples geometry comparison (all mark-priced), while
// V0 stays capped as the optimistic-instant-fill reference for the future fill-tracking work.
function selectCoverFixedMark(pos, cfg, getLeg) {
  const tentLong = pos.side === 'bull' ? pos.shortStrike + cfg.spreadWidth : pos.shortStrike - cfg.spreadWidth;
  const plan = priceCoverCandidate(pos.side, pos, tentLong, cfg, getLeg); // geometry === 'tent'
  if (plan.error) return { error: plan.error, positionId: pos.id };
  plan.payload = buildOrderPayload(plan.resolved, plan.limit, cfg.quantity, 'DEBIT');
  return plan;
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

// Net-debit mark of a cover leg-set from the CURRENT chain (null if any leg is unquoted).
function coverMarkNow(legs, getLeg) {
  let v = 0;
  for (const l of legs) {
    const q = getLeg(l.type, l.strike);
    if (!q || q.mid == null) return null;
    v += (l.side === 'long' ? 1 : -1) * q.mid;
  }
  return round2(v);
}

// RESTING-cover fill model (see the cover step): a working cover fills when its real mark reaches
// its target (= width − openCost). Fill price = min(target, mark + tick) → cross cheap when the
// cover is already below target (deep-ITM lock), else fill at the resting target. Books the locked
// floor (width − open − fill) at the actual fill price. Live analog of the backtest's two-mode fill;
// here the fill check uses the real per-candle chain mark instead of the pricer/wick.
function resolveRestingCovers(st, cfg, getLeg, decisions) {
  const tick = cfg.tickIncrement;
  for (const pos of st.positions) {
    if (!pos.filled || !pos.pendingCover) continue;
    const pc = pos.pendingCover;
    const mark = coverMarkNow(pc.legs, getLeg);
    if (mark == null || mark > pc.target) continue;      // not fillable yet — keep resting
    const fill = round2(Math.max(tick, Math.round(Math.min(pc.target, mark + tick) / tick) * tick));
    pos.covered = true;
    pos.coverId = nextId('cov');
    pos.coverLegs = pc.legs;          // kept for EOD terminal-settlement P/L
    pos.coverLimit = fill;
    pos.coverGeometry = pc.geometry;
    pos.coverStatus = 'filled';
    pos.coverTime = st.lastCandleTime || null;   // CANDLE time of the cover (for NQ-chart trade plotting)
    pos.coverEpoch = st.lastCandleEpoch || null;
    const floor = round2((cfg.spreadWidth - pos.limit - fill) * 100 * (pos.quantity || cfg.quantity));
    st.realizedPnl = round2(st.realizedPnl + floor);
    // Signed cash ledger: a credit cover RECLAIMS ~width cash (-), a debit cover PAYS the fill (+). Does
    // not touch P&L — the floor above is booked from the debit-canonical target either way.
    const q = pos.quantity || cfg.quantity;
    const cashDelta = pc.sentNet === 'CREDIT' ? -(pc.sentCredit || 0) * 100 * q : fill * 100 * q;
    st.cashDeployed = round2((st.cashDeployed || 0) + cashDelta);
    st.peakCashDeployed = Math.max(st.peakCashDeployed || 0, st.cashDeployed);
    pos.coverSentNet = pc.sentNet;
    pos.pendingCover = null;
    decisions.push({ action: 'cover-fill', positionId: pos.id, coverId: pos.coverId, fillPrice: fill, mark, target: pc.target, geometry: pc.geometry, lockedFloor: floor, sentNet: pc.sentNet, cashDeployed: st.cashDeployed });
  }
}

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
  computeTerminalPnl,
  tryComboLockAndOpen   // exported for the combo unit test
};
