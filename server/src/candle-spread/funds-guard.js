'use strict';
// FUNDS GUARD (user, 2026-10-14). Live v7-10 drew 50 Schwab rejections in an hour ("You do not have enough available
// cash/buying power for this order"): 2 opens, one cover retried 27 times, another 20 times, and a raise — every
// retry rebuilt in the SAME form. The user's rules:
//   1. Assume the account holds only the strategy's risk max (lossMax: $2,000 for the 10-wides). Watch net spend —
//      debits paid minus credits received, plus debits still working — and when a DEBIT order would push it past
//      that, send the order's CREDIT twin instead (same payoff, cash comes in rather than going out).
//   2. When Schwab rejects an order for funds, send the opposing form next time (debit <-> credit). Often the
//      same position placed the other way is accepted.
// A credit order still needs margin (width - credit) unless it pairs with a leg already held, so (2) alternates
// rather than assuming the credit form always passes: 10/14 12:20's rejected open and 12:41's cover were credits.

const FUNDS_REJECT = /buying power|available cash|insufficient funds|not enough (available )?(cash|funds)/i;
const isFundsReject = (reason) => FUNDS_REJECT.test(String(reason || ''));
const r2 = (x) => Math.round(x * 100) / 100;

// The ceiling on net spend: cfg.fundsBudget when set, else the strategy's risk max.
function fundsBudget(cfg) {
  if (!cfg) return null;
  if (cfg.fundsBudget != null) return cfg.fundsBudget > 0 ? cfg.fundsBudget : null;
  return cfg.lossMax > 0 ? cfg.lossMax : null;
}

// Net dollars out: st.cashDeployed (booked at the fill: +debit, -credit) plus every DEBIT still working, since
// Schwab reserves a working debit's cash the moment it is placed.
function netSpend(st) {
  let working = 0;
  for (const p of (st && st.positions) || []) {
    if (!p) continue;
    const q = p.quantity || 1;
    if (!p.filled && !p.expired && p.orderId && String(p.sentNet || 'DEBIT') !== 'CREDIT') {
      const px = p.pendingHedge && p.pendingHedge.limit != null ? p.pendingHedge.limit : (p.sentLimit != null ? p.sentLimit : p.limit);
      if (px > 0) working += px * 100 * q;
    }
    if (p.pendingCover && !p.covered && String(p.coverSentNet || 'DEBIT') !== 'CREDIT') {
      const px = p.pendingCover.limit != null ? p.pendingCover.limit : p.coverLimit;
      if (px > 0) working += px * 100 * q;
    }
  }
  return r2(((st && st.cashDeployed) || 0) + working);
}

// Would paying `debitDollars` more keep net spend within the budget? true when no budget applies.
function debitFits(st, cfg, debitDollars) {
  const b = fundsBudget(cfg);
  if (!(b > 0) || !(debitDollars > 0)) return true;
  return netSpend(st) + debitDollars <= b;
}

// The last rejection on `key` was for funds: { net: 'DEBIT'|'CREDIT'|null, count }. null otherwise.
function fundsRejected(st, key) {
  const rj = st && st.rejectStreaks && st.rejectStreaks[key];
  if (!rj || !isFundsReject(rj.lastReason)) return null;
  return { net: rj.net || null, count: rj.count };
}

// The send form for an order that can go either way. Returns { credit: bool, why } when the guard decides, or
// null to leave the caller's own choice. A funds rejection flips to the form NOT last rejected (when the record
// carries no side, it alternates on the count, as the cover style flip does); otherwise a debit that would
// overrun the budget goes as credit.
function fundsStyle(st, cfg, { key, debitDollars, wantCredit }) {
  const rj = key ? fundsRejected(st, key) : null;
  if (rj) {
    const credit = rj.net ? rj.net === 'DEBIT' : (rj.count % 2 === 1 ? !wantCredit : !!wantCredit);
    return { credit, why: 'funds-reject', rejected: rj.net, rejects: rj.count };
  }
  if (!wantCredit && !debitFits(st, cfg, debitDollars)) {
    return { credit: true, why: 'funds-budget', netSpend: netSpend(st), budget: fundsBudget(cfg), debit: r2(debitDollars) };
  }
  return null;
}

// Twin of a DEBIT 2-leg vertical (bull call or bear put): the other option type at the same strikes and sides —
// a credit spread whose payoff is the original's less the constant width, so its credit = width - debit.
// { legs, offset } in the shape of floor-raise ironTwin (debit-equivalent = offset - credit).
function verticalTwin(legs) {
  if (!legs || legs.length !== 2 || legs[0].type !== legs[1].type || legs[0].side === legs[1].side) return null;
  const long = legs[0].side === 'long' ? legs[0] : legs[1];
  const short = long === legs[0] ? legs[1] : legs[0];
  const isDebit = long.type === 'C' ? long.strike < short.strike : long.strike > short.strike;
  if (!isDebit) return null;
  const t = long.type === 'C' ? 'P' : 'C';
  return { legs: [{ side: 'long', type: t, strike: long.strike }, { side: 'short', type: t, strike: short.strike }],
    offset: r2(Math.abs(long.strike - short.strike)) };
}

module.exports = { isFundsReject, fundsBudget, netSpend, debitFits, fundsRejected, fundsStyle, verticalTwin };
