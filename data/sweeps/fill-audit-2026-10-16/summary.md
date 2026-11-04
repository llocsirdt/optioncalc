# Sim fill audit — NDX 0DTE, 2026-10-16 (all 80 prod variants)

Data: prod run records (`/candle-spread/runs/NDX/2026-10-16?variant=…`, fetched 2026-10-17), NDX 1m (`signal-lab-data/raw-1m/NDX-2026-10-16.json`).
Raw records kept in the session scratchpad, not in the repo. No engine code changed.

## What quote data exists (and what does not)
- **The combo quote at the exact fill look is REAL and recorded.** Every `open-fill` / `cover-fill` / `raise-fill` decision carries the structure's
  `mark` (mid), `bid` (natural sell) and `ask` (natural buy), plus the order's best-ever look `markLow/markLowBid/markLowAsk`, `looks`, `atOrThrough`.
  For credit-sent opens these are the credit twin's quote (converted to debit-canonical here as W + mark). For credit-sent covers the recorded
  quote is the DEBIT legs; the twin quote that actually triggered the fill survives only as `markLow`.
- **Per-leg quotes exist only at each 5m bar close**: `candle_close.chainSnapshot`, 17 strikes (±80 pts) around NDX, bid/mid/ask per call and put.
  No per-leg quote is stored for the 30s `resting_work` looks where nearly all fills happen. Median |gap| from fill to nearest snapshot = 97s.
- **431 of 2,186 fills (20%) have a leg outside the ±80 window** (232 raises, 186 covers, 10 opens, 3 hedges) — no fair value can be computed for them.
- The engine's own underlying was stale at the 09:40 snapshot (29,775 vs 1m NDX 29,694); no flagged fill traces to it.

## Method (DERIVED values flagged)
- `fair` (DERIVED): nearest chain snapshot, each leg = inverse-spread-weighted blend of its own mid and its put-call-parity synthetic
  (forward = median K + C − P on that snapshot), then shifted along the strike axis by the 1m-NDX move between snapshot and fill (sticky moneyness).
  Calibration on ~800 non-fill looks: recorded mark − fair has median +0.05, p10 −1.2, p90 +1.3 — fair is unbiased but the recorded mid is noisy.
- Flags (counted): `cheap-vs-fair` (fill < fair − tol, tol = max($0.25, 5% W)); `cheap-vs-BOTH-snapshots` (also cheaper than the shifted fair from the
  snapshot before AND after); `below-recorded-mid` (fill cheaper than the recorded combo mid at the fill look — only possible on credit covers, where
  the twin and the debit legs disagree); `insane-quote-seen` (the order's best look was a mark outside [0, W] — impossible); `below-natural-bid`, `outside-0..W` (none found).
- Info only (not counted): natural width > 50% W (normal on 0DTE NDX); below spot intrinsic (NOT a bound — European 0DTE verticals trade below spot intrinsic all day);
  cheaper than the order's own last-10 marks (confounded by real moves).
- Check 4 (gap-through): with `simFillAtLimit` the sim never gives price improvement, so a gap-through books the limit — conservative, never cheap. Not a source.

## How widespread
| | fills | priced | cheap-vs-fair | of which BOTH snapshots | $ (fill vs fair) | rich tail (fill > fair + tol) |
|---|---|---|---|---|---|---|
| opens | 1,073 | 1,063 | 52 | 41 | −$8,434 | 71 fills, +$14,100 |
| covers | 861 | 675 | 94 | 61 | −$16,804 | 27 fills, +$5,121 |
| raises/hedges | 252 | 17 | 1 (+41 insane-quote) | — | −$450 | — |
| **all** | **2,186** | **1,755** | **147 (64 distinct events)** | **102** | **−$25,688** | |

- Opens are NOT systematically cheap: the rich tail outweighs the cheap tail (fill = limit sits above the mid). Open flags are mostly within estimator noise — low confidence.
- **Covers are systematically cheap.** 94 cheap vs 27 rich. Concentrated in:

| cover class | n | median fill − fair | cheap / rich |
|---|---|---|---|
| 20W DEBIT, structure > 30 pts ITM | 30 | **−2.07** | **29 / 0** |
| 40W DEBIT, > 30 pts ITM | 16 | −1.32 | 5 / 0 |
| 20W CREDIT twin (canonical OTM → the SOLD twin is deep ITM) | 86 | −0.27 | 37 / 7 |
| 10W CREDIT, 10–30 ITM | 11 | −0.58 | 7 / 0 |
| everything ATM/OTM debit | 160 | ~0 | 2 / 4 |

## Root-cause pattern in the data
1. **Transient single-look dips on deep-ITM legs.** 88 of 94 cheap covers filled on the ONLY look that was ever at/through the price (`atOrThrough = 1`).
   The order's recorded mark sits at fair for many looks, drops $3–5 for one 30s look, and is back at fair at the next snapshot. The underlying did not move enough to explain it.
   Signature on 20W: combo quote ≈ 1.0 / 9.6–9.9 / 18.x (mid ≈ W/2) on structures whose fair is 12–14. These are wide, noisy deep-ITM leg quotes.
2. **The fill rule takes the minimum of a noisy series.** Fill = "mid touched the limit on any 30s look"; across 20–60 looks the order is eventually filled
   by the low tail of the quote noise. At fills the recorded mark is 0.37 (opens) / 0.20 (covers) below fair; at non-fill looks it is +0.05.
3. **Credit covers take the better of two inconsistent chains.** 68 credit covers filled cheaper than the recorded mid of the debit legs at the same look,
   because the twin's own (deep-ITM) quote showed a bigger credit. Real market makers price the twin by parity, not its stale mid.
4. **The width gate is too loose to catch it.** `simMaxQuoteWidthFrac = 1` allows a natural width up to 100% W; flagged fills have median natural width 0.71 W (others 0.44 W).
5. **Hedges skip structural sanity.** 41 raise fills (flies/condors) booked off a NEGATIVE mark (e.g. fly mid −1.10, quote −31.9 / 29.7) — impossible quotes.

## Top 10 worst (distinct events; twin variants listed together)
| # | variants | time ET | kind | legs | fill | recorded bid/mid/ask | fair (prev/next snap) | gap s | NDX | prior marks | cheap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | v9-40-unc | 15:55:23 | raise (fly) | +P29170 −2×P29190 +P29210 | 0.95 | −17.7 / 0.10 / 17.9 (markLow −0.15) | 5.45 | 14 | 29,171 | — | $450, insane quote |
| 2 | v9-20, v9-20-unc | 10:42:50 | cover DB | +C29630 −C29650 | 10.00 | 1.0 / 9.85 / 18.7 | 13.71 (13.24/13.71) | −137 | 29,703 | 14.6, 14.7, 14.25, 15.1, 14.75, 15.2, 14.25, 14.75 | $371 (18.6% W) |
| 3 | v5-40, v5-40-unc | 10:42:50 | cover DB | +C29630 −C29670 | 22.60 | 14.2 / 22.4 / 30.6 | 26.23 (25.79/26.23) | −137 | 29,703 | 24.0, 24.95 | $363 — same bad C29630 tick as #2 |
| 4 | v6-20, v6-20-unc, v8-20, v8-20-unc | 14:58:23 | cover DB | +P29190 −P29170 | 10.20 | 1.0 / 9.6 / 18.2 | 13.33 (12.07/13.33) | −106 | 29,136 | 10.95, 10.2, 11.1, 13.85 | $313 ×4 |
| 5 | v4-20-unc | 15:13:53 | cover DB | +P29220 −P29200 | 10.00 | 1.5 / 9.6 / 17.7 | 12.96 (12.6/12.96) | −74 | 29,177 | 16.5 … 14.9, 13.65 | $296 |
| 6 | v7-20, v7-20-unc | 10:26:20 | cover CR | +C29680 −C29700 (sent as put twin, credit 14.60) | 5.40 | 4.6 / 7.7 / 10.8 | 8.29 (8.29/7.57) | 72 | 29,632 | 7.7, 7.7 | $289; debit-leg mid said 7.7 |
| 7 | v0/v1/v2/v3-20-cATM | 11:22:50 | cover CR | +C29500 −C29520 | 6.15 | 2.8 / 8.1 / 13.4 | 8.98 (8.54/8.98) | −136 | 29,466 | 9.7, 9.55 | $283 ×4 |
| 8 | v8-40-cATM | 12:34:23 | open DB | +P29490 −P29450 | 19.50 | 11.6 / 19.5 / 27.4 | 22.26 (23.69/22.26) | −44 | 29,437 | 19.5, 20.4 | $276 (low confidence: open) |
| 9 | v5-20-cATM | 15:13:53 | cover DB | +P29230 −P29210 | 10.65 | 1.1 / 9.95 / 18.8 | 13.38 (12.74/13.38) | −74 | 29,177 | 16.8, 16, 14.9, 17, 13.75, 13.4, 11.1, 14.9 | $273 |
| 10 | v9-40-cATM | 12:17:51 | cover DB | +C29410 −C29450 | 24.80 | 15.1 / 24.2 / 33.3 | 27.45 (27.55/27.45) | −135 | 29,483 | 26.95, 30.5 | $265 |

Notes: #2: NDX 10:42 bar range 29,684–29,707. A 20-pt dip moves a 53–73-pt-ITM 20W call vertical by about $1, not $4.90; the raw snapshot mid was 16.10 again at 10:45.
#4/#5/#9: the recorded mid fell from 11–17 to ≈ 9.6 for one look. The natural quote (≈1 / 18) is the deep-ITM puts' wide market.

## Restated 10/16 P&L
Method: each `cheap-vs-fair` fill re-priced at the DERIVED fair (P&L −(fair − fill) × 100). Each insane-quote raise with no fair value is treated as
NOT FILLED (its settled P&L is removed). Every other fill is unchanged; path effects (a later order that would not have happened) are not modelled.
Second column: every priced fill moved to fair in both directions.
Totals across 80 variants: claimed −$186,284 → restated −$210,282 (−$23,998 = −$25,688 cheap fills + $1,690 from removing losing insane-quote raises); all-to-fair −$191,472.
v7-10 (paper): 18 fills, 0 flagged, −$139 unchanged.

| variant | fills | flagged | claimed | adj | restated (flagged->fair) | restated (all priced->fair) |
|---|---|---|---|---|---|---|
| v0-10 | 18 | 2 | 0 | -1595 | -122 | -1717 |
| v0-10-unc | 18 | 2 | 0 | -1595 | -124 | -1719 |
| v0-20 | 22 | 2 | 0 | -2840 | -16 | -2856 |
| v0-20-cATM | 31 | 5 | 0 | -635 | -651 | -1286 |
| v0-20-unc | 33 | 3 | 0 | -355 | 130 | -225 |
| v0-40 | 23 | 3 | 0 | -4040 | 90 | -3950 |
| v0-40-cATM | 17 | 0 | 0 | -6230 | 0 | -6230 |
| v0-40-unc | 28 | 2 | 0 | -1810 | 45 | -1765 |
| v1-10 | 16 | 1 | 0 | -615 | 115 | -500 |
| v1-10-unc | 18 | 2 | 0 | -520 | 47 | -473 |
| v1-20 | 22 | 3 | 0 | -1635 | -458 | -2093 |
| v1-20-cATM | 31 | 5 | 0 | -635 | -651 | -1286 |
| v1-20-unc | 33 | 3 | 0 | -355 | 130 | -225 |
| v1-40 | 23 | 3 | 0 | -4040 | 90 | -3950 |
| v1-40-cATM | 17 | 0 | 0 | -6230 | 0 | -6230 |
| v1-40-unc | 28 | 2 | 0 | -1810 | 45 | -1765 |
| v2-10 | 18 | 1 | 0 | 265 | -67 | 198 |
| v2-10-unc | 18 | 2 | 0 | 285 | 2 | 287 |
| v2-20 | 23 | 3 | 0 | -1640 | -337 | -1977 |
| v2-20-cATM | 31 | 5 | 0 | -635 | -651 | -1286 |
| v2-20-unc | 33 | 3 | 0 | -355 | 130 | -225 |
| v2-40 | 23 | 3 | 0 | -4040 | 90 | -3950 |
| v2-40-cATM | 17 | 0 | 0 | -6230 | 0 | -6230 |
| v2-40-unc | 28 | 2 | 0 | -1810 | 45 | -1765 |
| v3-10 | 18 | 2 | 0 | -1595 | -124 | -1719 |
| v3-10-unc | 19 | 1 | 0 | -1600 | -68 | -1668 |
| v3-20 | 23 | 3 | 0 | -1680 | -337 | -2017 |
| v3-20-cATM | 31 | 5 | 0 | -635 | -651 | -1286 |
| v3-20-unc | 29 | 2 | 0 | -2465 | -234 | -2699 |
| v3-40 | 29 | 3 | 0 | -1750 | 45 | -1705 |
| v3-40-cATM | 17 | 0 | 0 | -6230 | 0 | -6230 |
| v3-40-unc | 28 | 2 | 0 | -3950 | 100 | -3850 |
| v4-10 | 8 | 0 | 0 | -1800 | 0 | -1800 |
| v4-10-unc | 16 | 1 | 0 | -2275 | -145 | -2420 |
| v4-20 | 8 | 2 | 0 | -4245 | -403 | -4648 |
| v4-20-cATM | 14 | 2 | 0 | -3675 | -429 | -4104 |
| v4-20-unc | 24 | 6 | 0 | -5870 | -1202 | -7072 |
| v4-40 | 14 | 0 | 0 | -5210 | 0 | -5210 |
| v4-40-cATM | 15 | 1 | 0 | -7330 | -202 | -7532 |
| v4-40-unc | 27 | 0 | 0 | -11325 | 0 | -11325 |
| v5-10 | 16 | 1 | 0 | -1790 | -73 | -1863 |
| v5-10-unc | 19 | 1 | 0 | -3345 | -73 | -3418 |
| v5-20 | 31 | 4 | 0 | -1290 | -507 | -1797 |
| v5-20-cATM | 46 | 6 | 0 | 75 | -1083 | -1008 |
| v5-20-unc | 36 | 5 | 0 | -1080 | -647 | -1727 |
| v5-40 | 40 | 6 | 0 | -5620 | -123 | -5743 |
| v5-40-cATM | 30 | 1 | 0 | -5720 | -213 | -5933 |
| v5-40-unc | 41 | 6 | 0 | -7870 | -407 | -8277 |
| v6-10 | 11 | 2 | 0 | -835 | -127 | -962 |
| v6-10-unc | 11 | 2 | 0 | -835 | -127 | -962 |
| v6-20 | 41 | 8 | 0 | -1210 | -1527 | -2737 |
| v6-20-cATM | 15 | 1 | 0 | -3215 | 0 | -3215 |
| v6-20-unc | 41 | 8 | 0 | -1210 | -1527 | -2737 |
| v6-40 | 21 | 2 | 0 | -1830 | -221 | -2051 |
| v6-40-cATM | 24 | 0 | 0 | -5715 | 0 | -5715 |
| v6-40-unc | 21 | 2 | 0 | -1910 | -222 | -2132 |
| v7-10 | 18 | 0 | 0 | -139 | 0 | -139 |
| v7-10-unc | 29 | 2 | 0 | -755 | -139 | -894 |
| v7-20 | 50 | 6 | 0 | -1650 | -985 | -2635 |
| v7-20-cATM | 11 | 0 | 0 | -1835 | 0 | -1835 |
| v7-20-unc | 50 | 6 | 0 | -1650 | -982 | -2632 |
| v7-40 | 36 | 1 | 0 | 125 | 0 | 125 |
| v7-40-cATM | 52 | 1 | 0 | -6645 | -213 | -6858 |
| v7-40-unc | 46 | 2 | 0 | 2225 | -210 | 2015 |
| v8-10 | 11 | 2 | 0 | -835 | -127 | -962 |
| v8-10-unc | 11 | 2 | 0 | -835 | -127 | -962 |
| v8-20 | 41 | 8 | 0 | -1210 | -1527 | -2737 |
| v8-20-cATM | 19 | 1 | 0 | -3475 | 0 | -3475 |
| v8-20-unc | 41 | 8 | 0 | -1210 | -1527 | -2737 |
| v8-40 | 21 | 2 | 0 | -1830 | -221 | -2051 |
| v8-40-cATM | 26 | 1 | 0 | -5490 | -276 | -5766 |
| v8-40-unc | 21 | 2 | 0 | -1910 | -222 | -2132 |
| v9-10 | 46 | 4 | 0 | -585 | -311 | -896 |
| v9-10-unc | 37 | 3 | 0 | -530 | -173 | -703 |
| v9-20 | 54 | 5 | 0 | -3145 | -743 | -3888 |
| v9-20-cATM | 11 | 0 | 0 | -1835 | 0 | -1835 |
| v9-20-unc | 84 | 14 | 0 | 1385 | -2122 | -737 |
| v9-40 | 43 | 2 | 0 | 3265 | -265 | 3000 |
| v9-40-cATM | 48 | 2 | 0 | -5460 | -467 | -5927 |
| v9-40-unc | 47 | 3 | 0 | 1875 | -716 | 1159 |

## Files
- `flagged.csv` — the 219 flagged fills (all columns: recorded quote, markLow, looks/atOrThrough, fair + prev/next, gap, NDX, cheap $/%, restated price, method, checks).
- `all-fills.csv` — all 2,186 fills with the same columns.
- `per-variant.csv` — counts per check, claimed / adjusted / restated P&L.
