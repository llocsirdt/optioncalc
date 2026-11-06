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

From `server/src/candle-spread/backtest-baselines.csv` (rebuilt 2026-11-06, committed in `a635d39`, 821 trading
days; reopen after cover modelled for v9 and v9ob). Parent rows for reference.

| variant | total $ | avg/day $ | worst day $ | win % | maxDD30 $ | ret/maxDD30 | avg end floor $ | locked-floor days % | opens/day |
|---|---|---|---|---|---|---|---|---|---|
| v9ob-10 | 441019 | 537 | -2000 | 57% | -10278 | 42.9 | -533 | 24.6 | 16.5 |
| v9ob-20 | 1150225 | 1401 | -4460 | 70% | -13650 | 84.3 | -455 | 44.6 | 18.49 |
| v9ob-40 | 1721681 | 2097 | -7187 | 63% | -20983 | 82.1 | -1137 | 34.1 | 26.28 |
| v9ob-10-unc | 520262 | 634 | -7510 | 57% | -23884 | 21.8 | -908 | 23.2 | 20.74 |
| v9ob-20-unc | 1237685 | 1508 | -14095 | 73% | -25184 | 49.1 | -725 | 46 | 20.68 |
| v9ob-40-unc | 2096072 | 2553 | -18240 | 65% | -42442 | 49.4 | -2064 | 33.9 | 28.67 |
| v9ob-20-cATM | 818735 | 997 | -6270 | 63% | -30920 | 26.5 | -867 | 39.1 | 19.25 |
| v9ob-40-cATM | 946348 | 1153 | -8965 | 54% | -24435 | 38.7 | -1921 | 22.4 | 24.02 |
| *v9-10* | 660067 | 804 | -2275 | 60% | -9506 | 69.4 | -587 | 24.7 | 25.4 |
| *v9-20* | 1608574 | 1959 | -4650 | 71% | -15445 | 104.1 | -453 | 42 | 27.3 |
| *v9-40* | 2513142 | 3061 | -7179 | 65% | -20705 | 121.4 | -1638 | 26.6 | 39.96 |

## Open questions / suspected drift

1. **Contradicts the attribution study it came out of.** The 2026-10-07 attribution study (198k opens) found
   counter-trend overextension fades and be-wrong opens *profitable on average* and concluded "do NOT block
   opens; leash them" — the open block was kept as a control arm only. v9ob is that control, now live-simulated.
2. **The `FEATURE_FAMILIES` v9ob rationale (`index.js`) does not match current baselines.** It says "20/40W maxDD
   much better, 10W total -27%"; on the 2026-11-06 CSV v9ob-20's maxDD30 is better than v9-20's (-13650 vs -15445),
   v9ob-40's is slightly worse (-20983 vs -20705), and the 10W total is 33% below v9's (441019 vs 660067).
3. **Resolved 2026-11-06: "never armed" was a convention, not a guard** — same as v9sg. `buildFeatureFamilies`
   now sets `simulateOnly: true`, so `armableReason` refuses it.
