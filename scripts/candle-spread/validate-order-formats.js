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
 * --place additionally places each order at an UNFILLABLE price (buys at <= 50% of the bid, credits at
 * >= 1.5x the value and < width), reads the status, cancels it and confirms the cancel, stopping on any
 * anomaly. Note: Schwab rejects a single option priced far from the market ("significantly away from the
 * current market price"), so a --place single-leg result can only confirm the FORMAT, not the price; the
 * realistic price is what the preview checks.
 *
 * Run from the repo root (reads ./.env):
 *   node scripts/candle-spread/validate-order-formats.js [--exp YYYY-MM-DD] [--place] [--only wing,offset]
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
      const unf = s.credit ? Math.min(r2(W - TICK), tickDown(Math.max(1.5 * s.value, s.price) + 0.5)) : tickDown(Math.max(TICK, 0.5 * Math.min(s.value, s.price)));
      if (!s.credit && !(unf < 0.5 * s.value + 1e-9)) { res.place = 'SKIPPED: could not price safely unfillable'; console.log(JSON.stringify(res)); continue; }
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
  console.log(`\n${failures ? `${failures} shape(s) NOT accepted by preview — see above` : 'every engine order shape passed Schwab preview'}${PLACE ? '' : ' (preview only; nothing was placed)'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
