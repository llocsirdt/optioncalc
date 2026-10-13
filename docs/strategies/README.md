> Operator settings (env vars, remote control, kill switches): [../SETTINGS.md](../SETTINGS.md)

# Candle-spread strategy families — specification index

**What this is.** One page per strategy FAMILY (v0-v9) describing how it is *meant* to operate, what the
code *actually* does, and where the two still differ. **Rewritten 2026-10-06 against `main` at `0c24886`**
(the 2026-09-09 edition described an engine that no longer exists: instant opens, per-family minLock,
$5k/$7k/$9k caps, covers that could never move or close at a loss).

**Ground truth is the code** — `server/src/candle-spread/index.js` (roster), `trader.js` (live engine),
`backtest/backtest-v6-5m.js` + `backtest/opts-for.js` (backtest), `floor-raise.js`, `cover-ladder.js`,
`signals/*.js`. Line citations are to that commit. Where a code comment, a memory note and the code
disagree, the code is what is described here and the disagreement is listed under *Open questions*.

**Rules used writing these.** No number in these files is derived. Per-variant backtest results are copied
verbatim from `server/src/candle-spread/backtest-baselines.csv` as rebuilt 2026-10-07 on commit `43c7678`
(G placement, ladder opens, 1-tick-through covers booked AT their limit, resting floor raises, governed
open walks, 10-min re-strike, give-up by width, floor raise spreads-first 3:1, v7-10 cap $1,750).
Remaining known model limits: option prices are Black-Scholes with bucketed skew, not real quotes, and fills
are judged on 5-minute bars. Historical measurements are kept only
where they explain a current design choice, and are dated.

---

## Comparison table

| Family | What it is (one line) | Open signal | Cover signal (signal part) | Δ vs predecessor | Status |
|---|---|---|---|---|---|
| **v0** | Classic 15m price-action breakout; cover = tent (shares the short strike) | 15m green + new high → bull; red + new low → bear | Opposite-colour 15m candle that FAILED to extend the prior extreme | Control / root | Active. v0 cells carry flies |
| **v1** | v0 with the cover short walked HALFWAY to the underlying (condor) | as v0 | as v0 | `coverGeometry:'halfway'` | Active. **v1-10 is a ladder control cell + watchlist** |
| **v2** | v0 with the cover short AT the underlying (widest; can give up the guaranteed floor) | as v0 | as v0 | `coverGeometry:'underlying'` | Active. **v2-10 is a ladder control cell + watchlist**; v2 cells carry flies |
| **v3** | v0 geometry, but continuous covering is RISK-ARMED instead of placed at birth | as v0 | as v0 | `continuousCoverArmFrac 0.20`, `continuousCoverOppRatio 1.0` | Active. The only family where continuous covers do not go on at birth |
| **v4** | Multi-timeframe precision layer (user's discretionary read encoded) | 15m closes: overextension reversal, grind top/bottom, gated trend continuation | Overext/grind flip + active-cover into an opposing ≥3-TF cluster | New signal (replaces classic) | Active, frozen lineage baseline; v4 cells carry flies |
| **v5** | v4 + trend-flip (cover whole book and take the new side on a structural 15m cross) | v4's | v4's + trend-flip | `trendFlip` (default on) | Active |
| **v6** | v5 acting every 5 minutes | v5's at 15m closes; intra-15m flip on a 2-bar-confirmed 5m reversal | v5's + intra-5m early cover | `signalCfg.fiveMin: true` | Active. **v6-10 is a ladder control cell + watchlist**; v6 cells carry flies |
| **v7** | v6 + "be wrong": open the opposite side while holding, without covering the loser | v6's + be-wrong opposite open | v6's, **per side** (`coverSide`) | `beWrong`, `bidirectional` | Active. **v7-10 is the ARMED real-money variant** |
| **v8** | v6 signal + fixed $3,000 "churn" soft cap (trend-stack exempt) + proactive cover at 0.70×W | v6's | v6's + proactive | `softCap 3000`, `exemptTrendStack`, `proactiveCoverFrac 0.70` | Experiment slot (measured-losing mutation, kept deliberately); v8 cells carry flies |
| **v9** | v7 signal + proactive cover at 0.80×W | v7's | v7's + proactive | `proactiveCoverFrac 0.80` | Experiment slot |

Source: the `FAMILIES` array, `index.js:176-217` (entries at `:199-216`).

### Baselines

Headline per governed variant (`AVG terminal/day $` from `backtest-baselines.csv`):

| | 10W | 20W | 40W |
|---|---|---|---|
| v0 | 1073 | 1725 | 1729 |
| v1 | 873 | 1824 | 1811 |
| v2 | 896 | 1746 | 1635 |
| v3 | 1037 | 1630 | 1727 |
| v4 | 1195 | 1641 | 1659 |
| v5 | 1339 | 2060 | 2232 |
| v6 | 1239 | 2347 | 2713 |
| v7 | 1712 | 2682 | 2195 |
| v8 | 1431 | 1156 | 554 |
| v9 | 1805 | 2336 | 2335 |

Each family file carries the fuller per-variant block (total, avg/day, worst day, win %, maxDD30, ret/maxDD30).

**Source.** Rebuilt 2026-10-07 on `43c7678`, the config the server will trade. Honest-fill fixes of
2026-10-06 (`8f10006`): a simulated order books AT its limit, never better (live vs simulated v7-10 on the
same 8 positions had been +$7 vs +$765); backtest floor raises rest as limit orders (~70% fill) instead of
filling on the bar they are planned; open-ladder steps are governor-checked. **The fill model matters more than any of those:** baselines now use **ladder
opens + 1-tick-through covers** (`build-backtest-baselines.js:28-35`; `--openFillModel immediate`
reproduces the old model). The old instant-open baselines overstated the fleet roughly 2× (fleet
231,417 → 108,090 $/day on the 2026-10-05 rebuild, experiments log). Never compare a new number to a
pre-2026-10-05 one.

---

## Trigger catalog — every rule that can put an ORDER on the live engine

**Read from the code at `7629c4e` (2026-10-12), not from comments or memory.** Where a comment, this README or a
memory note disagrees, the code is described and the disagreement is under *Discrepancies found* at the end.

**v7-10 (the armed real-money variant) — what can open a position.** Signal = `v7Signal` with
`signalCfg { fiveMin: true, beWrong: true }` and nothing else (`index.js:212`). At each 15m close, in this order:
**trend-flip** (O7), **be-wrong** (O9), **overextension reversal** (O2), **grind reversal** (O3), **trend
continuation** (O5). Between 15m closes: the **5m+15m flip** (O8), only while a side is held. **OFF on v7-10 (and on
every variant):** green-breaks-high `breakOpen`, the hourly band gate `htfGate`, `beWrongCover`, `centerlineCross`,
`openGate5m`, candle-at-confluence, `fastCover5m`, `revTrendGate`, trend-floor opens, over-cap rest
(`openOverCapBelow`) — none is set by the roster and none has an env switch.

**Can "a green 15m candle that breaks the prior candle's high" open v7-10 on its own? No.** Rule O11
(`breakOpen`) is the only rule that would, and it is off. The same candle opens a bull on v7-10 only when one
of these also holds: **(a)** the 15m close is ABOVE the 15m Bollinger midline (20-SMA) AND the 15m 9EMA is at or
above the midline, no uncovered bear is held, and no ≥3-timeframe line cluster sits within 8 pts above the close
(O5 trend-cont, with its pause); or **(b)** an uncovered bear is held AND the candle is also a bullish reversal
formation (hammer / bullish engulfing / green doji) (O9 be-wrong — any band position); or **(c)** independent of
the break, its low reached the 5m lower band (O2) or the grind-bottom rule fires (O3, needs close BELOW the 15m
midline); or **(d)** an uncovered bear is held and the 15m trend is up (O7). Below the 15m midline with no bear
held, the break alone never opens. (Note the code tests the candle's HIGH breaking the prior high, not its
CLOSE — `candle-patterns.js:66`, `classic-signal.js:20`.)

**Conventions used below.** *15m trend up* = 15m close > 15m BB midline AND 15m 9EMA ≥ midline (`trendTf`
default `'15m'`, `v7-signals.js:74-79`; `v5-signals.js:49-50`). All candles are COMPLETED /NQ 24h candles
(`analysis-builder.js:56-59`); *prior 15m* = the previous completed 15m candle. *Held*: v0-v6 and v8 pass
`heldDir = st.direction`, a STANCE set by every open (`trader.js:753`) and cleared only by a signal cover
(`trader.js:1834`); v7/v9 pass per-side `heldBull/heldBear` = a filled position of that side whose cover has not
FILLED (a resting cover still counts as held) (`trader.js:1666-1667`). *Bullish reversal candle* = lower wick ≥50%
of range with body ≤40% and close in the upper half, OR bullish engulfing, OR a green doji (body <25% of range)
(`candle-patterns.js:31-54`). *Cluster* = `confluence.strongestClusterNear(..., minTf: 3)`. Signals run at every
5m mark 09:35-15:55 ET (`index.js:1392-1393`); a mark is a 15m close when minute % 15 = 0 (`index.js:1425`);
v0-v5 are wrapped in `at15`, so between 15m closes their signal is empty (`index.js:95`, `:201-206`). The 30 s
sub-bar worker reads no signal (`index.js:2306-2372`).

### 1. OPEN triggers

| # | Trigger (decision `reason`) | Exact condition | Flag · default | ON in the live roster | Where |
|---|---|---|---|---|---|
| O1 | Classic breakout (`classicSignal`) | 15m close: green (close ≥ open) AND 15m high > prior 15m high → bull; red AND low < prior low → bear. No band or midline condition. | family signal | v0 v1 v2 v3 | `classic-signal.js:17-22`; `index.js:201-204` |
| O2 | `overext-bottom` / `overext-top` | (5m BB lower − 15m low) / 5m band width ≥ `reversalFrac` AND 15m close > 5m BB lower → bull (mirror → bear). With −0.15 the low only has to come within 0.15 band-widths of the band. Also covers the held opposite side. | `reversalFrac` −0.15; `revTrendGate` off | v4-v9 | `v4-signals.js:48-57`; `v5:79-90`; `v6:129-140`; `v7:162-171` |
| O3 | `grind-bottom` / `grind-top` | max(1m band beyond the 5m band, beyond the 15m band, as a fraction of its own width) ≥ `widenFrac` AND 15m close < 15m midline AND bullish reversal candle → bull (mirror). | `widenFrac` 0.10 (see D1) | v4-v9 | `v4:63-76`; `v5:96-109`; `v6:146-159`; `v7:174-187` |
| O4 | `candle-top/bottom @cluster` | reversal candle + ≥3-TF cluster within radius | `candleConfluenceRadius` null = OFF | none | `v4:79-89`; `v7:190-200` |
| O5 | `trend-cont-bull` / `-bear` | 15m trend up AND 15m green AND (v4-v6/v8: stance bull or none · v7/v9: no uncovered bear) → bull. Returns NO open instead when: `htfGate` fires (off); `openGate5m` and 5m trend down (off; v6/v7 only); **pause** = a ≥3-TF cluster (searched within 25 pts) above the close by ≤ `pausePts`. Mirror for bear. | `pausePts` 8 | v4-v9 | `v4:107-121`; `v5:141-152`; `v6:195-208`; `v7:217-231` |
| O6 | `htf-gate` (blocks O5 only) | last completed 60m candle: close (`'close'`) or high/low (`'touch'`) beyond its upper/lower band → no trend-cont that way | `htfGate` null = OFF, no env | none | `candle-patterns.js:76-81`; `v7:219,226` |
| O7 | `trend-flip→bull/bear` | holding bull (stance on v5/v6/v8; uncovered on v7/v9) AND 15m trend down → open bear + cover bull (mirror). First rule evaluated at a 15m close. | `trendFlip` on unless `false`; `flipMomentum` off | v5-v9 (not in v4) | `v5:63-67`; `v6:113-117`; `v7:107-111` |
| O8 | `5m+15m flip→bull/bear` (intra-15m) | at a NON-15m mark, holding X: 5m trend against X on this AND the prior 5m bar (5m close + 5m 9EMA vs 5m midline) AND 15m trend against X → open the other side + cover X. 15m not agreeing → cover only (`5m early-cover`). Never opens from flat. | `fiveMin` true; `fiveMinFlip` on unless `false` | v6-v9 | `v6:80-88`; `v7:85-93`; `index.js:211-218` |
| O9 | `be-wrong→bull/bear` | holding an uncovered bear AND 15m high > prior 15m high AND bullish reversal candle → open bull, bear NOT covered (mirror). Evaluated after O7, before O2. | `beWrong` true; `beWrongStrong` off; `beWrongDirMin` null | v7, v9 | `v7:145-147`; `index.js:212,218` |
| O10 | `be-wrong (centerline cross)` | close crosses the 5m/15m midline vs the prior bar against the held side | `centerlineCross` null = OFF | none | `v7:148-156` |
| O11 | `green-breaks-high` / `red-breaks-low` | 15m green AND high > prior high → bull (`'flat'`: not while a bear is held; `'any'`: always, never covers). Reached only if NO earlier rule returned — a pause, htf-gate, 5m veto or active cover blocks it. | `breakOpen` null = OFF, no env | none (code in v4-v7 signal fns, so v8/v9 would inherit it) | `candle-patterns.js:63-69`; `v4:124-125`; `v5:155-156`; `v6:211-212`; `v7:235-236` |
| O12 | `trend-floor-open` | trend-side floor biased → with-trend open, only when the signal has no open | `deps.trendFloor` null = OFF | none | `trader.js:1610-1682`; `index.js:1970` |

**Open-trigger matrix (live roster; ✓ on, · absent from that family's signal, ✗ coded but off everywhere).**
Shapes (`-W`, `-W-unc`, `-W-cATM`) share their family's signal (`index.js:1163,1214,1260`).

| Trigger | v0 | v1 | v2 | v3 | v4 | v5 | v6 | v7 | v8 | v9 |
|---|---|---|---|---|---|---|---|---|---|---|
| O1 classic breakout | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | · |
| O2 overextension | · | · | · | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| O3 grind | · | · | · | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| O5 trend-cont (held = stance / per-side) | · | · | · | · | ✓ s | ✓ s | ✓ s | ✓ p | ✓ s | ✓ p |
| O7 trend-flip | · | · | · | · | · | ✓ | ✓ | ✓ | ✓ | ✓ |
| O8 5m+15m flip | · | · | · | · | · | · | ✓ | ✓ | ✓ | ✓ |
| O9 be-wrong | · | · | · | · | · | · | · | ✓ | · | ✓ |
| O4, O6, O10, O11, O12 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

### 2. COVER triggers

| # | Trigger (decision `action`) | Exact condition / price | Flag · default | ON in the live roster | Where |
|---|---|---|---|---|---|
| C1 | `continuous` at the candle | every 5m bar, each filled position with no cover covered or working: rest at `W − openCost − minLock×W` (minLock 0.10 at 10W, 0.20 at 20/40W). Skipped if that is ≤ 0. Geometry: tent, v1 halfway, v2 at the underlying. **v3:** only once book floor ≤ −0.20×lossTarget, or when the cover locks ≥ 1.0× its own cost (v3-unc: the latter only — no lossTarget). | `continuousCover` true (BASE_RUNS) | all 80 | `trader.js:1499-1556`, `:1777`; `index.js:136,176,660,944` |
| C2 | cover on fill (30 s worker) | same function, every 30 s, as soon as a fill is booked | — | all 80 | `index.js:2359-2362` |
| C3 | signal / reversal cover | the signal's `cover`/`coverSide`: O1-classic (held bull + red 15m + high NOT above prior high; mirror), O2/O3 against the held side, **active-cover** (held bull + close > 15m midline + ≥3-TF cluster above within `activeCoverRadius` 8 pts; mirror) v4-v9, O7 v5-v9, O8 v6-v9. Places a break-even cover ONLY on filled positions with NO cover working (`trader.js:1791`) — so after C1/C2 it places nothing except on v3's unarmed positions or where C1 failed (`cover-skip-leg`, `cover-not-sent`, broker `cover-defer-governor`). Always: cancels a working open of that side (`:1707`) and clears the stance (`:1834`). | `activeCoverRadius` 8; `beWrongCover`, `fastCover5m` OFF | all (orders mostly v3) | `trader.js:1788-1836`; `classic-signal.js:12-16`; `v7:203-213` |
| C4 | `proactive-deep-itm` | candle close only: position marks ≥ frac×W and has no cover working → rest at break-even | `proactiveCoverFrac` | v8 0.70, v9 0.80 (all shapes) | `trader.js:1842-1852`; `index.js:215,218` |
| C5 | `cover-to-stack` | only when `softCap` blocks an open (v8: uncovered at-risk debit + new debit > $3,000, unless every uncovered position is on the open's side): lock positions marking ≥ 0.65×W with no cover working, deepest first | `coverToStack` true; needs softCap | v8, v8-cATM (v8-unc has no softCap) | `trader.js:1948-1975`, `:373-438`; `index.js:132,215` |
| C6 | combo lock+open | 4-leg atomic order on a cap block | `comboOrders` unset = OFF (refused under the broker) | none | `trader.js:1956`, `:443-460` |
| C7 | `cover-reprice` (ladder) | every candle and every 30 s: limit = lock target + earned × $0.05; a step per 120 s OR per 10 NDX pts moved (either direction) since placement; capped at break-even (`ladderLossCapFrac` 0) and at the mark; never moves down | `coverLadder` on every cell (control set now empty) | all 80 | `trader.js:3545-3566`; `cover-ladder.js:84-117`; `index.js:648-650,681-692,945` |
| C8 | `cover-giveup` (points) | NDX ≥ 20 pts back through the position's own short strike → price min(mark + 1 tick, W − openCost + allowance×W), allowance 10W 5% · 20W 7.5% · 40W 10%; never lowered; supersedes ladder and stall | `CANDLE_SPREAD_GIVEUP` default `all` | all 80 | `trader.js:3497-3524`; `index.js:1005-1016` |
| C9 | give-up by candle / trend urgency / trend-floor cover | candle reversal kinds, trend-state against, trend-side floor | `giveUpCandle`, `giveUpTrend`, `trendFloor` null = OFF | none | `trader.js:1597-1609,1616-1680,3503-3506` |
| C10 | `cover-stall` | ≥ 15 min since the fill AND NDX (last bar) on the losing side of the NDX at fill (`fav < stallCoverPts` = 0) → price min(break-even, mark + 1 tick), only if above the working price | `CANDLE_SPREAD_STALL_COVER` default on, 15 | all 80 | `trader.js:3531-3544`; `index.js:921-922` |
| C11 | governor deferral (BLOCKER) | a cover whose fill lowers the floor through −lossMax: mark path declined at fill; broker: not placed, pulled every pass, pulled before an open, a ladder/give-up raise not sent | `lossMax` set | governed shapes (not -unc) | `trader.js:3713-3722`, `:254`, `:3453-3465`, `:866-881`, `:3382-3396` |
| C12 | `cover-defer-late` (BLOCKER) | from 15:00 ET, if the governor floor at the first look ≥ 15:00 was ≥ 0: a cover fill that takes the floor below 0 is declined (mark) / pulled (broker) | `CANDLE_SPREAD_LATE_FLOOR` default on | governed shapes (the check sits inside `govOn`) | `trader.js:3723-3727`, `:833-836`, `:910-921` |
| C13 | `cover-style-flip` | broker rejected the last cover as "not an opening transaction" → resend in the other form (same strikes) | — | broker path only (v7-10 live) | `trader.js:195-207` |
| C14 | signal cover → give-up | a signal cover escalates resting covers to the give-up price | `signalCoverGiveUp` | **backtest only**, set by no variant | `backtest-v6-5m.js:1531-1540`; `opts-for.js:112` |
| C15 | `cover-restrike` (range) | 20W/40W: every 5 min a resting cover moves to the candidate strike (one inside the open's long leg … 2 beyond the tent) closest to filling at tent-equivalent price + k × 0.03 × W; broker: cancel first, re-place after Schwab confirms | `coverRangeInside/Beyond/Premium` (`applyCoverStrikeChoice`) | all 20W/40W | `trader.js` workRestingCovers / pickCoverK / restrikeCover |
| C16 | `cover-restrike` (give-up) | 20W/40W: when give-up fires, the cover first moves inside the open spread (cheapest legal cover), then takes the give-up price | `giveUpGeometry: 'inside'` | all 20W/40W | `trader.js` workRestingCovers |
| C17 | `cover-roll` | 10W: a covered position whose market is past the next strike rolls its cover a strike wider when that costs ≤ 0.03 × W (≤ 2 beyond the tent); floor drops by the cost. Simulated/paper only — broker runs log `cover-roll-not-sent` | `coverRollMaxDebit/MaxK` | all 10W (v7-10 live: not sent) | `trader.js` rollCovers |

### 3. HEDGE and order-working triggers

| # | Trigger (decision `action`) | Exact condition | Flag · default | ON in the live roster | Where |
|---|---|---|---|---|---|
| H1 | `raise` (floor raise) | candle close only, ≥ 15 min since the last pass, no raise working, < 8/day; ≤ 2 structures/pass; 2σ band; priced mid + 2 ticks; `spreadFirst` at 3:1 (verticals/longs fixing a valley, scored on its outward region; else any structure incl. flies that raises the band low); negative valleys first; never takes a floor ≥ 0 below 0; never past −lossMax (governed) nor below the late-floor limit; no budget cap set | `CANDLE_SPREAD_FLOOR_RAISE` default `all` | all 80, v7-10 included | `trader.js:1329-1478`, `:2025`; `floor-raise.js:312-321`; `index.js:862-876` |
| H2 | `offset` (floor offsets) | candle close only: floor < −lossTarget (0.7×lossMax) → far-side 20/40/60-wide at ≥ 3:1, ≤ 6/day; floor < −lossMax → must-fix at ≥ 1:1, ≤ 18/day | `floorOffset` true (BASE_RUNS) | governed shapes (-unc: false) | `trader.js:2006-2015`, `:964-1100`; `index.js:132` |
| H3 | `wing` (peak → floor) | candle close only: book peak > 0 and the planner finds a wing at ≥ 3:1, budget 10% of peak, ≤ 6/day, 1.5σ, naked longs allowed, mid ± $0.25/leg; no governor or late gate | `WINGS` | all 80 | `trader.js:1103-1212`, `:2020`; `index.js:254-255` |
| H4 | `fly` (valley repair) | — | `FLY_LIVE` EMPTY since 2026-10-09 | none | `trader.js:1214-1216`; `index.js:588-595` |
| H5 | raise-cap / raise-wing (repair fold) | — | `CANDLE_SPREAD_FLOOR_FOLD` default off | none | `index.js:894-905` |
| H6 | floor ratchet / trend-floor | — | `RATCHET_LEVELS` all null; `trendFloor` null | none | `index.js:1090`; `trader.js:1616` |
| H7 | risk-harvest | live: OBSERVER only, records lopsidedness, never sends; `trader` uses its candidate search for H2 only | — | observer on all | `index.js:2206-2232`; `trader.js:21,1023` |
| M1 | `open-reprice` (open ladder) | every candle and 30 s: placement + earned × $0.05 (120 s or 10 NDX pts, either direction), ≤ walk cap, ≤ the debit mark; refused if it pushes the floor through lossMax; frozen under no-open/halt | follows `coverLadder` | all 80 | `trader.js:3234-3330`, `:3229-3233` |
| M2 | `open-restrike` | open at its walk cap ≥ 10 min without a fill → CANCEL. It does not re-open: the next bar opens only if its signal fires again. | `openRestrikeMin` 10 | all 80 | `trader.js:3208-3227`; `index.js:851-852` |
| M3 | `open-stale` (orphan) | no fill and no reprice 90 min → cancel | 90 min | all (mark: trader; broker: order-manager) | `trader.js:3189-3201`; `order-manager.js:420,566` |
| M4 | `cancel-open` (reversal) | signal open side ≠ the working open's side, or the signal covers its side | — | all 80 | `trader.js:1700-1740` |
| M5 | pull covers before an open | covers this open would turn into a governor breach are cancelled first | — | broker path | `trader.js:665`, `:866-881` |
| M6 | hedge TTL | raise/offset/wing order unfilled 10 min → cancel (broker) / expire (mark); never repriced | `hedgeWorkMinutes` 10 | all | `trader.js:3031-3121` |
| M7 | over-cap rest | every placement over the cap → rest at cap − x and walk up | `openOverCapBelow` null = OFF, no env | none | `trader.js:2140-2143,2161-2164,2224-2226` |

### 4. BLOCKERS on an open (checked in this order, `trader.js:1867-1977`)

| Gate | Effect | Applies to | Where |
|---|---|---|---|
| Tradability | no evidence of a market → the whole tick is skipped | all | `index.js:2140-2156` |
| Control `halt` / `no-open` | halt: nothing reaches the broker; both: `open-skip-control`, working open's ladder frozen; covers/hedges keep running | per variant (S3 file) | `index.js:1534-1546,1889`; `trader.js:1867-1870,3229` |
| Stance conflict | open opposite a non-`none` stance → `open-skip-conflict` | v0-v6, v8 (v7/v9 bidirectional bypass) | `trader.js:1871-1872` |
| Leg uniqueness | no unique placement / twin credit unquotable → `open-skip-leg` | all | `trader.js:1886-1918`, `:676-687` |
| Ceiling | every placement over capFrac → `open-skip-ceiling` (G: 0.55 / 0.575 / 0.5875 × W; cATM 0.65); quote gates send the walk to the next placement | all | `trader.js:2113-2152,2187-2211`; `index.js:289-302` |
| Governor | projected floor with the open < −lossMax → `open-skip-governor` | governed shapes | `trader.js:1926-1931` |
| Late-day | from 15:00, if the 15:00 floor was ≥ 0, an open that takes it below 0 → `open-skip-late`; a 15:00 floor < 0 sets no limit | ALL shapes incl. -unc (D7) | `trader.js:1932-1936,910-921`; `index.js:928-931` |
| Ratchet | — | none (off) | `trader.js:1937-1947` |
| softCap | → cover-to-stack, else `open-skip-cap` | v8, v8-cATM | `trader.js:1948-1975` |
| One working open | a second open while one rests → `open-skip-pending` | all | `trader.js:656-663` |

### Backtest differences (only where it differs from live)

- **Governor-block locking.** The backtest locks deep winners (≥ 0.65×W) when the governor blocks an open
  (`coverToStackVsRisk`, `opts-for.js:62`; `backtest-v6-5m.js:1655-1664`) and when the floor passes −lossTarget
  (`reduceRisk` step 1, `:719`). Live does neither (C5 is softCap-only). Both skip positions with a cover working
  (`:548`), so they are inert where C1 placed one.
- **Backtest-only switches, set by no variant:** `signalCoverGiveUp`, `giveUpTrigger` rev5/rev5c/rev15/rev15c/
  signal/beWrong, `openCutoffMin`, `openFloorGate`, `openTrendBlock`, `decayStop`, `coverPriorOnOpen`,
  `coverLockGate`, `riskHarvest` (a trading overlay there; observer-only live) (`backtest-v6-5m.js:474-480,
  1109-1135,1173,1519-1540,1595-1598`).
- **Reversal-cover geometry:** tent unless `coverGeometryOnReversal` (set by nothing) (`backtest-v6-5m.js:1556-1561`);
  live reversal covers honour v1/v2 geometry.
- **`directionality`:** the backtest passes `directionalityAt(i)` to the signal (`backtest-v6-5m.js:1518`); live
  forwards `deps.directionality`, which `index.js` never sets (`trader.js:1670`). Latent — see D14.

### Discrepancies found

Cited above as D1-D17.

1. **"Signals (2)-(4) are OFF unless their cfg gate is set"** (`v4-signals.js:24`, `v5:26`, `v6:31`, `v7:31`).
   Code: grind (2) defaults to `widenFrac` 0.10 and active-cover (4) to 8 pts, both ON for v4-v9. Because each is
   read as `cfg.x != null ? cfg.x : default`, setting it to `null` does NOT turn it off — only a value that can
   never fire would. Only (3) candle-at-confluence is off by default.
2. `v6-signals.js:60` says trendTf `'5m'` is the DEFAULT; the code defaults to `'15m'` (`:63`).
3. `v7-signals.js:2-33` header is a copy of v6's ("v6 = v5 + a FASTER trend read") and does not describe be-wrong.
4. **"Held" is a stance on v0-v6/v8, not exposure.** `st.direction` is set by every open even before it fills
   (`trader.js:753`) and cleared only by a signal cover (`:1834`) — never by covers filling. On a fully covered
   book v4-v6/v8 still "hold" the last side: trend-cont the other way is refused (held must be the same or none),
   trend-flip / active-cover / O2-cover fire against nothing, and the conflict guard (`:1871`) refuses an
   opposite classic/v4-v6/v8 open until a signal cover clears the stance. The v5/v6 comments ("when we hold
   AGAINST a now-confirmed opposite structural trend") read as exposure. v7/v9 use positions, but a position
   whose cover is resting-not-filled still counts as held (`:1666-1667`). The backtest uses the same stance
   (`backtest-v6-5m.js:1516-1518,1567`), so this is parity-consistent, not a live-only bug.
5. **Signal covers place (almost) no orders.** C1 runs before the signal cover each bar (`trader.js:1777`) and the
   30 s worker now places it within 30 s of a fill (`index.js:2359-2362`); C3, C4 (proactive) and C5
   (cover-to-stack) all skip a position with a cover working (`trader.js:1791,1844,405`). On every family but v3
   the signal's cover changes nothing but (a) cancelling a working open and (b) clearing the stance. The
   Comparison table's "Cover signal" column and the v8/v9 "proactive" row describe triggers that are starved.
6. **The breakout rules test the HIGH, not the close.** Both the classic rule and `breakOpen` fire on green +
   high > prior high (`classic-signal.js:20`, `candle-patterns.js:66`), not on a close above the prior high.
   `breakOpen` is also unreachable whenever an earlier rule returned (pause, htf-gate, 5m veto, active cover,
   any intra-15m bar); in v4-v6/v8 its `'flat'` test reads the stance (D4), not open positions.
7. **Late-day guard scope.** `index.js:923` says "on every governed variant"; `applyLateFloor` (`:928-931`) sets
   it on every variant including -unc, where it gates opens (`trader.js:1932`) and floor raises (`:1411`) but not
   covers (that check is inside `govOn`, `:3713-3727`). It binds only when the 15:00 floor was ≥ 0
   (`lateFloorGiveW` null → no limit otherwise, `:918-919`).
8. **Re-strike does not re-strike.** `index.js:847-848` "cancelled so the next bar can re-place it at current
   strikes and prices"; the code only cancels (`trader.js:3208-3227`). A new open needs that bar's signal to
   fire again; between 15m closes v0-v5 have no signal, and v6-v9 only O8 (which needs a held side).
9. **Stall cover = currently losing, not "no favourable move".** It fires when, at any check ≥ 15 min after the
   fill, the last-bar NDX is on the losing side of the fill-time NDX (`fav < 0`, `trader.js:3533-3534`); a
   position that rallied and came back to +0 never fires, one that is 1 pt adverse at minute 40 does.
10. **Ladders step on movement in EITHER direction.** `stepsEarned` uses `Math.abs(move)` (`cover-ladder.js:87`),
    so a favourable 10-pt move raises a resting open's bid and a cover's price exactly as an adverse one does;
    the open-ladder comment (`trader.js:3176-3177`) speaks of a price that "runs AWAY".
11. `trader.js:1513`: the minLock ramp "ships ON for v7-10" — no variant sets `minLockRamp`.
12. `trader.js:3243`: open-ladder step "$0.25 (and $0.10 at W=40)"; every variant runs $0.05 (`index.js:691`).
13. `index.js:1010`: "TRIGGER stays 10 points"; the code sets 20 (`:1014`).
14. **Latent parity trap:** v7 `beWrongDirMin` reads `ctx.directionality`, which live never supplies — if the flag
    were ever set, live would suppress EVERY be-wrong open (`v7-signals.js:126`) while the backtest would not.
15. **Classic path comment is dead.** `trader.js:1583-1590` says v0-v3 decide via `spread-logic.classifyOpen /
    shouldCover` (with a Bollinger override); every roster family has a `signalFn`, so `ported` is always true
    (`:1577`) and v0-v3 run `classicSignal`, which has no Bollinger gate. `classifyOpen` (`:1679`) is unreachable.
16. **This README's own "Shared machinery" section is stale against the code:** give-up is 20 pts, not 10
    (`index.js:1014`); `FLY_LIVE` is empty — no variant runs stand-alone flies (`:588-595`); the no-ladder
    control cells are empty — v1-10/v2-10/v6-10 run the ladder (`:648-650`); placement G caps and walk caps are
    10W $5.50 / 20W $11.50 / 40W $23.50 with the 0.45×W floor only labelling, never declining (`:289-302`,
    `trader.js:2209`); v7-10's cap is $2,000 (`index.js:782`); the floor-offset must-fix needs ≥ 1:1, it does not
    drop the ratio (`trader.js:969-974`); continuous covers go on within 30 s of a fill, not at the next candle.
17. `index.js:216`: v9 "on top of the $20k backstop" — no such cap exists; v9-10's lossMax is $2,000.

---

## Shared machinery (read this before any family file)

### The variant axes — NOT families

| Axis | Values | Built by |
|---|---|---|
| Spread width | 10 / 20 / 40 | `WIDTHS`, `index.js:255-259` |
| Strike placement | `vX-W` = adaptive **placement G** (below); `vX-W-cATM` = fixed ATM-centred control (20/40 only) | `buildVariants` `:1069`, `buildAtmComparators` `:1166` |
| Risk caps | governed `vX-W` / `-cATM` vs uncapped twin `vX-W-unc` (no governor, no floorOffset, no softCap) | `buildUncapped` `:1120` |

**80 variants**: 30 governed adaptive + 30 `-unc` + 20 `-cATM` (`VARIANTS`, `index.js:1261-1265`). Every
builder routes through one hook, `applyExperiments` (`index.js:851-952`), so a flag reaches every shape.

### Instruments and cadence

- **Signals from /NQ 24h, pricing/strikes/settlement from cash NDX** (`BASE_RUNS`, `index.js:99-155`:
  `symbol:'NDX'`, `signalSymbol:'/NQ'`, `signalRth:false`). The backtest prices off the dataset's NDX
  series via `opts.priceOf` (`opts-for.js:153`). Foundational; not to change without discussion.
- **5-minute engine.** One tick per 5m bar from 09:35 to 15:55 ET, settlement at 16:00
  (`index.js:1297-1300`). v0-v5 wrap their signal in `at15` (`index.js:93`), a no-op on intra-15m bars —
  so their *signal* is 15m while their cover machinery, governor and hedges run every 5m. v6-v9 pass
  `fiveMin: true` and act on every bar.
- **Sub-bar worker (live only), every 30 s** (`WORK_MS`, `index.js:2183`; `runRestingWork` `:2186`):
  books broker fills, re-tests the working open, works resting covers (governor pull → ladder/give-up →
  fill test). It places nothing new and reads no signal; it uses the last candle's NDX as the underlying.

### Opening: placement G (every adaptive variant, `-unc` included)

`applyPlacementG`, `index.js:271-281`; walk in `trader.buildOpenAdaptive`, `trader.js:1877-1929`.

| Width | Price band `[minDebitFrac, capFrac] × W` | Open-ladder walk cap `openWalkCapFrac × W` |
|---|---|---|
| 10 | $4.80 – $5.30 (0.48 / 0.53) | $5.50 (0.55) |
| 20 | $9.50 – $11.00 (0.475 / 0.55) | $11.50 (0.575) |
| 40 | $19.00 – $23.00 (0.475 / 0.575) | $24.00 (0.60) |

Placements are tried **most-ITM first** — short leg 3 strikes in the money (`maxItmStrikes 3`) — through
the centred (straddle) placement and then **`maxOtmStrikes 1` step further out** (loop bound
`k <= halfOnGrid/incr + maxOtm`, `trader.js:1893`). The first placement whose real-chain mark is inside
the band is taken. Over the cap → try the next (cheaper) placement; under the floor → stop and decline
(every later placement is cheaper still). On a 10-wide the last step is short-leg one strike OTM; on 20/40
it is one strike beyond the centred spread. `-cATM` controls are **not** adaptive: fixed centred strikes,
gated at the `debitLimit` default `capFrac 0.65` (`spread-logic.js:265`), no price floor, no walk cap.

Quote gates applied while building the open (`buildOpenAtStrikes`, `trader.js:1931-1998`) — a failing
placement is skipped, not sent: `saneMark` (0 ≤ debit ≤ W), `chainMonotonic` (call mids fall / put mids
rise with strike), `cheapOutlier` (`spread-quote.js:126-167`: a vertical marked below a spread 1-2 strikes
further OTM by > 10% W, **or** whose midpoint is ≥ 1 strike ITM yet marks < 40% W, is a bad quote).

Other opening rules: `openNeverOtm` (a leg-uniqueness shift may not start fully OTM), leg uniqueness
(never trade a strike both ways), capital recapture (credit twin when `cashDeployed ≥ 0.25×W×100`,
`creditPreferred` `trader.js:2483`; trigger set at `index.js:878`). Order slip is 0 ticks fleet-wide.

### The open order's life

1. **Placed at ceil(mark) to the tick** (never below the mark) and **rests** — it is not booked at
   placement (`openPosition`, `trader.js:632-760`). **One working open at a time**; a repeat signal logs
   `open-skip-pending`.
2. **Reversal cancel**: if the signal now wants the other side, or wants this side covered, the working
   open is cancelled (`trader.js:1435-1476`; under the broker it is kept until the cancel is confirmed).
3. **Open ladder** (on wherever the cover ladder is on): **+$0.05 per 120 s or per 10 NDX points since
   placement**, whichever is further along, bounded by the walk cap and the mark (`trader.js:2970-3068`).
4. **Re-strike timeout** `openRestrikeMin 10` (`index.js:821-822`, `trader.js:2938-2961`): an open sitting
   at its walk cap for 10 min without a fill is cancelled so the next bar can re-place it at current
   strikes and prices.
5. **90-min orphan backstop**, separate: no fill and no reprice for 90 min → released (mark path
   `trader.js:2919-2936`; broker path `order-manager.js:325,458`; backtest `backtest-v6-5m.js:709-711`).
6. **Simulated fill** (mark path only): the touch test (mark ≤ limit, plus the quote gates in `markFill`,
   `trader.js:2505-2585`) must pass on a **later** look than the placing one — `simOpenFillMinLooks 2`
   (`applySimFillRealism`, `index.js:845-849`; test `trader.js:2892-2897`). Under the broker the fill is
   Schwab's (`applyBrokerFills`).

### The cover triggers

| Trigger | When the order is placed | Starting price | Where |
|---|---|---|---|
| `continuous` | Every bar, on every filled, uncovered position with no cover working. Unarmed families: the first candle after the open fills. v3: only once armed. | lock target `W − openCost − minLock×W` | `trader.js:1511-1565`; backtest `backtest-v6-5m.js` (a0b) |
| `reversal` | The signal's `cover`/`coverSide`, on positions **without** a cover working | `W − openCost` (break-even) | `trader.js:1566-1623` |
| `proactive` | v8/v9: position marking ≥ `proactiveCoverFrac×W`, no cover working | break-even | `trader.js:1628-1638` |
| `cover-to-stack` (lock) | Live: only when a legacy cap (`softCap`) blocks an open — i.e. v8. Backtest: also when the governor blocks an open. Winners ≥ 0.65×W, no cover working | break-even | `trader.js:380-416`, `:1729-1755`; backtest `lockDeepWinners` |

Continuous runs **before** the reversal and proactive steps and they skip anything already holding a
cover, so on unarmed families continuous claims almost every position. Measured 2026-09-30: proactive
fires ~0.6 times per run-day on v8/v9 — "rare, not dead".

### The cover order's life

- **Cover ladder** (`applyLadderCfg`, `index.js:659-670`; `cover-ladder.js`): walks the resting price
  from the lock target **up to break-even** (`ladderLossCapFrac 0`) at **$0.05 per 120 s or per 10 NDX
  points**, never above the mark. On every cell **except the control cells v1-10, v2-10, v6-10** (and their
  `-unc` twins) (`MINLOCK_CONTROL_CELLS`, `index.js:626-628`). A cover that starts at break-even (reversal,
  proactive, lock) has no span to walk.
- **Give-up** (`coverGiveUp`, fleet-wide, `index.js:921-930`; live `trader.js:3220-3234`): once NDX is
  **10 points back through the position's own short strike** (`giveUpPoints 10`), the cover is repriced to
  `min(mark + 1 tick, W − openCost + allowance×W)` — i.e. it may close at a loss of at most the
  **allowance: 10W 5%, 20W 7.5%, 40W 10% of width** (`giveUpMaxLoss`). Give-up supersedes the ladder for
  that position. Env `CANDLE_SPREAD_GIVEUP` = `all` (default) / `none` / a list.
  *Measured and not adopted:* a candle-break reversal trigger (`giveUpTrigger rev5/rev5c/rev15/rev15c`,
  `77a8224`) and the strategy's own signal reversal (`'signal'`/`'beWrong'`, `74dd777`) exist in the
  backtest only (`backtest-v6-5m.js:872-890`). 2026-10-06 sweep, 765 days, 50 variants, G roster, floor
  raise off (fleet locked-profit days / avg-per-day sum): points-10 **33.7% / $63,396**; 5m close-break
  31.3% / $63,030 (lowest drawdown, −36.7k vs −41.9k, but fewer locked days and worse on 10W); signal
  reversal **29.1% / $44,014** — it closed fewer losers, left more open at the close and blocked more opens
  than points-10; be-wrong only 32.1% / $50,728 (barely fires). v7-10: points-10 52.0% locked / $1,190 vs
  signal reversal 35.6% / $835. The signal turns too late: by then the cover is dearer than the allowance.
- **Simulated fill** (mark path): a cover books only when the market is **1 tick through** its price
  (`coverFillThroughTicks 1`, `trader.js:3318`; backtest `fillThroughTicksCover`). A credit-sent cover is
  judged on **its own sent (twin) legs' quote**, parity only as a fallback (`trader.js:3274-3282`).
- **Pricing mode**: `coverPriceMode` is `'lock'` on every variant (`'mark'` exists, `trader.js:212-226`,
  and is set by no variant). The market is consulted by the ladder (capped at the mark) and by give-up.

### minLock — by WIDTH

`continuousCoverMinLockFrac` = **0.10 at 10-wide, 0.20 at 20/40-wide**, every family and every shape,
controls included (`minLockByWidth`, `index.js:638`; applied `:860`). The per-family `MIN_LOCK` table
(`index.js:1059`) still seeds the builders but is always overwritten. With the G band's ceilings
(≤ 0.60×W walk cap) the lock target `W − openCost − minLock` is always positive, so the old "target
underwater → no cover placed" guard (`trader.js:1550`) no longer binds on adaptive variants.

### Risk layer

**Day-loss governor** — bounds the **book floor** (worst terminal P&L of the whole day's book), not
at-risk debit (`trader.js:763-875`).
- **Caps are per variant**: `TUNED_CAPS` (`index.js:709-809`), then a **ceiling of $7,500** and a **floor
  of 1.5 × W × 100** ($1,500 / $3,000 / $6,000) applied last and unconditionally (`index.js:894-916`).
  `lossTarget = 0.7 × lossMax` whenever a tuned cap, floor or ceiling set it. `CAPPRES_LIVE`
  (`index.js:467`) still names v7-10/v3-10/v6-20/v7-40 for a 1×W cap, but all four are in `TUNED_CAPS`,
  which is applied after it, so the preset is inert in the default config.
- **Effective caps (lossMax $)** from the roster as built:

  | Family | 10W | 20W | 40W | 20W-cATM | 40W-cATM |
  |---|---|---|---|---|---|
  | v0 | 1,500 | 4,500 | 6,000 (floor) | 7,000 | 7,500 |
  | v1 | 2,000 | 4,500 | 6,000 | 4,500 | 7,500 (ceiling) |
  | v2 | 2,500 | 4,500 | 6,000 (floor) | 4,500 | 7,500 |
  | v3 | 2,000 | 3,000 (floor) | 7,500 (ceiling) | 3,500 | 7,500 |
  | v4 | 2,000 | 4,500 | 7,000 | 4,500 | 7,500 (ceiling) |
  | v5 | 1,500 | 4,000 | 7,500 (ceiling) | 4,500 | 7,500 |
  | v6 | 2,000 | 4,500 | 7,500 (ceiling) | 7,000 | 7,500 (ceiling) |
  | v7 | **1,750** | 6,500 | 6,000 (floor) | 6,500 | 7,000 |
  | v8 | 1,500 | 3,000 (floor) | 6,000 (floor) | 7,000 (untuned generic; lossTarget 5,000) | 6,000 (floor) |
  | v9 | 2,500 | 4,500 | 7,500 | 6,500 | 7,500 |

  `-unc` twins: `lossMax`/`lossTarget` null — no governor.
- **Open gate**: an open whose projected floor breaches lossMax is skipped (`open-skip-governor`,
  `trader.js:1712-1717`). **Design B** (`govFloor`, `trader.js:787-805`): every open that can still fill
  (the working open; under the broker, a reversed open whose cancel is unconfirmed) counts as filled;
  working covers are not assumed to fill.
- **Cover deferral**: a cover whose fill would push the floor down *and* through lossMax does not book.
  Mark path: declined at fill time (`trader.js:3387`). Broker path: not placed (`trader.js:234`),
  pulled every pass (`governRestingCovers` `:3176`), pulled before any open is sent (`pullCoversForOpen`
  `:844`), and a ladder/give-up **raise** that would breach is not sent (`concedeCover` `:3105-3124`).
- **`floorOffset`** (governed only): floor through `lossTarget` → buy far-side offsets at ≥ 3:1 lift per
  dollar; through `lossMax` → must-fix, ratio gate dropped (`trader.js:1782-1795`, `:913-1042`).

**Hedges that change the shape** (all run after covers resolve each bar, `trader.js:1782-1805`):
- **Wing conversion** — peak→floor, every variant (`WINGS`, `index.js:252-253`): ratio ≥ 3, budget 10% of
  peak, naked longs allowed, no time gate.
- **Fly/condor valley repair** — on `FLY_LIVE` only (`index.js:567-570`): v0/v2/v4/v6/v8 at every
  capped shape incl. `-cATM`, plus `v7-10-unc, v7-20-unc, v7-40-unc, v6-40-unc, v0-40-unc`. Ratio 3, 1.5σ
  band, $1,500 budget, ≤ 4/day, condors allowed, stops at 15:00 (`index.js:935-938`).
- **Floor raise** — **every variant, v7-10 included** (`applyFloorRaise`, `index.js:832-844`; env
  `CANDLE_SPREAD_FLOOR_RAISE` = `all` default / `sim` (all but the armed one) / `off`). Planner
  `floor-raise.js` is shared by both engines. Every 15 min, up to 2 structures per pass, ≤ 8/day
  (`trader.js:1252-1360`), searching single longs, 10/20-wide verticals and 10/20-wing flies inside a
  2σ expected-move band, priced at **mid + 2 ticks**. Objective **`spreadFirst`** at **3:1**: verticals
  and longs may fix a valley on their own, scored on the lowest point of the valley's *outward* region out
  to the book's tail; only when none qualifies may anything (flies included) be bought, and only if it
  raises the band's lowest point (`pickBestMulti`, `floor-raise.js:208-217`). Negative valleys only while
  any exist. **Never pushes a locked profit (global floor ≥ 0) below zero; never pushes the global floor
  past −lossMax** (or deeper if already past) (`floor-raise.js:189-190`). Measured 765 days, honest fills
  (2026-10-06): off / 2:1 / **3:1** fleet locked-profit days 30.6 / 34.6 / **35.6%**, closing floor
  −1,467 / −1,152 / **−1,069**, avg/day 62.8k / 79.0k / **84.5k**. On v7-10 it trades floor for profit:
  locked days 51.8% → 44.9%, avg/day 1,177 → 1,630, maxDD30 −3,345 → −4,644 (user chose to trade it).
- **Floor ratchet** — built, **off** (`RATCHET_LEVELS` all null, `index.js:1003`); measured −$1.75M and
  rejected 2026-09-16. Env-armable for a re-test.

**Pricing / signals plumbing**: `ivSkew` on (`BASE_RUNS`), `intradayIV` canonical in the backtest.

### Arming

`CANDLE_SPREAD_ARMED` (default **`v7-10`**, `index.js:310`) selects the single variant that may send.
`CANDLE_SPREAD_ARMED_MODE=live` makes its orders real and fillable (`index.js:470`; default `'test'` =
real but unfillable, auto-cancelled). Sending also requires `isProd` and `CANDLE_SPREAD_LIVE === 'true'`
(`index.js:1337`). The S3 strategy-control file can only **lower** a mode, never raise it
(`effectiveDryRun`, `index.js:1377`). Per the live-run handoff, v7-10 runs with real money in prod; every
other variant is simulated on the mark path.

### Watchlist

`v1-10, v2-10, v6-10` (`WATCHLIST`, `index.js:50-53`) — a UI marker for the three no-ladder control cells.
v2-10 and v6-10 carry flies, so only v1-10 is free of every experiment (`index.js:34-38`).

---

## History (only what explains a current choice)

- **2026-09-04** — the day-loss governor replaced `hardCap`/`softCap`/`riskCap` as the risk layer
  because those gated at-open debit and a day could realise ~2× the cap. v8's `softCap` is the one survivor.
- **2026-09-05/06** — v0-v3 re-slotted after continuous covering made them identical to the dollar: v0-v2
  vary *where* the cover sits under instant covering, v3 carries risk-arming (`index.js:178-198`).
- **2026-09-09** — the previous edition of these docs. Its headline drift items, re-checked:
  *continuous covering pre-empts the other triggers* — **still true** (see Open questions 1);
  *the cover ladder-on-next-open (`coverPriorOnOpen`) is backtest-only* — **still true**;
  *cover limits never consult the market* — **superseded** by the cover ladder (to the mark) and give-up;
  *nothing can cover at a loss* — **superseded** by give-up (bounded loss);
  *per-family minLock 0.20-0.35* — **superseded** by the width rule;
  *$5k target / $6k/$7k/$9k max* — **superseded** by tuned caps with floor and ceiling;
  *`selectCoverFixed` ignored geometry* — **fixed** live; *governor is backtest-only* — **stale**, it is live.
- **2026-10-04** — minLock width rule and fleet give-up adopted on full-roster re-sweeps; fly re-sweep
  ~neutral (no change; user deferred fly decisions).
- **2026-10-05** — realistic fill model (ladder opens, 1-tick covers) adopted for baselines; placement G,
  re-strike timeout, sim-fill realism and the `cheapOutlier` gate shipped.
- **2026-10-06** — floor raise (spreadFirst) on every variant; give-up allowance by width; fills at the
  limit; resting raises in the backtest; open-ladder governor check.
- **2026-10-07** — floor raise 3:1; v7-10 cap $1,500 → $1,750 (10W cap sweep with raises on: +$82/day,
  maxDD30 −4,644 → −4,188, worst day −1,490 → −1,745).

---

## Cross-family open questions / suspected drift

| # | Finding | Kind |
|---|---|---|
| 1 | Continuous covering still runs before the reversal/proactive steps and they skip any position with a cover working (`trader.js:1511-1576`), so on unarmed families (all but v3) the signal-driven covers mostly do not place orders; the signal still cancels working opens, resets the stance and drives the opposite open. `coverPriorOnOpen` (cover a PRIOR position when a new one opens — the 2026-09-09 reading of "continuous cover") exists only in the backtest (`backtest-v6-5m.js:635-642`), set by no variant; `coverTiming: 'each-candle'` is still a placeholder (`trader.js:1765-1767`). Roadmap #1 priority of 2026-09-09; not decided. | Open decision |
| 2 | ~~Open-ladder raises are not governor-checked.~~ **Fixed `8f10006`:** a walk step that would push the floor down and through lossMax is refused (live `open-reprice-governor`, backtest `walkGovBlocked`). | Fixed |
| 3 | **Give-up vs placement G.** G can place the short leg one strike OTM. A bull whose short is ~10 points above spot is already ~10 points "through" its short strike at birth, so give-up can fire on the first cover. Flagged in `77a8224` ("fires almost at once"); the 10-point trigger was kept on the 2026-10-05/06 sweeps. Behaviour of OTM-short placements under give-up not separately measured. | Suspected interaction |
| 4 | **Cover-to-stack parity.** Live, cover-to-stack runs only when a legacy cap blocks an open (`trader.js:1729`; the governor branch at `:1712` comes first and just skips). The backtest also runs `lockDeepWinners` when the governor blocks (`backtest-v6-5m.js:1289-1293`). Inert where continuous covers exist on everything; can differ on v3 (risk-armed). | Suspected live/backtest drift (code-read, not measured) |
| 5 | Give-up and the cover ladder in the sub-bar worker read the **last candle's** NDX (`index.js:2180-2182`), so the 10-point test can be up to 5 min stale between bars. | Documented limitation |
| 6 | `CAPPRES_LIVE` names four variants whose 1×W preset is always overwritten by `TUNED_CAPS` (and the floor) — dead config that reads like a live experiment. | Dead config |
| 7 | Stale code comments: `FAMILIES` header says caps "are the $20 values; buildVariants scales them by width" (`index.js:163`) — it does not (`softCap` is absolute); the v1-v3 arming description at `:182-186` predates the 09-06 re-slot; the v9 comment cites a "$20k backstop" (`:214`); the ARMED comment says default `'v6-20'` (`:292`) while the code defaults to `v7-10`; `buildAtmComparators` says cATM is "capFrac-0.525" (`:1161`) while the code leaves capFrac unset → 0.65; the maxCapFor comment's $6k/$7k/$9k (`:289`) is no longer the cap anywhere but v8-20-cATM; the continuous-cover comment says the minLock ramp "ships ON for v7-10" (`trader.js:1524`) — no variant sets it. | Doc drift in code |
| 8 | The experiments-log lineage table still defines v0 as "fixed-cap 0.525×W", v1/v2 as greedy/joint selectors, v7 as "v6 + risk cap, be-wrong SHELVED" and v9 as standalone mean-reversion. The `FAMILIES` array is the definition. | Doc drift (memory) |
| 9 | `coverSelector` `greedy`/`joint` are reachable only from the reversal path and set by no family. Dead axis. | Dead axis |
| 10 | Backtest reversal covers on v1/v2 use the tent unless `coverGeometryOnReversal` (set by nothing, `backtest-v6-5m.js:1180-1191`); live reversal covers honour geometry. Small, since #1 starves the path. | Known parity gap |
| 11 | Committed baselines predate re-strike, floor raise and give-up-by-width (see Baselines). | Pending rebuild |

---

## Files

- [`v0.md`](v0.md) · [`v1.md`](v1.md) · [`v2.md`](v2.md) · [`v3.md`](v3.md) — the classic-signal / cover-geometry group
- [`v4.md`](v4.md) · [`v5.md`](v5.md) · [`v6.md`](v6.md) · [`v7.md`](v7.md) — the multi-timeframe lineage
- [`v8.md`](v8.md) · [`v9.md`](v9.md) — the experiment slots

Related memory: `project_candle_spread_experiments_log` (the catalog), `project_v4_multitimeframe_strategy`
(the v4→v7 narrative), `project_roadmap_backlog` (open work), `project_first_live_run` (the armed variant).
