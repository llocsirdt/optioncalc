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
