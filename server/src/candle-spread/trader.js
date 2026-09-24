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
const CL = require('./capital-legs');
const LAD = require('./cover-ladder');   // works a resting cover toward the market (opt-in: deps.coverLadder)   // proven debit/credit leg foundation (capital recapture)
const RC = require('./risk-curve');     // shared exact bookFloor — the quantity the day-loss governor bounds
const RH = require('./risk-harvest');   // shared hedge-candidate search, used by the floor-offset overlay
const WC = require('./wing-convert');
const FY = require('./fly-convert');   // valley repair: flies/condors — SHARED with the backtest engine
const IIV = require('../../shared/intraday-iv');   // time-of-day IV multiplier — MUST match the backtest   // shared peak->floor wing planner (same module the backtest uses)
const bs = require('./bs-pricer');      // band = spot*iv*sqrt(tau), the same expected move the backtest uses
const LL = require('./leg-ledger');     // intraday leg-uniqueness ledger + placement resolver
const SQ = require('./spread-quote');
const BV = require('./book-value');   // shared book valuation — the risk curve, the settle, the scrubber   // net spread quotes + mark validation (parity / neighbour / ceiling)
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
// THE STRATEGY TYPE HAS TO MATCH THE LEGS, and duplicated strikes have to be merged.
//
// This sent complexOrderStrategyType 'VERTICAL' for everything. A vertical is two legs; the engine also
// sends 1-leg naked wings (wing-convert's `naked` shape) and 4-leg flies and condors, and Schwab is
// entitled to reject a 4-leg order declared VERTICAL. Worse, a butterfly's body is the SAME strike twice
// — CL emits it as two separate short legs — so the payload carried two identical SELL_TO_OPEN entries
// at quantity 1 rather than one at quantity 2. Even if accepted, what comes back is not what was priced.
//
// mergeLegs (combo-order.js) already nets duplicate strikes and carries a per-leg quantity; it was only
// ever wired into the combo path. Using it here makes every order type send what it actually means, and
// a per-leg quantity now wins over the flat argument — which is also what makes qty > 1 correct on a fly.
//
// SINGLE / VERTICAL / CUSTOM is the same ladder combo-order.js already picks between.
function buildOrderPayload(resolvedLegs, limit, quantity, net /* 'DEBIT'|'CREDIT' */) {
  const merged = CO.mergeLegs(resolvedLegs, quantity);
  // mergeLegs drops a strike whose net is zero. That cannot happen on any structure we send (it would be
  // a spread against itself), but if it ever did, sending the un-merged legs is safer than sending none.
  const legs = merged.length ? merged : resolvedLegs.map(l => ({ ...l, quantity }));
  const strategy = legs.length === 1 ? 'NONE' : legs.length === 2 ? 'VERTICAL' : 'CUSTOM';
  return {
    orderType: net === 'CREDIT' ? 'NET_CREDIT' : 'NET_DEBIT',
    session: 'NORMAL',
    price: limit,
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    complexOrderStrategyType: strategy,
    orderLegCollection: legs.map(l => ({
      instruction: l.side === 'long' ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN',
      quantity: l.quantity || quantity,
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
async function placeRestingCover(pos, plan, cfg, deps, candleTime, decisions, note, minLock, st) {
  const W = cfg.spreadWidth, tick = cfg.tickIncrement;
  // minLock (price units, 0 unless the caller is CONTINUOUS COVERING): the resting target is the price
  // that still LOCKS A REAL PROFIT, not bare break-even. Resting at break-even (W − openCost) fills the
  // instant the cover is barely acceptable, which is a bad trade on a deep winner — measured in backtest
  // as strictly WORSE than not doing it at all (v6-20 $135,713 -> $105,690). Both the BOOKED target and
  // the SENT limit must carry it or we would rest at one price and book at another.
  const ML = minLock || 0;
  // CAPITAL RECAPTURE: prefer a CREDIT cover on a deep-ITM winner (reclaim ~width cash). LEG-UNIQUENESS:
  // resolve so no cover leg is traded the wrong way — ideal → credit twin (same strikes) → WING-SHIFT
  // (anchor cover: long wing out to a free strike) → skip (leave uncovered). The resting-fill BOOKING stays
  // debit-canonical (pendingCover.legs) so the floor + settlement P&L are right for the position's own
  // style; only the SENT order + the cash ledger differ. Wing-shift books/settles at the wider wing.
  let style = 'debit', wing = W, shift = 0, anchor = pos.shortStrike;
  {
    const m = coverMarkNow(pos.legs, deps.getLeg);
    const legacy = deps.capitalRecapture === true
      && m != null && m >= (deps.creditCoverFrac != null ? deps.creditCoverFrac : 0.65) * W;
    if (creditPreferred(st, deps, legacy)) style = 'credit';
  }
  // RESOLVE now, COMMIT after the send. The resolver has to run here — its answer decides which legs we
  // send — but recording them is a commitment, and it used to happen unconditionally, before the send and
  // before the `if (!sentOk)` bail below. So `cover-not-sent` (unquotable sent legs, or a non-positive
  // price, or now a Schwab rejection) permanently burned those strikes for the rest of the day. Nothing
  // can un-record them: makeLegLedger exposes record/conflicts/sideOf and no reverse. Every later cover
  // then resolved around strikes nobody traded, which is what pushes covers onto the ITM-slide path —
  // the one that locked a guaranteed loss on 98 of 103 shifted covers.
  let ledgerLegs = null;
  if (deps.enforceLegUniqueness && deps._ledger) {
    const rc = LL.resolveCover(pos.side, pos.shortStrike, W, deps._ledger, { preferStyle: style, incr: cfg.strikeIncrement, maxWingShift: deps.legMaxWing || 8 });
    if (rc.resolution === 'skip') { decisions.push({ action: 'cover-skip-leg', positionId: pos.id }); return; }   // can't place — stays uncovered
    style = rc.style; wing = rc.wing; shift = rc.shift || 0; anchor = rc.anchor != null ? rc.anchor : pos.shortStrike;
    ledgerLegs = rc.legs;
  }
  // BOOK debit-canonical at the resolved ANCHOR. The resolver now slides the whole spread at CONSTANT
  // width rather than widening it, so `wing === W` always and the lock arithmetic below stays true.
  const bookLegs = shift ? CL.coverLegsFor(pos.side, anchor, W, 'debit') : plan.legs;
  const brl = resolveLegs(bookLegs, deps.getLeg);
  // A broken quote here used to clamp to one tick and BOOK a cover at $0.05. null falls through to
  // lockTarget below, which is the honest answer: price it off the lock, not off a number that cannot be.
  const bookMark = brl.error ? null : saneMark(bookLegs, round2(brl.longMid - brl.shortMid));
  // COVER PRICING (deps.coverPriceMode, default 'lock' = the historical behaviour).
  //   'lock' — rest at W - openCost - minLock: a price derived from a HOPED-FOR profit, not from the
  //            market. Measured on the real 2026-09-09 session this put 733 of 735 unfilled covers BELOW
  //            the market at placement, a median 64% below the mark; they could never have filled, and
  //            the ones that did fill only filled after the cover decayed to the target.
  //   'mark' — rest at the cover's CURRENT mark (+ coverSlipTicks). A cover placed on a signal is there
  //            to protect capital, so it must not assume a profit; a proactive cover may vary its price
  //            but still off the mark. This is the user's rule, 2026-09-09.
  const markMode = deps.coverPriceMode === 'mark';
  const slip = (deps.coverSlipTicks != null ? deps.coverSlipTicks : 1) * tick;
  const lockTarget = round2(W - pos.limit - ML);
  // Lock mode always rests at the profit-lock price. It used to fall back to the cover's own mark whenever
  // the legs had been shifted, which is how a resolver-shifted cover came to be BOUGHT AT MARK and lock a
  // guaranteed loss; with a constant-width slide there is no wider instrument to price off, so the lock
  // target is the only correct price and a cover that cannot reach it simply rests unfilled.
  const target = markMode
    ? (bookMark != null ? round2(Math.max(tick, bookMark)) : lockTarget)
    : lockTarget;
  // placedEpoch / placedUnder are what the ladder walks on: how long this has rested and how far the
  // underlying has travelled since. Without them a resting order has no way to know it has gone stale.
  // BUILT, NOT YET ATTACHED. This used to be assigned to pos.pendingCover here, before the send below —
  // which is inside `if (!srl.error)` and `if (price > 0)`. When the SENT legs are unquotable (they are a
  // different instrument from the booked ones whenever the style is credit or the resolver shifted) or
  // the price comes back non-positive, no order goes to the broker at all — but the pending cover existed
  // anyway, and resolveRestingCovers would book it as filled and credit its floor to realizedPnl.
  // A lock reported for an order that was never placed. Attached only after a send is confirmed.
  const pending = { legs: bookLegs, target, geometry: plan.geometry, longStrike: plan.longStrike,
    markAtPlace: plan.mark, placedAt: candleTime, placedEpoch: Date.now(), placedUnder: deps.underlying != null ? deps.underlying : null,
    minLock: ML, openCost: pos.limit };
  // SEND the resolved cover (debit or credit) at the resolved wing.
  const sendLegs = (style === 'debit' && !shift) ? plan.legs : CL.coverLegsFor(pos.side, anchor, W, style);
  const srl = resolveLegs(sendLegs, deps.getLeg);
  let restOrderId = null, sentNet = 'DEBIT', sentCredit = null, price = 0, sentOk = false;
  if (!srl.error) {
    // THE DEBIT PRICE FIRST, ALWAYS — the credit twin is derived from it rather than priced on its own.
    //
    // These two branches used to answer DIFFERENT QUESTIONS. The debit cover rests at the profit-LOCK
    // target (W - openCost - minLock): a price chosen to bank a result. The credit twin was priced at its
    // own chain MARK, which is a price chosen to trade. On a 40-wide with a lock target of 8.6 the twin
    // therefore asked 21.6 credit where parity demands W - 8.6 = 31.4 — nearly $1,000 a contract less,
    // so it filled far too easily and locked far less than the book recorded.
    //
    // Measured on 2026-09-17: 258 of 284 credit-style covers asked less credit than their own target
    // implied, $107,950 of credit not asked for in a single session. Deriving the twin from the debit
    // price makes the two economically identical by construction, which is the only reason the record is
    // allowed to stay debit-canonical.
    let debitPrice = null;
    if (markMode) {
      // Pay the market. The sent limit is the SENT legs' own mark plus the slip, independent of the
      // booked target above (they can differ when a wing-shift moved the legs).
      // Was Math.max(tick, m + slip): a negative mark from a broken chain became a $0.05 cover order.
      // Leaving price at 0 makes the `if (price > 0)` guard below skip the send, so the cover simply is
      // not placed this bar and is retried on the next one with a fresh quote.
      const markLegs = style === 'credit' ? CL.coverLegsFor(pos.side, anchor, W, 'debit') : sendLegs;
      const mrl = style === 'credit' ? resolveLegs(markLegs, deps.getLeg) : srl;
      const m = mrl.error ? null : saneMark(markLegs, round2(mrl.longMid - mrl.shortMid));
      if (m != null) debitPrice = L.roundToTick(Math.max(tick, round2(m + slip)), tick);
    } else {
      debitPrice = L.roundToTick(round2(W - pos.limit - ML), tick);
    }
    if (style === 'credit') {
      // Receive exactly what the debit twin would have paid away: credit = W - debit. The credit twin
      // concedes the slip in the same direction the debit one pays it (see openSlip's mirror note).
      if (debitPrice != null && debitPrice > 0 && debitPrice < W) {
        sentNet = 'CREDIT';
        // round2 AFTER roundToTick: `Math.round(x/tick)*tick` is not exact in binary, so 24 ticks comes
        // back as 12.950000000000001 rather than 12.95. The resting-cover fill test asks
        // `creditNow >= sentCredit` against a round2'd market credit, so that hair refuses a market
        // offering exactly the price we asked. It bit 47 of 173 resting credit covers (27%) across
        // 2026-09-16/17, and always in the direction that COSTS a fill — the epsilon is high, so we
        // silently ask for a fraction of a cent more than we meant to.
        price = sentCredit = round2(L.roundToTick(Math.min(round2(W - tick), round2(W - debitPrice)), tick));
      }
    } else if (debitPrice != null) {
      price = debitPrice;
    }

    if (price > 0) {
      const payload = buildOrderPayload(srl.resolved, price, cfg.quantity, sentNet);
      const placed = await deps.placeOrder(payload, { kind: 'cover-rest', of: pos.id, legs: sendLegs, limit: price, net: sentNet, mark: plan.mark });
      restOrderId = (placed && placed.orderId) || null;
      // THE SEND HAS TO HAVE SUCCEEDED. This was an unconditional `true`, so a Schwab rejection still
      // attached a pendingCover and resolveRestingCovers later booked its floor into realizedPnl — a lock
      // reported for an order the broker refused. The comment above already promised "attached only after
      // a send is confirmed"; it only guarded unquotable legs and a non-positive price.
      sentOk = !!placed && placed.filled !== false;
    }
  }
  // NOTHING WAS SENT -> NOTHING RESTS. Leave the position uncovered so it is visible as exposed and is
  // retried next bar with a fresh quote, rather than silently carrying a lock it does not have.
  if (!sentOk) {
    decisions.push({ action: 'cover-not-sent', positionId: pos.id, style, target,
      reason: srl.error ? `sent legs unquotable (${srl.error})` : 'no valid price' });
    return;
  }
  // The send succeeded, so the strikes are genuinely played now.
  if (ledgerLegs && deps._ledger) deps._ledger.record(ledgerLegs);
  pos.pendingCover = pending;
  pos.coverStatus = 'resting';
  pos.pendingCover.orderId = restOrderId;
  pos.pendingCover.sentNet = sentNet;                   // what really rests at the broker
  pos.pendingCover.sentCredit = sentNet === 'CREDIT' ? sentCredit : null;
  // THE INSTRUMENT THAT IS ACTUALLY RESTING. `legs` above is the debit-canonical BOOKING, which for a
  // credit cover is a different instrument entirely (the twin, option type flipped). Without this the
  // ladder could only ever rebuild the booked legs, so working a credit cover would have replaced the
  // real order with a DEBIT order on the wrong structure. Identical to `legs` for every debit cover,
  // shifted or not, so it costs nothing there.
  pos.pendingCover.sentLegs = sendLegs;
  // `mark` MUST be the mark of the legs actually booked. It used to log plan.mark — the mark of the
  // UNSHIFTED plan that was never sent — sitting next to a target taken from a different instrument, which
  // made a correctly-priced order read as a buy limit far above the market. planMark is kept, named, when
  // the two differ.
  decisions.push({ action: 'cover-rest', positionId: pos.id, target, legs: bookLegs,
    mark: bookMark != null ? bookMark : plan.mark, planMark: shift ? plan.mark : undefined,
    geometry: plan.geometry, longStrike: plan.longStrike, orderId: restOrderId, sentNet,
    // THE PRICE IN THE SPACE IT WAS SENT IN. `target` is debit-canonical, so on a credit cover this
    // decision recorded a number the order never asked for — and the debug table's Cost column shows the
    // credit, so the placement price could not be matched to it. cover-reprice already logs sentFrom/
    // sentTo; the placement had no equivalent until now.
    sentCredit: sentNet === 'CREDIT' ? sentCredit : undefined,
    shift: shift || undefined, minLock: ML || undefined, note });
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
      await placeRestingCover(p, plan, cfg, deps, candleTime, decisions, 'cover-to-stack', undefined, st);
    } else {
      await deps.placeOrder(plan.payload, { kind: 'cover', of: p.id, legs: plan.legs, limit: plan.limit, mark: plan.mark, note: 'cover-to-stack' });
      p.covered = true; p.coverId = nextId('cov'); p.coverLimit = plan.limit; p.coverLegs = plan.legs;
    }
    // ONLY IF A COVER ACTUALLY EXISTS. This flag tells capState to treat the position's at-risk capital as
    // freed, and it used to be set unconditionally — including when placeRestingCover returned early on
    // `cover-skip-leg` or (since the unsent-cover fix) `cover-not-sent`. Nothing anywhere clears it, so a
    // single failed lock removed that position from the cap for the whole session. Reproduced: a $2,200
    // uncovered winner whose cover could not be sent took totalUncov from $2,200 to $0 and flipped riskCap
    // from BLOCKED to OK, admitting an open the cap existed to refuse.
    if (!p.covered && !p.pendingCover) { tried.add(p.id); continue; }   // lock did not happen — still at risk
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
  const wantCredit = creditPreferred(st, deps, cand.m >= (deps.creditCoverFrac != null ? deps.creditCoverFrac : 0.65) * W);
  const rc = LL.resolveCover(winner.side, winner.shortStrike, W, deps._ledger, { preferStyle: wantCredit ? 'credit' : 'debit', incr: cfg.strikeIncrement, maxWingShift: deps.legMaxWing || 8 });
  if (rc.resolution === 'skip') return false;
  const coverSentLegs = (rc.style === 'debit' && rc.wing === W) ? plan.legs : CL.coverLegsFor(winner.side, winner.shortStrike, rc.wing, rc.style);
  const coverBookLegs = (rc.wing === W) ? plan.legs : CL.coverLegsFor(winner.side, winner.shortStrike, rc.wing, 'debit');   // debit-canonical (floor P&L)
  // Booked cover price = min(target = W−openLimit, coverMark+tick) — same as resolveRestingCovers, so the
  // locked floor (W − openLimit − coverLimit) matches the sequential path exactly.
  // Same clamp, same failure: a broken quote used to book the combo's cover leg at one tick.
  const coverMark = saneMark(coverBookLegs, CO.spreadNet(coverBookLegs, mid));
  if (coverMark == null) { decisions.push({ action: 'combo-skip', reason: 'cover mark not sane', winner: winner.id }); return false; }
  const coverLimit = L.roundToTick(Math.max(tick, Math.min(round2(W - winner.limit), coverMark + tick)), tick);

  // 3) re-resolve the open against a TEMP ledger = the real one PLUS the cover, so the open can't net
  // against the lock. Nothing touches the REAL ledger until we commit below → a bail is a clean rollback.
  const tempLedger = LL.makeLegLedger({ ...(st.legLedger || {}) });
  tempLedger.record(rc.legs);
  const wantCreditOpen = creditPreferred(st, deps,
    deps.capitalRecapture === true && Math.floor((st.openN || 0) / (deps.openAlternateEvery || 3)) % 2 === 1);
  const rr = LL.resolveOpen(openSide, res.lower, res.upper, tempLedger, { incr: cfg.strikeIncrement, maxShift: deps.legMaxShift || 6, preferStyle: wantCreditOpen ? 'credit' : 'debit' });
  if (rr.resolution === 'skip') return false;                      // can't place open cleanly → sequential fallback (real ledger untouched)
  const openBook = rr.resolution === 'shift' ? buildOpenAtStrikes(openSide, rr.lo, rr.hi, cfg, deps.getLeg) : res;
  if (openBook.error || openBook.declined) return false;   // over the risk/reward ceiling → no combo either
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
  // NOTHING IS BOOKED OFF A REJECTED COMBO. This is the only path that credits realizedPnl straight from
  // a send result, and it books BOTH spreads plus a locked floor plus a cash entry — so a single 4xx
  // fabricated a tent, a position and a profit. The ledger commit below is on the same footing: a cover
  // that was never sent must not burn its strikes for the rest of the day.
  if (!placed || placed.filled === false) {
    decisions.push({ action: 'combo-not-sent', winner: winner.id, reason: (placed && placed.error) || 'send failed' });
    return false;
  }
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
  noteCash(st, cn.net * 100 * qty);

  decisions.push({ action: 'combo-lock-open', winner: winner.id, openId: pos.id, coverId: winner.coverId, net: cn.side, limit: price, legs: resolvedMerged.length, lockedFloor: floor, cashDeployed: st.cashDeployed });
  return true;
}

// Build the P&L-equivalent CREDIT open order (parity twin of the debit vertical at the same strikes):
// bull → sell the bull put spread, bear → sell the bear call spread. NET_CREDIT priced at the mid credit
// (short leg richer than long). Used only for capital recapture; returns { legs, limit, credit, payload }.
function buildCreditOpenOrder(side, lower, upper, cfg, getLeg, debitMark) {
  const legs = CL.openLegsFor(side, lower, upper, 'credit');
  const { resolved, longMid, shortMid, error } = resolveLegs(legs, getLeg);
  if (error) return { error };
  const credit = round2(shortMid - longMid);
  if (!(credit > 0)) return { error: `non-positive credit (${credit}) — bad quotes` };
  // MIRROR THE SLIP. A debit twin pays a tick OVER the mark to be crossed; the credit twin has to concede
  // the same economics by ACCEPTING a tick less credit. Slipping only the debit side would make the two
  // twins economically different orders, which breaks the parity the recapture alternation depends on —
  // it is exactly what the capital-recapture and leg-uniqueness tests caught.
  const asked = round2(credit - openSlip(cfg));
  // PARITY CHECK ON THE TWIN, and the reason this exists. The credit twin is supposed to be the SAME
  // position as the debit vertical at these strikes, so by put-call parity it must receive exactly
  // W - debitMark. On 2026-09-16 at 14:00 the put legs came back broken and `credit` computed to 9.95 on
  // a 10-wide spread while the engine's own debit mark for the same strikes was 3 — it should have asked
  // 7. The clamp below then hid it: Math.min(W - tick, asked) pinned the nonsense to exactly the ceiling
  // and sent NET_CREDIT $995. Same failure as the $5 covers, in the opposite direction — a price that
  // cannot be right, forced into range instead of refused.
  //
  // Nothing else could have caught this. markFill gates FILLS, not placements, and structurally a 9.95
  // credit on a 10-wide spread is legal (|mark| <= W, credit <= 0), so mark sanity passes it too. Only the
  // twin identity is exact enough to convict it.
  const W = cfg.spreadWidth;
  if (debitMark != null && Number.isFinite(debitMark)) {
    const fair = round2(W - debitMark);
    const tol = Math.max(4 * cfg.tickIncrement, 0.1 * W);   // friction + a tick or two, not a judgement call
    if (Math.abs(credit - fair) > tol) {
      return { error: `credit twin ${credit} disagrees with parity (debit mark ${debitMark} on a ${W} spread implies ${fair})` };
    }
  }
  // NO CEILING CLAMP. A credit above W - tick is not a rich price, it is a broken quote: the twin can
  // never receive more than the width. Refuse it rather than pinning it to the ceiling.
  if (!(asked > 0) || asked > round2(W - cfg.tickIncrement)) {
    return { error: `credit ${asked} outside [0, ${round2(W - cfg.tickIncrement)}] on a ${W} spread — bad quotes` };
  }
  const limit = L.roundToTick(asked, cfg.tickIncrement);
  return { legs, limit, credit, payload: buildOrderPayload(resolved, limit, cfg.quantity, 'CREDIT') };
}

// Book a filled/assumed open into state (shared by the normal path and the cover-to-stack rescue path).
// CAPITAL RECAPTURE (deps.capitalRecapture): every openAlternateEvery opens we flip the ORDER SENT between
// the debit vertical and its parity CREDIT twin, so net cash oscillates instead of draining. The position
// RECORD stays debit-CANONICAL (legs/limit) so floor/settlement/cover/cap logic is byte-identical and P&L
// is provably unchanged (see capital-legs parity test); only the actual sent order + the signed cash
// ledger differ. sentNet/sentLegs record what really went to the broker for fill reconciliation.
async function openPosition(st, res, openSide, cfg, deps, decisions, legStyle) {
  // ONE WORKING OPEN AT A TIME. Now that an open can rest, a second signal on the same side would
  // overwrite st.pendingOpenId and orphan the first — it would sit in st.positions unfilled forever,
  // never resolved and never cancelled. A repeat signal means "still want this", and the existing order
  // is already working (and laddering) toward it; a REVERSED signal cancels it earlier in the tick.
  if (st.pendingOpenId) {
    const prior = st.positions.find(p => p.id === st.pendingOpenId);
    if (prior && !prior.filled) {
      decisions.push({ action: 'open-skip-pending', side: openSide, workingId: prior.id,
        workingSince: prior.openTime, limit: prior.limit });
      return;
    }
    st.pendingOpenId = null;
  }
  const altEvery = deps.openAlternateEvery || 3;
  // Send style: the leg-uniqueness resolver's choice when enforcing (it took the recapture preference but
  // may have flipped to the twin); otherwise the recapture alternation; otherwise debit.
  const style = legStyle || (creditPreferred(st, deps,
    deps.capitalRecapture === true && Math.floor((st.openN || 0) / altEvery) % 2 === 1) ? 'credit' : 'debit');
  let payload = res.payload, sentNet = 'DEBIT', sentLegs = res.legs, sentLimit = res.limit;
  if (style === 'credit') {
    const c = buildCreditOpenOrder(openSide, res.lower, res.upper, cfg, deps.getLeg, res.mark);
    if (!c.error) { payload = c.payload; sentNet = 'CREDIT'; sentLegs = c.legs; sentLimit = c.limit; }
    else if (legStyle) {
      // FORCED TWIN — leg-uniqueness picked the credit style because the debit legs conflict with a
      // position we already hold, so there is no debit to fall back to and the open is abandoned.
      //
      // RECORD WHY. These went from 11 a day to 126 the day the twin gained a parity check and a range
      // refusal (both of which replaced a silent clamp), and the generic message made it impossible to
      // tell an over-strict gate from a genuinely unquotable chain. The refusal reason distinguishes
      // them: `disagrees with parity` is the tolerance biting, `outside [0, W]` is a credit that cannot
      // exist, anything else is the chain. Do not tune either threshold without reading this first.
      decisions.push({ action: 'open-skip-leg', side: openSide, error: 'twin credit unquotable',
        reason: c.error, style: legStyle, lower: res.lower, upper: res.upper, debitMark: res.mark });
      return;
    }
    else decisions.push({ action: 'credit-open-fallback', side: openSide, error: c.error });   // recapture-only: fall back to debit
  }
  const placed = await deps.placeOrder(payload, { kind: 'open', side: openSide, legs: sentLegs, limit: sentLimit, net: sentNet, mark: res.mark });
  // SAME FILL TEST AS EVERY OTHER ORDER (markFill). This was `filled: !!placed.filled`, and placeOrder
  // returns filled:true in simulate — so an open booked whether or not any price supported it, and an
  // unquotable leg still produced a position. Now the observed mark has to reach the limit we placed.
  // With the slip that is normally satisfied at once (a marketable buy), which is the correct answer for
  // an open — the point is that it is now TESTED, and a missing or stale quote no longer books a fill.
  // WHEN CAN THIS NOW FAIL? Only when the legs have no usable quote at all (markFill returns mark null),
  // because the limit ceils to a tick at or above the mark. That distinction matters: an open we chose not
  // to price is not an open the market refused, and there is nothing to work on a spread we cannot quote.
  // We do not make money on opens — we make it on covers, and a cover needs an open that filled — so an
  // open must never fail its own fill test for a rounding reason. If real chasing is ever wanted (bump the
  // limit toward the market over successive candles rather than leaving it), that is a feature to build
  // deliberately, not a side effect of how a price was rounded.
  // REST, do not fill here. Testing an open against the very snapshot that priced it can only ever say
  // yes (limit = ceil(mark) + slip, so mark <= limit by construction), which is why not one open was
  // refused on 2026-09-15. The order now works and is resolved by a LATER observation — the 30s sub-bar
  // pass, or the next candle — exactly the way a resting cover is. That is the only way "filled" carries
  // information. A spread we cannot even quote is not placed at all (resolveLegs already refused above).
  // A REFUSED SEND IS NOT A WORKING ORDER. The open below rests and is resolved by a later observation,
  // which is right — but only if the order is actually at the broker. On a Schwab rejection we would
  // otherwise create a position, ladder its price, reserve its strikes in the leg ledger, and eventually
  // book a fill, for an order that never existed.
  if (!placed || placed.filled === false) {
    decisions.push({ action: 'open-not-sent', side: openSide, legs: sentLegs, limit: sentLimit,
      net: sentNet, reason: (placed && placed.error) || 'send failed' });
    return;
  }
  const openChk = markFill(res.legs, res.limit, deps.getLeg, cfg.tickIncrement);
  const pos = {
    id: nextId('pos'), side: openSide, legs: res.legs, quantity: cfg.quantity,   // debit-CANONICAL (drives all strategy logic)
    // Book what we OFFERED, not markFill's cheap-side price. markFill caps its fill at one tick through
    // the mark (the cover convention); an open placed at mark + N ticks that books at mark + 1 would
    // concede less than its credit twin does, and the twins must stay economically identical. Paying the
    // slip is the whole point of placing it — that is the $5/tick/contract being spent on crossing odds.
    shortStrike: res.shortStrike, mark: res.mark, cap: res.cap, limit: res.limit,
    // LOW-WATER MARK while this order was working. Seeded at the placement mark and pushed down by each
    // sub-bar pass, so the record answers "how far through our price did the market actually trade?"
    // rather than only "was it through at the two instants we happened to look".
    markLow: res.mark,
    orderStatus: placed.status, filled: false, covered: false, coverId: null,
    // THE BROKER'S HANDLE. Never recorded before, which is why neither the open ladder nor cancel-open
    // could reach the order they were talking about: the ladder walked pos.limit in memory while the real
    // order rested at its placement price, and cancel-open deleted the position while the order stayed
    // live at Schwab. A resting cover has carried its orderId since placeRestingCover; an open did not.
    orderId: (placed && placed.orderId) || null,
    openedAt: new Date().toISOString(),
    openTime: st.lastCandleTime || null,   // the CANDLE time (for plotting the trade on the NQ chart timeline)
    openEpoch: st.lastCandleEpoch || null, // 5m-mark epoch ms (robust chart-candle match, no ET parsing)
    sentNet, sentLimit, sentLegs: sentNet === 'CREDIT' ? sentLegs : undefined   // what actually hit the broker
  };
  st.positions.push(pos);
  if (deps.enforceLegUniqueness && deps._ledger) deps._ledger.record(sentLegs);   // record the actual played legs
  st.pendingOpenId = pos.id;
  // Resolve immediately against THIS observation too, so an order that is already marketable does not
  // wait 30s for no reason. The point is not to delay fills, it is to stop asserting them: this call reads
  // the same chain, so it will usually fill at once — and when the market has moved away it will not.
  await resolvePendingOpen(st, cfg, deps, decisions);
  st.direction = openSide;
  st.openN = (st.openN || 0) + 1;
  // CASH IS BOOKED AT THE FILL, NOT HERE — see noteCash() at the open-fill site. This used to add the
  // order's cash the moment it was SENT, which counted capital for orders that never filled and were
  // cancelled on the next candle, and counted the PLACEMENT price for an order the ladder then walked
  // somewhere else. resolvePendingOpen is called just above, so a marketable order still books within
  // this same call.
  // itmStrikes/placementsTried are present only under adaptive placement — recording WHICH placement was
  // taken is what makes maxItmStrikes answerable from live data instead of only from the backtest.
  decisions.push({ action: 'open', positionId: pos.id, side: openSide, legs: res.legs, mark: res.mark, cap: res.cap, limit: res.limit, filled: pos.filled, sentNet, cashDeployed: st.cashDeployed,
    ...(res.itmStrikes != null ? { itmStrikes: res.itmStrikes, placementsTried: res.placementsTried } : {}) });
}

// ── DAY-LOSS GOVERNOR (deps.lossTarget / deps.lossMax) ──────────────────────────────────────────────
// Bounds the BOOK FLOOR — the worst terminal P&L of the whole day's book — rather than at-risk debit.
// riskCap/softCap/hardCap gate `uncovered open debit`, an at-OPEN snapshot that ignores covered pairs'
// locked P&L and RESETS every time the book is covered, so a day could realize ~2x the cap. Since realized
// day P&L = bookPnl(settle) >= floor, holding floor >= -lossMax is a true bound on the day's loss.
//
// TWO gates make it airtight, and BOTH are needed:
//   (a) OPEN GATE — refuse an open whose projected floor would breach lossMax.
//   (b) COVER DEFERRAL — refuse to BOOK a cover that would push the floor through lossMax. Non-obvious
//       but essential: a naked OPPOSITE-side position is the stack's natural tail hedge (it pays exactly
//       where the other side loses), so covering it lifts ITS floor to ~0 but can DROP the book floor.
//       Measured in backtest on 2023-02-21: floor -$6,695 -> -$9,320 with zero new opens, purely from
//       bears being covered while 8 naked bulls stayed on. We own the resting order, so declining the
//       fill is free — it stays working and re-checks next candle. Covers that IMPROVE the floor always
//       book, so this can never trap the book in a worse state.
const govOn = (deps) => deps && deps.lossMax != null;
function bookFloorNow(st, extra) {
  return RC.bookFloor(st.positions.filter(p => p.filled !== false), extra || null, 10);
}

// FLOOR RATCHET (deps.floorRatchet) — protect a floor once we actually have one.
//
// Measured on 2026-09-16: EVERY ONE of 79 variants gave back floor between its intraday peak and 15:00 —
// $278,125 of fleet peak floor down to $48,995, 82% surrendered, with 75 of 79 peaking at or after 14:00.
// A floor is a GUARANTEE (the worst terminal P&L across every settlement price), so handing one back is
// not variance. It is returning money already won.
//
// The rule cannot be "never lower the floor". EVERY debit open lowers it by its debit, because the worst
// terminal case for a new spread is losing what we paid for it — so a literal no-lowering rule is "stop
// trading" with extra steps, and it would also forbid the late opens that GET COVERED and lift the floor
// (the 14:30-15:00 window was floor-accretive on 2026-09-16, which is why a blunt time stop measured
// WORSE than a later one).
//
// So this is a GIVE-BACK BUDGET against a high-water mark: the floor may retreat from its peak by
// floorGiveBackFrac of that peak and no further. Only OPENS are gated. Covers, offsets, wings and flies
// are never gated — they raise the floor or carry their own budgets, and gating them would be backwards.
//
// Engages only once the peak clears floorRatchetMinPeak. Without that guard a fraction-of-peak budget is
// zero while the peak is zero, which would block the morning's first trade and every trade after it.
// Returns the floor level an open must not push the book below, or null when the ratchet is not engaged.
function ratchetLimit(st, deps, nowMin) {
  if (!deps || deps.floorRatchet !== true) return null;
  const peak = st.peakFloor;
  if (!(peak > 0)) return null;
  const minPeak = deps.floorRatchetMinPeak != null ? deps.floorRatchetMinPeak : 1000;
  if (peak < minPeak) return null;
  // AFTER-MINUTE GATE (ET minute-of-day). An always-on ratchet measured -$1.75M over 765 days: it fires
  // through the productive 10:00-14:00 window and is dormant on the days that set the worst floor. The
  // live give-back was concentrated after 14:00. null = no time gate, i.e. the rejected behaviour.
  if (deps.floorRatchetAfterMin != null && !(nowMin >= deps.floorRatchetAfterMin)) return null;
  const frac = deps.floorGiveBackFrac != null ? deps.floorGiveBackFrac : 0.25;
  return peak * (1 - frac);
}

// Update the high-water mark. Called at the END of a bar, after covers, offsets, wings and flies have all
// moved the floor, so the peak reflects a floor we have actually observed rather than one mid-bar state.
function noteFloorPeak(st, deps) {
  if (!deps || deps.floorRatchet !== true) return;
  const f = bookFloorNow(st, null);
  if (Number.isFinite(f) && (st.peakFloor == null || f > st.peakFloor)) st.peakFloor = f;
}

// LOW-COST RISK OFFSET (deps.floorOffset) — the live port of the backtest's buyFloorOffsets, and the
// governor's only tool that REPAIRS a bad floor rather than preventing a worse one. Everything else it
// does is preventive: block an open, defer a cover. This one acts on a book that has ALREADY run through
// the target, by buying the far-side debit spread with the best FLOOR-LIFT PER DOLLAR.
//
// The ratio gate is what keeps it honest: un-forced it only trades an outsized risk reduction for a small
// slice of the peak (default 3:1 lift per dollar). FORCED mode drops the gate entirely and is used only
// when the floor is through lossMax, because that is a ceiling rather than a preference — taking the best
// available repair beats holding out for a good price.
//
// Prices off the REAL CHAIN via getLeg rather than a model, so the ratio is measured on quotes the book
// could actually be repaired at. Respects leg-uniqueness, since a hedge that nets against an existing
// position is not a hedge. Nothing is sent when the search finds no qualifying candidate — an expensive
// repair is worse than the exposure it removes, which is the whole point of the gate.
async function buyFloorOffsets(st, cfg, deps, decisions, candleTime, limit, force) {
  if (!(deps.floorOffset === true) || !govOn(deps)) return 0;
  const spot = deps.underlying;
  if (!(spot > 0)) return 0;
  const minRatio = force ? 0 : (deps.floorOffsetMinRatio != null ? deps.floorOffsetMinRatio : 3);
  const maxCount = (deps.floorOffsetMaxPerDay != null ? deps.floorOffsetMaxPerDay : 6) * (force ? 3 : 1);
  const widths = deps.floorOffsetWidths || [20, 40, 60];
  const depth = deps.floorOffsetDepth != null ? deps.floorOffsetDepth : 8;
  const slip = deps.floorOffsetSlip != null ? deps.floorOffsetSlip : 0.25;
  const budget = deps.floorOffsetBudget != null ? deps.floorOffsetBudget : Infinity;
  const qty = cfg.quantity || 1;
  // Real-chain mark for a single leg; null when the strike is not quoted, which drops that candidate.
  const mark = (type, strike) => { const q = deps.getLeg(type, strike); return q && q.mid != null ? q.mid : null; };
  let bought = 0;
  st.offCount = st.offCount || 0; st.offSpent = st.offSpent || 0;
  // PENDING COUNTS TOWARD THE LIMITS. offCount/offSpent only move when a hedge FILLS (budget should be
  // consumed by hedges we own), so on their own they are no longer this loop's brake: an order that is
  // working leaves both untouched. Neither does the floor check below, because a pending hedge is
  // `filled:false` and is filtered out of the book the floor is computed from — so the floor it is trying
  // to repair never moves either.
  //
  // With all three exits dead this loop pushed a position per iteration forever. On 2026-09-16 it logged
  // the SAME offset (v5-40-cATM C 28930/28950 @1.65) once a second for hours, growing st.positions and
  // rewriting the whole run record each time, until the instance stopped answering. Counting what is
  // already working restores every guard.
  const pendingOff = () => {
    let n = 0, spent = 0;
    for (const p of st.positions) {
      if (p.filled === false && p.pendingHedge && p.pendingHedge.kind === 'offset') {
        n++; spent += (p.pendingHedge.limit || 0) * 100 * qty;
      }
    }
    return { n, spent };
  };
  for (;;) {
    const pend = pendingOff();
    if (st.offCount + pend.n >= maxCount) break;
    if (st.offSpent + pend.spent >= budget) break;
    const filled = st.positions.filter((p) => p.filled !== false);
    const f = RC.bookFloor(filled, null, 10);
    if (-f <= limit) break;                       // floor is back inside the limit — nothing to repair
    // A WORKING OFFSET ALREADY ADDRESSES THIS FLOOR. Without this the loop would queue a second, third,
    // Nth copy of the same repair while the first is still unfilled — which is exactly what it did.
    if (pend.n > 0) break;
    // Which tail carries the loss? The terminal payoff is piecewise-linear with kinks only at strikes, so
    // the worst point is at one of them — the same scan the backtest does, via the shared bookPnl.
    let worstX = spot, worstV = Infinity;
    for (const p of filled) for (const l of p.legs || []) {
      const v = RC.bookPnl(filled, l.strike);
      if (v < worstV) { worstV = v; worstX = l.strike; }
    }
    const zoneSide = worstX >= spot ? 'above' : 'below';
    let best = null;
    for (const cand of RH.candidateHedges(zoneSide, spot, cfg.strikeIncrement, widths, depth)) {
      if (deps.enforceLegUniqueness && deps._ledger && deps._ledger.conflicts(cand.legs)) continue;
      const debit = RH.legsDebit(cand.legs, mark, slip);
      if (debit == null || debit <= 0) continue;
      const cost = debit * 100 * qty;
      if (st.offSpent + pendingOff().spent + cost > budget) continue;
      // STAMP THE TIME. Hedges were the only positions created without openTime/openEpoch, so every UI
      // that orders by time sorted them to the very top with a blank timestamp — they appeared to be the
      // first two trades of the day when they were bought mid-session.
      const hp = { filled: true, side: 'hedge', shortStrike: null, legs: cand.legs, limit: debit,
        // markAtPlace: the mark this order was TESTED against. Recorded on every order type now, not just
        // covers, because "filled" is only as trustworthy as the price behind it and a row with no mark
        // cannot be audited at all. See the note on markFill about how weak that test currently is here.
        markAtPlace: null,
        openedAt: candleTime, openTime: candleTime, openEpoch: deps.nowMs != null ? deps.nowMs : (st.lastCandleEpoch || Date.now()),
        quantity: qty, covered: false, pendingCover: null, coverLegs: null, coverLimit: null, hedge: true };
      const lift = RC.bookFloor(filled.concat([hp]), null, 10) - f;
      if (lift <= 0) continue;
      const ratio = lift / cost;
      if (ratio >= minRatio && (!best || ratio > best.ratio)) best = { hp, cost, ratio, debit, lift };
    }
    if (!best) break;
    const resolved = [];
    for (const l of best.hp.legs) {
      const q = deps.getLeg(l.type, l.strike);
      if (!q || !q.symbol) { resolved.length = 0; break; }
      resolved.push({ ...l, symbol: q.symbol, mid: q.mid });
    }
    if (!resolved.length) break;
    // SAME FILL TEST AS EVERY OTHER ORDER (markFill). An offset used to book filled:true on the strength
    // of its own cost estimate; now the observed mark has to reach the limit we place, and the limit
    // carries the standard slip so it is likelier to be crossed for real.
    const limitPx = round2(best.debit + openSlip(cfg, deps));
    const chk = markFill(best.hp.legs, limitPx, deps.getLeg, cfg.tickIncrement);
    if (chk.mark == null) {                  // unquotable — nothing to work
      decisions.push({ action: 'floor-offset-nofill', legs: best.hp.legs, mark: null, limit: limitPx });
      break;
    }
    best.hp.markAtPlace = chk.mark;
    const payload = buildOrderPayload(resolved, limitPx, qty, 'DEBIT');
    const placed = await deps.placeOrder(payload, { kind: 'floor-offset', legs: best.hp.legs, net: 'DEBIT', limit: limitPx });
    if (!placed || placed.filled === false) break;
    best.hp.id = nextId('off');
    // WORKS rather than books. filled:false keeps it out of every floor/cover path (the `filled !== false`
    // guards) until a later observation says the market reached our price, which is the whole point: an
    // offset we do not own must not reshape a risk curve we are about to act on.
    best.hp.filled = false;
    best.hp.pendingHedge = { limit: limitPx, kind: 'offset', markAtPlace: chk.mark,
      placedEpoch: deps.nowMs != null ? deps.nowMs : (st.lastCandleEpoch || Date.now()) };
    st.positions.push(best.hp);
    if (deps.enforceLegUniqueness && deps._ledger) deps._ledger.record(best.hp.legs);
    bought++;
    decisions.push({ action: 'floor-offset', id: best.hp.id, legs: best.hp.legs, cost: round2(best.cost),
      lift: round2(best.lift), ratio: round2(best.ratio), forced: !!force, limit: limitPx, mark: chk.mark,
      spentToday: round2(st.offSpent) });
  }
  return bought;
}

// WING CONVERSION (deps.wingConvert) — the live port. Turns PEAK into FLOOR: late in a good day the book
// is a tall narrow tent, and a cheap OTM wing on the declining side lifts that wing for a premium that
// costs nothing at the peak. It is the opposite trigger to floorOffset — that repairs a BAD floor, this
// banks a GOOD one — and the constructive answer to "freeze once locked": it banks floor WITHOUT stopping.
//
// Measured over 765 days: ret/DD improves on 7 of 8 $10 variants and the premium pays for itself, with the
// clear, split-sample-stable gain on the $20 book (v6-20 +$33,929 in the first half, +$30,816 in the
// second). The candidate set includes NAKED longs — a long option is a spread whose short strike went to
// infinity — and the score carries an upside term, because floor-lift-per-dollar is structurally blind to
// the uncapped tail and would never pick one.
//
// The band (how far the underlying can plausibly travel by settle) comes from the SAME formula the
// backtest uses — 15m Bollinger width -> implied vol -> spot·iv·√tau — so live and backtest anchor their
// wings on the same expected move rather than two different notions of "far".
async function convertWings(st, cfg, deps, decisions, candleTime) {
  if (!(deps.wingConvert === true)) return 0;
  const spot = deps.underlying;
  const A = deps.A;
  if (!(spot > 0) || !A || !A['15m'] || !st.positions.length) return 0;
  const nowMin = etMinutesOf(candleTime);
  if (deps.wingAfterMin && nowMin != null && nowMin < deps.wingAfterMin) return 0;
  st.wingCount = st.wingCount || 0; st.wingSpent = st.wingSpent || 0;
  const maxPerDay = deps.wingMaxPerDay != null ? deps.wingMaxPerDay : 6;
  const pendW = pendingHedges(st, 'wing', cfg.quantity);
  if (st.wingCount + pendW.n >= maxPerDay) return 0;   // working wings count against the day's cap

  const b = A['15m'];
  // Time-to-expiry from the CANDLE being processed, not the wall clock. Live they coincide, but a replay
  // or a test would otherwise price the band at whatever time the process happens to run — and a tau of
  // ~0 collapses the band to 0, which silently disables wings exactly like the ivSkew NaN did.
  const tau = bs.tauFromTime(deps.nowMs != null ? deps.nowMs : (st.lastCandleEpoch || Date.now()));
  // INTRADAY IV TERM STRUCTURE. Vol is not flat across the session (~1.27x the band-width estimate at the
  // open, ~0.84x into the close), and every backtest baseline is built with this applied. Live omitted it
  // entirely, because the calibration lived under data/ where the deploy package could not reach it — so
  // live bands ran ~21% too narrow at the open and ~19% too wide into the close versus the numbers these
  // strategies were selected on. The band is an expected-move width, so it takes the ATM scalar vol.
  const ivMult = nowMin != null ? IIV.ivMultAt(nowMin) : 1;
  const iv = bs.ivFromRelBandWidth((b.bbupper - b.bblower) / b.close) * ivMult;
  const band = Math.round(spot * iv * Math.sqrt(tau) * (deps.wingBandSigmas != null ? deps.wingBandSigmas : 1.5));
  if (!(band > 0) || !(tau > 0)) return 0;

  // MARKETABLE pricing off the real chain: pay the ask on a long leg, receive the bid on a short. The
  // backtest approximates this with mid ± slip; here the actual quotes are available, so use them.
  const price = (type, strike, legSide) => {
    const q = deps.getLeg(type, strike);
    if (!q) return null;
    const px = legSide === 'long' ? (q.ask != null ? q.ask : q.mid) : (q.bid != null ? q.bid : q.mid);
    return px != null ? px : null;
  };
  const filled = st.positions.filter((p) => p.filled !== false);
  const bookView = filled.map((p) => ({ filled: true, legs: p.legs, limit: p.limit, quantity: p.quantity || cfg.quantity,
    covered: p.covered, coverLegs: p.coverLegs, coverLimit: p.coverLimit }));
  const shape = WC.curveShape(bookView, { step: cfg.strikeIncrement });
  const peakNow = shape ? shape.peak.pnl : 0;
  // There has to be a peak worth converting before any premium is spent — a small tent can never justify
  // it, which is what makes this distinct from floorOffset's must-fix mode.
  const budget = Math.min(deps.wingBudget != null ? deps.wingBudget : Infinity,
    (deps.wingBudgetFrac != null ? deps.wingBudgetFrac : 0.10) * peakNow) - pendW.spent;
  if (!(peakNow > 0) || !(budget > 0)) return 0;

  const plan = WC.planWings(bookView, {
    spot, band, incr: cfg.strikeIncrement, price, qty: cfg.quantity, step: cfg.strikeIncrement, budget,
    maxWings: Math.min(3, maxPerDay - st.wingCount - pendW.n),
    minRatio: deps.wingMinRatio != null ? deps.wingMinRatio : 3,
    outSteps: deps.wingOutSteps, naked: deps.wingNaked,
    upsideLambda: deps.wingUpsideLambda, tailSigmas: deps.wingTailSigmas,
  });
  if (!plan || !plan.wings.length) return 0;

  let bought = 0;
  for (const w of plan.wings) {
    if (deps.enforceLegUniqueness && deps._ledger && deps._ledger.conflicts(w.legs)) continue;
    const resolved = [];
    for (const l of w.legs) {
      const q = deps.getLeg(l.type, l.strike);
      if (!q || !q.symbol) { resolved.length = 0; break; }
      resolved.push({ ...l, symbol: q.symbol, mid: q.mid });
    }
    if (!resolved.length) continue;
    // SAME FILL TEST AS EVERY OTHER ORDER (markFill) — a wing no longer books on its own cost estimate.
    const limitPx = round2(w.cost + openSlip(cfg, deps));
    const chk = markFill(w.legs, limitPx, deps.getLeg, cfg.tickIncrement);
    if (chk.mark == null) {                  // unquotable — nothing to work
      decisions.push({ action: 'wing-nofill', tag: w.tag, legs: w.legs, mark: null, limit: limitPx });
      continue;
    }
    const payload = buildOrderPayload(resolved, limitPx, cfg.quantity, 'DEBIT');
    const placed = await deps.placeOrder(payload, { kind: 'wing', legs: w.legs, net: 'DEBIT', limit: limitPx, naked: !!w.naked });
    if (!placed || placed.filled === false) continue;
    const pos = { id: nextId('wing'), filled: false, side: 'wing', shortStrike: null, legs: w.legs, limit: limitPx,
      markAtPlace: chk.mark, limitSent: limitPx,
      pendingHedge: { limit: limitPx, kind: 'wing', markAtPlace: chk.mark, tag: w.tag,
        placedEpoch: deps.nowMs != null ? deps.nowMs : (st.lastCandleEpoch || Date.now()) },
      openedAt: candleTime, openTime: candleTime, openEpoch: deps.nowMs != null ? deps.nowMs : (st.lastCandleEpoch || Date.now()),
      quantity: cfg.quantity, covered: false, pendingCover: null, coverLegs: null, coverLimit: null, hedge: true, wing: true };
    st.positions.push(pos);
    if (deps.enforceLegUniqueness && deps._ledger) deps._ledger.record(w.legs);
    bought++;   // count + spend move to the FILL (resolvePendingHedges); budget belongs to wings we own
    decisions.push({ action: 'wing', id: pos.id, tag: w.tag, naked: !!w.naked, side: w.side,
      cost: round2(chk.fill * 100 * cfg.quantity), ratio: w.ratio, peakNow: round2(peakNow), spentToday: st.wingSpent,
      mark: chk.mark, limit: limitPx });
  }
  return bought;
}

// FLY / CONDOR VALLEY REPAIR (deps.flyConvert) — the live port of the backtest's opts.flyConvert
// (backtest/backtest-v6-5m.js). Shares fly-convert.js with the backtest, so both engines plan the same
// structures off the same objective; only the PRICES differ (real chain here, Black-Scholes there).
//
// The complement to wingConvert, not a replacement. Wings and offsets only BUY, so they need cheap OTM
// premium and have little potential until late; a fly SELLS THE BODY to fund its wings, so its net cost
// stays small when premium is rich. Measured on 231 real chain snapshots a 30-wide fly is $175 (17:1) at
// 09:30 and $720 (4.2:1) by 15:00 — an early/mid-day tool by its own economics, the mirror image of when
// wings work, which is why flyBeforeMin defaults to 15:00 rather than running to the bell.
//
// It targets the biggest measured leak. Blocking late opens (time cutoff OR positive-floor gate) lost
// total AND ret/DD in all 42 arms tested, so the late opens that erode the floor are net-positive and
// "stop trading" is the wrong answer. Repairing the curve while continuing to trade is what is left.
async function convertFlies(st, cfg, deps, decisions, candleTime) {
  if (!(deps.flyConvert === true)) return 0;
  const spot = deps.underlying;
  const A = deps.A;
  if (!(spot > 0) || !A || !A['15m'] || st.positions.length < 2) return 0;
  const nowMin = etMinutesOf(candleTime);
  const afterMin = deps.flyAfterMin != null ? deps.flyAfterMin : 0;
  const beforeMin = deps.flyBeforeMin != null ? deps.flyBeforeMin : 15 * 60;   // cost/ratio collapses late
  if (nowMin != null && (nowMin < afterMin || nowMin >= beforeMin)) return 0;
  st.flyCount = st.flyCount || 0; st.flySpent = st.flySpent || 0;
  const maxPerDay = deps.flyMaxPerDay != null ? deps.flyMaxPerDay : 4;
  const pendF = pendingHedges(st, 'fly', cfg.quantity);
  if (st.flyCount + pendF.n >= maxPerDay) return 0;    // working flies count against the day's cap

  // SAME band as wings: 15m Bollinger width -> implied vol -> spot*iv*sqrt(tau), with the intraday IV
  // term structure applied. Live and backtest must anchor on the same expected move or they are planning
  // against two different notions of "far".
  const b = A['15m'];
  const tau = bs.tauFromTime(deps.nowMs != null ? deps.nowMs : (st.lastCandleEpoch || Date.now()));
  const ivMult = nowMin != null ? IIV.ivMultAt(nowMin) : 1;
  const iv = bs.ivFromRelBandWidth((b.bbupper - b.bblower) / b.close) * ivMult;
  const band = Math.round(spot * iv * Math.sqrt(tau) * (deps.flyBandSig != null ? deps.flyBandSig : 1.5));
  if (!(band > 0) || !(tau > 0)) return 0;

  // MARKETABLE pricing off the real chain — pay the ask on a long leg, receive the bid on a short. A fly
  // is short the body, so getting this backwards would make it look free.
  const price = (type, strike, legSide) => {
    const q = deps.getLeg(type, strike);
    if (!q) return null;
    const px = legSide === 'long' ? (q.ask != null ? q.ask : q.mid) : (q.bid != null ? q.bid : q.mid);
    return px != null ? px : null;
  };
  const filled = st.positions.filter((p) => p.filled !== false);
  const bookView = filled.map((p) => ({ filled: true, legs: p.legs, limit: p.limit, quantity: p.quantity || cfg.quantity,
    covered: p.covered, coverLegs: p.coverLegs, coverLimit: p.coverLimit }));
  const incr = cfg.strikeIncrement;
  const budget = Math.max(0, (deps.flyBudget != null ? deps.flyBudget : 1500) - st.flySpent - pendF.spent);
  if (!(budget > 0)) return 0;

  const plan = FY.planFlies(bookView, {
    spot, band, incr, price, qty: cfg.quantity, step: incr, budget,
    maxFlies: Math.min(2, maxPerDay - st.flyCount - pendF.n),
    minRatio: deps.flyMinRatio != null ? deps.flyMinRatio : 3,
    widths: deps.flyWidths || [2 * incr, 3 * incr, 4 * incr],
    condors: deps.flyCondors !== false,
  });
  if (!plan || !plan.flies.length) return 0;

  let bought = 0;
  for (const f of plan.flies) {
    if (deps.enforceLegUniqueness && deps._ledger && deps._ledger.conflicts(f.legs)) continue;
    const resolved = [];
    for (const l of f.legs) {
      const q = deps.getLeg(l.type, l.strike);
      if (!q || !q.symbol) { resolved.length = 0; break; }
      resolved.push({ ...l, symbol: q.symbol, mid: q.mid });
    }
    if (!resolved.length) continue;
    // SAME FILL TEST AS EVERY OTHER ORDER (markFill) — a fly does not book on its planned cost either.
    const limitPx = round2(f.cost + openSlip(cfg, deps));
    const chk = markFill(f.legs, limitPx, deps.getLeg, cfg.tickIncrement);
    if (chk.mark == null) {                  // unquotable — nothing to work
      decisions.push({ action: 'fly-nofill', tag: f.tag, legs: f.legs, mark: null, limit: limitPx });
      continue;
    }
    const payload = buildOrderPayload(resolved, limitPx, cfg.quantity, 'DEBIT');
    const placed = await deps.placeOrder(payload, { kind: 'fly', legs: f.legs, net: 'DEBIT', limit: limitPx, condor: !!f.condor });
    if (!placed || placed.filled === false) continue;
    const pos = { id: nextId('fly'), filled: false, side: 'fly', shortStrike: null, legs: f.legs, limit: limitPx,
      markAtPlace: chk.mark, limitSent: limitPx,
      pendingHedge: { limit: limitPx, kind: 'fly', markAtPlace: chk.mark, tag: f.tag,
        placedEpoch: deps.nowMs != null ? deps.nowMs : (st.lastCandleEpoch || Date.now()) },
      openedAt: candleTime, openTime: candleTime, openEpoch: deps.nowMs != null ? deps.nowMs : (st.lastCandleEpoch || Date.now()),
      quantity: cfg.quantity, covered: false, pendingCover: null, coverLegs: null, coverLimit: null, hedge: true, fly: true };
    st.positions.push(pos);
    if (deps.enforceLegUniqueness && deps._ledger) deps._ledger.record(f.legs);
    bought++;   // count + spend move to the FILL (resolvePendingHedges)
    decisions.push({ action: 'fly', id: pos.id, tag: f.tag, condor: !!f.condor, legs: f.legs,
      cost: round2(chk.fill * 100 * cfg.quantity), ratio: f.ratio, band, mark: chk.mark, limit: limitPx,
      spentToday: st.flySpent });
  }
  return bought;
}


// "MM/DD HH:MM" -> minutes from ET midnight, for the wing time gate.
function etMinutesOf(candleTime) {
  const m = /(\d{1,2}):(\d{2})\s*$/.exec(String(candleTime || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
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

  // (1) WORK THE UNFILLED OPEN — rest it, ladder it toward the market, and cancel it only on a REVERSAL.
  //
  // This used to cancel any unfilled open unconditionally at the next candle. The original rule was
  // narrower than that and still holds: we do not want a stale open working once the signal has FLIPPED.
  // Until it flips we want the order resting exactly like a cover, and worked the same way — an open that
  // never fills is a cover we never get to place, and covers are where the money is.
  //
  // An unfilled position stays in st.positions and is excluded from every floor, cover and settlement
  // path by the `filled !== false` guards already in place, so resting it changes no risk arithmetic.
  if (st.pendingOpenId) {
    const pos = st.positions.find(p => p.id === st.pendingOpenId);
    if (!pos || pos.filled) {
      st.pendingOpenId = null;
    } else {
      // REVERSAL = the signal now wants the other side, or wants this side covered. Either way the order
      // was placed on a view the engine no longer holds, so it goes rather than filling into a flip.
      const reversed = (openSide && openSide !== pos.side) || coverSet.includes(pos.side);
      if (reversed) {
        pos.orderStatus = 'cancelled';
        // AND CANCEL IT AT THE BROKER. This deleted the position locally and left the order working at
        // Schwab. The engine then opened the OTHER side, so both orders were live and both could fill —
        // double, opposed exposure on a view the engine no longer held. Nothing pulled it except the
        // order manager's stale sweep, up to 15 minutes later, and only because its kind happens to be
        // 'open'; a reversal is the core signal, so this is a normal-day occurrence, not an edge case.
        //
        // Fire-and-forget on purpose: the local decision stands either way (the order was placed on a
        // view we have abandoned), and a cancel that fails is recorded by the sender. Waiting on Schwab
        // here would stall the tick for every variant behind it.
        if (deps.cancelOrder && pos.orderId) {
          Promise.resolve(deps.cancelOrder(pos.orderId, { kind: 'cancel-open', of: pos.id, reason: 'reversal' }))
            .catch(() => { /* the sender logs it; never let a cancel break the tick */ });
        }
        decisions.push({ action: 'cancel-open', positionId: pos.id, side: pos.side, limit: pos.limit,
          orderId: pos.orderId || null, cancelSent: !!(deps.cancelOrder && pos.orderId),
          reason: openSide && openSide !== pos.side ? `reversal → ${openSide}` : `cover signal on ${pos.side}` });
        st.positions = st.positions.filter(p => p.id !== pos.id);
        st.pendingOpenId = null;
      } else {
        await resolvePendingOpen(st, cfg, deps, decisions);   // still our view — try to fill it, else work it
      }
    }
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

  // (2b) CONTINUOUS COVERING (deps.continuousCover) — keep a standing resting cover on EVERY uncovered
  // position, from the moment it opens, at the price that still locks a real profit
  // (W − openCost − minLockFrac×W). Not signal-triggered and not risk-triggered: the objective is
  // "open as many tents as possible, lock as often as possible, keep risk low, let the closing price
  // decide the upside". Measured as the single biggest improvement in backtest — ON beat OFF in 9/9
  // variants on both fill models, and OFF averaged only 43.9% of achievable.
  //
  // PLACED BEFORE the reversal cover ON PURPOSE: step (3) filters out positions that already have a
  // resting cover working, so continuous covering PRE-EMPTS the reversal cover — which is exactly the
  // ordering the backtest measured (its continuous-cover pass runs ahead of the signal cover and the
  // signal cover skips anything already pending). Reversing the order here would silently trade a
  // different strategy from the one the baselines describe.
  if (ported && deps.continuousCover === true && cfg.coverFillModel === 'resting') {
    // DYNAMIC minLock (deps.minLockRamp, default OFF = the constant it has always been). The live port of
    // the backtest's ramp — same four knobs, same linear interpolation on the ET minute, so the two engines
    // compute the identical target for the identical bar.
    //
    // WHY: `W - openCost - minLock` is a FIXED price but the premium it competes against DECAYS all day.
    // Early it sits far below a rich mark and cannot fill, so the position sits naked for hours; by
    // afternoon the same target is reachable. Measured across 29 variants, ramping raised COVER FILL on
    // 29/29 (mean +4.1 pts) and, on the variants where covers were being skipped outright, raised covers
    // PLACED by up to 21% — the `W - open - minLock <= 0` gate below stops rejecting them.
    //
    // IT IS NOT A FREE WIN AND IS NOT A FLEET DEFAULT: uncapped it trades floor for those fills and loses
    // on 18 of 29 variants (-$1.1M aggregate). It only pays where a tight day-loss cap already bounds the
    // floor, which is why it ships ON for v7-10 (lossMax $1,000) and OFF everywhere else. See index.js.
    let minLock = (deps.continuousCoverMinLockFrac || 0) * cfg.spreadWidth;
    if (deps.minLockRamp) {
      const a = deps.minLockRampStart != null ? deps.minLockRampStart : 9 * 60 + 30;
      const b = deps.minLockRampEnd != null ? deps.minLockRampEnd : 12 * 60 + 30;
      const from = deps.minLockRampFrom != null ? deps.minLockRampFrom : 0;
      const to = deps.minLockRampTo != null ? deps.minLockRampTo : 1;
      const now = etMinutesOf(candleTime);
      // No clock (a malformed candle time) must not silently mean "ask for nothing" — fall back to the
      // full constant lock, the safe end of the ramp.
      const prog = now == null ? 1 : (b > a ? Math.max(0, Math.min(1, (now - a) / (b - a))) : 1);
      minLock = minLock * (from + (to - from) * prog);
    }
    // ARMING (deps.continuousCoverArmFrac / continuousCoverOppRatio) — unset keeps the original
    // behaviour: rest a cover on EVERY position the instant it opens, which maximises locking but decides
    // each position's outcome at birth. When set, arm on either:
    //   (a) BOOK RISK — the day's worst case has reached armFrac x lossTarget, the governor's own measure;
    //   (b) OPPORTUNITY — this cover is cheap enough to lock at least oppRatio x what it costs. Without
    //       (b) a couple of deep winners can sit uncovered through a whole reversal purely because total
    //       book risk never approached the target; lockDeepWinners does not catch that, being gated on the
    //       floor ALREADY breaching lossTarget.
    const armFrac = deps.continuousCoverArmFrac, oppRatio = deps.continuousCoverOppRatio;
    const armedByRisk = armFrac == null
      || (deps.lossTarget != null && -bookFloorNow(st) >= armFrac * deps.lossTarget);
    for (const pos of st.positions) {
      if (!pos.filled || pos.covered || pos.pendingCover) continue;
      if (round2(cfg.spreadWidth - pos.limit - minLock) <= 0) continue;   // target underwater → no order
      const plan = selectCoverGeometric(pos, cfg, deps.getLeg, underlying);
      if (plan.error) continue;
      if (!armedByRisk) {
        // Not armed by book risk — take it only if it stands on its own as a trade.
        if (oppRatio == null) continue;
        const cost = plan.mark;
        const locked = cfg.spreadWidth - pos.limit - cost;
        if (!(cost > 0) || locked < oppRatio * cost) continue;
        decisions.push({ action: 'cover-arm-opportunity', positionId: pos.id, cost, locked: round2(locked),
          ratio: round2(locked / cost), geometry: plan.geometry });
      }
      await placeRestingCover(pos, plan, cfg, deps, candleTime, decisions, 'continuous', minLock, st);
    }
  }

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
        await placeRestingCover(pos, plan, cfg, deps, candleTime, decisions, undefined, undefined, st);
      } else {
        // ASSUME-FILL model (v0 reference): book the cover immediately at mark+tick.
        const placed = await deps.placeOrder(plan.payload, { kind: 'cover', of: pos.id, legs: plan.legs, limit: plan.limit, mark: plan.mark });
        if (!placed || placed.filled === false) {
          decisions.push({ action: 'cover-not-sent', positionId: pos.id, reason: (placed && placed.error) || 'send failed' });
          continue;                       // a refused order is not a cover; the position stays exposed
        }
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
        if (!plan.error && cfg.coverFillModel === 'resting') await placeRestingCover(pos, plan, cfg, deps, candleTime, decisions, 'proactive-deep-itm', undefined, st);
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
    // adaptiveGeo (per-variant, default OFF -> byte-identical to the fixed placement) walks the strike
    // to the most ITM placement still inside the ceiling instead of taking or declining a single one.
    let res = cfg.adaptiveGeo
      ? buildOpenAdaptive(openSide, underlying, cfg, deps.getLeg)
      : buildOpen(openSide, underlying, cfg, deps.getLeg);
    // LEG-UNIQUENESS: resolve strikes + style BEFORE the caps/send so a shifted spread is capped
    // correctly. ideal → parity twin (same strikes) → shift → skip. legStyle drives the actual send.
    let legStyle = null, legSkipped = false;
    if (deps.enforceLegUniqueness && deps._ledger && !res.error && res.limit > 0) {
      const wantCredit = creditPreferred(st, deps,
        deps.capitalRecapture === true && Math.floor((st.openN || 0) / (deps.openAlternateEvery || 3)) % 2 === 1);
      // openNeverOtm: an initial order must not START fully out of the money. Adaptive placement already
      // guarantees it; without this the shift below rebuilt at the shifted strikes and could cross out.
      const allow = deps.openNeverOtm ? ((lo, hi) => LL.notFullyOtm(openSide, lo, hi, underlying)) : undefined;
      const rr = LL.resolveOpen(openSide, res.lower, res.upper, deps._ledger, { incr: cfg.strikeIncrement, maxShift: deps.legMaxShift || 6, preferStyle: wantCredit ? 'credit' : 'debit', allow });
      if (rr.resolution === 'skip') { decisions.push({ action: 'open-skip-leg', side: openSide, lower: res.lower, upper: res.upper }); legSkipped = true; }
      else {
        if (rr.resolution === 'shift') {
          // LOG THE SHIFT. It used to rebuild silently, so the recorded action:'open' showed the shifted
          // legs as if the geometry had chosen them — which is why strikes landing off-placement went
          // unnoticed. Record where it wanted to be, where it went, and what that cost.
          const before = res;
          res = buildOpenAtStrikes(openSide, rr.lo, rr.hi, cfg, deps.getLeg);
          decisions.push({ action: 'open-shift', side: openSide, reason: 'leg-uniqueness',
            fromLower: before.lower, fromUpper: before.upper, toLower: rr.lo, toUpper: rr.hi,
            shift: rr.shift, style: rr.style, underlying,
            markBefore: before.mark != null ? before.mark : null,
            markAfter: res && res.mark != null ? res.mark : null });
        }
        legStyle = rr.style;
      }
    }
    if (legSkipped) {
      // already logged; the leg constraint blocked every placement
    } else if (res.declined) {
      decisions.push({ action: 'open-skip-ceiling', side: openSide, reason: res.reason, mark: res.mark, cap: res.cap, placementsTried: res.placementsTried });
    } else if (res.error) {
      decisions.push({ action: 'open-skip', side: openSide, error: res.error });
    } else if (!(res.limit > 0)) {
      decisions.push({ action: 'open-skip', side: openSide, error: `non-positive limit (${res.limit}) — bad quotes`, mark: res.mark });
    } else if (govOn(deps) && -bookFloorNow(st, { filled: true, legs: res.legs, limit: res.limit, quantity: cfg.quantity, covered: false }) > deps.lossMax) {
      // GOVERNOR OPEN GATE — this open would push the day's worst terminal outcome through the ceiling.
      // Evaluated on the FINAL res, after any leg-uniqueness shift, so we gate what we would actually send.
      const projected = round2(bookFloorNow(st, { filled: true, legs: res.legs, limit: res.limit, quantity: cfg.quantity, covered: false }));
      decisions.push({ action: 'open-skip-governor', side: openSide, projectedFloor: projected, lossMax: deps.lossMax, limit: res.limit });
    } else if (ratchetLimit(st, deps, etMinutesOf(candleTime)) != null
        && bookFloorNow(st, { filled: true, legs: res.legs, limit: res.limit, quantity: cfg.quantity, covered: false }) < ratchetLimit(st, deps, etMinutesOf(candleTime))) {
      // FLOOR RATCHET OPEN GATE — this open would surrender more of the day's locked floor than the
      // give-back budget allows. Same evaluation point as the governor gate (the FINAL res, post-shift),
      // for the same reason: gate what we would actually send. The two are independent — the governor
      // bounds the ABSOLUTE loss, this one bounds the RETREAT FROM THE PEAK, and a book can be nowhere
      // near lossMax while still giving back a won floor.
      const lim = ratchetLimit(st, deps, etMinutesOf(candleTime));
      const projected = round2(bookFloorNow(st, { filled: true, legs: res.legs, limit: res.limit, quantity: cfg.quantity, covered: false }));
      decisions.push({ action: 'open-skip-ratchet', side: openSide, projectedFloor: projected,
        peakFloor: round2(st.peakFloor), ratchetFloor: round2(lim), limit: res.limit });
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
  // Work the orders BEFORE testing for fills: a repriced limit should be eligible to fill on this very
  // candle, not the next one.
  if (cfg.coverFillModel === 'resting') await workRestingCovers(st, cfg, decisions, deps, underlying);
  if (cfg.coverFillModel === 'resting') resolveRestingCovers(st, cfg, deps.getLeg, decisions, deps);
  // Hedges placed earlier in THIS tick get their first look here; anything still working is re-tested by
  // the 30s sub-bar pass and by every later candle until it fills or expires.
  resolvePendingHedges(st, cfg, deps, decisions);

  // RISK-REDUCTION LADDER, cheapest removal first — mirrors the backtest's reduceRisk(), and runs AFTER
  // covers resolve so a cover that just filled already counts toward the floor. Locking winners is the
  // free step and is handled by cover-to-stack above; what remains is the premium-spending step:
  //   (1) ratio-gated offsets toward the WORKING TARGET — outsized risk reduction for a small slice of peak
  //   (2) MUST-FIX toward the HARD CEILING — take the best available lift regardless of ratio, because
  //       lossMax is a ceiling and not a preference.
  if (govOn(deps) && deps.floorOffset === true) {
    const floorNow = () => RC.bookFloor(st.positions.filter((p) => p.filled !== false), null, 10);
    if (deps.lossTarget != null && -floorNow() > deps.lossTarget) {
      await buyFloorOffsets(st, cfg, deps, decisions, candleTime, deps.lossTarget, false);
    }
    if (deps.lossMax != null && -floorNow() > deps.lossMax) {
      await buyFloorOffsets(st, cfg, deps, decisions, candleTime, deps.lossMax, true);
    }
  }
  // WING CONVERSION runs after the reduction ladder and is its mirror image: the ladder repairs a floor
  // that is through the target, this banks a floor that is already good. Deliberately NOT gated on the
  // governor — a book can be worth converting while nowhere near the cap, which is the case floorOffset
  // structurally cannot reach.
  await convertWings(st, cfg, deps, decisions, candleTime);
  // FLY/CONDOR VALLEY REPAIR runs alongside wings and is their complement, not their competitor: wings
  // buy OTM premium to bank a peak (late-day economics), a fly sells the body to fund its wings and
  // repairs a valley (early/mid-day economics). Both are ungated by the governor for the same reason.
  await convertFlies(st, cfg, deps, decisions, candleTime);

  // FLOOR RATCHET — record the bar's high-water floor LAST, once every floor-moving action above has run.
  // Placed here rather than at the open gate on purpose: the open on the next bar is then measured against
  // a floor this bar actually closed at, not a mid-bar value that a later cover would have changed anyway.
  noteFloorPeak(st, deps);

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
    // THE PRICING BAR'S OWN OHLC. `underlying` is its CLOSE, which is all we used to keep — so the
    // session open never entered the record and "how much of this move did we get" could only ever be
    // answered from the 09:35 close. On 2026-09-23 that hid 69 of the day's 236-point decline inside the
    // first bar. Null on older runs and whenever the price feed did not supply a bar.
    priceCandle: deps.priceBar || null,
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
  // spreadShift (default 0 = ATM) shifts the spread ITM for the $40 short-ATM geometry; capFrac is the
  // risk/reward CEILING (default 0.65 of width) and GATES the trade — it never sets the price.
  const { lower, upper } = L.spreadStrikesShifted(center, cfg.spreadWidth, cfg.spreadShift || 0, side);
  return buildOpenAtStrikes(side, lower, upper, cfg, getLeg);
}

// ADAPTIVE STRIKE PLACEMENT — the live port of backtest-width.makeAdaptiveGeo.
//
// The user's actual discretion: early in the session, when a spread is cheap, put the short leg AT or
// INSIDE the money; as the day burns, the same placement gets expensive and the choice walks back out
// toward straddle. ONE RULE reproduces all of it — take the MOST ITM placement whose real price is still
// within the risk/reward ceiling, floored at straddle — and it is self-adjusting, needing no time input.
//
// Why this matters more than it looks: we do not make money on opens, we make money on COVERS, and an ITM
// spread covers more easily (the offsetting side is cheaper when the short is ITM). Fixed geometry either
// overpays for one placement or declines and loses the trade entirely; walking the strike keeps the fill
// AND buys as much ITM as the budget allows. Measured over 765 days it beat fixed on both total and
// ret/DD in all 30 governed variants.
//
// LIVE IS THE BETTER HALF OF THIS. The backtest has to model each candidate's price; here every candidate
// is priced off the REAL CHAIN through buildOpenAtStrikes/getLeg, so the ceiling is applied to a quote
// rather than an estimate. Nothing is sent while searching — this is pricing, not ordering.
//
// Ordered MOST ITM first, ending at straddle (short leg just OTM). A placement with no chain quote is
// skipped rather than fatal: a missing strike is a gap in the chain, not a reason to abandon the signal.
function buildOpenAdaptive(side, underlying, cfg, getLeg) {
  const incr = cfg.strikeIncrement, W = cfg.spreadWidth;
  const center = L.centerStrike(underlying, incr);
  // On a coarse grid the exact straddle can be off-grid, in which case short-at-the-money is the
  // least-ITM placement available — still never OTM, which is an opening rule, not a preference.
  const halfOnGrid = Math.floor((W / 2) / incr) * incr;
  const maxItm = cfg.maxItmStrikes != null ? cfg.maxItmStrikes : 3;
  const strikesAt = (k) => {
    const off = k * incr;
    const shortStrike = side === 'bull' ? center + off : center - off;
    return side === 'bull' ? { lower: shortStrike - W, upper: shortStrike } : { lower: shortStrike, upper: shortStrike + W };
  };
  let tried = 0, lastDeclined = null, lastError = null;
  for (let k = -maxItm; k <= halfOnGrid / incr; k++) {
    const { lower, upper } = strikesAt(k);
    const res = buildOpenAtStrikes(side, lower, upper, cfg, getLeg);
    if (res.error) { lastError = res.error; continue; }
    tried++;
    if (res.declined) { lastDeclined = res; continue; }
    // PRICE-FOR-STRIKES FLEX (cfg.capFlexFrac, default 0 = off, byte-identical to before). The ceiling
    // walks the placement OUT until the debit fits, so a rising market is paid for entirely in strikes.
    // The user's preference is to split it: give a little on price to keep the strikes near where the
    // geometry wanted them. So before accepting this placement, look at up to capFlexStrikes candidates
    // that are MORE ITM and take the most ITM one that fits the FLEXED cap (capFrac + capFlexFrac).
    // Bounded on both axes on purpose — a little of each, not much of either.
    const flex = cfg.capFlexFrac || 0;
    if (flex > 0) {
      const back = cfg.capFlexStrikes != null ? cfg.capFlexStrikes : 1;
      const flexCfg = { ...cfg, capFrac: (cfg.capFrac != null ? cfg.capFrac : 0.65) + flex };
      for (let j = Math.max(-maxItm, k - back); j < k; j++) {
        const st = strikesAt(j);
        const alt = buildOpenAtStrikes(side, st.lower, st.upper, flexCfg, getLeg);
        if (alt.error || alt.declined) continue;
        return { ...alt, itmStrikes: -j, placementsTried: tried, capFlexed: true, flexedFrom: -k };
      }
    }
    // itmStrikes: how many strikes INSIDE the money the short leg sits (0 = straddle placement).
    return { ...res, itmStrikes: -k, placementsTried: tried };
  }
  return {
    declined: true, placementsTried: tried, limit: 0,
    reason: tried
      ? `no placement within ${Math.round((cfg.capFrac != null ? cfg.capFrac : 0.65) * 100)}% of $${W} (tried ${tried}, cheapest ${lastDeclined ? lastDeclined.mark : '?'})`
      : `no chain quotes for any placement${lastError ? ` (${lastError})` : ''}`,
    mark: lastDeclined ? lastDeclined.mark : null, cap: lastDeclined ? lastDeclined.cap : null,
  };
}

// Build a debit-canonical open at EXPLICIT strikes (used by leg-uniqueness to reprice a shifted spread).
function buildOpenAtStrikes(side, lower, upper, cfg, getLeg) {
  const legs = L.openLegs(side, lower, upper);
  const { resolved, longMid, shortMid, error } = resolveLegs(legs, getLeg);
  if (error) return { error };
  const { mark, cap, exceedsCap, limit: atMark } = L.debitLimit(longMid, shortMid, cfg.spreadWidth, cfg.tickIncrement, cfg.capFrac);
  // RISK/REWARD CEILING — decline rather than send a sub-market limit that would never fill.
  if (exceedsCap) return { declined: true, reason: `mark ${mark} over ${Math.round((cfg.capFrac != null ? cfg.capFrac : 0.65) * 100)}% of $${cfg.spreadWidth} (cap ${cap})`, mark, cap, limit: 0 };
  // CEIL TO THE TICK, NEVER ROUND DOWN. debitLimit rounds the mark to the NEAREST tick, which puts the
  // limit BELOW the mark for 40 of every 100 one-cent marks (8.22 -> 8.20). That was harmless while opens
  // booked on assumption; the moment they were price-tested it meant 40% of opens failed their own fill
  // test and were cancelled. A BUY limit under the mark is not a cheap fill, it is a non-marketable order
  // — the same sub-market booking ab922ee removed from the ceiling path.
  //
  // We do not make money on opens; we make it on covers, and a cover needs an open that filled. So an
  // open pays the tick UP rather than risk not existing.
  const tick = cfg.tickIncrement;
  const atOrAbove = round2(Math.ceil((mark / tick) - 1e-9) * tick);
  // SLIP OVER THE MARK (see openSlip), still bounded by the ceiling — paying up must never be a way
  // around the gate that just let this open through.
  const limit = Math.min(round2(atOrAbove + openSlip(cfg)), cap);
  return {
    legs, lower, upper, shortStrike: L.shortStrikeOf(side, lower, upper),
    mark, cap, limit, markLimit: atMark, payload: buildOrderPayload(resolved, limit, cfg.quantity, 'DEBIT')
  };
}

function buildCover(pos, cfg, getLeg, coverShort) {
  // Default debit-offset cover. (credit style parked — needs its own pricing rule.)
  // `coverShort` moves the cover's short leg off the position's own strike (the non-tent geometries).
  // Only the LEGS move; the pricing below is untouched, so geometry and price stay separable.
  const legs = (coverShort != null && coverShort !== pos.shortStrike)
    ? L.coverLegsAtShort(pos.side, coverShort, cfg.spreadWidth)
    : L.coverLegs(pos.side, pos.shortStrike, cfg.spreadWidth, cfg.coverStyle || 'debit-offset');
  const { resolved, longMid, shortMid, error } = resolveLegs(legs, getLeg);
  if (error) return { error };
  // NOTE: covers deliberately do NOT take the open path's ceiling — a cover is risk reduction, so
  // "too expensive to open" is not the same decision as "too expensive to de-risk". Priced at the mark.
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
    return selectCoverFixed(pos, cfg, getLeg, ctx && ctx.underlying);
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
  // null = the mark is outside [0, W] and cannot be a real cover price. Same shape as the `error` return
  // above, so the candidate is simply dropped from the selection rather than priced off a broken quote.
  if (limit == null) return { error: `cover mark ${mark} impossible on a ${cfg.spreadWidth} spread`, positionId: pos.id, longStrike };
  const floor = round2((cfg.spreadWidth - pos.limit - limit) * 100 * cfg.quantity);
  const peakExtra = round2(L.coverPeakExtra(pos.shortStrike, longStrike, cfg.spreadWidth) * 100 * cfg.quantity);
  return {
    positionId: pos.id, legs, resolved, mark, limit, floor, peakExtra, longStrike,
    geometry: coverGeometryLabel(coveredSide, pos.shortStrike, longStrike, cfg.spreadWidth)
  };
}

// V0 baseline: the fixed geometry priced with the old debitLimit (so V0 reproduces the deployed
// behavior exactly for a clean A/B against the smarter variants).
//
// GEOMETRY. This selector used to build the TENT unconditionally, but v1 and v2 declare
// coverGeometry 'halfway' / 'underlying' while riding coverSelector 'fixed' — so every 'fixed' variant
// placed the SAME cover and the geometry axis those variants exist to test never expressed. Measured on
// the live 2026-09-08 session: v0/v1/v2/v3 cover legs identical. It now honours cfg.coverGeometry, using
// the same capped pricing as before, so the only thing that changes is WHERE the cover sits.
// v0/v3 carry geometry 'tent', so this is a no-op for them and their baselines are unmoved.
function selectCoverFixed(pos, cfg, getLeg, underlying) {
  const geometry = cfg.coverGeometry || 'tent';
  const coverShort = (geometry === 'tent' || !(underlying > 0))
    ? pos.shortStrike
    : L.coverShortFor(geometry, pos.side, pos.shortStrike, underlying, cfg.strikeIncrement);
  const res = buildCover(pos, cfg, getLeg, coverShort);
  if (res.error) return { error: res.error, positionId: pos.id };
  const longStrike = pos.side === 'bull' ? coverShort + cfg.spreadWidth : coverShort - cfg.spreadWidth;
  return {
    positionId: pos.id, legs: res.legs, mark: res.mark, limit: res.limit,
    floor: round2((cfg.spreadWidth - pos.limit - res.limit) * 100 * cfg.quantity),
    peakExtra: round2(L.coverPeakExtra(pos.shortStrike, longStrike, cfg.spreadWidth) * 100 * cfg.quantity),
    geometry: coverGeometryLabel(pos.side, pos.shortStrike, longStrike, cfg.spreadWidth),
    longStrike, payload: res.payload
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

// GEOMETRY-AWARE cover plan — the live counterpart of the backtest's coverGeometry. WHERE the offsetting
// spread sits is the axis v0-v3 differ on:
//   'tent'       shares the covered position's short strike (butterfly: one peak, cheapest cover,
//                biggest locked floor, least upside) — identical to selectCoverFixedMark, so v0 is
//                untouched and 'tent' is a no-op relative to the previous behaviour;
//   'halfway'    puts the cover's short midway to the underlying (condor: a plateau, more terminal
//                potential for a dearer cover);
//   'underlying' puts it at the money (widest tent, dearest cover, and far enough out it can push
//                open+cover past the width and forfeit the guaranteed floor — the trade being measured).
// priceCoverCandidate takes a LONG strike, and candidateCoverLegs' convention puts the cover's short at
// long∓width, so the long is the geometry's short strike offset by the width on the covered side.
function selectCoverGeometric(pos, cfg, getLeg, underlying) {
  const geometry = cfg.coverGeometry || 'tent';
  if (geometry === 'tent' || !(underlying > 0)) return selectCoverFixedMark(pos, cfg, getLeg);
  const coverShort = L.coverShortFor(geometry, pos.side, pos.shortStrike, underlying, cfg.strikeIncrement);
  const longStrike = pos.side === 'bull' ? coverShort + cfg.spreadWidth : coverShort - cfg.spreadWidth;
  const plan = priceCoverCandidate(pos.side, pos, longStrike, cfg, getLeg);
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
  return { underlying, center, strikes, spreads: snapshotSpreads(getLeg, center, incr, windowStrikes) };
}

// COMBO/SPREAD QUOTE CAPTURE. The per-leg chain above cannot answer "what would this spread actually cost
// to execute" — that needs the NET of the two legs, and the gap between the net mid and the net ask is the
// execution cost we have been ASSUMING rather than measuring. Capture it for the spreads the engine
// actually trades: at each width, the placements from short-leg-ITM through straddle, both directions,
// plus the parity partner (the opposing side at the SAME strikes), which is what makes a bad mark
// detectable (call mid + put mid must equal the width).
//
// Recorded per candle so execution cost can be characterised by moneyness, width and time of day, and so a
// suspect mark can be reconstructed after the fact. Read-only; never drives an order on its own.
function snapshotSpreads(getLeg, center, incr, windowStrikes) {
  const out = [];
  const reach = Math.max(2, Math.floor(windowStrikes / 2) - 2);
  for (const W of [10, 20, 40]) {
    // shift = how far the SHORT leg sits inside the money, in strikes: 0 = straddle, +n = n strikes ITM.
    for (let sh = 0; sh <= 3; sh++) {
      const hi = center + W / 2 - sh * incr, lo = hi - W;
      if (hi - lo !== W) continue;
      if (Math.abs(hi - center) > reach * incr || Math.abs(lo - center) > reach * incr) continue;
      const call = SQ.netQuote(SQ.bullCallLegs(lo, hi), getLeg);
      const put = SQ.netQuote(SQ.bearPutLegs(lo, hi), getLeg);
      if (!call || !put) continue;
      const sum = Math.round((call.mid + put.mid) * 100) / 100;
      out.push({
        width: W, shiftStrikes: sh, lo, hi,
        call: { mid: call.mid, bid: call.bid, ask: call.ask, cross: call.crossOverMid, perLeg: call.perLeg },
        put: { mid: put.mid, bid: put.bid, ask: put.ask, cross: put.crossOverMid, perLeg: put.perLeg },
        // parity residual: mids must sum to W. Non-zero => friction or a bad quote on the richer side.
        paritySum: sum, parityExcess: Math.round((sum - W) * 100) / 100,
        callFracOfWidth: Math.round(call.mid / W * 1000) / 1000,
        putFracOfWidth: Math.round(put.mid / W * 1000) / 1000,
      });
    }
  }
  return out;
}

// --- EOD terminal-settlement P/L ------------------------------------------
// The fair cross-variant metric: value every established position at the day's settle
// price (0DTE => intrinsic). Covered pairs realize their true value INCLUDING the upside
// the floor number ignores (so it doesn't undersell the joint variant); uncovered filled
// spreads settle at their own intrinsic. floor = state.realizedPnl (guaranteed locked sum).
// TERMINAL (settle) P&L, valued from the ACTUAL orders sent — a credit open/cover uses its real credit-twin
// legs + NEGATIVE cost (cash received), a debit uses its legs + positive cost — so this is the REAL cash
// P&L, not the debit-canonical (parity-idealized) figure, which OVERSTATES recapture variants by the
// credit-vs-debit pricing gap (~$0.71/credit-open). Opens carry sentLegs/sentLimit on the position; covers
// come from the order log (order_simulated dry-run / order_sent live, keyed by meta.of). Falls back to
// debit-canonical only when an order isn't found. See feedback_use_real_numbers_not_derived.
function computeTerminalPnl(state, cfg, settle, events) {
  // ONE IMPLEMENTATION, shared with both UI pages — see book-value.js. Four hand-written copies of this
  // calculation had drifted into four different answers for the same book (2026-09-17: +$3,140 on debug,
  // -$975 on compare, $2,840 here, $4,120 from RC.bookPnl).
  //
  // coverPriceFromFill: the price paid is the FILL price, not the order-log price. The log holds the
  // order AS FIRST SENT and the ladder and give-up both reprice, so a cover sent at 10.00 and walked to
  // 19.30 was being valued at 10.00. On 2026-09-17 that moved single variants by up to $3,380 (it roughly
  // washes out across the fleet, +$210 over eight). See feedback_use_real_numbers_not_derived.
  const out = BV.terminalAt({ state, config: cfg, events }, settle, { coverPriceFromFill: true });
  return { settle: out.settle, total: out.total, floor: state.realizedPnl, positions: out.positions };
}

function round2(n) { return Math.round(n * 100) / 100; }

// Net-debit mark of a cover leg-set from the CURRENT chain (null if any leg is unquoted).
// ── ONE FILL TEST FOR EVERY ORDER TYPE ───────────────────────────────────────────────────────────────
// Opens, offsets/hedges and wings used to book `filled: true` unconditionally: the position appeared in
// the book whether or not any price supported it, and a missing or unquotable leg still produced a fill.
// Only resting covers were ever price-tested. Every order type now goes through this, so "filled" means
// the same thing everywhere — an observed mark reached the limit we placed.
//
// DEBIT-CANONICAL, like the rest of the engine: `mark <= limit` fills a BUY. Fill price is
// min(limit, mark + tick) so a mark already through the limit books at the cheap side rather than
// pretending we paid the full limit.
//
// HONEST LIMIT: `mark` here is Schwab's mark, or the midpoint when it is absent (see makeLegAccessor).
// A resting buy fills when someone trades at the price, and the mid touching our limit is necessary but
// not sufficient — the ask has to come to us. This test is therefore still optimistic; it is a real
// market observation rather than a model, which is the improvement, but it is not broker confirmation.
// ORDER_SLIP_TICKS is what buys the extra confidence: see openSlip below.
// SHOULD THIS ORDER BE SENT AS CREDIT? One answer, called from all five decision sites, because this is
// precisely the shape that has drifted here before: a rule implemented per-site ends up meaning five
// slightly different things and nobody notices until the telemetry disagrees with itself.
//
// `creditCapitalTrigger` (dollars) replaces two hand-set rules that were never measured —
// `openAlternateEvery` (alternate opens on a COUNT) and `creditCoverFrac` (cover goes credit when the
// POSITION is that deep). Neither fires on the thing they exist to control. A CREDIT cover lands its short
// leg on the OPEN's short strike, so the pair collapses to a butterfly and the capital is released; a
// DEBIT cover shares no strike and stacks both debits. Measured live 2026-09-18/21/22: net capital per
// position -$798 credit-covered against +$953 debit-covered.
//
// The trigger is a THERMOSTAT: pay debits until deployment reaches the threshold, then take credits until
// it falls back. Deliberately NOT "always credit" — the user's rule, 2026-09-23: "negative capital is just
// a number, going negative is no better than keeping near zero, so no reason to intentionally bias toward
// credits beyond just recapturing the capital already laid out."
//
// Reads st.cashDeployed, which books at the FILL (see noteCash), so it is capital actually deployed rather
// than capital merely ordered. `legacy` is the existing per-site expression and is returned UNCHANGED when
// the trigger is unset, so every variant without it behaves exactly as before.
function creditPreferred(st, deps, legacy) {
  const trig = deps && deps.creditCapitalTrigger;
  if (!(trig > 0)) return legacy;
  if (deps.capitalRecapture !== true) return false;
  return ((st && st.cashDeployed) || 0) >= trig;
}

// SIGNED CASH LEDGER — one entry point, so every order type books the same way and at the same moment.
// +paid debit, -received credit. Does NOT touch P&L; it is the pure capital view behind /status
// cashDeployed / peakCashDeployed.
//
// BOOKED AT THE FILL, ALWAYS. Opens used to book at PLACEMENT (so a cancelled order left its cash behind
// forever, and a laddered order booked a price it never traded at) and hedges never booked at all —
// floor-offset, wing and fly each pay a real debit, and across 2026-09-17/18/21/22 that was $147,665 of
// spend the ledger simply never saw, on 354 filled hedges across 144 of 320 runs. Covers already booked
// at the fill; now everything does.
function noteCash(st, dollars) {
  st.cashDeployed = round2((st.cashDeployed || 0) + dollars);
  st.peakCashDeployed = Math.max(st.peakCashDeployed || 0, st.cashDeployed);
  return st.cashDeployed;
}

function markFill(legs, limit, getLeg, tick, deps, net) {
  const q = spreadQuote(legs, getLeg);
  const mark = q.mark;
  const base = { mark, bid: q.bid, ask: q.ask, underlying: deps && deps.underlying != null ? deps.underlying : null };
  if (mark == null || limit == null || !(limit > 0)) return { ...base, fillable: false, fill: null };
  // STRUCTURAL GATE, BEFORE the price comparison. `mark > limit` is the only test this used to make, and
  // an IMPOSSIBLE mark passes it trivially: a debit spread marked -32.20 is not above any positive limit,
  // so it read as fillable, and the fill price then clamped to one tick. That is how 154 covers across 55
  // variants booked at $5 on 40-wide spreads on 2026-09-16, inflating the recorded floor by roughly
  // $188,425 of locked value that was never captured. A quote that cannot exist is a BAD QUOTE, not a
  // cheap fill — refuse it and let the order keep working.
  const sane = SQ.verticalSanity(legs, mark);
  if (!sane.ok) return { ...base, fillable: false, fill: null, badQuote: sane.reason };
  const usable = SQ.quoteUsable(legs, q);
  if (!usable.ok) return { ...base, fillable: false, fill: null, badQuote: usable.reason };
  // CHAIN MONOTONICITY — the invariant that actually broke on 2026-09-16, and the one gate here that
  // looks OUTSIDE the spread. Every one of 201,144 individual leg quotes that day was individually
  // sane; the corruption was in ADJACENT PAIRS (a call worth more at the higher strike, a put worth
  // less), which makes a vertical mark impossible while both its legs look healthy. All 1,185
  // violations fell inside the single 14:00 hour that produced every bad fill, and none outside it —
  // so this refuses a broken chain without costing a good trade. It abstains wherever a neighbour is
  // simply unquoted, so a thin chain is never mistaken for a broken one.
  const mono = SQ.chainMonotonic(legs, getLeg, (deps && deps.strikeIncrement) || 10);
  if (!mono.ok) {
    const v = mono.violations[0];
    return { ...base, fillable: false, fill: null,
      badQuote: `chain not monotonic: ${v.type}${v.at} at ${v.mid} beside ${v.type}${v.neighbour} at ${v.neighbourMid}` };
  }
  // PARITY, for two-leg verticals: the opposing structure at the SAME strikes must price to the width.
  // This is the check that catches legs which are broken but net to something legal-looking — the four
  // covers on 2026-09-16 marked $0.05 with a ±148 book, which structural bounds cannot see.
  //
  // RECORDED ALWAYS, BLOCKING ONLY ON REQUEST (deps.parityGateTolFrac). The residual cannot be measured
  // from history — run records store the NET quote, not the per-leg quotes — and switching on an unmeasured
  // gate is how the quoted-width test nearly cost 354 good fills. So this collects the distribution on
  // live orders now and can be armed once there is evidence for a tolerance. Recording it is the point:
  // a check that is built but never wired is the failure mode this module already has a history of.
  let parity = null;
  if (legs.length === 2 && legs[0].type === legs[1].type) {
    const ks = legs.map((l) => l.strike);
    const tolFrac = deps && deps.parityGateTolFrac != null ? deps.parityGateTolFrac : null;
    const pd = SQ.parityDeviation(Math.min(...ks), Math.max(...ks), getLeg, { tolFrac: tolFrac != null ? tolFrac : 0.25 });
    if (pd) {
      parity = { residual: pd.residual, width: pd.width, callMid: pd.callMid, putMid: pd.putMid };
      if (tolFrac != null && !pd.ok) {
        return { ...base, parity, fillable: false, fill: null,
          badQuote: `parity off by ${pd.residual} on a ${pd.width} spread (calls ${pd.callMid} + puts ${pd.putMid})` };
      }
    }
  }
  // DIRECTION. A DEBIT order fills when the market comes DOWN to it: you pay at most the limit. A CREDIT
  // order is the mirror — it fills when the market comes UP to it, because you must RECEIVE at least the
  // limit. Testing a credit order with the debit inequality books a fill whenever the mark is merely
  // BELOW the asked credit, which is precisely when the real order would not have filled.
  //
  // Measured on 2026-09-17: 18 of 60 credit-sent opens (30%) were booked filled while the best credit
  // mark all day never reached the asked credit — short by 1 to 5 ticks mostly, one by 1.70 on a 20-wide.
  //
  // The engine records positions DEBIT-CANONICAL, and testing the debit twin is only equivalent while
  // sentLimit == W - debitLimit exactly. It is not: 40 of 60 differed, because the debit limit rounds UP
  // to a tick while the credit side does not, so the debit test is systematically the easier of the two.
  // So the test has to run against the order that is actually resting.
  if (net === 'CREDIT') {
    // spreadQuote signs long +, short -, so a credit structure marks NEGATIVE; the credit received is -mark.
    const credit = round2(-mark);
    if (credit < limit) return { ...base, parity, fillable: false, fill: null };
    // Concede at most a tick below the asked credit, never below the market.
    return { ...base, parity, fillable: true, fill: round2(Math.min(credit, Math.max(limit, credit - tick))) };
  }
  if (mark > limit) return { ...base, parity, fillable: false, fill: null };
  // The floor is the MARK, not one tick. Flooring at `tick` is what turned a nonsense mark into a $5
  // fill; a real fill never prices below what the thing is actually marked at.
  return { ...base, parity, fillable: true, fill: round2(Math.max(mark, Math.min(limit, mark + tick))) };
}

// Pay a tick or two OVER the mark so the order is likelier to actually be crossed. A limit sitting exactly
// at the mark needs the market to come to us; a limit above it is already marketable against a reasonable
// ask. At $0.05 a tick that is $5/contract per tick — cheap next to a cover that never fills, and it is
// the same trade the cover fill price has always made (min(target, mark + tick)).
const ORDER_SLIP_DEFAULT = 0;   // OFF by default — see the note above openSlip
function openSlip(cfg, deps) {   // deps optional: buildOpen* paths only carry cfg
  const n = (deps && deps.orderSlipTicks != null) ? deps.orderSlipTicks
    : (cfg && cfg.orderSlipTicks != null) ? cfg.orderSlipTicks : ORDER_SLIP_DEFAULT;
  return Math.max(0, n) * cfg.tickIncrement;
}

// The spread's EXECUTABLE extremes alongside its mark. `ask` is what it would cost to buy right now
// (pay the ask on each long, receive the bid on each short); `bid` is what selling it would fetch. Both
// are worst-case leg-by-leg, so the true package price sits between them.
//
// Recorded with the low-water mark because a mid can fall for two very different reasons: the market
// genuinely traded down, or the BID collapsed while the ask never moved. The second drags the midpoint
// down to a price no buyer could ever have hit, and on the mark alone the two are indistinguishable —
// a suspiciously good markLow next to a bid/ask a dollar apart is the tell.
function spreadQuote(legs, getLeg) {
  let mark = 0, bid = 0, ask = 0, ok = true;
  for (const l of legs) {
    const q = getLeg(l.type, l.strike);
    if (!q || q.mid == null) { ok = false; break; }
    const sgn = l.side === 'long' ? 1 : -1;
    mark += sgn * q.mid;
    // Buying the package: pay ask on longs, receive bid on shorts. Selling it is the mirror.
    ask += sgn * (sgn > 0 ? (q.ask != null ? q.ask : q.mid) : (q.bid != null ? q.bid : q.mid));
    bid += sgn * (sgn > 0 ? (q.bid != null ? q.bid : q.mid) : (q.ask != null ? q.ask : q.mid));
  }
  return ok ? { mark: round2(mark), bid: round2(bid), ask: round2(ask) } : { mark: null, bid: null, ask: null };
}

// EVERY price this engine sends or books starts life as a spread mark, and a mark computed from a broken
// chain is worse than no mark at all. The clamps downstream -- Math.max(tick, x), Math.min(ceiling, x) --
// turn an impossible number into a plausible-looking ORDER instead of a refusal. That produced all three
// of 2026-09-16's pricing failures: 154 covers booked at $5 (clamped up from a negative mark), a $995
// NET_CREDIT open on a $10 spread (clamped down from a broken credit), and fills priced at one tick.
//
// saneMark is the single choke point. It returns the mark, or NULL when the quote is structurally
// impossible -- and null is exactly what these paths already treat as "cannot price this", because every
// one of them was written to cope with an unquotable leg. So the fix reuses handling that already exists
// and is already tested, rather than adding a new refusal branch per clamp.
function saneMark(legs, mark) {
  if (mark == null || !Number.isFinite(mark)) return null;
  return SQ.verticalSanity(legs, mark).ok ? mark : null;
}

function coverMarkNow(legs, getLeg) {
  let v = 0;
  for (const l of legs) {
    const q = getLeg(l.type, l.strike);
    if (!q || q.mid == null) return null;
    v += (l.side === 'long' ? 1 : -1) * q.mid;
  }
  // Gated here rather than at the six call sites: this IS the "what is this spread worth" helper, and an
  // impossible answer must not be distinguishable from an unanswerable one.
  return saneMark(legs, round2(v));
}

// RESTING-cover fill model (see the cover step): a working cover fills when its real mark reaches
// its target (= width − openCost). Fill price = min(target, mark + tick) → cross cheap when the
// cover is already below target (deep-ITM lock), else fill at the resting target. Books the locked
// floor (width − open − fill) at the actual fill price. Live analog of the backtest's two-mode fill;
// here the fill check uses the real per-candle chain mark instead of the pricer/wick.
// WORK THE RESTING COVERS (deps.coverLadder, default OFF). Recompute what limit each live cover order
// should be showing given how long it has rested and how far the underlying has moved, and REPLACE the
// order at the broker when that has changed by at least a tick.
//
// Measured on the real 2026-09-08/09 sessions: of the covers that never filled, 42% sat at a price the
// underlying DID reach and another quarter came within 10 index points — the median miss was 20-27
// points on a ~29,400 index. So most unfilled covers were marginally, not wildly, mispriced, which is
// exactly the gap a ladder closes.
//
// COUNTER-EVIDENCE, recorded honestly: the backtest sweep of this ladder raised fill from 47% to 83% and
// LOST $461k-$863k across all 36 arms, because paying up to fill an order the market was going to come
// to anyway is a worse trade than waiting. That result is why this ships DEFAULT OFF. It is wired so it
// can be enabled deliberately and measured live, not because the backtest endorses it.
// Try to FILL a resting open against the current chain, and work it toward the market if it will not.
// Split out of processCandleClose so the LIVE sub-bar worker can call it between candles: the candle tick
// prices an open and tests it in the same snapshot, which can only ever say yes, while a pass seconds
// later reads the chain again and gives the answer an actual resting order would get.
//
// Deliberately does NOT decide reversals. A reversal needs the signal, the signal only exists at a candle
// close, and cancelling an order on stale direction between bars would be guessing.
// Resolve HEDGES that are working — offsets, wings and flies. Same rule as a resting cover: the order
// books only when a LATER observation shows the mark at or through the limit we sent.
//
// Why these need it as much as opens did: an offset is priced from the same mids it was then tested
// against, and a wing or fly is priced at the ASK while the test reads the MID — so each was priced at or
// above its own mark and asked whether the mark was at or below its price. None could ever be refused.
//
// THEY EXPIRE, unlike a cover. A cover is worth having whenever it finally fills; a hedge was chosen for
// the shape of the risk curve at one moment, and that reason goes stale. Working one for the rest of the
// day would book a structure bought for a peak that is long gone. Default 10 minutes — two candles.
// Push the low-water mark down and, when it improves, snapshot the QUOTE that produced it. One helper
// for all three resting order types so the three cannot drift apart on what "the low" means.
// EVERY OBSERVATION OF A WORKING ORDER, in the direction the order actually fills.
//
// `net` says which side of the limit counts. A DEBIT order is reached when the mark falls TO it; a CREDIT
// order when the credit RISES to it. Counting a credit order with the debit inequality made `atOrThrough`
// equal `looks` on every credit order ever placed — the mark of a credit structure is negative, so
// `mark <= limit` was trivially true — which quietly destroyed the one statistic that says whether a fill
// was real. `best` is likewise the best price the order ever saw in ITS OWN direction.
//
// AFTER A FILL, KEEP WATCHING. `throughLooks`/`throughBest` record how far the market went beyond our
// price once we had already booked, which is what separates a graze from a genuine fill: a mark that
// touched the limit once and a mark that spent the afternoon a dollar through it produce the same
// markLow and are very different claims. Nothing here changes a decision — it is evidence for reading the
// fill afterwards.
function noteMarkLow(o, chk, limit, net, parityWidth) {
  if (chk.mark == null) return;
  const credit = net === 'CREDIT';
  // THE PRICE IN THE ORDER'S OWN SPACE — and a credit order can be quoted TWO different ways, which is
  // what broke this. It depends entirely on WHICH legs the caller quoted:
  //
  //   OPEN path   — quotes `pos.sentLegs`, the credit twin itself. A credit structure marks NEGATIVE, so
  //                 the credit received is `-mark`.
  //   COVER path  — quotes `pc.legs`, the DEBIT-CANONICAL cover. That marks POSITIVE, and the credit is
  //                 `W - mark` by parity — exactly what the fill test in resolveRestingCovers computes.
  //
  // Applying the open convention to a cover gave px = -10.50 against a 29.50 ask, so `reached` was false
  // on every observation a credit cover ever saw: 1,027 of 1,027 filled credit covers across 2026-09-18,
  // 09-21 and 09-22 carried a null/zero dwell counter, against 0 of 2,177 debit covers. Orders that
  // genuinely filled AT their limit reported "the market never reached this price", and the debug table's
  // graze warning fired on all of them. `parityWidth` tells this function which convention it is in.
  const own = (m) => credit ? (parityWidth != null ? round2(parityWidth - m) : round2(-m)) : m;
  const px = own(chk.mark);
  const reached = limit != null && (credit ? px >= limit : px <= limit);
  if (o.filled) {
    // Post-fill: how decisively did it go through, and for how long.
    o.throughLooks = (o.throughLooks || 0) + 1;
    if (reached) {
      o.throughAt = (o.throughAt || 0) + 1;
      const by = round2(credit ? px - limit : limit - px);
      if (o.throughBest == null || by > o.throughBest) o.throughBest = by;
    }
    return;
  }
  // DWELL, not just the extreme. `looks` counts every observation of this working order and `atOrThrough`
  // how many of them had the market at or through the price we sent. A single tick grazing our limit and
  // the market sitting there for ten minutes produce an IDENTICAL extreme, and they are very different
  // claims about whether a real order would have been hit — 1-of-47 is a graze, 22-of-47 is a fill.
  o.looks = (o.looks || 0) + 1;
  if (reached) o.atOrThrough = (o.atOrThrough || 0) + 1;
  // Keep the BEST price seen in the order's own direction (lowest debit / highest credit). Uses the same
  // conversion as `px` above, or the two disagree about which observation was better.
  const better = o.markLow == null || (credit ? px > own(o.markLow) : px < o.markLow);
  if (!better) return;
  o.markLow = chk.mark;
  o.markLowBid = chk.bid;
  o.markLowAsk = chk.ask;
  o.markLowSpread = (chk.bid != null && chk.ask != null) ? round2(chk.ask - chk.bid) : null;
  if (chk.underlying != null) o.markLowUnder = chk.underlying;
}

// STAMP THE MARKET AT PLACEMENT. bid/ask were recorded only at the low-water mark and at the fill, never
// at the moment the order was created, and the underlying was never stamped on an order at all — it lived
// on the candle event, so reconstructing "where was NDX when this went out" meant joining on time. Every
// after-the-fact question asked in this session needed one of these.
function notePlaced(o, chk, underlying) {
  if (!o || o.placedMark != null) return;              // first observation only
  o.placedMark = chk && chk.mark != null ? chk.mark : null;
  o.placedBid = chk ? chk.bid : null;
  o.placedAsk = chk ? chk.ask : null;
  o.placedUnder = underlying != null ? round2(underlying) : null;
}

// What is already WORKING of a given hedge kind. The counters (wingCount/flyCount/offCount) and their
// spend only advance on a FILL, so any per-day cap or budget that reads them alone is blind to orders
// still in flight and will re-place the same structure every pass. Every cap must add this in.
function pendingHedges(st, kind, qty) {
  let n = 0, spent = 0;
  for (const p of st.positions || []) {
    if (p.filled === false && p.pendingHedge && p.pendingHedge.kind === kind) {
      n++; spent += (p.pendingHedge.limit || 0) * 100 * (p.quantity || qty || 1);
    }
  }
  return { n, spent };
}

function resolvePendingHedges(st, cfg, deps, decisions) {
  const now = deps.nowMs != null ? deps.nowMs : (st.lastCandleEpoch || Date.now());
  const ttl = (deps.hedgeWorkMinutes != null ? deps.hedgeWorkMinutes : 10) * 60 * 1000;
  let filled = 0;
  for (const pos of st.positions) {
    if (pos.filled !== false || !pos.pendingHedge) continue;
    const ph = pos.pendingHedge;
    const chk = markFill(pos.legs, ph.limit, deps.getLeg, cfg.tickIncrement);
    noteMarkLow(pos, chk, ph.limit, 'DEBIT');
    notePlaced(pos, chk, deps.underlying);
    if (chk.fillable) {
      pos.filled = true; pos.orderStatus = 'filled'; pos.limit = chk.fill; pos.pendingHedge = null;
      // Spend is counted HERE, not at placement: budget should be consumed by hedges we actually own.
      const spent = chk.fill * 100 * (pos.quantity || cfg.quantity);
      noteCash(st, spent);          // a hedge is always a DEBIT — it pays, and the ledger must see it

      if (ph.kind === 'wing') { st.wingCount = (st.wingCount || 0) + 1; st.wingSpent = round2((st.wingSpent || 0) + spent); }
      else if (ph.kind === 'fly') { st.flyCount = (st.flyCount || 0) + 1; st.flySpent = round2((st.flySpent || 0) + spent); }
      else { st.offCount = (st.offCount || 0) + 1; st.offSpent = round2((st.offSpent || 0) + spent); }
      decisions.push({ action: `${ph.kind}-fill`, id: pos.id, legs: pos.legs, limit: ph.limit,
        fillPrice: chk.fill, mark: chk.mark, bid: chk.bid, ask: chk.ask,
        markLow: pos.markLow, markLowBid: pos.markLowBid, markLowAsk: pos.markLowAsk, cost: Math.round(spent),
        restedMs: ph.placedEpoch != null ? now - ph.placedEpoch : null });
      filled++;
      // `!= null`, not a truthiness test: epoch 0 is a legitimate value and `ph.placedEpoch &&` skipped
      // the expiry entirely for it, so a stale hedge would have worked forever.
    } else if (ph.placedEpoch != null && (now - ph.placedEpoch) > ttl) {
      decisions.push({ action: `${ph.kind}-expire`, id: pos.id, legs: pos.legs, limit: ph.limit,
        mark: chk.mark, markLow: pos.markLow, markLowBid: pos.markLowBid, markLowAsk: pos.markLowAsk,
        restedMs: now - ph.placedEpoch });
      pos.pendingHedge = null; pos.orderStatus = 'expired';
      pos.expired = true;                    // filtered out below rather than spliced, so the row survives
    }
  }
  // Drop expired orders from the working list once logged: they were never held, so leaving them would
  // let a structure we do not own keep appearing in position counts.
  st.positions = st.positions.filter(p => !p.expired);
  return filled;
}

// ASYNC since the open ladder now replaces at the broker. Every state mutation still happens BEFORE
// the first await, so a caller that does not await still observes the updated book synchronously —
// which is what the unit tests rely on. No caller uses the return value.
async function resolvePendingOpen(st, cfg, deps, decisions) {
  if (!st.pendingOpenId) return 0;
  const pos = st.positions.find(p => p.id === st.pendingOpenId);
  if (!pos || pos.filled) { st.pendingOpenId = null; return 0; }
  // TEST THE ORDER THAT IS ACTUALLY RESTING. For a capital-recapture credit twin that is the CREDIT
  // spread at sentLimit, not the debit-canonical record — see the direction note in markFill. The record
  // stays debit-canonical either way; only the fill TEST follows the sent order.
  const sentCredit = pos.sentNet === 'CREDIT' && pos.sentLegs && pos.sentLimit != null;
  const chk = sentCredit
    ? markFill(pos.sentLegs, pos.sentLimit, deps.getLeg, cfg.tickIncrement, deps, 'CREDIT')
    : markFill(pos.legs, pos.limit, deps.getLeg, cfg.tickIncrement, deps);
  noteMarkLow(pos, chk, sentCredit ? pos.sentLimit : pos.limit, sentCredit ? 'CREDIT' : 'DEBIT');
  notePlaced(pos, chk, deps.underlying);
  if (chk.fillable) {
    pos.filled = true; pos.orderStatus = 'filled';
    // The price that actually traded: a credit open receives sentLimit, a debit one pays its limit.
    noteCash(st, (sentCredit ? -(pos.sentLimit || 0) : (pos.limit || 0)) * 100 * (pos.quantity || cfg.quantity));
    decisions.push({ action: 'open-fill', positionId: pos.id, side: pos.side, limit: pos.limit, cashDeployed: st.cashDeployed,
      mark: chk.mark, bid: chk.bid, ask: chk.ask,
      markLow: pos.markLow, markLowBid: pos.markLowBid, markLowAsk: pos.markLowAsk,
      looks: pos.looks, atOrThrough: pos.atOrThrough, restedSince: pos.openTime });
    st.pendingOpenId = null;
    return 1;
  }
  // OPEN LADDER, its own flag. It defaults to coverLadder so nothing changes today, but the two are
  // different jobs and were never measured together: the ladder's case (+5 to +16 fill points over 765
  // days) is entirely a COVER result, established before opens could rest at all. A cover waits for
  // premium to decay toward a fixed target; an open chases a price that runs AWAY as the underlying moves
  // against the entry. Sharing one flag meant open-laddering could never be isolated — it went live on 74
  // variants at once, bundled into a flag whose evidence came from something else.
  const openLadderOn = deps.openLadder != null ? deps.openLadder === true : deps.coverLadder === true;
  if (!openLadderOn || chk.mark == null) return 0;
  // SAME LADDER AS THE COVERS, same direction: an open is a BUY, so walking toward the market means
  // paying MORE. Bounded by the ceiling this open was already gated on and by the mark itself — working
  // an order must never become a way past the 65% rule, nor a way to pay through the market.
  //
  // Step timing is ELAPSED-TIME based (cover-ladder.stepsEarned reads restingMs), so evaluating more
  // often does not make the ladder walk faster. The sub-bar pass changes how often we LOOK, not how
  // quickly we chase — which is the whole point of it.
  // Same reasoning for the step: $0.25 (and $0.10 at W=40) was fitted to covers over 765 days, and there
  // is no result behind it for opens. Separately settable, same default.
  const step = deps.openLadderStepDollars != null ? deps.openLadderStepDollars
    : (deps.ladderStepDollars != null ? deps.ladderStepDollars : 0.25);
  const ceiling = pos.cap != null ? pos.cap : Infinity;
  // THE LADDER WALKS IN DEBIT SPACE, ALWAYS. `chk` follows the order that is RESTING, so for a credit
  // twin chk.mark is the CREDIT structure's mark — which is NEGATIVE. Feeding that to
  // Math.min(pos.limit + step, ceiling, mark) returns the negative every time, `next > pos.limit` is
  // never true, and the order is never worked: 43.2% of opens on 2026-09-17 were credit-sent, across the
  // 74 variants that run the ladder. Introduced by the fill-direction fix (53b12b7) — before it, chk was
  // always the debit quote and this read correctly.
  //
  // The market's DEBIT-space mark is the bound either way (an open is a BUY; walking toward the market
  // means paying more), so quote the canonical legs for it. The twin's ask is then re-derived as
  // W - limit, which is how placeRestingCover keeps the two economically identical by construction.
  const ladderMark = sentCredit ? spreadQuote(pos.legs, deps.getLeg).mark : chk.mark;
  if (ladderMark == null) return 0;
  const next = round2(Math.min(pos.limit + step, ceiling, ladderMark));
  if (next > pos.limit) {
    const ks = (pos.legs || []).map((l) => l.strike);
    const w = ks.length ? Math.max(...ks) - Math.min(...ks) : cfg.spreadWidth;
    decisions.push({ action: 'open-reprice', positionId: pos.id, side: pos.side,
      from: pos.limit, to: next, mark: ladderMark, cap: pos.cap,
      ...(sentCredit ? { sentFrom: pos.sentLimit, sentTo: round2(w - next) } : {}) });
    const sentTo = sentCredit ? round2(w - next) : next;
    if (sentCredit) pos.sentLimit = sentTo;
    pos.limit = next;
    // AND TELL THE BROKER. This walked pos.limit purely in memory: markFill then booked an open-fill at
    // the walked price while the real order still rested at the price it was placed at. The engine went
    // on to cover a position it did not own. Covers have gone out through concedeCover since b901054;
    // opens never went out at all.
    if (deps.replaceOrder && pos.orderId) {
      const sendLegs = sentCredit && pos.sentLegs && pos.sentLegs.length ? pos.sentLegs : pos.legs;
      const srl = resolveLegs(sendLegs, deps.getLeg);
      if (!srl.error) {
        const payload = buildOrderPayload(srl.resolved, sentTo, pos.quantity || cfg.quantity,
          sentCredit ? 'CREDIT' : 'DEBIT');
        const r = await deps.replaceOrder(pos.orderId, payload,
          { kind: 'open-reprice', of: pos.id, fromLimit: sentCredit ? pos.sentLimit : pos.limit, legs: sendLegs,
            net: sentCredit ? 'CREDIT' : 'DEBIT' });
        if (r && r.orderId) pos.orderId = r.orderId;
      }
    }
    return 1;
  }
  decisions.push({ action: 'open-rest', positionId: pos.id, side: pos.side, limit: pos.limit,
    mark: chk.mark, cap: pos.cap, reason: next >= ceiling ? 'at ceiling' : 'no room' });
  return 0;
}

// CONCEDE ON A RESTING COVER — the one place a working cover's price moves, whichever space it was sent in.
//
// "there's no difference between a debit order and a credit order, we're only using credit to recapture
// capital, the risk is the same, the reward is the same, we want to walk every order, open or cover, debit
// or credit ... debits our price goes up, we're willing to pay more for the fill, credits the price goes
// down, we're accepting less to get the fill" (user, 2026-09-18). Credit covers used to be skipped outright
// — 23 of 174 resting covers on 2026-09-17 and 150 of 406 on 09-16 sat untouched from placement to the
// close, never once worked, which is the opposite of the standing rule that an order is worked and never
// hoped for.
//
// The LADDER decides how much to concede, in debit space, where its whole calibration lives. This applies
// that concession to the order really at the broker.
//
// BY THE DELTA, NOT BY PARITY. The obvious move is to re-derive the credit as W - target the way the OPEN
// ladder does, and it is wrong here: an open's sentLimit IS W - limit by construction, but a cover's
// sentCredit is derived from the SENT legs' debit price, which parts company with the booked `target`
// whenever the cover geometry picks a long strike other than short ± W. Measured across 2026-09-16/17,
// W - target equalled sentCredit on 0 of 173 resting credit covers (asked 12.95 where the twin implies
// 15.75 on a 20-wide). Re-deriving would have jumped every one of them to a different price under the
// guise of a ladder step. Moving by the DELTA preserves whatever relationship the placement established
// and concedes exactly what the ladder asked for.
//
// The credit floors at one tick: conceding past zero is not a cheaper order, it is a nonsensical one.
async function concedeCover(pos, pc, to, from, cfg, deps, decisions, kind, extra) {
  const tick = cfg.tickIncrement;
  const credit = pc.sentNet === 'CREDIT' && pc.sentCredit != null;
  pc.target = to;                                  // the booked target moves with the working limit, or we
                                                   // would fill on one price and book at another
  let sentFrom = from, sentTo = to, net = 'DEBIT';
  if (credit) {
    sentFrom = pc.sentCredit;
    sentTo = round2(Math.max(tick, L.roundToTick(round2(pc.sentCredit - round2(to - from)), tick)));
    pc.sentCredit = sentTo;
    net = 'CREDIT';
  }
  const legs = credit ? (pc.sentLegs || pc.legs) : pc.legs;
  if (deps.replaceOrder && pc.orderId) {
    const srl = resolveLegs(legs, deps.getLeg);
    if (!srl.error) {
      const payload = buildOrderPayload(srl.resolved, sentTo, pos.quantity || cfg.quantity, net);
      const r = await deps.replaceOrder(pc.orderId, payload, { kind, of: pos.id, fromLimit: sentFrom, legs, net });
      if (r && r.orderId) pc.orderId = r.orderId;
    }
  }
  decisions.push({ action: kind, positionId: pos.id, from, to, sentNet: net,
    ...(credit ? { sentFrom, sentTo } : {}), ...(extra || {}) });
}

async function workRestingCovers(st, cfg, decisions, deps, underlying) {
  // Either mechanism can be enabled alone: the ladder walks price on a schedule, give-up reacts to the
  // position turning. They compose — give-up supersedes the ladder for a position it fires on.
  if (!deps.coverLadder && !deps.coverGiveUp) return;
  const tick = cfg.tickIncrement, W = cfg.spreadWidth;
  const opts = {
    stepSeconds: deps.ladderStepSeconds, stepPoints: deps.ladderStepPoints,
    steps: deps.ladderSteps, lossCapFrac: deps.ladderLossCapFrac,
    stepDollars: deps.ladderStepDollars,   // width-neutral step sizing (see cover-ladder)
  };
  for (const pos of st.positions) {
    if (!pos.filled || pos.covered || !pos.pendingCover) continue;
    const pc = pos.pendingCover;
    const mark = coverMarkNow(pc.legs, deps.getLeg);

    // GIVE-UP RULE (deps.coverGiveUp) — "better to fill at a small locked profit or even a small loss
    // than to let an open position expire worthless" (user, 2026-09-10).
    //
    // The ladder concedes price on a SCHEDULE. This watches the POSITION: once the underlying has crossed
    // back THROUGH the position's own short strike by giveUpPoints, the trade that was winning is now
    // losing, and we take the fill rather than keep asking. That is precisely where minLock is worst — a
    // deteriorating position makes its cover DEARER exactly as the optimistic target becomes least
    // reachable — so this is what makes an optimistic ask survivable rather than permanent.
    //
    // THE LOSS CAP IS THE WHOLE BALL GAME. Measured over 765 days at 10 points: a 5% cap is a clear win
    // (v6-20 +$324,393, v7-20 +$643,090, and win rate / cover fill / ret-DD up on all four tested), 15%
    // is mixed, 30% is a rout (-$1.5M to -$2.0M). Force the exit, but CHEAPLY — 5% of width is $1.00 on
    // a $20 spread, enough to cross the spread and not enough to chase.
    if (deps.coverGiveUp && pos.shortStrike != null && underlying > 0 && mark != null) {
      const pts = deps.giveUpPoints != null ? deps.giveUpPoints : 10;
      // a bull loses as price falls back BELOW its short strike; a bear as price rises above it
      const through = pos.side === 'bull' ? (pos.shortStrike - underlying) : (underlying - pos.shortStrike);
      if (through >= pts) {
        const cap = (deps.giveUpMaxLoss != null ? deps.giveUpMaxLoss : 0.05) * W;
        const openCost = pc.openCost != null ? pc.openCost : pos.limit;
        const give = L.roundToTick(Math.min(round2(mark + tick), round2(W - openCost + cap)), tick);
        if (give > 0 && Math.abs(give - pc.target) >= tick - 1e-9) {
          pc.gaveUp = true;
          await concedeCover(pos, pc, give, pc.target, cfg, deps, decisions, 'cover-giveup', { mark,
            through: round2(through), points: pts, capFrac: deps.giveUpMaxLoss != null ? deps.giveUpMaxLoss : 0.05 });
        }
        continue;   // give-up supersedes the ladder for this position; it is already at the market
      }
    }

    if (!deps.coverLadder) continue;   // ladder is opt-in separately from give-up
    const next = LAD.limitNow({
      spreadWidth: W, openCost: pc.openCost != null ? pc.openCost : pos.limit, minLock: pc.minLock || 0,
      restingMs: pc.placedEpoch ? (Date.now() - pc.placedEpoch) : 0,
      underlyingMove: (pc.placedUnder != null && deps.underlying != null) ? (deps.underlying - pc.placedUnder) : 0,
      mark, tick,
    }, opts);
    // Gate on the ladder ESCALATING, not on any price wiggle. Bounds this to at most `steps` replaces
    // per order per day; the minMove guard below covers the pinned-to-mark case.
    const stepChanged = pc.ladderStep == null || next.step !== pc.ladderStep;
    if (!LAD.shouldReprice(pc.target, next.limit, tick, { stepChanged, spreadWidth: W, minMoveFrac: deps.ladderMinMoveFrac })) continue;
    pc.ladderStep = next.step;
    await concedeCover(pos, pc, next.limit, pc.target, cfg, deps, decisions, 'cover-reprice',
      { step: next.step, ideal: next.ideal, maxPay: next.maxPay, mark, capped: next.capped, atMax: next.atMax });
  }
}

function resolveRestingCovers(st, cfg, getLeg, decisions, deps) {
  const tick = cfg.tickIncrement;
  for (const pos of st.positions) {
    // POST-FILL OBSERVATION: a cover that has already booked keeps being watched (see the note where
    // filledCover is set) so we can tell a graze from a decisive fill after the fact.
    if (pos.filled && !pos.pendingCover && pos.filledCover) {
      const fq = spreadQuote(pos.filledCover.legs, getLeg);
      const fc = pos.filledCover;
      const fCred = fc.sentNet === 'CREDIT' && fc.sentCredit != null;
      const fks = (fc.legs || []).map((l) => l.strike);
      const fw = fks.length ? Math.max(...fks) - Math.min(...fks) : cfg.spreadWidth;
      noteMarkLow(fc, fq, fCred ? fc.sentCredit : fc.target, fCred ? 'CREDIT' : 'DEBIT',
        fCred ? fw : undefined);
      continue;
    }
    if (!pos.filled || !pos.pendingCover) continue;
    const pc = pos.pendingCover;
    const quote = spreadQuote(pc.legs, getLeg);
    const mark = quote.mark;
    // LOW-WATER MARK — the best price this resting order ever saw, pushed down on EVERY observation
    // including the ones that do not fill. With the sub-bar worker that is ~10 looks per candle instead
    // of one, so `markLow` vs `target` finally answers "did the market actually come to our price, and by
    // how much?" — which a single mark at placement cannot. Recorded before the fill test so a cover that
    // never fills still carries the evidence of how close it came.
    // The dwell has to be measured against the order RESTING: a credit twin against its own credit,
    // a debit against the canonical target.
    const pcCredit = pc.sentNet === 'CREDIT' && pc.sentCredit != null;
    const pcks = (pc.legs || []).map((l) => l.strike);
    const pcw = pcks.length ? Math.max(...pcks) - Math.min(...pcks) : cfg.spreadWidth;
    noteMarkLow(pc, quote, pcCredit ? pc.sentCredit : pc.target, pcCredit ? 'CREDIT' : 'DEBIT',
      pcCredit ? pcw : undefined);
    notePlaced(pc, quote, deps && deps.underlying);
    // TEST THE ORDER THAT IS ACTUALLY RESTING. `mark` and `pc.target` are DEBIT-CANONICAL, but when
    // capital recapture sent the credit twin the thing at the broker is a CREDIT at pc.sentCredit, and a
    // credit fills when the market comes UP to it. Those two tests coincide only while
    // sentCredit == W - target; they did not, because the twin was priced off its own mark until 2096509,
    // so the debit test held covers that the real order had already filled.
    //
    // Measured on 2026-09-17: of 94 credit covers left resting all day, 92 (98%) saw a credit mark that
    // reached the price they were asking. Those positions stayed UNCOVERED and carried the full naked
    // risk of the open for the rest of the session. This is the cover-side mirror of the credit OPEN fill
    // bug fixed in 53b12b7, and the reason the earlier audit missed it is that it asked whether FILLED
    // credit covers deserved to fill — never whether the unfilled ones deserved not to.
    const creditRest = pc.sentNet === 'CREDIT' && pc.sentCredit != null;
    if (mark == null) continue;
    if (creditRest) {
      const ks = (pc.legs || []).map((l) => l.strike);
      const cw = ks.length ? Math.max(...ks) - Math.min(...ks) : 0;
      // The credit the market is offering for the twin, by parity with the canonical mark.
      const creditNow = round2(cw - mark);
      if (!(creditNow >= pc.sentCredit)) continue;       // market has not come up to our ask yet
    } else if (mark > pc.target) {
      continue;                                          // debit: not fillable yet — keep resting
    }
    // THE MAIN COVER FILL PATH, and where most of 2026-09-16's 154 bogus fills were booked. The guard
    // above only asks whether the mark reached the target, which an IMPOSSIBLE mark passes trivially:
    // -32.20 is comfortably below any positive target. The fill price then floored at one tick, so a
    // 40-wide cover booked for $5 and the book recorded it as a nearly free lock. Refuse the quote
    // instead -- the order stays working and is re-tested on the next observation with a fresh one.
    // ALL THE GATES markFill RUNS, not just the first one.
    //
    // This path re-implements the price comparison inline (it has to — the credit side tests the twin's
    // ask against a parity-converted mark, which markFill's sign-flip convention does not express), and
    // it only ever ran verticalSanity. So the two gates written BECAUSE of 2026-09-16 guarded opens and
    // hedges while covers — the orders that actually booked the 154 bogus fills, and the orders that book
    // realizedPnl — were checked by the weakest test in the file.
    //
    // chainMonotonic is the one that matters here: every leg quote that day was individually sane, and
    // the corruption was in ADJACENT PAIRS (a call worth more at the higher strike). All 1,185 violations
    // fell inside the single 14:00 hour that produced every bad cover, and none outside it.
    const sane = SQ.verticalSanity(pc.legs, mark);
    if (!sane.ok) {
      decisions.push({ action: 'cover-badquote', positionId: pos.id, mark, reason: sane.reason, target: pc.target });
      continue;
    }
    const usable = SQ.quoteUsable(pc.legs, quote);
    if (!usable.ok) {
      decisions.push({ action: 'cover-badquote', positionId: pos.id, mark, reason: usable.reason, target: pc.target });
      continue;
    }
    const cmono = SQ.chainMonotonic(pc.legs, getLeg, (deps && deps.strikeIncrement) || cfg.strikeIncrement || 10);
    if (!cmono.ok) {
      const v = cmono.violations[0];
      decisions.push({ action: 'cover-badquote', positionId: pos.id, mark, target: pc.target,
        reason: `chain not monotonic: ${v.type}${v.at} at ${v.mid} beside ${v.type}${v.neighbour} at ${v.neighbourMid}` });
      continue;
    }
    // THE PRICE, IN THE SPACE THE ORDER WAS SENT IN, then booked debit-canonically.
    // A debit pays at most its target and never below the market. A credit RECEIVES at least what it
    // asked and never more than the market — the mirror — and the book records the canonical equivalent,
    // W - credit, so floor/settlement/cover logic keeps seeing one convention.
    let fill;
    if (creditRest) {
      const ks = (pc.legs || []).map((l) => l.strike);
      const cw = ks.length ? Math.max(...ks) - Math.min(...ks) : 0;
      const creditNow = round2(cw - mark);
      const got = round2(Math.min(creditNow, Math.max(pc.sentCredit, round2(creditNow - tick))));
      fill = round2(cw - got);
    } else {
      // Floor at the MARK, not at a tick: a fill never prices below what the thing is marked at.
      fill = round2(Math.max(mark, Math.round(Math.min(pc.target, mark + tick) / tick) * tick));
    }
    // GOVERNOR COVER DEFERRAL — booking this cover would un-hedge the book past the ceiling. Leave the
    // order working and re-check next candle. Covers that improve (or hold) the floor always book.
    if (govOn(deps)) {
      const f0 = RC.bookFloor(st.positions.filter(p => p.filled !== false), null, 10);
      const sv = { covered: pos.covered, coverLegs: pos.coverLegs, coverLimit: pos.coverLimit };
      pos.covered = true; pos.coverLegs = pc.legs; pos.coverLimit = fill;
      const f1 = RC.bookFloor(st.positions.filter(p => p.filled !== false), null, 10);
      pos.covered = sv.covered; pos.coverLegs = sv.coverLegs; pos.coverLimit = sv.coverLimit;
      if (f1 < f0 && -f1 > deps.lossMax) {
        decisions.push({ action: 'cover-defer-governor', positionId: pos.id, floorIfBooked: round2(f1), floorNow: round2(f0), lossMax: deps.lossMax });
        continue;
      }
    }
    pos.covered = true;
    pos.coverId = nextId('cov');
    pos.coverLegs = pc.legs;          // kept for EOD terminal-settlement P/L
    pos.coverLimit = fill;
    pos.coverGeometry = pc.geometry;
    pos.coverStatus = 'filled';
    pos.coverMarkLow = pc.markLow != null ? pc.markLow : mark;   // how far through target it actually got
    pos.coverMarkLowBid = pc.markLowBid; pos.coverMarkLowAsk = pc.markLowAsk;
    // The mark this cover was PLACED at, kept on the position because pendingCover is cleared below —
    // without it a filled cover loses the price it was working against and the row reads "—".
    pos.coverMarkAtPlace = pc.markAtPlace != null ? pc.markAtPlace : null;
    pos.coverLooks = pc.looks || null; pos.coverAtOrThrough = pc.atOrThrough || null;
    pos.coverTime = st.lastCandleTime || null;   // CANDLE time of the cover (for NQ-chart trade plotting)
    pos.coverEpoch = st.lastCandleEpoch || null;
    // WHEN IT ACTUALLY FILLED. coverTime/coverEpoch are deliberately CANDLE-aligned because the NQ chart
    // plots trades on candles — but resting covers are resolved by the sub-bar worker roughly every 30s,
    // so up to ten fills inside one candle all carry the same stamp. On 2026-09-22 v7-40-unc that made 14
    // covers read "14:20", and the same spread booked anywhere from 12.15 to 14.90 — prices a single
    // instant cannot produce, which is exactly how you could tell the stamp was not the fill time.
    // Recorded separately so the table can say when, without moving what the chart plots.
    pos.coverFilledAt = deps && deps.nowMs != null ? deps.nowMs : null;
    // THE GUARANTEED VALUE OF A TENT IS min(openWidth, coverWidth), not the configured width.
    //
    // Open long K1/K2 (width W1) plus cover long K2/K3 (width W2) is worth W2 below K1, W1+W2 at K2 and
    // W1 above K3 — so the floor is min(W1, W2) minus what both cost. Using cfg.spreadWidth is right
    // whenever the cover is the same width or WIDER (min is then W1 = cfg.spreadWidth) and OVERSTATES by
    // (W1 - W2) x 100 when the cover is narrower.
    //
    // Checked against the whole archive before changing anything: 9,120 covers at the same width, 272
    // WIDER, and ZERO narrower — so this has never been wrong, exactly as the resolver's constant-width
    // slide intends. The review that raised it proposed using the COVER's width, which would have
    // overstated those 272 by (W2 - W1) x 100 each. Written as the min so it stays correct by
    // construction if the resolver ever slides at a different width.
    const ck2 = (pc.legs || []).map((l) => l.strike);
    const cw2 = ck2.length ? Math.max(...ck2) - Math.min(...ck2) : cfg.spreadWidth;
    const floorW = Math.min(cfg.spreadWidth, cw2);
    const floor = round2((floorW - pos.limit - fill) * 100 * (pos.quantity || cfg.quantity));
    st.realizedPnl = round2(st.realizedPnl + floor);
    // Signed cash ledger: a credit cover RECLAIMS ~width cash (-), a debit cover PAYS the fill (+). Does
    // not touch P&L — the floor above is booked from the debit-canonical target either way.
    const q = pos.quantity || cfg.quantity;
    // CASH AT THE FILL, NOT THE ASK. sentCredit is what the order ASKED for; the credit actually RECEIVED
    // is `cw - fill` by the same parity the fill was booked through, and a cover can fill better than its
    // ask. book-value.js already values the cover from the fill (`cCost = -(cw - coverLimit)`), so the
    // two disagreed by exactly that difference — measured across the archive's credit covers, up to $237
    // each and $22,577 in total, always overstating the cash reclaimed.
    //
    // This matters more since c6e9c24: cashDeployed is what creditCapitalTrigger reads to decide whether
    // the next order goes out as a debit or a credit, so an overstated reclaim makes the engine think it
    // has freed capital it has not.
    const creditGot = creditRest ? round2(cw2 - fill) : null;
    const cashDelta = pc.sentNet === 'CREDIT' ? -(creditGot != null ? creditGot : (pc.sentCredit || 0)) * 100 * q
      : fill * 100 * q;
    noteCash(st, cashDelta);
    pos.coverSentNet = pc.sentNet;
    // PERSIST THE CREDIT ACTUALLY ASKED. The cover books and tests entirely in DEBIT-canonical space,
    // which is only equivalent to the credit order really resting while sentCredit == W - target. On
    // 2026-09-17 that equivalence broke on the OPEN side (40 of 60 twins differed, and 18 of 60 booked
    // fills the real order would not have got) and the cover side could not be checked at all, because
    // sentCredit lived only on pendingCover and was dropped on fill. Recording it makes the same audit
    // possible here instead of assuming the cover path is fine because nothing has bitten yet.
    pos.coverSentCredit = pc.sentCredit != null ? pc.sentCredit : null;
    // KEEP THE FILLED COVER OBSERVABLE. It used to be dropped here, which ended all evidence the moment
    // it booked — so a cover that just grazed its price and one the market later went a dollar through
    // looked identical afterwards. `filledCover` carries the same object forward and resolveRestingCovers
    // keeps feeding it observations, accruing throughLooks/throughAt/throughBest for the rest of the day.
    // It is evidence only; nothing reads it to make a decision.
    pc.filled = true;
    pos.filledCover = pc;
    pos.pendingCover = null;
    decisions.push({ action: 'cover-fill', positionId: pos.id, coverId: pos.coverId, fillPrice: fill, mark,
      bid: quote.bid, ask: quote.ask, markLow: pc.markLow, markLowBid: pc.markLowBid, markLowAsk: pc.markLowAsk,
      looks: pc.looks, atOrThrough: pc.atOrThrough, target: pc.target, geometry: pc.geometry, lockedFloor: floor, sentNet: pc.sentNet, cashDeployed: st.cashDeployed });
  }
}

module.exports = {
  noteCash,
  creditPreferred,
  openPosition,   // exported for the failed-send contract test

  processCandleClose,
  ratchetLimit, noteFloorPeak,   // FLOOR RATCHET — exported so the suite can drive them directly
  markFill,                      // FILL TEST — exported so its DIRECTION (debit vs credit) can be tested
  placeRestingCover,
  coverToStackFreeBudget, capState,   // CAP ACCOUNTING — exported so stackLocked's effect can be tested             // COVER PLACEMENT — exported so credit/debit price PARITY can be tested
  buildCreditOpenOrder,          // CREDIT TWIN — exported so its parity check can be tested directly
  workRestingCovers,
  // Exported for the sub-bar worker. workRestingCovers WALKS a resting cover; this is what FILLS it, and
  // a caller that takes only the first will reprice forever and never book anything.
  resolveRestingCovers,
  noteMarkLow, notePlaced,       // EVIDENCE CAPTURE — dwell direction, placement stamp, post-fill dwell
  resolvePendingOpen,
  resolvePendingHedges,
  pendingHedges,      // exported so the loop-termination guards are directly testable
  makeLegAccessor,
  buildOrderPayload,
  buildOpen,
  buildOpenAdaptive,
  buildOpenAtStrikes,
  selectCoverGeometric,
  selectCoverFixedMark,
  buyFloorOffsets,
  convertWings,
  buildCover,
  resolveLegs,
  selectCovers,
  selectCoverGreedy,
  selectCoversJoint,
  priceCoverCandidate,
  snapshotChain,
  computeTerminalPnl,
  snapshotSpreads,
  tryComboLockAndOpen   // exported for the combo unit test
};
