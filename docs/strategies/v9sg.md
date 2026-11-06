# v9sg — "v9 + stack gate (NQ not against)"

`{ parent: 'v9', tag: 'sg', label: '+ stack gate (NQ not against)', flags: { stackGate: 'nqNotAgainst' } }`
— `server/src/candle-spread/index.js` `FEATURE_FAMILIES`, cloned by `buildFeatureFamilies`

Shared machinery: [README.md](README.md#shared-machinery-read-this-before-any-family-file). Every open / cover
trigger and the strategy × signal matrix: [signals.md](signals.md).

**Feature-test family** (user convention 2026-10-19): a complete copy of [v9](v9.md) — all 8 shapes (10/20/40,
-unc 10/20/40, -cATM 20/40) — with exactly one flag added. `buildFeatureFamilies` clones the *finished* v9
variants (after every builder and `applyExperiments`), so caps, minLock, ladder, give-up, reopen and every
name-keyed override are v9's; it only renames, relabels, drops `dryRun`, sets `simulateOnly: true` (since 2026-11-06), and sets `stackGate`.

## Intent

Stop **stacking** into a side while the /NQ trend points against it. v9 freely adds same-side positions on
repeated signals; v9sg refuses the *add* (not the first open) when the NQ 15m or 60m 9EMA read is against
that side. Source: the stack-gate sweep 2026-10-17 (`data/sweeps/stack-gate-2026-10-17`), arm `nqNotAgainst`.

## Open signal

**Identical to v9** (`v7Signal`, `{ fiveMin: true, beWrong: true }`, `bidirectional: true`), except one blocker.

**The stack gate, exactly** (`trader.js` `processCandleClose`, the STACK GATE block, decision `open-skip-stack-gate`;
backtest `backtest-v6-5m.js` `runDay5m`, the STACK GATE block, reads taken in the `if (stackGate)` trend-read block):

1. **Only an ADD is judged.** An add = the open's side already holds a position that is not a hedge, not
   manual, and **not covered** (a still-working open counts). A first open on a side, and any opposite-side
   open (be-wrong, trend-flip), always passes. Scope is `'uncovered'` (the backtest default; `'any'` is
   backtest-only).
2. **The NQ read** (`trend-state.js` `emaRead`, `nqStackTrend`), per timeframe 15m and 60m:
   `a = sign(NQ 5m close − that TF's 9EMA)`, `b = sign(that TF's last completed candle close − its 9EMA)`;
   read = `a` if `a ≠ 0` and `a === b`, else 0. No slope term.
3. **Pass rule** (`trend-state.js` `stackGatePasses`): a bull add passes unless `t15 === −1` or `t60 === −1`; a bear add
   passes unless either is `+1`. A neutral (0) read never blocks.

Order in the live blocker chain: control no-open → (opens-only busy) → c2o wait (unset on v9) → **stack gate**
→ conflict guard → placement / governor / cap gates.

## Cover signal

**Identical to v9.** The gate refuses opens only; covers, give-up, ladder, floor raise and wings are untouched.
Cover-to-stack: `coverToStack: true` is on the roster, but live it only fires when `capState` fails, and
`capState` (`trader.js`) checks only `softCap` / `hardCap` / `riskCap` — `null` on every variant — so it
never fires live. The backtest's governor-block lock skips positions with a resting cover (all of them), so it does
nothing there either (journal 2026-11-06).

## Where v9sg and v9ob differ (worked examples, verified against `trend-state.js`)

| # | Situation | v9sg | [v9ob](v9ob.md) |
|---|---|---|---|
| 1 | No bull held; a bull open (e.g. overextension-bottom) fires while the 15m structural trend is **down** and the last completed hourly is **red** | **allowed**: it is a first open, not an add | **dropped**: trend A = −1, bull is against it |
| 2 | Holding an uncovered bull; a bull add fires. NQ 5m close is below the 15m 9EMA, and the 15m candle's own close is below its EMA too (read −1). The 15m structural trend is still up (close and EMA above the BB mid) and the last hourly is green | **blocked** (`t15 = −1`) | **allowed**: trend A = +1 |
| 3 | 15m structural trend up, last hourly red | (depends only on the NQ EMA reads) | trend A = 0 (neutral): blocks nothing |

## Distinguishing config

| Flag | v9sg | v9 |
|---|---|---|
| `stackGate` | **`'nqNotAgainst'`** | unset |
| everything else | v9's, field for field (roster dump) | — |
| `simulateOnly` | **`true`** (since 2026-11-06; can never be armed or send an order) | unset |

## Baselines

From `server/src/candle-spread/backtest-baselines.csv` (rebuilt 2026-11-06, committed in `a635d39`, 821 trading
days; reopen after cover modelled for v9 and v9sg).
Parent rows for reference.

| variant | total $ | avg/day $ | worst day $ | win % | maxDD30 $ | ret/maxDD30 | avg end floor $ | locked-floor days % | opens/day |
|---|---|---|---|---|---|---|---|---|---|
| v9sg-10 | 675910 | 823 | -2460 | 61% | -6883 | 98.2 | -605 | 24.2 | 23.67 |
| v9sg-20 | 1563510 | 1904 | -4500 | 69% | -18679 | 83.7 | -344 | 43 | 25.13 |
| v9sg-40 | 2168332 | 2641 | -7495 | 64% | -24979 | 86.8 | -1706 | 25.7 | 37.92 |
| v9sg-10-unc | 840958 | 1024 | -6198 | 60% | -12831 | 65.5 | -1161 | 23.6 | 29.4 |
| v9sg-20-unc | 1784726 | 2174 | -11155 | 71% | -23962 | 74.5 | -741 | 41.7 | 27.84 |
| v9sg-40-unc | 2913821 | 3549 | -22154 | 65% | -32072 | 90.9 | -3232 | 24.2 | 42.26 |
| v9sg-20-cATM | 1027334 | 1251 | -6490 | 60% | -21083 | 48.7 | -1197 | 33.3 | 28.35 |
| v9sg-40-cATM | 932263 | 1136 | -9107 | 50% | -46239 | 20.2 | -3163 | 11.8 | 37.39 |
| *v9-10* | 660067 | 804 | -2275 | 60% | -9506 | 69.4 | -587 | 24.7 | 25.4 |
| *v9-20* | 1608574 | 1959 | -4650 | 71% | -15445 | 104.1 | -453 | 42 | 27.3 |
| *v9-40* | 2513142 | 3061 | -7179 | 65% | -20705 | 121.4 | -1638 | 26.6 | 39.96 |

The experiments log records that the 2026-10-23 baselines reproduced the stack-gate sweep exactly (669,900 /
1,507,682 / 1,939,505). The current rows include reopen after cover and no longer match it.

## Open questions / suspected drift

1. **Resolved 2026-11-06: "never armed" was a convention, not a guard.** Until then v9sg carried no
   `simulateOnly` and `armableReason` would have accepted the capped shapes. `buildFeatureFamilies` now sets
   `simulateOnly: true` on every copy, so `armableReason` refuses it as simulate-only.
2. **The `FEATURE_FAMILIES` v9sg rationale (`index.js`) is from the 10/17 sweep** ("better maxDD30 at 10/40W and end
   floor at all three widths, total -1..+9%"). On the current baselines (2026-11-06) only 10W has a better maxDD30
   than v9 (-6883 vs -9506; 20W -18679 vs -15445, 40W -24979 vs -20705), only 20W has a better avg end floor (-344
   vs -453), and the 40W total is 13.7% below v9's (2168332 vs 2513142). The comment predates the rebuilt baselines.
3. The STACK GATE NQ READ comment in `trend-state.js` (above `emaRead`) describes the NQ read as "+1 above **and
   rising**"; the code has no slope term. The slope is only in the backtest-only NDX-RTH reads (`backtest-v6-5m.js`
   `runDay5m`, `sgRt15` / `sgRt60`).
4. NDX-RTH gate forms (`notAgainst` / `oneWith` / `rth15` / `rth60`, scope `'any'`) remain backtest-only (backlog:
   NQ + NDX agreement).
