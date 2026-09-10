# Candle-spread strategy families — specification index

**What this is.** One page per strategy FAMILY (v0-v9) describing how it is *meant* to operate,
what the code *actually* does, and where those two differ. Written 2026-09-09 against the working
tree (some cited code is uncommitted — flagged where it matters).

**Why it exists.** "Continuous cover" was implemented as *rest a cover the instant a position
opens*; the user's stated intent was *opening a NEW position is the trigger to cover a PRIOR one —
a ladder*. Nothing documented the intent, so the divergence survived weeks and silently collapsed
the v0/v1/v2 geometry comparison. Every family file therefore ends with an **Open questions /
suspected drift** section, and drift that is *confirmed* (code contradicts a stated intent) is
called out as such rather than hedged.

**Rules used writing these.** Where no stated reason for a behaviour could be found in code
comments, the experiments log, or the v4 narrative, the doc says *intent not documented* rather
than guessing.

---

## Comparison table

| Family | What it is (one line) | Open signal | Cover signal | Δ vs predecessor | Status |
|---|---|---|---|---|---|
| **v0** | Classic 15m price-action breakout, cover = tent (shares the short strike) | 15m green + new high → bull; red + new low → bear | Continuous (every bar, unarmed) + classic confirmed reversal | Baseline / control | Active; the control the other three geometries are read against |
| **v1** | v0 with the cover short walked HALFWAY to the underlying (condor, not butterfly) | same as v0 | same as v0 | `coverGeometry:'halfway'` | Active; **on the live watchlist** (v1-10, best efficiency 150.0) |
| **v2** | v0 with the cover short AT the underlying (widest tent, may forfeit the guaranteed floor) | same as v0 | same as v0 | `coverGeometry:'underlying'` | Active; weakest of v0-v3 on total |
| **v3** | v0 geometry (tent) but covering is RISK-ARMED rather than instant | same as v0 | Continuous only once armed (book floor ≥ 0.20×lossTarget, or cover locks ≥ 1.0× its cost) + classic reversal | `continuousCoverArmFrac 0.20`, `continuousCoverOppRatio 1.0` | Active; the clean policy A/B against v0 |
| **v4** | Multi-timeframe precision layer — the user's real discretionary edge encoded | 15m closes only: overextension reversal, grind top/bottom, gated trend continuation | Overextension/grind flip + active-cover into an opposing confluence cluster + the shared triggers | First multi-TF family; replaces classic's single-TF rules | Active; superseded on P&L by v5/v6 but kept as the frozen lineage baseline |
| **v5** | v4 + a **trend-flip cover** (the exit v4 lacked) | v4's signals, unchanged | v4's + cover the whole book and take the new side when 15m close **and** 9EMA cross the midline against you | `trendFlip` (on by default) | Active; halved v4's drawdown |
| **v6** | v5 acting every **5 minutes** instead of only at 15m closes | v5's at 15m closes; intra-15m bars can flip on a 2-bar-confirmed 5m reversal | v5's + intra-5m early cover (5m structural trend against the held side for two consecutive 5m bars) | `signalCfg.fiveMin: true` | Active; **watchlist** (v6-20, v6-10). Best non-bidirectional signal |
| **v7** | v6 + **"be wrong"**: open the opposite side while still holding, without covering the loser | v6's + a be-wrong opposite open on a reversal candle that breaks the prior extreme | v6's, but **per-side** (`coverSide`) — only the wrong-way side is covered | `beWrong: true`, `bidirectional: true` | Active; **highest total in the roster** (v7-20 $3.27M), armed default (v7-10) |
| **v8** | v6 signal + a fixed $3,000 "churn" soft cap (trend-stack exempt) + proactive deep-ITM covering | v6's | v6's + rest a cover on any position marking ≥ 0.70×W | `softCap 3000`, `exemptTrendStack`, `proactiveCoverFrac 0.70` | **Experiment slot.** Current mutation is measured-fatal (softCap alone costs 3.3×); kept deliberately |
| **v9** | v7 signal + proactive deep-ITM covering at 0.80×W | v7's (be-wrong) | v7's + rest a cover on any position marking ≥ 0.80×W | `proactiveCoverFrac 0.80` on top of v7 | **Experiment slot.** Daily correlation with v7 = 1.00; costs 2-3% |

Source of truth for the table: `server/src/candle-spread/index.js:146-187` (the `FAMILIES` array).

### Committed baseline totals (`TOTAL terminal $`, 765 days, from `server/src/candle-spread/backtest-baselines.csv`)

| | $10 | $20 | $40 |
|---|---|---|---|
| v0 | 1,090,189 | 1,660,072 | 1,952,758 |
| v1 | 1,062,735 | 1,642,494 | 1,930,145 |
| v2 | 1,005,770 | 1,534,098 | 1,913,555 |
| v3 | 929,190 | 1,591,512 | 1,918,892 |
| v4 | 1,128,111 | 1,641,262 | 1,638,106 |
| v5 | 1,398,166 | 2,280,452 | 2,559,041 |
| v6 | 1,815,339 | 2,699,959 | 2,822,661 |
| v7 | **2,807,738** | **3,273,545** | 2,783,778 |
| v8 | 959,816 | 654,562 | 561,900 |
| v9 | 2,749,615 | 3,190,436 | 2,716,213 |

---

## Shared machinery (read this before any family file)

### The variant axes — NOT families

Every family is cross-producted into concrete runs. These axes are *not* strategy differences:

| Axis | Values | Built by |
|---|---|---|
| Spread width | $10 / $20 / $40 | `WIDTHS`, `index.js:225-229` |
| Strike placement | short-ATM sweep `vX-W` (adaptive, ITM-seeking) vs ATM-centered control `vX-W-cATM` ($20/$40 only) | `buildVariants` / `buildAtmComparators`, `index.js:292`, `index.js:374` |
| Risk caps | governed `vX-W` vs uncapped twin `vX-W-unc` | `buildUncapped`, `index.js:333` |

80 concrete variants: 30 governed short-ATM + 30 `-unc` + 20 `-cATM` (`index.js:425-429`).
The old `vX-W-10k` low-cap twins were retired 2026-09-04 (`index.js:409-411`).

**Adaptive placement** (`adaptiveGeo: true, maxItmStrikes: 3`, `index.js:230`) is the default open
geometry: take the most-ITM placement whose real price is still inside `capFrac 0.60 × W`, floored
at straddle, never OTM. Rationale in `index.js:189-205` — "ITM spreads cover more easily, and we
make money on COVERS, not opens."

### Cadence

The live engine steps every **5 minutes** for every family (`index.js:479-486`). Families v0-v5 wrap
their signal in `at15` (`index.js:63`), which returns a no-op on intra-15m bars — so their *signal*
is 15m, but their **cover machinery, governor, and resting-order resolution still run every 5m**.
v6-v9 pass `fiveMin: true` and act on intra-15m bars too.

### The five cover triggers (shared by all families)

| Trigger | When the ORDER is placed | When it FILLS | Where |
|---|---|---|---|
| `continuous` | Every bar, on every uncovered position that has no cover working. Unarmed families place it **on the bar the position opens**. | When the real mark reaches `W − openCost − minLockFrac×W` | backtest `backtest-v6-5m.js:533-587`; live `trader.js:657-698` |
| `reversal` | On a signal cover (`sig.cover` / `sig.coverSide`), on uncovered positions **that do not already have a cover working** | same resting model | backtest `:722-751`; live `trader.js:708-742` |
| `proactive` | v8/v9 only: any position marking ≥ `proactiveCoverFrac × W` | same | backtest `:525-531`; live `trader.js:746-757` |
| `lock` (cover-to-continue) | When a new open would breach `lossMax`: lock the deepest-ITM winners (≥ `0.65 × W`) to free room | same (`lockCoverMode: 'rest'`) | backtest `:323-410`; live `trader.js:823-825` |
| `ladder` | **Built but not enabled by any family.** On a new open, cover a PRIOR position. | same | backtest `:855-880` (`opts.coverPriorOnOpen`) — uncommitted; **no live implementation** |

Nothing in the engine can cover at a loss: every target is at or above `W − openCost`. A position
whose cover mark has passed break-even rides to expiry naked (roadmap, 2026-09-08).

**⚠️ CONFIRMED DRIFT, all families.** `continuous` runs first and the other triggers all filter on
`!pendingCover`, so continuous covering **structurally starves the other four**. Measured live
2026-09-08: **101 of 101 covers came from `continuous`; zero from the other three implemented
triggers.** See "Continuous cover" below.

### Continuous cover — the confirmed misinterpretation

**As implemented:** rest a cover on EVERY uncovered position on EVERY bar, at
`W − openCost − minLockFrac×W`. For an unarmed family that is *the bar the position opened*.
`backtest-v6-5m.js:560-587`, `trader.js:669-698`.

**User's stated intent (2026-09-09):** *opening a NEW position is itself the trigger to cover a
PRIOR one — a ladder.* Open one and leave it working; if a cover signal comes, cover on the signal;
if instead another open signal comes, cover the earlier (now deeper-ITM) position as the new one
goes on. This reading is written verbatim into the uncommitted `coverPriorOnOpen` block at
`backtest-v6-5m.js:855-861`, and the original engine design carried it as
`coverTiming: 'each-candle'` — still a dead placeholder at `trader.js:838-840` ("cover the prior
uncovered position on every candle … exact semantics TBD") with `'on-reversal'` the only implemented
value (`index.js:82`, `variant-contract.js:24`).

**Measured consequences of the as-implemented reading:**
- A cover chosen while the underlying is still AT the short strike makes `tent` / `halfway` /
  `underlying` resolve to the *same strike*. Live 2026-09-08: **71% of positions got identical
  cover legs across v0/v1/v2**; v0-10 vs v1-10 daily correlation 0.93. The geometry axis those
  three families exist to compare barely expresses.
- Every position's outcome is decided at birth, which is why the arming knobs
  (`continuousCoverArmFrac` / `continuousCoverOppRatio`) were added — and they are enabled on **v3
  only**.

**Status:** the ladder is implemented in the backtest engine only, behind `opts.coverPriorOnOpen`,
**set by no family and no variant**, and absent from `trader.js` entirely. Flagged in v6/v7/v8 (and
every other) family file.

### Shared risk layer (all families, from `BASE_RUNS`, `index.js:69-117`)

- **Day-loss governor** — bounds the *book floor* (worst terminal P&L of the whole day's book), not
  at-risk debit. `lossTarget $5,000` for every family and width; `lossMax = max(2×W×100, 5000+W×100)`
  → $6k/$7k/$9k at $10/$20/$40 (`index.js:262-263`). Three mechanisms: open gate
  (`trader.js:811-815`), cover deferral (`trader.js:1300-1306`), floor-aware cover-to-continue.
- **`floorOffset`** — ratio-gated cheap far-side offsets once the floor is through the target;
  must-fix mode above `lossMax` (`trader.js:853-861`).
- **Wing conversion** — peak→floor, on for all 80 variants (`WINGS`, `index.js:222-223`).
- **Capital recapture** (alternate debit/credit opens every 3, credit covers on deep-ITM winners) and
  **leg uniqueness** (never trade a strike both ways) — both default on (`index.js:90-91`).
- **`openNeverOtm`** — an initial order may not START fully OTM (`index.js:110`).
- **`continuousCoverMinLockFrac`** — per family: v0-v3 0.25, v4/v5 0.30, v6/v8 0.35, v7/v9 0.20
  (`MIN_LOCK`, `index.js:282-287`).
- **Pricing** — `intradayIV` and `ivSkew` on by default; signals always off /NQ 24h, pricing always
  off cash NDX (`index.js:71-75`).

### Arming

`CANDLE_SPREAD_ARMED` (default `v7-10`) selects which single variant may send; sending additionally
requires `isProd` **and** `CANDLE_SPREAD_LIVE === 'true'` (`index.js:240-260`). Everything else is
`dryRun: true`. `testAtBase` on v6 is vestigial — nothing reads it (`index.js:175-176`).

---

## Cross-family drift summary

| # | Finding | Kind |
|---|---|---|
| 1 | "Continuous cover" rests a cover on every position at birth; intent was a ladder triggered by the next OPEN. Ladder exists only as an unwired backtest flag. | **Confirmed drift** |
| 2 | Continuous covering starves the other four triggers (101/101 live covers were `continuous`), so the reversal / proactive / lock paths are nearly dead code in practice. | **Confirmed drift** |
| 3 | The experiments-log lineage table defines v1/v2 as greedy/joint cover selectors, v7 as "v6 + risk cap, be-wrong SHELVED", and v9 as a standalone mean-reversion strategy. The `FAMILIES` array defines them as halfway/at-money geometry, be-wrong bidirectional, and v7+proactive 0.80. **Two authoritative sources disagree about what v1, v2, v7 and v9 ARE.** | **Confirmed doc drift** |
| 4 | `index.js:133` states "Caps here are the $20 values; buildVariants scales them by width" — `buildVariants` does **not** scale `softCap` (`index.js:316`), and `index.js:289-291` states the opposite (caps are absolute). v8's fixed $3,000 softCap on a $40 spread is the measured cause of v8-40's collapse. | **Confirmed drift** (contradictory comments; behaviour follows the "absolute" reading) |
| 5 | `minLock` is applied uniformly (0.20-0.35×W) to continuous covers. User's stated model: a reversal cover may rationally lock ~zero or a small loss because the upside lives in the tent's shape. Not implemented. | **Documented intent, not implemented** |
| 6 | The `coverSelector` seam (`fixed` / `greedy` / `joint`) is reachable only from the reversal path, which continuous covering pre-empts. All four of v0-v3 are `fixed`, so `greedy` and `joint` are currently unreachable in every family. | Dead axis |
| 7 | The experiments log's "⚠️ LIVE GAP: the governor is in the BACKTEST engine only" is **stale** — `trader.js` implements the governor (`:367-395`, `:811-815`, `:1300-1306`). | Stale doc |
| 8 | Cover targets never consult the mark (`W − openCost − minLock`). Live 2026-09-08: 43 of 101 covers unfilled, limits at a **median 40% of the mark**, never repriced. Live 2026-09-09: **733 of 735 unfilled covers were BELOW the market at placement, a median 64% below** — they could never have filled. A `coverPriceMode: 'mark'` fix exists **uncommitted** in the working tree (`trader.js:118-131`, `index.js:620-621`) and is set by no family. | **Confirmed drift** vs `feedback_opens_must_fill` |

---

## Files

- [`v0.md`](v0.md) · [`v1.md`](v1.md) · [`v2.md`](v2.md) · [`v3.md`](v3.md) — the classic-signal / cover-geometry group
- [`v4.md`](v4.md) · [`v5.md`](v5.md) · [`v6.md`](v6.md) · [`v7.md`](v7.md) — the multi-timeframe lineage
- [`v8.md`](v8.md) · [`v9.md`](v9.md) — the experiment slots

Related memory: `project_candle_spread_experiments_log` (the catalog),
`project_v4_multitimeframe_strategy` (the v4→v7 narrative), `project_roadmap_backlog` (open work).
