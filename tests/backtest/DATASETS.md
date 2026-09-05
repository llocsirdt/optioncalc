# Candle-spread backtest datasets — which one matches live, and which don't

The live engine **signals off /NQ over the full 24h session** (`signalSymbol:'/NQ'`, `signalRth:false` —
overnight NQ acts as real support/resistance) and **prices and settles options on cash NDX**
(`symbol:'NDX'`). A dataset only reproduces the live strategy if it carries **both** series.

| dataset | days | signal | pricing | matches live? |
|---|---|---|---|---|
| `backtest-data-5m-nq` | 922 (2022-12-27 … 2025-12-11) | NQ 24h ✅ | **NQ** ❌ | signal right, prices options off the wrong instrument |
| **`backtest-data-5m-nq-ndx`** | **34 (2026-07-20 … 2026-09-04)** | **NQ 24h ✅** | **NDX ✅** | **yes — this is the faithful one** |

Bars in the dual set carry both: `analysis` is the NQ multi-timeframe snapshot, `px` is the NDX OHLC at
the same 5m mark. Drive the engine with `opts.priceOf = b => b.px`; without that it silently prices off the
signal series and you are back to the NQ-only case.

## Why the other two still exist

`backtest-data-5m-nq` is the **statistical** base — 922 days is the only sample large enough to say a
strategy change is real rather than noise, and the whole v4→v9 lineage was validated on it. Its numbers are
NQ-priced, so treat them as relative comparisons between variants, never as dollar expectations for the
live NDX book. Do not mix its totals with NDX totals.

`backtest-data-5m-ndx` is for **pricing realism** on real NDX option economics across a longer 2026 window
than the dual set reaches (it goes back to January; NQ capture only starts 2026-07-20). Its *signals* are
not the live signals, so it answers "how do these strike/cover mechanics behave on real NDX pricing", not
"what would the live engine have done".

## Coverage gaps

NDX raw 1m starts 2026-07-06 and the Jan–Apr set came from an earlier capture, so `-ndx` has a gap from
2026-04-13 to 2026-07-08 (plus a short one in late March). NQ raw 1m only starts 2026-07-20, which is what
bounds the dual set to 34 days.

Rebuild: `node scripts/candle-spread/build-dual-dataset.js` (dual) ·
`node scripts/candle-spread/build-analysis-dataset.js NDX --step 5 --out <dir>` (NDX-only).
