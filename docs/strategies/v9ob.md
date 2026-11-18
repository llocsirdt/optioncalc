# v9ob — "v9 + open block against trend A"

`{ parent: 'v9', tag: 'ob', label: '+ open block against trend A', flags: { openTrendBlock: 'A' } }`
— `server/src/candle-spread/index.js` `FEATURE_FAMILIES`, cloned by `buildFeatureFamilies`

Shared machinery: [README.md](README.md#shared-machinery-read-this-before-any-family-file). Every open / cover
trigger and the strategy × signal matrix: [signals.md](signals.md).

**Feature-test family** (2026-10-19): a complete copy of [v9](v9.md) — all 8 shapes — built exactly as
[v9sg](v9sg.md) is, with `openTrendBlock: 'A'` as the one added flag.

## Intent

**Never open against the trend.** Any open — first open, add, be-wrong, overextension reversal — that points
against trend definition **A** is dropped. Until 2026-10-19 this was a backtest-only control arm of the
2026-10-07 "never fight the trend" work; the trend sweep found it the best fleet-wide *risk* arm at a large 10W
P&L cost (the v9ob comment in `FEATURE_FAMILIES`).

## Open signal

**Identical to v9**, except the open is filtered **right after the signal is computed, before anything else
reads it** (`trader.js` `processCandleClose`, the OPEN TREND BLOCK block, decision `open-skip-trend-block`; backtest
`backtest-v6-5m.js` `runDay5m`, the OPEN TREND BLOCK block):

- **Trend A** (`trend-state.js` `DEFS.A`): `t15` if `t15 ≠ 0` **and** `t15 === hc`, else 0, where
  - `t15` = 15m structural trend of the last completed /NQ 15m candle (`trend-state.js` `trendOf`): +1 when close > BB mid
    and 9EMA ≥ BB mid; −1 when close < BB mid and 9EMA ≤ BB mid; else 0;
  - `hc` = colour of the last **completed** /NQ hourly candle (+1 green, −1 red).
- **Blocked** when `against(openSide, A)` (`trend-state.js` `against`): a bull open with A = −1, or a bear open with A = +1.
  A = 0 (15m neutral, or 15m and hourly disagree) blocks nothing.
- Only the open is dropped; **the signal's cover side still acts** on that candle.

Live, the trend context is built every tick from the series (`index.js` `processGroup` → `TS.contextFromSeries`);
the backtest follows it bar by bar (`TS.makeTracker`).

## Cover signal

**Identical to v9.** Cover-to-stack: `coverToStack: true` on the roster, but live it fires only when `capState`
(`trader.js`) fails on `softCap` / `hardCap` / `riskCap`, all `null` on every variant, and the backtest's
governor-block lock skips positions with a resting cover (all of them) — it does nothing in either engine
(journal 2026-11-06).

## Where v9ob and v9sg differ

See the worked examples in [v9sg.md](v9sg.md#where-v9sg-and-v9ob-differ-worked-examples-verified-against-trend-statejs):
v9ob drops a *first* open against trend A that v9sg allows; v9sg blocks an *add* on an NQ 9EMA read that
v9ob's structural-plus-hourly trend does not see; with the 15m up and the last hourly red, A is neutral and
v9ob blocks nothing.

## Distinguishing config

| Flag | v9ob | v9 |
|---|---|---|
| `openTrendBlock` | **`'A'`** | unset |
| everything else | v9's, field for field (roster dump) | — |
| `simulateOnly` | **`true`** (since 2026-11-06; can never be armed or send an order) | unset |

## Baselines

From `server/src/candle-spread/backtest-baselines.csv` (rebuilt 2026-11-13, committed in `a16aa4f`, never-lower covers, live parity, 821 trading
days; reopen after cover modelled for v9 and v9ob). Parent rows for reference.

| variant | total $ | avg/day $ | worst day $ | win % | maxDD30 $ | ret/maxDD30 | avg end floor $ | locked-floor days % | opens/day |
|---|---|---|---|---|---|---|---|---|---|
| v9ob-10 | 430289 | 524 | -2070 | 56% | -11079 | 38.8 | -541 | 24.1 | 16.51 |
| v9ob-20 | 1008259 | 1228 | -4495 | 67% | -12885 | 78.3 | -598 | 40.2 | 18.54 |
| v9ob-40 | 1552599 | 1891 | -6605 | 61% | -24683 | 62.9 | -1251 | 34.1 | 25.95 |
| v9ob-10-unc | 504374 | 614 | -7645 | 56% | -24545 | 20.5 | -914 | 22.3 | 20.48 |
| v9ob-20-unc | 1068964 | 1302 | -12900 | 67% | -23250 | 46.0 | -875 | 40.4 | 20.64 |
| v9ob-40-unc | 1966883 | 2396 | -17380 | 63% | -45964 | 42.8 | -2181 | 31.8 | 28.52 |
| v9ob-20-cATM | 669941 | 816 | -6275 | 61% | -26919 | 24.9 | -1053 | 35 | 19.2 |
| v9ob-40-cATM | 924597 | 1126 | -8965 | 55% | -28127 | 32.9 | -1970 | 21.6 | 24 |
| *v9-10* | 638804 | 778 | -2335 | 58% | -8603 | 74.3 | -655 | 22.5 | 25.4 |
| *v9-20* | 1497136 | 1824 | -4735 | 69% | -20443 | 73.2 | -649 | 38.7 | 27.4 |
| *v9-40* | 2170115 | 2643 | -7460 | 63% | -23511 | 92.3 | -1939 | 25 | 39.59 |

## Open questions / suspected drift

1. **Contradicts the attribution study it came out of.** The 2026-10-07 attribution study (198k opens) found
   counter-trend overextension fades and be-wrong opens *profitable on average* and concluded "do NOT block
   opens; leash them" — the open block was kept as a control arm only. v9ob is that control, now live-simulated.
2. **The `FEATURE_FAMILIES` v9ob rationale (`index.js`) does not match current baselines.** It says "20/40W maxDD
   much better, 10W total -27%"; on the 2026-11-13 CSV v9ob-20's maxDD30 is better than v9-20's (-12885 vs -20443),
   v9ob-40's is slightly worse (-24683 vs -23511), and the 10W total is well below v9's (430289 vs 638804).
3. **Resolved 2026-11-06: "never armed" was a convention, not a guard** — same as v9sg. `buildFeatureFamilies`
   now sets `simulateOnly: true`, so `armableReason` refuses it.
