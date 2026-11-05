# v9sg — "v9 + stack gate (NQ not against)"

`{ parent: 'v9', tag: 'sg', label: '+ stack gate (NQ not against)', flags: { stackGate: 'nqNotAgainst' } }`
— `server/src/candle-spread/index.js:1480` (`FEATURE_FAMILIES`, cloned by `buildFeatureFamilies`, `index.js:1485`)

Shared machinery: [README.md](README.md#shared-machinery-read-this-before-any-family-file). Every open / cover
trigger and the strategy × signal matrix: [signals.md](signals.md).

**Feature-test family** (user convention 2026-10-19): a complete copy of [v9](v9.md) — all 8 shapes (10/20/40,
-unc 10/20/40, -cATM 20/40) — with exactly one flag added. `buildFeatureFamilies` clones the *finished* v9
variants (after every builder and `applyExperiments`), so caps, minLock, ladder, give-up, reopen and every
name-keyed override are v9's; it only renames, relabels, drops `dryRun`, and sets `stackGate`.

## Intent

Stop **stacking** into a side while the /NQ trend points against it. v9 freely adds same-side positions on
repeated signals; v9sg refuses the *add* (not the first open) when the NQ 15m or 60m 9EMA read is against
that side. Source: the stack-gate sweep 2026-10-17 (`data/sweeps/stack-gate-2026-10-17`), arm `nqNotAgainst`.

## Open signal

**Identical to v9** (`v7Signal`, `{ fiveMin: true, beWrong: true }`, `bidirectional: true`), except one blocker.

**The stack gate, exactly** (`trader.js:2350-2358`, decision `open-skip-stack-gate` at `:2381`; backtest
`backtest-v6-5m.js:1984-1999`, read at `:940-944`):

1. **Only an ADD is judged.** An add = the open's side already holds a position that is not a hedge, not
   manual, and **not covered** (a still-working open counts). A first open on a side, and any opposite-side
   open (be-wrong, trend-flip), always passes. Scope is `'uncovered'` (the backtest default; `'any'` is
   backtest-only).
2. **The NQ read** (`trend-state.js` `emaRead` `:96`, `nqStackTrend` `:101`), per timeframe 15m and 60m:
   `a = sign(NQ 5m close − that TF's 9EMA)`, `b = sign(that TF's last completed candle close − its 9EMA)`;
   read = `a` if `a ≠ 0` and `a === b`, else 0. No slope term.
3. **Pass rule** (`stackGatePasses`, `:106`): a bull add passes unless `t15 === −1` or `t60 === −1`; a bear add
   passes unless either is `+1`. A neutral (0) read never blocks.

Order in the live blocker chain: control no-open → (opens-only busy) → c2o wait (unset on v9) → **stack gate**
→ conflict guard → placement / governor / cap gates.

## Cover signal

**Identical to v9.** The gate refuses opens only; covers, give-up, ladder, floor raise and wings are untouched.
Cover-to-stack: `coverToStack: true` is on the roster, but live it only fires when `capState` fails, and
`capState` (`trader.js:447`) checks only `softCap` / `hardCap` / `riskCap` — `null` on every variant — so it
never fires live.

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
| `simulateOnly` | **unset** (not simulate-only) | unset |

## Baselines

From `server/src/candle-spread/backtest-baselines.csv` (rebuilt on 894ce51, 2026-10-23, 821 trading days).
Parent rows for reference.

| variant | total $ | avg/day $ | worst day $ | win % | maxDD30 $ | ret/maxDD30 | avg end floor $ | locked-floor days % | opens/day |
|---|---|---|---|---|---|---|---|---|---|
| v9sg-10 | 669900 | 816 | -2460 | 60% | -8701 | 77.0 | -592 | 24.6 | 23.36 |
| v9sg-20 | 1507682 | 1836 | -4500 | 70% | -11225 | 134.3 | -364 | 43.7 | 24.37 |
| v9sg-40 | 1939505 | 2362 | -7205 | 65% | -16252 | 119.3 | -1307 | 30 | 32.9 |
| v9sg-10-unc | 820765 | 1000 | -6213 | 61% | -12831 | 64.0 | -1151 | 23 | 28.94 |
| v9sg-20-unc | 1659139 | 2021 | -11580 | 71% | -22610 | 73.4 | -703 | 43.7 | 26.89 |
| v9sg-40-unc | 2454684 | 2990 | -21140 | 66% | -28625 | 85.8 | -2618 | 27.5 | 36.17 |
| v9sg-20-cATM | 878804 | 1070 | -6485 | 59% | -24457 | 35.9 | -1126 | 32.6 | 27.15 |
| v9sg-40-cATM | 723021 | 881 | -7475 | 53% | -33829 | 21.4 | -2283 | 16.7 | 30.28 |
| *v9-10* | 612197 | 746 | -2275 | 60% | -10624 | 57.6 | -608 | 26.2 | 25.08 |
| *v9-20* | 1576504 | 1920 | -4795 | 70% | -12609 | 125.0 | -407 | 42 | 26.47 |
| *v9-40* | 2073300 | 2525 | -7441 | 65% | -19720 | 105.1 | -1394 | 29.8 | 34.71 |

The experiments log records that these baselines reproduce the stack-gate sweep exactly (669,900 / 1,507,682 /
1,939,505).

## Open questions / suspected drift

1. **"Never armed" is a convention, not a guard.** The `FEATURE_FAMILIES` comment (`index.js:1476`) and the
   experiments log say never armed, but v9sg carries no `simulateOnly`; `armableReason` (`index.js:3696`) would
   accept the capped shapes (finite `lossMax`, NDX).
2. **The `index.js:1478-1479` rationale is from the 10/17 sweep** ("better maxDD30 at 10/40W ... total
   -1..+9%"). On the current baselines all three capped widths have a better maxDD30 than v9, and the 20W and 40W
   totals are below v9's by more than the quoted range. The comment predates the rebuilt baselines.
3. `trend-state.js:93-95` describes the NQ read as "+1 above **and rising**"; the code has no slope term. The
   slope is only in the backtest-only NDX-RTH reads (`backtest-v6-5m.js:941-942`).
4. NDX-RTH gate forms (`notAgainst` / `oneWith` / `rth15` / `rth60`, scope `'any'`) remain backtest-only (backlog:
   NQ + NDX agreement).
