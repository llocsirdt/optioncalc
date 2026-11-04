# Sim fill audit + new-rule re-score — NDX 0DTE, 2026-10-05 … 10-16 (10 days × 80 variants)

Same method as `../fill-audit-2026-10-16/summary.md`:
- fair (DERIVED) = the nearest 5m `chainSnapshot`, parity blend weighted by inverse spread, shifted for the 1m-NDX move;
- tolerance = max($0.25, 5% W).

Sources:
- 10/07–10/16: prod API, with cache-busters.
- 10/05 and 10/06: the prod API returns 404 and the runs list omits them, so these came from the local prod mirror `candle-spread-archive/`.

Read-only. No engine changes, no commits.

## Data health
| day | sim fill model in force [atLimit, thruTicks, widthGate, openMinLooks] | notes |
|---|---|---|
| 10/05 | none of the gates (fills at mark+tick, not at the limit) | archive copy; credit `markLow` is in the pre-fix convention (positive, debit-canonical), handled |
| 10/06–07 | [–, 1, –, 2] | archive copy for 10/06; 10/07 from the API |
| 10/08 | [atLimit, 1, –, 2] | 567 fills unpriced (the most of any day; legs outside ±80) |
| 10/09–16 | [atLimit, 1, 1, 2] | — |

All days:
- 80/80 variants, EOD settlement present everywhere, 17-strike snapshots (±80) at every 5m bar.
- Before 10/14 there is no 09:30 snapshot (they start at 09:35).
- 3,064 of 23,674 fills (13%) have a leg outside the window and cannot be priced.
- 5–32 fills/day lack the fill quote or the `atOrThrough` field.
- No per-leg quote exists at the 30s looks, so quote age (rule e) cannot be evaluated.

## 1. Two-week audit
| day | fills (O/C/H) | open cheap/rich | open $ cheap / rich | cover cheap (both snaps) / rich | cover $ cheap / rich | credit cover < debit mid | impossible hedge marks | claimed | fair-restated |
|---|---|---|---|---|---|---|---|---|---|
| 10/05 | 991/687/54 | 203/7 | 29,544 / 1,274 | 199 (142) / 4 | 36,123 / 541 | 0 | 10 | −58,392 | −124,059 |
| 10/06 | 1145/696/76 | 70/52 | 11,692 / 9,854 | 369 (291) / 0 | 75,919 / 0 | 167 | 4 | −125,115 | −212,726 |
| 10/07 | 882/588/415 | 64/19 | 9,165 / 3,601 | 250 (219) / 1 | 46,283 / 204 | 112 | 5 | −234,459 | −289,907 |
| 10/08 | 988/772/627 | 47/36 | 6,706 / 6,194 | 173 (159) / 20 | 31,733 / 3,833 | 38 | 30 | −173,253 | −211,692 |
| 10/09 | 1175/848/502 | 61/85 | 7,026 / 18,351 | 190 (152) / 35 | 33,638 / 4,747 | 124 | 11 | +101,460 | +59,771 |
| 10/12 | 1149/828/707 | 91/52 | 13,650 / 9,474 | 168 (103) / 39 | 28,818 / 5,686 | 114 | 41 | +453,847 | +410,699 |
| 10/13 | 1117/945/670 | 122/59 | 20,920 / 13,466 | 112 (98) / 96 | 19,535 / 21,062 | 122 | 15 | +159,179 | +118,724 |
| 10/14 | 1281/1137/543 | 45/66 | 7,682 / 17,025 | 65 (45) / 114 | 9,390 / 25,042 | 73 | 7 | −127,862 | −145,465 |
| 10/15 | 1221/1076/368 | 58/101 | 7,972 / 18,343 | 162 (125) / 27 | 26,895 / 8,221 | 97 | 37 | −111,903 | −146,770 |
| 10/16 | 1073/861/252 | 52/71 | 8,434 / 14,100 | 94 (61) / 27 | 16,804 / 5,121 | 68 | 41 | −186,284 | −211,972 |
| **total** | **11,022/8,438/4,214** | **813/548** | **122,791 / 111,682** | **1,782 (1,395) / 363** | **325,138 / 74,457** | **915** | **201** | **−302,782** | **−753,397** |

Fair-restated = every cheap fill re-priced at fair. Opens and the rich tail are left as booked, so this is the pessimistic side.
- Covers: the cheap tail is 4.9× the rich tail by count and 4.4× by dollars. Net $250,681 of cover fills sit beyond tolerance below fair.
- Opens: net roughly neutral ($123k cheap vs $112k rich). Exception: 10/05, when fills booked at the mid (203 cheap vs 7 rich).
- 10/13 and 10/14 are the only days where covers are not clearly cheap.

### The pattern repeats every day
Cover classes over the two weeks (n / cheap / rich). Of the cheap covers, 1,674 of 1,782 (94%) filled on the only at-or-through look (`atOrThrough=1`).
| class | n | cheap | rich |
|---|---|---|---|
| 20W debit, > 30 pts ITM | 397 | **326** | **0** |
| 20W debit, 10–30 ITM | 413 | 211 | 7 |
| 10W debit, 10–30 ITM | 184 | 91 | 0 |
| 40W debit, > 30 ITM | 140 | 47 | 0 |
| 10W debit, > 30 ITM | 73 | 44 | 0 |
| 20W credit (sold twin deep ITM) | 831 | 368 | 88 |
| 10W debit OTM | 424 | 39 | 20 |

20W debit > 30 ITM, by day (n/cheap/rich):
- 10/05 8/8/0, 10/06 61/52/0, 10/07 60/59/0, 10/08 90/74/0, 10/09 51/46/0;
- 10/12 16/11/0, 10/13 13/13/0, 10/14 21/16/0, 10/15 47/18/0, 10/16 30/29/0.

Negative/impossible fly or condor raise marks occur every day: 4–41 per day, 201 in total.

Top movers, claimed → fair-restated, summed over 10 days. Every one is a 20W variant:
- v9-20-unc +13,959 → −1,351
- v6-20-unc / v8-20-unc +622 → −13,389
- v7-20-unc +9,099 → −4,810
- v6-20 +7,676 → −5,852
- v7-20-cATM +22,920 → +10,423
- v9-20-cATM +23,375 → +11,111
- v9-20 +1,859 → −10,433
- v5-20-unc +3,663 → −8,559

Least affected are the 40W-cATM variants (−$0.9k to −1.1k). v7-10: −7,312 → −7,807.

## 2. Re-score under the new rules
How each rule was evaluated from the record:
- (a) is approximated as `atOrThrough < 2` = refused, the only form the counts allow. It is not a faithful test:
  - a sim cover books on the first look at or through its price, so 89% of covers and ~99% of hedges carry `atOrThrough = 1` by construction;
  - the look after a fill is never recorded.
- (b) has two parts:
  - the ITM floor (midpoint ≥ 10 pts ITM and mark < 40% W) uses the recorded mark at the fill look;
  - sibling ordering is evaluated only when the fill happened on the same fetch as a snapshot (|gap| ≤ 5s).
- (c) "twin unquoted" cannot be told apart from "not recorded". The parity test uses the recorded debit-leg mid against the booked fill.
- (d) is applied as stated.
- (e) cannot be evaluated: no quote timestamps are stored at the looks.

A refused order keeps working. "Later fill" means a later 5m snapshot where both the raw recorded mid and the parity fair reach the limit; it books at the limit. Two variants:
- lenient: fair within tolerance of the limit is enough, standing in for the ladder walking up;
- strict: the condition above. Hedges get a 10-minute TTL.

Otherwise the position settles uncovered at the official close (hedge: removed). Path effects on later orders are not modelled.

**10/16, totals across 80 variants:**
- claimed −186,284
- fair-restated −211,972
- all rules, strict −182,324
- all rules, lenient −192,134
- (b)+(c)+(d) only −186,974

Fills moved: 765 covers + 252 hedges under (a); only 41 under (b)/(c)/(d), all of them (d).

Distance from the fair restatement, median per variant:
- (b)(c)(d) only: $179
- all rules: $1,015 (strict and lenient alike)
- claimed P&L itself: $129

| 10/16 variant | claimed | fair | all-strict | all-lenient | bcd |
|---|---|---|---|---|---|
| v7-40-cATM | −6,645 | −6,858 | −14,225 | −14,225 | −6,645 |
| v4-40-unc | −11,325 | −11,325 | −18,420 | −16,375 | −11,325 |
| v5-40-cATM | −5,720 | −5,933 | −10,340 | −10,340 | −5,720 |
| v3-40 | −1,750 | −1,750 | +3,595 | +2,810 | −2,650 |
| v0/v1/v2-40-unc | −1,810 | −1,810 | +3,595 | +2,810 | −1,765 |
| v9-20-unc | +1,385 | −842 | +8,130 | +6,925 | +1,490 |

Two weeks, totals: claimed −302,782; fair −753,397; all-strict −1,227,334; all-lenient −819,902; bcd −286,193 (238 fills moved).

**Reading:**
- (b), (c) and (d) as specified barely touch the cheap fills.
  - (c) at a 25% W tolerance refuses 0 of 831 cheap credit covers: their (debit mid − fill)/W runs p50 0.065, p90 0.14. At 5% W it would refuse 478 of 831 cheap covers, but also 437 of 3,676 others.
  - (b)'s 40% ITM floor catches 22 of 751 cheap ITM debit covers: their recorded mark at fill is 47–58% of W. The dips land near W/2, not under 40%.
  - (d) moves only 201 hedge fills.
- Rule (a) is the only rule that targets the dip, but its effect cannot be measured from these records.
  - Its re-score is dominated by which covers end up uncovered on a trending day, which is directional luck: +$73k on 10/14, −$300k on 10/08.
  - It lands nowhere near the fair restatement.
  - To score (a) properly, the engine needs to log the look after the at/through look, or per-look quote timestamps.

## Files
- `per-day.csv`: all counts, $, impossible quotes, the re-score columns, and degraded-data counts.
- `per-variant.csv`: day × variant, giving claimed / fair_restated / rescore_all_rules / rescore_all_lenient / rescore_bcd_only and refused count.
- `flagged.csv`: 3,513 flagged fills (checks, refusal reasons, outcome, position P&L before/after).
