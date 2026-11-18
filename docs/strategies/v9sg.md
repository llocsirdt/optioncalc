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

From `server/src/candle-spread/backtest-baselines.csv` (rebuilt 2026-11-13, committed in `a16aa4f`, never-lower covers, live parity, 821 trading
days; reopen after cover modelled for v9 and v9sg).
Parent rows for reference.

| variant | total $ | avg/day $ | worst day $ | win % | maxDD30 $ | ret/maxDD30 | avg end floor $ | locked-floor days % | opens/day |
|---|---|---|---|---|---|---|---|---|---|
| v9sg-10 | 688543 | 839 | -2070 | 61% | -8546 | 80.6 | -651 | 22.8 | 23.84 |
| v9sg-20 | 1418807 | 1728 | -4715 | 68% | -15379 | 92.3 | -535 | 38.6 | 25.38 |
| v9sg-40 | 1976946 | 2408 | -8302 | 62% | -28318 | 69.8 | -1924 | 24.1 | 37.73 |
| v9sg-10-unc | 855714 | 1042 | -6198 | 59% | -14176 | 60.4 | -1157 | 22.4 | 29.4 |
| v9sg-20-unc | 1606450 | 1957 | -11155 | 68% | -25467 | 63.1 | -957 | 36.8 | 28.08 |
| v9sg-40-unc | 2790132 | 3398 | -21140 | 65% | -33757 | 82.7 | -3415 | 23 | 42.22 |
| v9sg-20-cATM | 945130 | 1151 | -6865 | 57% | -22985 | 41.1 | -1356 | 28.1 | 28.61 |
| v9sg-40-cATM | 794326 | 968 | -9531 | 49% | -37086 | 21.4 | -3260 | 11.1 | 37.22 |
| *v9-10* | 638804 | 778 | -2335 | 58% | -8603 | 74.3 | -655 | 22.5 | 25.4 |
| *v9-20* | 1497136 | 1824 | -4735 | 69% | -20443 | 73.2 | -649 | 38.7 | 27.4 |
| *v9-40* | 2170115 | 2643 | -7460 | 63% | -23511 | 92.3 | -1939 | 25 | 39.59 |

The experiments log records that the 2026-10-23 baselines reproduced the stack-gate sweep exactly (669,900 /
1,507,682 / 1,939,505). The current rows include reopen after cover and no longer match it.

## Open questions / suspected drift

1. **Resolved 2026-11-06: "never armed" was a convention, not a guard.** Until then v9sg carried no
   `simulateOnly` and `armableReason` would have accepted the capped shapes. `buildFeatureFamilies` now sets
   `simulateOnly: true` on every copy, so `armableReason` refuses it as simulate-only.
2. **The `FEATURE_FAMILIES` v9sg rationale (`index.js`) is from the 10/17 sweep** ("better maxDD30 at 10/40W and end
   floor at all three widths, total -1..+9%"). On the current baselines (2026-11-13) 10W and 20W have a better maxDD30
   than v9 (-8546 vs -8603; 20W -15379 vs -20443) and 40W a worse one (-28318 vs -23511), the avg end floor is better
   at all three widths (-651 vs -655, -535 vs -649, -1924 vs -1939), and the 40W total is below v9's (1976946 vs
   2170115). The comment predates the rebuilt baselines.
3. The STACK GATE NQ READ comment in `trend-state.js` (above `emaRead`) describes the NQ read as "+1 above **and
   rising**"; the code has no slope term. The slope is only in the backtest-only NDX-RTH reads (`backtest-v6-5m.js`
   `runDay5m`, `sgRt15` / `sgRt60`).
4. NDX-RTH gate forms (`notAgainst` / `oneWith` / `rth15` / `rth60`, scope `'any'`) remain backtest-only (backlog:
   NQ + NDX agreement).
