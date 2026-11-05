# Signals — every open and cover trigger, and which strategy uses which

**What this is.** The single catalog of everything that can OPEN a position, COVER one, HEDGE the book, or BLOCK an
order on the candle-spread engine. Part 1 is the catalog with exact conditions; Part 2 is the **strategy × signal
table** (the "which strategy actually uses what" view). Per-family pages ([v0](v0.md) … [v21](v21.md)) explain *why*
each family is configured the way it is; this page is *what* each rule does.

**Written 2026-11-05 against `main` at `d9f6a6a` (prod build `a6bfb3d`), from three sources, in this order:**
1. The code — `server/src/candle-spread/signals/*.js` (`signal-trace.js` evaluates every candle trigger with its
   exact condition), `trader.js` (live engine), `natural-cover.js`, `signals/bb-fade.js`, `trend-state.js`,
   `index.js` (roster), `backtest/backtest-v6-5m.js` + `backtest/opts-for.js` (backtest).
2. The **live roster as configured** — every field of all 140 variants dumped from `index.js buildRuns()`.
   Part 2's mechanism rows are generated from that dump, not written by hand.
3. The **2026-11-04 live session traces** — every candle of every run records which triggers it evaluated, whether
   each was enabled and whether it fired. Part 2's candle-signal rows are the union of those traces per family.

Code is cited as `file` + function. Where a comment, an older doc or memory disagrees with the code, the code is what
is described here and the disagreement is listed in [Part 3](#part-3--live-vs-backtest-and-known-gaps).

---

## Conventions

- **Signal series vs pricing.** Every signal reads COMPLETED **/NQ 24h** candles; every price, fill, strike and the
  settle is **cash NDX**. NQ levels move to NDX with the live basis.
- **Cadence.** The engine ticks at every 5m close 09:30–15:55 ET; a tick is a *15m close* when minute % 15 = 0. v0–v5
  are wrapped in `at15`: between 15m closes their signal is empty. v6+ also act between 15m closes, but only on a
  held side (never a fresh open from flat). A 30 s worker between ticks works orders (fills, ladders, covers on fill)
  and reads no signal.
- **Trend.** *15m trend up* = 15m close above the 15m Bollinger midline (20-SMA) AND 15m 9 EMA at or above it
  (`signal-trace.js trendOf`); mirror for down; otherwise mixed. Same definition on 5m.
- **Bullish reversal candle** = lower wick ≥ 50% of range with body ≤ 40% and close in the upper half, OR bullish
  engulfing, OR a green doji (`candle-patterns.js`). Mirror for bearish.
- **Cluster** = ≥ 3 timeframes' band/EMA lines within a radius (`confluence.strongestClusterNear`, `minTf: 3`).
- **Held.** v0–v6, v8, v12, v13 hold a *stance*: the side of the last open, cleared only by a signal cover — not by
  covers filling. v7, v9, v9sg, v9ob, v20, v21 are *bidirectional*: held = a filled position of that side whose cover
  has not filled.
- **Shapes.** Every family runs as `-10/-20/-40` (governed), `-W-unc` (no day-loss governor; diagnostic, not
  tradable) and `-20-cATM/-40-cATM` (strikes centred at the money instead of placement G). v21 adds `-f50/-f55/-f60`.
  A shape never changes the signal — only the mechanisms marked by width in Part 2.

---

## Part 1 — the catalog

### 1a. Candle signals that OPEN

The signal function returns at most one open per tick. At a 15m close the triggers are evaluated **in this
order**, and the first enabled + active one wins.

| ID | Trigger (trace id) | Exact condition | Families |
|---|---|---|---|
| **O1** | Classic breakout (`classic-open-bull/-bear`) | 15m close green AND 15m **high** > prior 15m high → bull. Red AND low < prior low → bear. There's no band or midline condition, and the test is on the high/low, not the close. | v0–v3 |
| **O7** | Trend flip (`trend-flip-bull/-bear`) | Holding bull AND 15m trend down → open bear + cover bull (mirror). Evaluated first at a 15m close. | v5–v9, v9sg, v9ob, v12, v13 |
| **O9** | Be-wrong (`be-wrong-bull/-bear`) | Holding an uncovered bear AND 15m high > prior high AND bullish reversal candle → open bull and leave the bear **uncovered** (mirror). | v7, v9, v9sg, v9ob |
| **O2** | Overextension reversal (`overext-bottom/-top`) | (5m BB lower − 15m low) / 5m band width ≥ −0.15 (the low came within 0.15 band-widths of the 5m lower band, or pierced it) AND 15m closed back above the 5m lower band → bull (mirror). Also covers a held opposite side. | v4–v9, v9sg, v9ob, v12, v13 |
| **O3** | Grind reversal (`grind-bottom/-top`) | 1m band pushed ≥ 0.10 of its width past the slower (5m/15m) band AND 15m close below its midline AND bullish reversal candle → bull (mirror). | v4–v9, v9sg, v9ob, v12, v13 |
| **O5** | Trend continuation (`trend-cont-bull/-bear`) | 15m trend up AND green 15m AND not holding a bear → bull (mirror). **Suppressed (a hold, not an open)** when a ≥ 3-TF cluster sits ≤ 8 pts beyond the close in the trade's direction ("pause into resistance/support"). | v4–v9, v9sg, v9ob, v12, v13 |
| **O8** | 5m + 15m flip (`5m-turn-bull/-bear`) | **Between** 15m closes only, holding X: the 5m trend against X on this AND the prior 5m bar AND the 15m trend against X → open the other side + cover X. If the 15m doesn't agree → cover only (the "5m early cover", C3). Never opens from flat. | v6–v9, v9sg, v9ob, v12, v13 |
| **O13** | BB fade (`bb-fade-bull/-bear`) | 5m /NQ close **below both** the last *completed* 15m AND 60m lower BB(20,2) → bull. **Above both** uppers → bear. Evaluated every 5m tick. | v20, v21 |

**Coded but off on every variant** (set by no roster entry, no env switch). Each is listed here so its absence from
Part 2 isn't mistaken for an omission:
- **O4** candle at a cluster (`candleConfluenceRadius`)
- **O6** hourly band gate on O5 (`htfGate`)
- **O10** be-wrong on a centerline cross (`centerlineCross`)
- **O11** green-breaks-the-high open (`breakOpen`)
- **O12** trend-floor open (`trendFloor`)
- fast 5m cover (`fastCover5m`)
- O2's trend gate (`revTrendGate`)
- the 5m veto on O5 (`openGate5m`)

### 1b. Engine-level OPENS (not a candle signal)

| ID | Mechanism (decision `action`) | What it does | Families |
|---|---|---|---|
| **E1** | Open fallback (`open-fallback`) | "Always place on a signal". If no placement can be priced (every one over the cap, or the quotes refused), it places anyway: short strike nearest the underlying, starting at the low end of a known-good band and walking to the high end. At 09:30 the band is bull 0.50–0.55 × W and bear 0.47–0.52 × W; after that, the variant's own band, 0.45 × W up to its walk cap. Active until 15:55. | all |
| **E2** | Reopen after a quick cover (`reopenAfterCover`) | When an open's cover fills **inside the same 15m signal window**, the underlying is still between its strikes, and the decision still wants that side: re-open at the same strikes, never above the price paid. At most 2 per 5m bar; every open gate still applies. | v7 (**-10 only**), v8, v9, v9sg, v9ob |
| **E3** | Natural REV (`natural-rev`) | Opens the **other** side when the book's bias side has touched an outer band (NDX RTH 5m or NQ 60m), its last open is ≤ 30 min old, and the zigzag run (20-pt, NDX 1m) is ≥ 40 pts (60 without a band/EMA line at the extreme). It's struck at the paired position's short strike, with pair + REV ≤ 1.15 × W. A filled REV marks its pair offset. | v12, v13 |
| **E4** | Natural jump guard (`natural-guard`) | If the book's mark at spot ± the 15-minute p95 move would go through −lossMax, it opens the protective vertical. | v12, v13 |

### 1c. Gates that BLOCK an open

Checked after the signal decides to open. The first gate that refuses records its `open-skip-*` decision.

| ID | Gate (decision) | Refuses an open when | Families |
|---|---|---|---|
| **B1** | Tradability | There's no live-quote evidence of a market, so the whole tick is skipped (this covers holidays, half-days and halts alike) | all |
| **B2** | Control halt / no-open (`open-skip-control`) | Operator control file says halt or no-open; covers and hedges keep running | all (per variant) |
| **B3** | Open trend block (`open-skip-trend-block`) | The open is **against trend "A"**. Trend A = the 15m structural trend AND the last completed hourly candle agreeing; neutral (blocks nothing) when they disagree. Applies to **any** open, first or add. | v9ob |
| **B4** | Natural ADD gate (`open-skip-natural-add`) | An add (the side already holds a live position) without the NQ 15m candle at its outer band, or more than 3 adds on a side | v12, v13 |
| **B5** | Cover-to-open wait (`open-skip` c2o) | An open on a side that holds an **underwater** uncovered position. That side's cover escalates to the give-up price and the open waits. | v6, v7, v8, v12, v13 |
| **B6** | Stack gate (`open-skip-stack-gate`) | An **add** (that side already holds an uncovered position, or has a working open) while the NQ 15m **or** 60m read points against the side. The read is the 5m close vs that timeframe's 9 EMA, confirmed by the candle's own close vs that EMA. First opens are never gated. | v9sg |
| **B7** | Stance conflict (`open-skip-conflict`) | An open opposite the held stance | v0–v6, v8, v12, v13 |
| **B8** | Leg uniqueness (`open-skip-leg`) | No placement whose legs don't trade an existing leg the wrong way, or a credit twin that's unquotable | all |
| **B9** | Ceiling (`open-skip-ceiling`) | Every placement prices over the cap. G uses 0.55 / 0.575 / 0.5875 × W; cATM uses 0.65. E1 then takes over. | all |
| **B10** | Day-loss governor (`open-skip-governor`) | The projected book floor *with this open* would be below −lossMax. Caps: 10W 2,000 · 20W 4,500 · 40W 7,500; some cATM / older shapes differ, see the roster. | every governed shape (not `-unc`) |
| **B11** | Late-day guard (`open-skip-late`) | From 15:00: if the 15:00 floor was ≥ 0, an open that would take it below 0. A 15:00 floor below 0 sets no limit. | v0–v13, **including `-unc`** |
| **B12** | One working open (`open-skip-pending`) | Another open from the same run is still resting | all |

### 1d. COVER triggers

**How covers actually happen.** The continuous cover (C1) rests a cover on every filled position within 30 s of the
fill, so by the time a candle signal says "cover", the position almost always has one working already. The signal
covers (C3) and proactive covers (C4) skip any position with a cover working. On every family except v3, a signal
cover therefore mostly just **cancels a working open of that side and clears the stance**. The covers that actually
fill are C1's, worked by C5–C8.

| ID | Trigger (decision `action`) | Exact condition / price | Families |
|---|---|---|---|
| **C1** | Continuous cover (`continuous`) | Every filled position with no cover rests one at `W − openCost − minLock × W`, placed on the fill (30 s worker) and re-checked every tick. **minLock:** 10W = 0.10 on v0–v3 and 0.05 on v4+ (plateau, C9); 20W/40W = 0.20. **Geometry:** v0/v3 tent (shares the short strike); v1 halfway to the underlying; v2 at the underlying; v4+ 10W offset1 (C9); 20W/40W chosen from a strike range (C10). | v0–v9, v9sg, v9ob, v13 (**v13: only ≥ 30 min after the fill**, C13) |
| **C2** | Risk-armed continuous | v3 only. C1 waits until the book floor ≤ −0.20 × lossTarget, or the cover would lock ≥ 1.0 × its own cost (`-unc`: only the latter) | v3 |
| **C3** | Signal cover | The signal's cover side: O1's classic cover (held bull + red 15m that **failed** to make a new high; mirror); O2/O3 against the held side; **active cover** (held bull, close above the 15m midline, ≥ 3-TF cluster ≤ 8 pts above; mirror); O7; O8's 5m early cover. Places a break-even cover only on a filled position with **no** cover working (see note above). | v0–v9, v9sg, v9ob (evaluated on v12/v13 but never places, C14) |
| **C4** | Proactive cover (`proactive-deep-itm`) | At a candle close, a position marking ≥ 0.80 × W with no cover working rests at break-even | v8, v9, v9sg, v9ob |
| **C5** | Cover ladder (`cover-reprice`) | Every tick and every 30 s: limit = lock target + steps × $0.05. A step is earned per 120 s or per 10 NDX pts moved (either direction) since placement. Capped at break-even and at the mark; never moves down. | every family with covers |
| **C6** | Give-up (`cover-giveup`) | NDX ≥ 20 pts back through the position's own short strike → price = min(mark + 1 tick, W − openCost + allowance × W), allowance 10W 5% · 20W 7.5% · 40W 10%. Never lowered; supersedes the ladder and stall. 20W/40W first move the cover **inside** the open spread (cheapest legal cover); 10W v4+ moves it back to the tent. | every family with covers |
| **C7** | Stall cover (`cover-stall`) | ≥ 15 min since the fill AND NDX on the **losing** side of the fill-time NDX → price min(break-even, mark + 1 tick), if above the working price | every family with covers |
| **C8** | Late-day / governor cover deferral | A cover fill that would take the floor through −lossMax is declined (sim) or pulled (broker). From 15:00, if the 15:00 floor was ≥ 0, one that takes it below 0 is also declined or pulled. | governed shapes |
| **C9** | Plateau cover (10W) | Cover geometry `offset1` (a condor plateau instead of a tent peak), minLock 0.05, give-up returns the cover to the tent. The settled default for every 10W strategy from v4 up. | v4+ at 10W (incl. `-unc`) |
| **C10** | Cover range re-strike (`cover-restrike`) | 20W/40W: every 5 min a resting cover moves to whichever strike in a range is closest to filling at the tent-equivalent price + k × 0.02 × W. The range runs from one strike inside the open's long leg to 2 beyond the tent. | 20W/40W, every family with covers |
| **C11** | Credit-cover thermostat | Sends the cover as a **credit** spread (collapsing the pair to a butterfly and releasing capital) once cash deployed ≥ the trigger (scaled by width), and debits below it. Same P&L, less capital. | v0–v9, v9sg, v9ob, v12, v13 |
| **C12** | Cover-to-stack (`cover-to-stack`) | **Configured but never fires live.** It runs only when a soft, hard or risk cap blocks an open, and all three are off on every variant (v8's soft cap was removed 2026-10-14). When it does run, it locks the deepest winners (≥ 0.65 × W) to make room. The **backtest** also runs it when the *governor* would block an open; live does not. See Part 3. | configured v0–v13; fires nowhere live |
| **C13** | Cover after 30 min | C1 only on a position ≥ 30 min since its fill, not offset by a REV, and not a guard | v13 |
| **C14** | Natural cover (no per-position covers) | No continuous, signal, proactive or cover-to-stack cover; the book is protected by E3/E4 opens instead. v13 adds C13 back. | v12 (all), v13 (all but C13) |
| — | Opens-only | No covers of any kind; every position is held to the 16:00 NDX settle | v20, v21 |

### 1e. HEDGES and order working

| ID | Mechanism | What it does | Families |
|---|---|---|---|
| **H1** | Floor raise (`raise`) | At a candle close, at most once per 15 min and ≤ 8 a day: buys the best floor lift per dollar in the 2σ band, spreads first. Minimum lift per dollar: **4:1 near / 8:1 far** from the money. Under trend A, a valley on the side the trend is heading toward needs **3:1 / 6:1**, and one on the side it is leaving needs **5:1 / 10:1**. Flies and condors may only use strikes inside the book's range. It never takes a floor ≥ 0 below 0, and never goes past −lossMax or the late-day limit. | v0–v13 |
| **H2** | Floor offsets (`offset`) | Floor < −lossTarget → a far-side 20/40/60-wide at ≥ 3:1, ≤ 6 a day. Floor < −lossMax → must-fix at ≥ 1:1, ≤ 18 a day. | v0–v13 governed shapes |
| **H3** | Wings (`wing`) | Book peak > 0 → a wing at ≥ 3:1, budget 10% of the peak, ≤ 6 a day | v0–v13 |
| **M1** | Open ladder (`open-reprice`) | A resting open walks placement + steps × $0.05 (per 120 s or 10 pts) up to its walk cap, never above the debit mark; refused if it would push the floor through lossMax | all |
| **M2** | Open re-strike (`open-restrike`) | An open at its walk cap for 10 min without a fill is cancelled. It doesn't re-open by itself; a new open needs the signal to fire again. | all |
| **M3** | Cancel on reversal (`cancel-open`) | The signal turns to the other side, or covers this side → the working open is cancelled | all |
| **M4** | Strike placement | **G** (`adaptiveGeo`): the most in-the-money placement still under the cap, at most 3 strikes ITM and never fully OTM. **cATM**: centred at the money. **v21**: the vertical priced closest to f × W (`openPriceTarget`). | G: all governed + `-unc`; cATM: `-cATM`; price-target: v21 |

**Simulated fills** (every run except a real-money broker run) book **at the limit, never better**. A fill needs the
mark at or through the price on a **later, distinct** chain observation than the one that placed it, and the mark
must pass the structural, parity, chain-monotonic and too-cheap checks. Quoted bid/ask width is **not** a gate; it was
removed 2026-11-04 in `a6bfb3d` because 0DTE NDX fills at the mid through wide quotes.

---

## Part 2 — strategy × signal table

**Legend:**
- **✓** — on for every shape of the family
- **gov** — governed shapes only (not `-unc`)
- **10W / 20·40W** — only that width
- **eval** — evaluated (shows in the trace) but never places an order
- **◌** — configured but never fires live (see C12)
- **·** — not used

Rows O\*, C3 and the reason column come from the 2026-11-04 traces; every other row is generated from the live roster.

### Opens and open gates

| | v0 | v1 | v2 | v3 | v4 | v5 | v6 | v7 | v8 | v9 | v9sg | v9ob | v12 | v13 | v20 | v21 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| O1 classic breakout | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | · | · | · | · | · | · | · |
| O2 overextension | · | · | · | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| O3 grind | · | · | · | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| O5 trend continuation | · | · | · | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| O7 trend flip | · | · | · | · | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| O8 5m + 15m flip | · | · | · | · | · | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| O9 be-wrong | · | · | · | · | · | · | · | ✓ | · | ✓ | ✓ | ✓ | · | · | · | · |
| O13 BB fade | · | · | · | · | · | · | · | · | · | · | · | · | · | · | ✓ | ✓ |
| E1 open fallback | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| E2 reopen after cover | · | · | · | · | · | · | · | v7-10 only | ✓ | ✓ | ✓ | ✓ | · | · | · | · |
| E3 natural REV | · | · | · | · | · | · | · | · | · | · | · | · | ✓ | ✓ | · | · |
| E4 jump guard | · | · | · | · | · | · | · | · | · | · | · | · | ✓ | ✓ | · | · |
| B3 open trend block | · | · | · | · | · | · | · | · | · | · | · | ✓ | · | · | · | · |
| B4 natural ADD gate | · | · | · | · | · | · | · | · | · | · | · | · | ✓ | ✓ | · | · |
| B5 cover-to-open wait | · | · | · | · | · | · | ✓ | ✓ | ✓ | · | · | · | ✓ | ✓ | · | · |
| B6 stack gate | · | · | · | · | · | · | · | · | · | · | ✓ | · | · | · | · | · |
| B7 stance conflict (not bidirectional) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · | · | ✓ | ✓ | · | · |
| B10 day-loss governor | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov |
| B11 late-day guard | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| M4 strike placement | G | G | G | G | G | G | G | G | G | G | G | G | G | G | G | f × W |

B1, B2, B8, B9, B12 and M1–M3 apply to every family. Every family except v21 has `-cATM` centred twins at 20W and 40W.

### Covers and hedges

| | v0 | v1 | v2 | v3 | v4 | v5 | v6 | v7 | v8 | v9 | v9sg | v9ob | v12 | v13 | v20 | v21 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 continuous cover | ✓ | ✓ | ✓ | armed | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ≥ 30 min | · | · |
| C1 geometry at 10W | tent | halfway | at-money | tent | offset1 | offset1 | offset1 | offset1 | offset1 | offset1 | offset1 | offset1 | — | offset1 | — | — |
| C1 minLock at 10W / 20·40W | .10/.20 | .10/.20 | .10/.20 | .10/.20 | .05/.20 | .05/.20 | .05/.20 | .05/.20 | .05/.20 | .05/.20 | .05/.20 | .05/.20 | — | .05/.20 | — | — |
| C3 classic signal cover | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | · | · | · | · | · | · | · |
| C3 overext / grind / active cover | · | · | · | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | eval | eval | · | · |
| C3 trend-flip cover | · | · | · | · | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | eval | eval | · | · |
| C3 5m early cover | · | · | · | · | · | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | eval | eval | · | · |
| C4 proactive 0.80 × W | · | · | · | · | · | · | · | · | ✓ | ✓ | ✓ | ✓ | · | · | · | · |
| C5 cover ladder | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · |
| C6 give-up (20 pts) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · |
| C7 stall cover (15 min) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · |
| C8 governor / late cover deferral | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | · | gov | · | · |
| C9 plateau cover | · | · | · | · | 10W | 10W | 10W | 10W | 10W | 10W | 10W | 10W | · | 10W | · | · |
| C10 cover range re-strike | 20·40W | 20·40W | 20·40W | 20·40W | 20·40W | 20·40W | 20·40W | 20·40W | 20·40W | 20·40W | 20·40W | 20·40W | · | 20·40W | · | · |
| C11 credit-cover thermostat | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| C12 cover-to-stack | ◌ | ◌ | ◌ | ◌ | ◌ | ◌ | ◌ | ◌ | ◌ | ◌ | ◌ | ◌ | · | · | · | · |
| H1 floor raise | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| H2 floor offsets | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | gov | · | · |
| H3 wings | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| Simulate-only (can never be armed) | · | · | · | · | · | · | · | · | · | · | · | · | ✓ | ✓ | ✓ | ✓ |

**Notes on the table:**
- **v12** has continuous cover, ladder, give-up and stall *configured* in the roster, but natural cover makes
  `placeContinuousCovers` a no-op, so there are no per-position covers to work. The table shows what actually runs.
- **v13** places C1 only once a position is 30 min old, and never on a REV-offset position or a guard. Signal and
  proactive covers stay off.
- **C11 on v12** applies to the covers it never places; it only matters for v13.

### What fired on 2026-11-04 (live traces, all shapes of the family summed)

The number of candles on which each trigger's **condition was met** (the trace's `active` flag). When several are
met on one candle, only the first in the 1a order acts, so these are not order counts. This is one
trend-up-then-down day and shows *activity*, not quality:

| | O1 | O2 | O3 | O5 | O7 | O8 / 5m turn | O9 | O13 | E3 REV |
|---|---|---|---|---|---|---|---|---|---|
| v0–v3 (each) | 192 | · | · | · | · | · | · | · | · |
| v4 | · | 152 | 16 | 16 | · | · | · | · | · |
| v5 | · | 152 | 16 | 68 | 65 | · | · | · | · |
| v6 | · | 152 | 16 | 104 | 0 | 74 | · | · | · |
| v7 | · | 152 | 16 | 38 | 101 | 244 | 43 | · | · |
| v8 | · | 152 | 16 | 104 | 0 | 74 | · | · | · |
| v9 | · | 152 | 16 | 29 | 120 | 278 | 50 | · | · |
| v9sg | · | 152 | 16 | 31 | 115 | 267 | 46 | · | · |
| v9ob | · | 152 | 16 | 41 | 99 | 233 | 44 | · | · |
| v12 | · | 152 | 16 | 104 | 0 | 44 | · | · | 6 |
| v13 | · | 152 | 16 | 103 | 1 | 59 | · | · | 9 |
| v20 | · | · | · | · | · | · | · | 80 | · |
| v21 | · | · | · | · | · | · | · | 144 | · |

Each count sums bull + bear across the family's shapes (8 per family; 10 for v20, 18 for v21). O8 counts
both "turn" triggers (flip or early cover). v20/v21 fired only on the eight 5m candles from 09:45 to 10:20 (every
shape), then never again: the closest later miss was 10:25, 55 pts inside the higher upper band.

---

## Part 3 — live vs backtest, and known gaps

1. **Cover-to-stack on a governor block — backtest only.** The backtest (`backtest-v6-5m.js`, `opts-for.js` sets
   `coverToStackVsRisk`) locks deep winners (≥ 0.65 × W) when the governor would block an open, then opens. Live
   (`trader.js capState` → `coverToStackFreeBudget`) only reacts to soft/hard/risk caps, which are all off, so a
   governor block is just `open-skip-governor`. The backtest's lock (`lockDeepWinners`) takes only winners with
   **no cover working**, and continuous covers rest on nearly every position, so the difference rarely bites. It
   can bite on v3 (positions not yet armed) or wherever a continuous cover failed to place. Not measured; flagged
   2026-11-05.
2. **Signal covers are mostly starved** (see the note in 1d). C3 and C4 skip any position that already has a cover
   working; on every family but v3, C1 has nearly always placed one.
3. **"Held" is a stance on v0–v6, v8, v12, v13.** It's set by every open (even before it fills) and cleared only by a
   signal cover. On a fully covered book these families still "hold" the last side, so an opposite open is refused
   (B7) until a signal cover clears it. The backtest uses the same stance, so this is consistent, not a live-only bug.
4. **The breakout rules test the HIGH, not the close** (O1 and the off-by-default O11).
5. **Stall cover = currently losing**, not "no favourable move" (C7): a position that rallied and came back to +0
   never fires.
6. **Ladders step on movement in either direction** (C5, M1): a favourable 10-pt move raises the price exactly as an
   adverse one does.
7. **Re-strike doesn't re-strike** (M2): it only cancels; the next open needs a fresh signal.
8. **Reopen after cover (E2) is live-only.** `opts-for.js` / `backtest-v6-5m.js` have no reopen, so the baselines
   for v7-10 and every v8 / v9 / v9sg / v9ob variant do not model it. Its effect can only be read from live sessions.
9. **v9sg / v9ob are not simulate-only.** The `FEATURE_FAMILIES` comment and the experiments log say "never armed",
   but neither carries `simulateOnly`, so `armableReason` would accept their capped shapes if
   `CANDLE_SPREAD_ARMED` named one. Nothing arms them today.
10. **Removed 2026-11-04:** the simulated-fill quoted-width gate (`simMaxQuoteWidthFrac`). It refused every 10W fill
   on a wide-quote day. The backtest never used it.

---

## Changelog

- **2026-11-05** — Created. Replaces the README's 2026-10-12 "Trigger catalog" and extends it to v9sg, v9ob, v12,
  v13, v20 and v21, with the engine-level opens (E1–E4), the new gates (B3–B6), the plateau/range/credit cover
  mechanics, and the generated strategy × signal table. Corrections vs that edition: v8's proactive cover is 0.80
  (was 0.70) and its soft cap is gone (10/14); cover-to-stack therefore fires on no live variant.
