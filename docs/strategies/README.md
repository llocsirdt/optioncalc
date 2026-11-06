> Operator settings (env vars, remote control, kill switches): [../SETTINGS.md](../SETTINGS.md)

# Candle-spread strategy families — specification index

**What this is.** One page per strategy FAMILY describing how it is *meant* to operate, what the code *actually*
does, and where the two still differ. **[signals.md](signals.md) is the catalog of every open / cover / hedge
trigger and gate, with the strategy × signal table** — start there for "what does v_N actually use". This README
holds the family index, the baselines and the shared machinery.

**Updated 2026-11-05 against `main` at `d9f6a6a`** (prod build `a6bfb3d`): 16 rostered families, 140 live variants.
The 2026-10-06 edition covered v0–v9 only; v9sg, v9ob, v12, v13, v20 and v21 were added 10/19–10/23, and v10/v11
exist as a backtest-only engine.

**Ground truth is the code** — `server/src/candle-spread/index.js` (roster), `trader.js` (live engine),
`natural-cover.js`, `signals/*.js`, `backtest/backtest-v6-5m.js` + `backtest/opts-for.js` (backtest),
`floor-raise.js`, `cover-ladder.js`. Where a code comment, a memory note and the code disagree, the code is what is
described and the disagreement is listed. **No number in these files is derived.** Backtest figures are copied
verbatim from `server/src/candle-spread/backtest-baselines.csv`.

---

## Comparison table

| Family | What it is (one line) | Open signal | Cover | Δ vs parent | Status |
|---|---|---|---|---|---|
| **[v0](v0.md)** | Classic 15m price-action breakout; cover = tent (shares the short strike) | O1: 15m green + new high → bull; red + new low → bear | Continuous tent; classic signal cover | Control / root | Live, paper |
| **[v1](v1.md)** | v0 with the cover short walked halfway to the underlying | as v0 | as v0, geometry halfway | `coverGeometry:'halfway'` | Live, paper. **Same as v0 at 20W/40W** (see below) |
| **[v2](v2.md)** | v0 with the cover short at the underlying | as v0 | as v0, geometry at-money | `coverGeometry:'underlying'` | Live, paper. **Same as v0 at 20W/40W** |
| **[v3](v3.md)** | v0 with continuous covering RISK-ARMED instead of at birth | as v0 | armed continuous (C2) | `continuousCoverArmFrac 0.20`, `OppRatio 1.0` | Live, paper |
| **[v4](v4.md)** | Multi-timeframe read: 1/5/15/60m BB + 9 EMA confluence | O2 overextension, O3 grind, O5 trend continuation | + overext/grind/active-cover signal covers | New signal | Live, paper |
| **[v5](v5.md)** | v4 + trend flip | v4's + O7 | + trend-flip cover | `trendFlip` | Live, paper |
| **[v6](v6.md)** | v5 acting every 5 minutes | v5's + O8 5m+15m flip | + 5m early cover | `signalCfg.fiveMin` | Live, paper. Parent of v12/v13 |
| **[v7](v7.md)** | v6 + be-wrong: open the other side while holding, without covering the loser | v6's + O9 be-wrong | v6's, per side | `beWrong`, `bidirectional` | **v7-10 is the ARMED variant** (test mode) |
| **[v8](v8.md)** | v6 + proactive cover at 0.80 × W + reopen after cover | v6's + E2 | + C4 proactive | `proactiveCoverFrac 0.80` (soft cap removed 10/14) | Live, paper |
| **[v9](v9.md)** | v7 + proactive cover at 0.80 × W + reopen after cover | v7's + E2 | + C4 proactive | `proactiveCoverFrac 0.80` | Live, paper. Parent of v9sg/v9ob; the cover-to-open-wait control |
| **[v9sg](v9sg.md)** | v9 + stack gate | v9's; ADDS blocked while NQ 15m or 60m reads against (B6) | v9's | `stackGate:'nqNotAgainst'` | Live, paper (feature test) |
| **[v9ob](v9ob.md)** | v9 + open trend block | v9's; ANY open against trend A dropped (B3) | v9's | `openTrendBlock:'A'` | Live, paper (feature test) |
| **[v10/v11](v10-v11.md)** | Target engines: hold toward a close target / trade intraday touches of RTH lines | target rules | target rules | separate engine | **Backtest only**, not on the roster; live port in progress |
| **[v12](v12.md)** | v6 opens, book protected by reversal-opens (REV) + jump guard instead of covers | v6's + E3 REV, E4 guard; ADD gate (B4) | none per position (C14) | `natural:'v12'` | **Simulate-only** |
| **[v13](v13.md)** | v12 + continuous cover once a position is 30 min old | v12's | C1 after 30 min (C13) | `natural:'v13'`, `coverAfterMin 30` | **Simulate-only** |
| **[v20](v20.md)** | BB fade, opens only, held to the settle | O13: 5m close beyond BOTH 15m and 60m bands, faded | none | opens-only, strikes = v9 placement | **Simulate-only** |
| **[v21](v21.md)** | v20 with the strike chosen by price (closest to f × W) | O13 | none | `openPriceTarget` 0.50/0.55/0.60 | **Simulate-only** |

Shapes per family: `-10/-20/-40` (governed), `-W-unc` (uncapped twin, diagnostic), `-20-cATM/-40-cATM` (centred
strikes; not on v21), and `-f50/-f55/-f60` on v21. Source: `index.js` `FAMILIES`, `buildFeatureFamilies`,
`buildNaturalFamilies`, `buildOpensOnlyFamilies`.

**v0 / v1 / v2 are one strategy at 20W and 40W.** Their only difference is cover geometry. At 20W/40W the cover
strike is chosen by the cover-range re-strike (signals.md C10) for every family, so the geometry never acts. In the
baselines, v0/v1/v2 -20, -40 and -40-cATM are identical on every row. Live, they placed the same covers at the same
strikes on 11/02, 11/03 and 11/04, with one small 20W P&L difference on 11/03. They differ at 10W and 20W-cATM only.

### Baselines

`AVG terminal/day $` and `WORST single day $` per governed variant, copied from `backtest-baselines.csv`. That file
was rebuilt on `894ce51` (2026-10-23) over 821 trading days (12/27/2022–10/07/2026); the 2026 era (56 days) is priced
on real NDX, earlier days on NQ. Each family file carries its fuller block.

| | 10W avg/day | 20W avg/day | 40W avg/day | 10W worst day | 20W worst day | 40W worst day |
|---|---|---|---|---|---|---|
| v0 | 518 | 1159 | 1349 | -1970 | -4380 | -5295 |
| v1 | 545 | 1159 | 1349 | -1975 | -4380 | -5295 |
| v2 | 533 | 1159 | 1349 | -2300 | -4380 | -5295 |
| v3 | 504 | 924 | 1304 | -1970 | -3595 | -6865 |
| v4 | 546 | 1072 | 1906 | -2000 | -4500 | -6965 |
| v5 | 627 | 1495 | 2213 | -2315 | -4245 | -7263 |
| v6 | 537 | 815 | 1841 | -1530 | -2740 | -7347 |
| v7 | 697 | 1116 | 2047 | -1985 | -3625 | -6824 |
| v8 | 527 | 788 | 1822 | -1530 | -2740 | -7347 |
| v9 | 746 | 1920 | 2525 | -2275 | -4795 | -7441 |
| v9sg | 816 | 1836 | 2362 | -2460 | -4500 | -7205 |
| v9ob | 508 | 1271 | 1636 | -2000 | -4460 | -7024 |
| v12 | 148 | 179 | 11 | -1930 | -4330 | -6790 |
| v13 | 179 | 453 | 413 | -1985 | -5385 | -7480 |
| v20 | -57 | -202 | -374 | -2000 | -4500 | -7470 |
| v21 (f55) | -84 | -206 | -369 | -2000 | -4500 | -7485 |

**Read with care:** prices are Black-Scholes with bucketed skew, not real quotes, and fills are judged on 5-minute
bars (1m sub-bars on the 56 NDX days). Backtests are directional: live v7-10 has missed these tables badly. v20/v21
are opens-only and simulate-only; they are on the roster to be *watched* on real sessions, not traded.

---

## Trigger catalog

**Moved to [signals.md](signals.md)** (2026-11-05): every open trigger (O1–O13), engine-level open (E1–E4), open
gate (B1–B12), cover trigger (C1–C14) and hedge / order-working rule (H1–H3, M1–M4), with exact conditions, the
generated strategy × signal table, and the live-vs-backtest differences. The 2026-10-12 edition that used to sit here
(O1–O12 / C1–C16 / H1–H7 / M1–M7 and discrepancies D1–D17) is in git history at `ae06f72`. Its still-open items are
carried into signals.md Part 3.

---

## Shared machinery (read this before any family file)

Every trigger below has an ID in [signals.md](signals.md). This section explains how the shared pieces fit
together; signals.md has the exact conditions and which family uses which.

### The variant axes — NOT families

| Axis | Values | Built by (`index.js`) |
|---|---|---|
| Spread width | 10 / 20 / 40 | `WIDTHS` |
| Strike placement | `vX-W` = adaptive **placement G**; `vX-W-cATM` = fixed at-the-money centred control (20/40 only); v21 `-fNN` = priced closest to f × W | `buildVariants`, `buildAtmComparators`, `buildOpensOnlyFamilies` |
| Risk caps | governed `vX-W` / `-cATM` vs uncapped twin `vX-W-unc` (no governor, no floor offsets) | `buildUncapped` |

**140 variants**: v0–v9 = 80 (30 governed + 30 `-unc` + 20 `-cATM`); v9sg + v9ob = 16 (`buildFeatureFamilies`);
v12 + v13 = 16 (`buildNaturalFamilies`); v20 = 10 + v21 = 18 (`buildOpensOnlyFamilies`). Every builder routes
through one hook, `applyExperiments`, so a flag reaches every shape.

### Instruments and cadence

- **Signals from /NQ 24h, pricing/strikes/settlement from cash NDX** (`BASE_RUNS`: `symbol:'NDX'`,
  `signalSymbol:'/NQ'`, `signalRth:false`). The backtest prices off the dataset's NDX series via `opts.priceOf`.
  Foundational; not to change without discussion.
- **5-minute engine.** One tick per 5m close 09:30–15:55 ET, settlement at the 16:00 index close. v0–v5 wrap their
  signal in `at15` (empty between 15m closes), but their cover machinery, governor and hedges run every 5m. v6+
  (`fiveMin`) and v20/v21 act on every bar.
- **Sub-bar worker (live only), every 30 s** (`runRestingWork`): books fills, re-tests the working open, works
  resting covers (governor pull → ladder/give-up → fill test), and places the continuous cover on a new fill. It
  reads no signal and uses the last candle's NDX as the underlying.
- **The engine is DST-safe**: every ET time-of-day is computed through `America/New_York`. It was checked across
  the 2026-11-01 change.

### Opening: placement G (every adaptive variant, `-unc` included)

`applyPlacementG`; walk in `trader.buildOpenAdaptive`.

| Width | Price band `[minDebitFrac, capFrac] × W` | Open-ladder walk cap `openWalkCapFrac × W` |
|---|---|---|
| 10 | $4.50 – $5.50 (0.45 / 0.55) | $5.50 (0.55) |
| 20 | $9.00 – $11.50 (0.45 / 0.575) | $11.50 (0.575) |
| 40 | $18.00 – $23.50 (0.45 / 0.5875) | $23.50 (0.5875) |

Placements are tried **most-ITM first** (short leg at most 3 strikes in the money, `maxItmStrikes 3`) through
the centred placement and one strike further out (`maxOtmStrikes 1`). The first placement whose real-chain mark is
at or under the cap is taken; the 0.45 × W floor labels a placement, it never declines one. Every placement over
the cap → **open fallback** (signals.md E1) places one anyway at a known-good price. `-cATM` controls use fixed
centred strikes gated at capFrac 0.65. v21 instead takes the vertical whose real mark is closest to f × W.

**Sparse strike grid (2026-11-05).** When the chain lists no 10-pt strikes near the money (a big move leaves the band
the exchange listed them in), `strike-grid.js` reads the grid that is there and the variant opens a fallback width:

| Grid near the money | 10W | 20W | 40W |
|---|---|---|---|
| 5 or 10 pt | 10W | 20W | 40W |
| 25 pt | no opens | **25W** | **50W** |
| 50 pt | no opens | no opens | **50W** |
| 100 pt / none | no opens | no opens | no opens |

A fallback position records `width`/`incr`, and every later step (covers, ladder, give-up, re-strike, reopen,
broker-fill parity) works it at its own width. Fractions of W and strike-step knobs scale with it; **dollar caps do
not** (book-level). Live only: the backtest chain is always full. The UI shows a calm "SPARSE STRIKES" banner while it
is active.

Quote gates while building the open (`buildOpenAtStrikes`) — a failing placement is skipped, not sent: `saneMark`
(0 ≤ debit ≤ W), `chainMonotonic` (call mids fall / put mids rise with strike), `cheapOutlier` (a vertical marked
below a spread further OTM, or ≥ 1 strike ITM yet < 40% W, is a bad quote).

Other opening rules: `openNeverOtm`, leg uniqueness (never trade a strike both ways), and capital recapture (the
open or cover is sent as its credit twin once cash deployed reaches the width-scaled trigger,
`creditPreferred`). Order slip is 0 ticks.

### The open order's life

1. **Placed at ceil(mark) to the tick** and **rests**. **One working open at a time** (a repeat signal logs
   `open-skip-pending`).
2. **Reversal cancel** if the signal now wants the other side or covers this one.
3. **Open ladder**: +$0.05 per 120 s or per 10 NDX points since placement (either direction), up to the walk cap
   and never above the mark; a step that would push the floor through lossMax is refused.
4. **Re-strike timeout** 10 min at the walk cap without a fill → cancelled (the next open needs a fresh signal).
5. **90-min orphan backstop**: no fill and no reprice for 90 min → released.
6. **Simulated fill** (every non-broker run): mark at or through the limit on a **later, distinct** chain look
   than the placing one (`simOpenFillMinLooks 2`), booked AT the limit, with the structural / parity / monotonic /
   cheap-outlier checks in `markFill`. There's **no quoted-width gate** (removed 2026-11-04, `a6bfb3d`). Under the
   broker the fill is Schwab's.

### The cover order's life

- **Continuous cover** (C1) rests at the lock target `W − openCost − minLock × W` on the fill, and is the cover
  that actually fills on every family with covers. Signal, proactive and cover-to-stack covers skip any position
  that already has one working (signals.md 1d).
- **minLock by width**: 10W **0.10** on v0–v3, **0.05** on v4+ (plateau cover, C9); 20W/40W **0.20**.
- **Cover ladder** on every cell (the control-cell set `MINLOCK_CONTROL_CELLS` is empty): $0.05 per 120 s or per
  10 NDX points, up to break-even, never above the mark.
- **Give-up** (`coverGiveUp`, every family with covers): NDX **20 points** back through the position's own short
  strike → `min(mark + 1 tick, W − openCost + allowance × W)`, allowance **10W 5% · 20W 7.5% · 40W 10%**. 20W/40W
  first move the cover inside the open spread; 10W v4+ moves it back to the tent.
- **Stall cover** at 15 min while losing; **cover range re-strike** every 5 min at 20W/40W (signals.md C7, C10).
- **Simulated fill**: a cover books only when the market is **1 tick through** its price, at its limit.

### Risk layer

**Day-loss governor** — bounds the **book floor** (worst terminal P&L of the whole day's book), not at-risk debit.
Caps (`lossMax $`) from the roster as built; `lossTarget = 0.7 × lossMax` on every governed variant:

| Family | 10W | 20W | 40W | 20W-cATM | 40W-cATM |
|---|---|---|---|---|---|
| v0 | 2,000 | 4,500 | 6,000 | 7,000 | 7,500 |
| v1 | 2,000 | 4,500 | 6,000 | 4,500 | 7,500 |
| v2 | 2,000 | 4,500 | 6,000 | 4,500 | 7,500 |
| v3 | 2,000 | 3,000 | 7,500 | 3,500 | 7,500 |
| v4 | 2,000 | 4,500 | 7,000 | 4,500 | 7,500 |
| v5 | 2,000 | 4,000 | 7,500 | 4,500 | 7,500 |
| v6–v9, v9sg, v9ob, v12, v13, v20 | 2,000 | 4,500 | 7,500 | 6,500 | 7,500 |
| v21 (every f) | 2,000 | 4,500 | 7,500 | — | — |

All governed 10-wides are $2,000 / target $1,400 (user, 2026-10-07: so families compare cleanly). `-unc` twins
have no governor.

- **Open gate**: an open whose projected floor breaches lossMax is skipped (`open-skip-governor`). Every open that
  can still fill counts as filled; working covers are not assumed to fill.
- **Cover deferral**: a cover whose fill would push the floor through lossMax does not book (sim) or is pulled
  (broker).
- **Late-day guard** (15:00): if the 15:00 floor was ≥ 0, no open, raise or (governed) cover may take it below 0.
  It applies to `-unc` too.
- **Floor offsets** (governed only); **floor raise** (every family with covers, spreads first, 4:1 near / 8:1 far,
  trend-sided 3:1 / 6:1 with trend A and 5:1 / 10:1 against; never below a locked profit or past −lossMax); and
  **wings** (peak → floor, 3:1, budget 10% of the peak). See signals.md H1–H3.
- **Soft / hard / risk caps** (`softCap`, `hardCap`, `riskCap`) are off on every variant. v8's $3,000 soft cap,
  the last survivor, was removed 2026-10-14. That is why cover-to-stack (C12) never fires live.
- **Stand-alone fly repair** (`FLY_LIVE`) is empty since 2026-10-09; flies remain available inside floor raise.
  The floor ratchet is built and off.

### Arming

`CANDLE_SPREAD_ARMED` (default **`v7-10`**) selects the single variant that may send. `CANDLE_SPREAD_ARMED_MODE`
`live` makes its orders real and fillable; the default `test` sends real but unfillable orders, and fills are
simulated. Sending also requires `isProd` and `CANDLE_SPREAD_LIVE === 'true'`. The S3 control file can only
**lower** a mode. **Simulate-only** families (v12, v13, v20, v21) can never be armed (`effectiveDryRun`,
`buildEngineDeps`, `applyArmedSelection`, `armableReason`).

### Watchlist

`v1-10, v2-10, v6-10` (`WATCHLIST`, env-overridable) — a UI marker kept from when these were the no-ladder control
cells. The control-cell set is now empty, so all three run the ladder like everything else.

---

## History (only what explains a current choice)

- **2026-09-04** — the day-loss governor replaced `hardCap`/`softCap`/`riskCap` as the risk layer.
- **2026-09-05/06** — v0–v3 re-slotted: v0–v2 vary *where* the cover sits, v3 carries risk-arming.
- **2026-10-04/06** — minLock width rule, fleet give-up, realistic fill model (ladder opens, 1-tick covers), placement
  G, floor raise on every variant, give-up allowance by width, fills at the limit.
- **2026-10-07** — all governed 10-wides to $2,000 / target $1,400.
- **2026-10-09** — stand-alone fly repair off.
- **2026-10-13** — open fallback ("always place on a signal").
- **2026-10-14** — v8 soft cap removed and proactive 0.70 → 0.80; reopen-after-cover on v7-10, v8, v9; plateau
  cover the default for 10W v4+.
- **2026-10-16/17** — cover-to-open wait on v6/v7/v8 (v9 left as the control); sim fill realism part 2 (two-look
  rule, parity gate).
- **2026-10-19** — feature-test families v9sg / v9ob (roster 80 → 96).
- **2026-10-23** — v20/v21 opens-only BB fade and v12/v13 natural cover live as simulate-only (→ 140).
- **2026-10-28** — v10/v11 rules moved into the shared `target-rules.js` (live port step 1; not rostered).
- **2026-11-04** — simulated-fill quoted-width gate removed (`a6bfb3d`).

---

## Cross-family open questions / suspected drift

| # | Finding | Kind |
|---|---|---|
| 1 | Continuous covering runs before the signal / proactive steps, and they skip any position with a cover working, so on all families with covers but v3 the signal-driven covers mostly do not place orders. The signal still cancels working opens, resets the stance and drives the opposite open. | Open decision |
| 2 | **v0 / v1 / v2 are identical at 20W, 40W and 40W-cATM** (baselines identical on every row; live identical covers 11/02–11/04). The cover-range re-strike sets the strike at 20/40W, so their geometry never acts. Six of their runs duplicate each other. | Redundant variants (user decision) |
| 3 | **Cover-to-stack parity.** Live runs it only on soft/hard/risk caps (all off), so it never fires. The backtest also runs `lockDeepWinners` when the governor blocks an open. It locks only winners with no cover working, so it rarely bites where continuous covers rest on everything; it can differ on v3 (unarmed positions). | Live/backtest drift (code-read, not measured) |
| 4 | **Give-up vs placement G.** G can place the short leg one strike OTM, so give-up can fire on the first cover. Not separately measured. | Suspected interaction |
| 5 | Give-up and the cover ladder in the sub-bar worker read the **last candle's** NDX, up to 5 min stale between bars. | Documented limitation |
| 6 | `coverSelector` `greedy`/`joint` are reachable only from the reversal path and set by no family. | Dead axis |
| 7 | Backtest reversal covers on v1/v2 use the tent unless `coverGeometryOnReversal` (set by nothing); live reversal covers honour geometry. Small, since #1 starves the path. | Known parity gap |
| 8 | `family-about.js` (the compare page's strategy popover) said v8 covers at 70% of width; the roster has 0.80 since 10/14. Fixed in the same change as this README. | Fixed 2026-11-05 |

---

## Files

- [`signals.md`](signals.md) — every trigger and gate, and the strategy × signal table
- [`v0.md`](v0.md) · [`v1.md`](v1.md) · [`v2.md`](v2.md) · [`v3.md`](v3.md) — the classic-signal / cover-geometry group
- [`v4.md`](v4.md) · [`v5.md`](v5.md) · [`v6.md`](v6.md) · [`v7.md`](v7.md) — the multi-timeframe lineage
- [`v8.md`](v8.md) · [`v9.md`](v9.md) — proactive-cover families
- [`v9sg.md`](v9sg.md) · [`v9ob.md`](v9ob.md) — v9 feature tests
- [`v10-v11.md`](v10-v11.md) — target engines (backtest only)
- [`v12.md`](v12.md) · [`v13.md`](v13.md) — natural cover
- [`v20.md`](v20.md) · [`v21.md`](v21.md) — opens-only BB fade

Related memory: `project_candle_spread_experiments_log` (the catalog of every flag and experiment),
`project_v4_multitimeframe_strategy` (the v4→v7 narrative), `project_roadmap_backlog` (open work),
`project_first_live_run` (the armed variant).
