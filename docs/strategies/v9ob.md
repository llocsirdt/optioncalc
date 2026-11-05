# v9ob — "v9 + open block against trend A"

`{ parent: 'v9', tag: 'ob', label: '+ open block against trend A', flags: { openTrendBlock: 'A' } }`
— `server/src/candle-spread/index.js:1483` (`FEATURE_FAMILIES`, cloned by `buildFeatureFamilies`, `index.js:1485`)

Shared machinery: [README.md](README.md#shared-machinery-read-this-before-any-family-file). Every open / cover
trigger and the strategy × signal matrix: [signals.md](signals.md).

**Feature-test family** (2026-10-19): a complete copy of [v9](v9.md) — all 8 shapes — built exactly as
[v9sg](v9sg.md) is, with `openTrendBlock: 'A'` as the one added flag.

## Intent

**Never open against the trend.** Any open — first open, add, be-wrong, overextension reversal — that points
against trend definition **A** is dropped. Until 2026-10-19 this was a backtest-only control arm of the
2026-10-07 "never fight the trend" work; the trend sweep found it the best fleet-wide *risk* arm at a large 10W
P&L cost (`index.js:1481-1482`).

## Open signal

**Identical to v9**, except the open is filtered **right after the signal is computed, before anything else
reads it** (`trader.js:2085-2092`, decision `open-skip-trend-block`; backtest `backtest-v6-5m.js:1855-1860`):

- **Trend A** (`trend-state.js` `DEFS.A`, `:27`): `t15` if `t15 ≠ 0` **and** `t15 === hc`, else 0, where
  - `t15` = 15m structural trend of the last completed /NQ 15m candle (`trendOf`, `:20`): +1 when close > BB mid
    and 9EMA ≥ BB mid; −1 when close < BB mid and 9EMA ≤ BB mid; else 0;
  - `hc` = colour of the last **completed** /NQ hourly candle (+1 green, −1 red).
- **Blocked** when `against(openSide, A)` (`:91`): a bull open with A = −1, or a bear open with A = +1.
  A = 0 (15m neutral, or 15m and hourly disagree) blocks nothing.
- Only the open is dropped; **the signal's cover side still acts** on that candle.

Live, the trend context is built every tick from the series (`index.js:2447-2448`, `contextFromSeries`);
the backtest follows it bar by bar (`TS.makeTracker`).

## Cover signal

**Identical to v9.** Cover-to-stack: `coverToStack: true` on the roster, but it fires only when `capState`
(`trader.js:447`) fails on `softCap` / `hardCap` / `riskCap`, all `null` on every variant — never fires live.

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
| `simulateOnly` | **unset** | unset |

## Baselines

From `server/src/candle-spread/backtest-baselines.csv` (894ce51, 2026-10-23, 821 trading days). Parent rows for
reference.

| variant | total $ | avg/day $ | worst day $ | win % | maxDD30 $ | ret/maxDD30 | avg end floor $ | locked-floor days % | opens/day |
|---|---|---|---|---|---|---|---|---|---|
| v9ob-10 | 416968 | 508 | -2000 | 57% | -10883 | 38.3 | -527 | 24.6 | 16.2 |
| v9ob-20 | 1043771 | 1271 | -4460 | 69% | -13650 | 76.5 | -435 | 44.9 | 17.75 |
| v9ob-40 | 1343083 | 1636 | -7024 | 66% | -18836 | 71.3 | -714 | 38.3 | 20.93 |
| v9ob-10-unc | 509579 | 621 | -7345 | 57% | -23824 | 21.4 | -900 | 23.2 | 20.35 |
| v9ob-20-unc | 1143797 | 1393 | -13020 | 71% | -25184 | 45.4 | -733 | 45.9 | 19.79 |
| v9ob-40-unc | 1621588 | 1975 | -16565 | 66% | -21091 | 76.9 | -1236 | 39.5 | 22.52 |
| v9ob-20-cATM | 739567 | 901 | -6270 | 62% | -24320 | 30.4 | -831 | 40.9 | 18.33 |
| v9ob-40-cATM | 627829 | 765 | -6494 | 57% | -26165 | 24.0 | -1237 | 27.6 | 17.54 |
| *v9-10* | 612197 | 746 | -2275 | 60% | -10624 | 57.6 | -608 | 26.2 | 25.08 |
| *v9-20* | 1576504 | 1920 | -4795 | 70% | -12609 | 125.0 | -407 | 42 | 26.47 |
| *v9-40* | 2073300 | 2525 | -7441 | 65% | -19720 | 105.1 | -1394 | 29.8 | 34.71 |

## Open questions / suspected drift

1. **Contradicts the attribution study it came out of.** The 2026-10-07 attribution study (198k opens) found
   counter-trend overextension fades and be-wrong opens *profitable on average* and concluded "do NOT block
   opens; leash them" — the open block was kept as a control arm only. v9ob is that control, now live-simulated.
2. **The `index.js:1481-1482` rationale is stale against current baselines.** It says "20/40W maxDD much
   better"; on the current CSV v9ob-20's maxDD30 is worse than v9-20's and v9ob-40's is only slightly better.
3. **"Never armed" is a convention, not a guard** — same as v9sg: no `simulateOnly`, and `armableReason`
   (`index.js:3696`) would accept the capped shapes.
