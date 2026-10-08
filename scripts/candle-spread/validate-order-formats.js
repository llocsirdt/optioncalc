#!/usr/bin/env node
'use strict';
/**
 * VALIDATE ORDER FORMATS AGAINST SCHWAB — every order shape the engine sends, built by the ENGINE'S OWN
 * code (trader.buildOrderPayload, trader.tickUp, order-manager.wirePrice / netOfPayload), checked with
 * Schwab's previewOrder endpoint.
 *
 * WHY. On 2026-10-02 a cover went out as 3.3000000000000003 and Schwab rejected it for 40 minutes; on
 * 2026-10-04 a place-and-cancel test showed every naked wing the engine would have sent was refused
 * ("Limit price must be populated only for limit orders"). Neither was visible in tests or test mode,
 * because test mode rewrites prices and no hedge had ever reached the broker. This asks the broker.
 *
 * DEFAULT = PREVIEW ONLY. previewOrder validates an order and returns Schwab's reject reasons without
 * placing anything (verified 2026-10-04: same messages as a real placement). Prices are the REALISTIC
 * ones the engine would send, from the live chain.
 *
 * --place also PLACES each order at a near-market price that will not fill over a weekend: buys --offset
 * dollars (default 2.00) below the mark, never below 40% of it (Schwab rejects a single option priced
 * "significantly away from the current market price"); credits the same amount above the value, capped
 * below the width; all on the $0.05 tick. It reads the status, cancels, confirms the cancel, and stops on
 * any anomaly, naming the order so it can be cancelled by hand before the open.
 *
 * --flows exercises the order LIFECYCLE the engine relies on but that had never been verified end to end:
 * replace (does the response carry the NEW order id, as makeReplaceOrder assumes? does the old order go to
 * REPLACED?), a credit cover replace, a chained replace A -> B -> C, replacing a cancelled order, cancelling
 * a cancelled order, and the final cancels — each confirmed.
 *
 * Run from the repo root (reads ./.env):
 *   node scripts/candle-spread/validate-order-formats.js [--exp YYYY-MM-DD] [--place [--offset 2]] [--flows] [--only wing-naked,offset]
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(process.cwd(), '.env'), quiet: true });
process.env.CANDLE_SPREAD_RUNS_DIR = process.env.CANDLE_SPREAD_RUNS_DIR || fs.mkdtempSync(path.join(require('os').tmpdir(), 'vof-'));
const { TradingApiClient, MarketApiClient } = require('schwab-client-js');
const SR = path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread');
const trader = require(path.join(SR, 'trader'));
const OM = require(path.join(SR, 'order-manager'));
const L = require(path.join(SR, 'spread-logic'));

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const PLACE = process.argv.includes('--place');
const ONLY = arg('--only', null) ? arg('--only', null).split(',') : null;
const H = process.env.ACCOUNT_HASH;
const T = new TradingApiClient(process.env.SCHWAB_CLIENT_ID, process.env.SCHWAB_CLIENT_SECRET, process.env.SCHWAB_REFRESH_TOKEN);
const M = new MarketApiClient(process.env.SCHWAB_CLIENT_ID, process.env.SCHWAB_CLIENT_SECRET, process.env.SCHWAB_REFRESH_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK = 0.05, W = 10;
const r2 = (n) => Math.round(n * 100) / 100;
const tickDown = (x) => r2(Math.floor(r2(x) / TICK + 1e-9) * TICK);
const TERM = new Set(['CANCELED', 'REJECTED', 'FILLED', 'EXPIRED', 'REPLACED']);
const OFFSET = Number(arg('--offset', 2));
const FLOWS = process.argv.includes('--flows');
// A near-market price that will not fill: buys OFFSET below the mark (>= 40% of it), credits OFFSET above
// the value (< width). On the tick, rounded AWAY from a fill.
function awayPrice(value, credit) {
  if (credit) return Math.min(r2(W - TICK), r2(Math.ceil(r2(value + OFFSET) / TICK - 1e-9) * TICK));
  return Math.max(TICK, tickDown(Math.max(value - OFFSET, 0.4 * value)));
}
async function statusOf(id, wantTerminal) {
  let o = null;
  for (let i = 0; i < 6; i++) { await sleep(1500); try { o = await T.orderById(H, id); } catch (e) {} if (o && (!wantTerminal || TERM.has(o.status))) break; }
  return o;
}
async function cancelConfirmed(id) {
  try { await T.orderDelete(H, id); } catch (e) { return 'cancel error: ' + String(e.message).slice(0, 120); }
  const c = await statusOf(id, true);
  return c && c.status === 'CANCELED' ? 'CANCELED' : `NOT CONFIRMED (${c ? c.status : 'unknown'})`;
}

function nextTradingDay() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const after = d.getHours() * 60 + d.getMinutes() >= 16 * 60;
  if (after) d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA');
}

(async () => {
  const exp = arg('--exp', nextTradingDay());
  const ch = await M.chains('$NDX', { fromDate: exp, toDate: exp, strikeCount: 80 });
  if (!ch || ch.status !== 'SUCCESS') throw new Error(`no chain for ${exp}`);
  const S = ch.underlyingPrice;
  const book = { C: {}, P: {} };
  for (const [map, t] of [[ch.callExpDateMap, 'C'], [ch.putExpDateMap, 'P']])
    for (const strikes of Object.values(map || {})) for (const [k, arr] of Object.entries(strikes)) {
      const o = (arr || []).find((x) => /^NDXP/.test(String(x.symbol))) || (arr || [])[0];
      if (o) book[t][Number(k)] = { symbol: o.symbol, bid: o.bid, ask: o.ask, mark: o.mark };
    }
  const q = (t, k) => { const x = book[t][k]; if (!x) throw new Error(`no ${t}${k} in chain`); return x; };
  const leg = (side, t, k) => ({ side, type: t, strike: k, symbol: q(t, k).symbol });
  const atm = Math.round(S / 10) * 10;
  const vMark = (legs) => r2(legs.reduce((s, l) => s + (l.side === 'long' ? 1 : -1) * q(l.type, l.strike).mark, 0));
  console.log(`NDX ${S} · expiration ${exp} · ATM ${atm} · mode ${PLACE ? 'PREVIEW + PLACE/CANCEL (unfillable)' : 'PREVIEW ONLY (nothing placed)'}\n`);

  // Every shape v7-10 (and the fleet) can send, priced the way the engine prices it.
  const farCall = atm + 300, farPut = atm - 300;
  const bullOpen = [leg('long', 'C', atm), leg('short', 'C', atm + 10)];
  const bullOpenCreditTwin = [leg('short', 'P', atm + 10), leg('long', 'P', atm)];
  const bearCoverOfBull = [leg('short', 'P', atm + 10), leg('long', 'P', atm + 20)];        // tent cover, debit
  const bearCoverCreditTwin = [leg('short', 'C', atm + 10), leg('long', 'C', atm + 20)];    // its credit twin
  const offset = [leg('long', 'P', farPut + 20), leg('short', 'P', farPut)];                 // floor-offset debit vertical
  const wingSpread = [leg('long', 'C', farCall), leg('short', 'C', farCall + 20)];
  const nakedWing = [leg('long', 'C', farCall)];
  const fly = [leg('long', 'C', atm - 10), leg('short', 'C', atm), leg('short', 'C', atm), leg('long', 'C', atm + 10)];
  const condor = [leg('long', 'P', atm - 40), leg('short', 'P', atm - 30), leg('short', 'P', atm + 30), leg('long', 'P', atm + 40)];
  const mkt = (legs) => vMark(legs);
  const SHAPES = [
    { id: 'open-debit', legs: bullOpen, net: 'DEBIT', price: L.roundToTick(mkt(bullOpen), TICK), value: mkt(bullOpen) },
    { id: 'open-credit-twin', legs: bullOpenCreditTwin, net: 'CREDIT', price: r2(W - r2(L.roundToTick(mkt(bullOpen), TICK))), value: r2(W - mkt(bullOpen)), credit: true },
    { id: 'cover-debit', legs: bearCoverOfBull, net: 'DEBIT', price: r2(L.roundToTick(mkt(bearCoverOfBull), TICK)), value: mkt(bearCoverOfBull) },
    { id: 'cover-credit-twin', legs: bearCoverCreditTwin, net: 'CREDIT', price: r2(W - r2(L.roundToTick(mkt(bearCoverOfBull), TICK))), value: r2(W - mkt(bearCoverOfBull)), credit: true },
    { id: 'cover-float-3.3', legs: bearCoverOfBull, net: 'DEBIT', price: L.roundToTick(3.3, TICK), value: mkt(bearCoverOfBull), note: 'the 10-02 float, through wirePrice' },
    { id: 'offset', legs: offset, net: 'DEBIT', price: trader.tickUp(mkt(offset) + 0.25, TICK), value: mkt(offset) },
    { id: 'wing-spread', legs: wingSpread, net: 'DEBIT', price: trader.tickUp(q('C', farCall).ask - q('C', farCall + 20).bid, TICK), value: mkt(wingSpread) },
    { id: 'wing-naked', legs: nakedWing, net: 'DEBIT', price: trader.tickUp(q('C', farCall).ask, TICK), value: q('C', farCall).mark },
    { id: 'fly', legs: fly, net: 'DEBIT', price: trader.tickUp(Math.max(0.05, mkt(fly)), TICK), value: mkt(fly), note: 'not on v7-10' },
    { id: 'condor', legs: condor, net: 'DEBIT', price: trader.tickUp(Math.max(0.05, mkt(condor)), TICK), value: mkt(condor), note: 'floor-raise valley span (2026-10-07)' },
  ].filter((s) => !ONLY || ONLY.includes(s.id));

  let failures = 0;
  for (const s of SHAPES) {
    const payload = OM.wirePrice(trader.buildOrderPayload(s.legs, s.price, 1, s.net));
    const res = { shape: s.id, orderType: payload.orderType, strategy: payload.complexOrderStrategyType || '(none)', legs: payload.orderLegCollection.length,
      price: payload.price, side: OM.netOfPayload(payload), value: s.value };
    try {
      const pv = await T.orderPreview(H, payload);
      const rej = (pv && pv.orderValidationResult && pv.orderValidationResult.rejects) || (pv && pv.rejects) || [];
      res.preview = rej.length ? 'REJECT: ' + rej.map((x) => x.activityMessage).join(' | ') : 'OK';
    } catch (e) { res.preview = 'REFUSED: ' + String(e.message).replace(/^Error: /, '').slice(0, 200); }
    if (res.preview !== 'OK') failures++;

    if (PLACE) {
      const unf = awayPrice(s.value, !!s.credit);
      if (!(unf > 0)) { res.place = 'SKIPPED: no valid near-market price'; console.log(JSON.stringify(res)); continue; }
      const p2 = OM.wirePrice({ ...payload, price: unf });
      res.placedAt = unf;
      let id = null;
      try { const r = await T.placeOrderByAcct(H, p2); id = r && r.orderId; res.place = id ? 'ACCEPTED' : 'no id'; }
      catch (e) { res.place = 'REFUSED: ' + String(e.message).replace(/^Error: /, '').slice(0, 200); }
      if (id) {
        let o = null; for (let i = 0; i < 4; i++) { await sleep(1500); try { o = await T.orderById(H, id); } catch (e) {} if (o && TERM.has(o.status)) break; }
        res.status = o ? `${o.status}${o.statusDescription ? ' — ' + o.statusDescription : ''}` : 'unknown';
        if (!o || !TERM.has(o.status)) {
          try { await T.orderDelete(H, id); } catch (e) { res.cancel = 'ERR ' + String(e.message).slice(0, 100); }
          let c = null; for (let i = 0; i < 6; i++) { await sleep(1500); try { c = await T.orderById(H, id); } catch (e) {} if (c && TERM.has(c.status)) break; }
          res.final = c ? c.status : 'unknown';
          if (!c || c.status !== 'CANCELED') { console.log(JSON.stringify(res)); console.log(`STOP: cancel not confirmed for order ${id} — check the Schwab app`); process.exit(3); }
        }
      } else if (res.place === 'no id') { console.log(JSON.stringify(res)); console.log('STOP: placed without an id — check the Schwab app'); process.exit(2); }
    }
    console.log(JSON.stringify(res));
  }
  // ── LIFECYCLE FLOWS ───────────────────────────────────────────────────────────────────────────────
  if (FLOWS) {
    console.log('\nFLOWS');
    const step = (name, ok, detail) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
    const stop = (id) => { console.log(`STOP: order ${id} may still be working — cancel it in the Schwab app before the open`); process.exit(3); };
    // A replace that reports no new id may still have created a working replacement we cannot see.
    const needId = (newId, oldId, what) => { if (!newId || newId === oldId) { console.log(`STOP: ${what} returned no new order id — a replacement of ${oldId} may be WORKING untracked; check the Schwab app's open orders and cancel it before the open`); process.exit(4); } };
    // 1-3: replace chain on a debit cover, then the credit twin
    const cover = OM.wirePrice(trader.buildOrderPayload(bearCoverOfBull, awayPrice(mkt(bearCoverOfBull), false), 1, 'DEBIT'));
    let A = null;
    try { A = (await T.placeOrderByAcct(H, cover)).orderId; } catch (e) { step('place A (debit cover)', false, e.message); }
    if (A) {
      step('place A (debit cover)', true, `id ${A} @ ${cover.price}`);
      const aStat = await statusOf(A, false);
      step('A is working', aStat && !TERM.has(aStat.status), aStat && aStat.status);
      // replace A -> B, exactly as makeReplaceOrder: updateOrderById, read resp.orderId
      const bPayload = OM.wirePrice({ ...cover, price: r2(cover.price + TICK) });
      let rB = null; try { rB = await T.updateOrderById(H, A, bPayload); } catch (e) { step('replace A -> B', false, e.message); stop(A); }
      const B = rB && rB.orderId;
      needId(B, A, 'replace A -> B');
      step('replace A -> B returns a NEW order id (makeReplaceOrder relies on it)', !!B && B !== A, `resp.orderId=${B}`);
      const aAfter = await statusOf(A, true);
      step('A goes to REPLACED', aAfter && aAfter.status === 'REPLACED', aAfter && aAfter.status);
      if (B) {
        const bStat = await statusOf(B, false);
        step('B is working at the new price', bStat && !TERM.has(bStat.status) && Math.abs(bStat.price - bPayload.price) < 1e-9, bStat && `${bStat.status} @ ${bStat.price}`);
        // chained: B -> C before anything else polls
        const cPayload = OM.wirePrice({ ...cover, price: r2(bPayload.price + TICK) });
        let rC = null; try { rC = await T.updateOrderById(H, B, cPayload); } catch (e) { step('replace B -> C (chained)', false, e.message); stop(B); }
        const Cid = rC && rC.orderId;
        needId(Cid, B, 'replace B -> C');
        step('replace B -> C (chained) returns a new id', !!Cid && Cid !== B, `resp.orderId=${Cid}`);
        const bAfter = await statusOf(B, true);
        step('B goes to REPLACED', bAfter && bAfter.status === 'REPLACED', bAfter && bAfter.status);
        if (Cid) {
          const c = await cancelConfirmed(Cid);
          step('cancel C, confirmed', c === 'CANCELED', c);
          if (c !== 'CANCELED') stop(Cid);
          // replacing / cancelling a dead order: the engine expects Schwab to refuse both
          try { await T.updateOrderById(H, Cid, cPayload); step('replacing a CANCELED order is refused', false, 'it was accepted!'); }
          catch (e) { step('replacing a CANCELED order is refused', /cannot be replaced/i.test(e.message), String(e.message).slice(0, 120)); }
          try { await T.orderDelete(H, Cid); step('cancelling a CANCELED order is refused', false, 'it was accepted!'); }
          catch (e) { step('cancelling a CANCELED order is refused', /cannot be canceled/i.test(e.message), String(e.message).slice(0, 120)); }
        }
      }
    }
    // 4: credit cover placed then replaced (give-up / ladder on a credit twin concede DOWN in credit)
    // The credit twin's VALUE is width minus the debit cover's mark (its own raw mark is negative by
    // construction — gating on that skipped this flow silently in the first version).
    const ccv = r2(W - mkt(bearCoverOfBull));
    if (ccv > 0 && ccv < W) {
      const credit = OM.wirePrice(trader.buildOrderPayload(bearCoverCreditTwin, awayPrice(ccv, true), 1, 'CREDIT'));
      let X = null; try { X = (await T.placeOrderByAcct(H, credit)).orderId; } catch (e) { step('place credit cover', false, e.message); }
      if (!X) step('place credit cover', false, 'no order id');
      if (X) {
        step('place credit cover', true, `id ${X} @ ${credit.price} credit`);
        const yPayload = OM.wirePrice({ ...credit, price: r2(credit.price - TICK) });
        let rY = null; try { rY = await T.updateOrderById(H, X, yPayload); } catch (e) { step('replace credit cover (concede)', false, e.message); stop(X); }
        const Y = rY && rY.orderId;
        needId(Y, X, 'replace credit cover');
        step('replace credit cover returns a new id', !!Y && Y !== X, `resp.orderId=${Y}`);
        const yStat = Y ? await statusOf(Y, false) : null;
        step('the replacement keeps NET_CREDIT at the conceded price', yStat && yStat.orderType === 'NET_CREDIT' && Math.abs(yStat.price - yPayload.price) < 1e-9, yStat && `${yStat.orderType} @ ${yStat.price}`);
        const c = await cancelConfirmed(Y || X);
        step('cancel the credit cover, confirmed', c === 'CANCELED', c);
        if (c !== 'CANCELED') stop(Y || X);
      }
    }
    // 5: naked wing placed and replaced as a single-leg LIMIT
    const w = OM.wirePrice(trader.buildOrderPayload(nakedWing, awayPrice(q('C', farCall).mark, false), 1, 'DEBIT'));
    let Wid = null; try { Wid = (await T.placeOrderByAcct(H, w)).orderId; } catch (e) { step('place naked wing (LIMIT)', false, e.message); }
    if (Wid) {
      const ws = await statusOf(Wid, false);
      step('place naked wing (LIMIT)', ws && !TERM.has(ws.status), ws && `${ws.status}${ws.statusDescription ? ' — ' + ws.statusDescription : ''} @ ${w.price}`);
      if (ws && !TERM.has(ws.status)) {
        let rw = null; try { rw = await T.updateOrderById(H, Wid, OM.wirePrice({ ...w, price: r2(w.price + TICK) })); } catch (e) { step('replace naked wing', false, e.message); stop(Wid); }
        const W2 = rw && rw.orderId;
        needId(W2, Wid, 'replace naked wing');
        step('replace naked wing returns a new id', !!W2 && W2 !== Wid, `resp.orderId=${W2}`);
        const c = await cancelConfirmed(W2 || Wid);
        step('cancel naked wing, confirmed', c === 'CANCELED', c);
        if (c !== 'CANCELED') stop(W2 || Wid);
      }
    }
  }

  console.log(`\n${failures ? `${failures} check(s) FAILED — see above` : 'every check passed'}${PLACE || FLOWS ? '' : ' (preview only; nothing was placed)'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
