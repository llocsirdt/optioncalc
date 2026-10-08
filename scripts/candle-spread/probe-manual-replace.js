#!/usr/bin/env node
'use strict';
/**
 * PROBE: WHAT DOES A MANUAL EDIT IN THE SCHWAB APP DO TO AN ORDER THE ENGINE IS TRACKING?
 *
 * The engine tracks each working order by its id. An API replace (updateOrderById) is known — verified by
 * validate-order-formats --flows on 2026-10-04 — to create a NEW id and send the old one to REPLACED. An edit
 * made by hand in the Schwab app/website has never been observed. If it also issues a new id, the engine
 * today reads the old id's REPLACED as "my cover died", clears it, and sends a second cover next step
 * (order-manager generic dead path). This probe finds out what the edit looks like from the API, and which
 * fields (if any) link the new order to the old one, so it can be detected and adopted.
 *
 * Three steps:
 *   place   (YOU run it) — places ONE 10-wide debit vertical shaped like an engine cover, on the next trading
 *           day's NDXP expiration, priced --offset (default $2.00) under its mark so it cannot fill. Saves
 *           the id to a local state file. Then edit it in the Schwab app: change the price by $0.05 ONLY
 *           (keep it far from the market).
 *   read    (read-only; Claude can run it) — reads the original id and every order entered in the last 24h
 *           on the same legs, and prints status, price, times and every linkage field Schwab returns.
 *           Account numbers are stripped from the output.
 *   cancel  (YOU run it) — cancels whatever probe order is still working and confirms it.
 *
 * Run from the repo root (reads ./.env):
 *   node scripts/candle-spread/probe-manual-replace.js place [--offset 2] [--exp YYYY-MM-DD]
 *   node scripts/candle-spread/probe-manual-replace.js read
 *   node scripts/candle-spread/probe-manual-replace.js cancel
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config({ path: path.join(process.cwd(), '.env'), quiet: true });
process.env.CANDLE_SPREAD_RUNS_DIR = process.env.CANDLE_SPREAD_RUNS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pmr-'));
const { TradingApiClient, MarketApiClient } = require('schwab-client-js');
const SR = path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread');
const trader = require(path.join(SR, 'trader'));
const OM = require(path.join(SR, 'order-manager'));

const STATE = path.join(os.homedir(), '.optioncalc-probe-manual-replace.json');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const cmd = process.argv[2];
const H = process.env.ACCOUNT_HASH;
const T = new TradingApiClient(process.env.SCHWAB_CLIENT_ID, process.env.SCHWAB_CLIENT_SECRET, process.env.SCHWAB_REFRESH_TOKEN);
const M = new MarketApiClient(process.env.SCHWAB_CLIENT_ID, process.env.SCHWAB_CLIENT_SECRET, process.env.SCHWAB_REFRESH_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK = 0.05;
const r2 = (n) => Math.round(n * 100) / 100;
const TERM = new Set(['CANCELED', 'REJECTED', 'FILLED', 'EXPIRED', 'REPLACED']);

// Never print account identifiers.
function scrub(x) {
  if (Array.isArray(x)) return x.map(scrub);
  if (x && typeof x === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(x)) { if (/account/i.test(k)) continue; o[k] = scrub(v); }
    return o;
  }
  return x;
}
function nextTradingDay() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (d.getHours() * 60 + d.getMinutes() >= 16 * 60) d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA');
}
const legKey = (o) => (o.orderLegCollection || []).map((l) => `${l.instruction}:${l.instrument && l.instrument.symbol}`).sort().join('|');
// Everything that could tie an edited order back to its original. Printed whole so nothing is assumed.
const summary = (o) => ({
  orderId: o.orderId, status: o.status, statusDescription: o.statusDescription, price: o.price, orderType: o.orderType,
  enteredTime: o.enteredTime, closeTime: o.closeTime, cancelable: o.cancelable, editable: o.editable,
  // The tag identifies the app that entered the order ('TA_' + an account-linked id for our API app). Only its
  // prefix is printed: whether an app edit changes it is the point, the identifier is not.
  tag: o.tag ? `${String(o.tag).split('_')[0]}_… (${String(o.tag).length} chars)` : o.tag, session: o.session, duration: o.duration, filledQuantity: o.filledQuantity, remainingQuantity: o.remainingQuantity,
  replacingOrderCollection: o.replacingOrderCollection ? scrub(o.replacingOrderCollection).map((r) => ({ orderId: r.orderId, status: r.status, price: r.price })) : undefined,
  childOrderStrategies: o.childOrderStrategies ? o.childOrderStrategies.map((r) => ({ orderId: r.orderId, status: r.status, price: r.price })) : undefined,
  otherKeys: Object.keys(o).filter((k) => !/account/i.test(k)).sort().join(','),
});

(async () => {
  if (cmd === 'place') {
    if (fs.existsSync(STATE)) { console.log(`a probe is already recorded in ${STATE} — run 'cancel' first`); process.exit(2); }
    const exp = arg('--exp', nextTradingDay());
    const offset = Number(arg('--offset', 2));
    const ch = await M.chains('$NDX', { fromDate: exp, toDate: exp, strikeCount: 40 });
    if (!ch || ch.status !== 'SUCCESS') throw new Error(`no chain for ${exp}`);
    const S = ch.underlyingPrice, atm = Math.round(S / 10) * 10;
    const book = { C: {}, P: {} };
    for (const [map, t] of [[ch.callExpDateMap, 'C'], [ch.putExpDateMap, 'P']])
      for (const strikes of Object.values(map || {})) for (const [k, arr] of Object.entries(strikes)) {
        const o = (arr || []).find((x) => /^NDXP/.test(String(x.symbol))) || (arr || [])[0];
        if (o) book[t][Number(k)] = o;
      }
    const leg = (side, t, k) => { const q = book[t][k]; if (!q) throw new Error(`no ${t}${k}`); return { side, type: t, strike: k, symbol: q.symbol, mark: q.mark }; };
    // An engine-shaped tent cover of a bull (short P atm+10 / long P atm+20), the most common cover shape.
    const legs = [leg('short', 'P', atm + 10), leg('long', 'P', atm + 20)];
    const mark = r2(legs.reduce((s, l) => s + (l.side === 'long' ? 1 : -1) * l.mark, 0));
    const price = Math.max(TICK, r2(Math.floor(Math.max(mark - offset, 0.4 * mark) / TICK + 1e-9) * TICK));
    const payload = OM.wirePrice(trader.buildOrderPayload(legs, price, 1, 'DEBIT'));
    console.log(`NDX ${S} · exp ${exp} · P${atm + 20}/P${atm + 10} mark ${mark} · placing at ${price} (unfillable)`);
    const r = await T.placeOrderByAcct(H, payload);
    const id = r && r.orderId;
    if (!id) { console.log('STOP: placed without an id — check the Schwab app and cancel by hand'); process.exit(3); }
    fs.writeFileSync(STATE, JSON.stringify({ id: String(id), placedAt: new Date().toISOString(), price, exp, legs: legs.map((l) => `${l.side} ${l.type}${l.strike}`) }));
    await sleep(2000);
    const o = await T.orderById(H, String(id));
    console.log(JSON.stringify(summary(o), null, 1));
    console.log(`\nNow edit order ${id} in the Schwab app: change the price from ${price} to ${r2(price + TICK)} (nothing else).`);
    console.log("Then tell Claude to run 'read'. Cancel it before the open with 'cancel'.");
  } else if (cmd === 'read') {
    if (!fs.existsSync(STATE)) { console.log('no probe recorded — run place first'); process.exit(2); }
    const s = JSON.parse(fs.readFileSync(STATE));
    const orig = await T.orderById(H, s.id);
    console.log(`ORIGINAL ${s.id} (placed ${s.placedAt} at ${s.price}, legs ${s.legs.join(' / ')})`);
    console.log(JSON.stringify(summary(orig), null, 1));
    const now = new Date(), from = new Date(now.getTime() - 24 * 3600 * 1000);
    const all = await T.ordersByAccount(H, from.toISOString(), now.toISOString());
    const same = (all || []).filter((o) => legKey(o) === legKey(orig) && String(o.orderId) !== s.id);
    console.log(`\nOTHER ORDERS ON THE SAME LEGS, last 24h: ${same.length}`);
    for (const o of same) console.log(JSON.stringify(summary(o), null, 1));
    const verdict = orig.status === 'REPLACED' ? 'the edit RETIRED the original id (status REPLACED) — a new id carries the order'
      : !TERM.has(orig.status) && Math.abs(orig.price - s.price) > 1e-9 ? 'the edit KEPT the original id and changed its price in place'
        : !TERM.has(orig.status) ? 'the original is still working at its placed price — not edited yet?' : `the original is ${orig.status}`;
    console.log(`\nVERDICT: ${verdict}`);
  } else if (cmd === 'cancel') {
    if (!fs.existsSync(STATE)) { console.log('no probe recorded'); process.exit(2); }
    const s = JSON.parse(fs.readFileSync(STATE));
    const orig = await T.orderById(H, s.id);
    const now = new Date(), from = new Date(now.getTime() - 24 * 3600 * 1000);
    const all = await T.ordersByAccount(H, from.toISOString(), now.toISOString());
    const live = [orig, ...(all || []).filter((o) => legKey(o) === legKey(orig) && String(o.orderId) !== s.id)].filter((o) => o && !TERM.has(o.status));
    if (!live.length) { console.log('nothing working on the probe legs'); fs.unlinkSync(STATE); return; }
    let ok = true;
    for (const o of live) {
      try { await T.orderDelete(H, String(o.orderId)); } catch (e) { console.log(`cancel ${o.orderId} error: ${String(e.message).slice(0, 120)}`); }
      let c = null; for (let i = 0; i < 6; i++) { await sleep(1500); try { c = await T.orderById(H, String(o.orderId)); } catch (e) {} if (c && TERM.has(c.status)) break; }
      console.log(`order ${o.orderId}: ${c ? c.status : 'unknown'}`);
      if (!c || c.status !== 'CANCELED') ok = false;
    }
    if (ok) { fs.unlinkSync(STATE); console.log('probe cancelled and cleared'); }
    else { console.log('STOP: a cancel was not confirmed — check the Schwab app and cancel by hand before the open'); process.exit(3); }
  } else {
    console.log('usage: probe-manual-replace.js place [--offset 2] | read | cancel');
    process.exit(1);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
