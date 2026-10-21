# BB FADE v20 / v21 — OPENS ONLY — 821 days 12/27/2022..10/7/2026 (56 NDX-priced 2026 days)

Signal (NQ 24h, every 5m close): close below BOTH the 15m and 60m lower BB(20,2) -> bull; above BOTH uppers -> bear.
Bands = last COMPLETED 15m / 60m bar as of the 5m close (analysis-builder completedAsOf). v20 = v9 strike placement;
v21 = strike whose BS mark is closest to f x W (nearest the money on a tie), walk cap = f + (v9 capFrac - 0.50).
OPENS ONLY (backtest/opens-only.js): no covers or hedges of any kind; every open held to the settle. Kept: risk cap (governor
lossMax on the projected book floor; -unc = none), open walk ladder, placement, leg ledger. v9 rows = unchanged roster controls.
bind% = days the cap refused >= 1 open; blk/d = signal opens refused by the cap; walk/d = ladder steps refused by the cap;
1stBlk = median ET time of the first refusal (days with one); pkCap = peak sum of open debits held ($, = max-loss sum).
sig/d = qualifying 5m closes 09:30-15:55 ET; placed/d / filled/d = signal opens the ladder placed / filled (after one-working-open,
caps, governor); opens/d = every position booked incl. hedges and wings (the baselines opens/day definition).

## All days

```
variant           worst  maxDD30  IF avg  IF>=0%  endFl locked  uncov/d  sig/d  placed/d filled/d  opens/d  avg/d        total  bind%  blk/d walk/d 1stBlk pkCapMed pkCapMax
v9-10            -2,275  -10,624    -795    14.5   -608   26.2     3.56      -    23.81    20.85    25.08    746      612,197
v20-10           -2,000  -16,295  -1,341       0 -1,447      0     2.74   9.47     3.01     2.74     2.74    -53      -43,495   64.2   5.42      0  10:45    1,580    5,815
v20-10-unc      -10,875  -56,445  -3,013       0 -3,858      0     6.72   9.47      7.3     6.72     6.72   -202     -165,506      0      0      0      -    3,015   17,990
v21-10-f50       -2,000  -19,000  -1,444     0.3 -1,566    0.6     3.16   9.47      3.4     3.16     3.16    -59      -48,793   63.7   5.08      0  10:40    1,550    6,485
v21-10-f50-unc  -14,470  -63,050  -2,967     0.2 -3,806      0     7.05   9.47      7.5     7.05     7.05   -316     -259,588      0      0      0      -    3,025   16,190
v21-10-f55       -2,000  -18,765  -1,426       0 -1,516      0     2.83   9.47     2.97     2.83     2.83    -75      -61,430   69.5   6.18      0  10:30    1,650    5,845
v21-10-f55-unc  -12,615  -74,550  -3,736       0 -4,720      0        8   9.47      8.4        8        8   -432     -354,554      0      0      0      -    3,865   18,695
v21-10-f60       -1,985  -18,320  -1,560       0 -1,654      0     2.74   9.47     2.89     2.74     2.74   -116      -95,237   70.2   6.15      0  10:35    1,790    5,500
v21-10-f60-unc  -18,085  -79,840  -4,058       0 -5,162      0     7.86   9.47     8.24     7.86     7.86   -530     -434,830      0      0      0      -    4,195   18,585

v9-20            -4,795  -12,609  -1,396    19.1   -407     42     3.31      -    24.27    21.22    26.47  1,920    1,576,504
v20-20           -4,500  -43,475  -3,393       0 -3,686      0     3.31   9.47     3.62     3.31     3.31   -203     -166,860   60.9   4.96      0  10:50    4,310   12,470
v20-20-unc      -33,130 -133,425  -6,562       0 -8,440    0.1     7.13   9.47     7.73     7.13     7.13   -720     -590,724      0      0      0      -    6,595   37,650
v21-20-f50       -4,375  -44,840  -3,230     0.5 -3,450    0.3     3.56   9.47     3.73     3.56     3.56   -197     -161,481   64.8   5.39      0  10:35    3,990   13,965
v21-20-f50-unc  -31,875 -153,655  -7,106     0.4 -8,984    0.3     8.41   9.47     8.76     8.41     8.41   -834     -685,015      0      0      0      -    7,155   33,045
v21-20-f55       -4,500  -43,140  -3,450       0 -3,749      0     3.38   9.47     3.63     3.38     3.38   -202     -165,658   62.7    5.1      0  10:50    4,365   12,485
v21-20-f55-unc  -33,490 -145,365  -6,937       0 -8,960      0     7.52   9.47     8.03     7.52     7.52   -814     -668,550      0      0      0      -    6,710   36,350
v21-20-f60       -4,485  -37,025  -3,104       0 -3,343      0     2.71   9.47     2.93     2.71     2.71   -267     -219,097   66.7   5.77      0  10:40    3,555   12,090
v21-20-f60-unc  -28,835 -122,650  -7,224       0 -9,435      0      7.1   9.47      7.6      7.1      7.1   -933     -766,382      0      0      0      -    7,455   37,150
v9-20-cATM       -6,460  -25,300  -1,801    14.5 -1,244   31.1     3.24      -    25.79    24.15    29.56  1,133      929,971
v20-20-cATM      -6,500  -68,895  -4,302     0.3 -4,806    0.3     4.77   9.47     5.02     4.77     4.77   -276     -226,616   51.9   3.85      0  10:55    5,780   17,445
v20-20-cATM-unc -29,305 -151,975  -6,891     0.3 -8,717    0.3     8.18   9.47     8.57     8.18     8.18   -847     -695,658      0      0      0      -    7,220   32,075

v9-40            -7,441  -19,720  -2,560    13.2 -1,394   29.8     2.02      -    26.17    24.26    34.71  2,525    2,073,300
v20-40           -7,420  -68,045  -5,776       0 -6,093      0     2.75   9.47     2.95     2.75     2.75   -397     -325,929   69.5   6.12      0  10:35    6,705   22,020
v20-40-unc      -67,385 -290,445 -15,525       0 -19,752      0      8.1   9.47     8.54      8.1      8.1 -1,814   -1,489,020      0      0      0      -   15,705   76,880
v21-40-f50       -7,445  -74,085  -5,160     0.5 -5,483    0.3     2.85   9.47        3     2.85     2.85   -296     -243,027   69.9   6.19      0  10:30    5,990   22,485
v21-40-f50-unc  -62,095 -294,270 -13,972     0.4 -17,764    0.4     8.27   9.47     8.65     8.27     8.27 -1,668   -1,369,349      0      0      0      -   14,090   69,220
v21-40-f55       -7,465  -65,420  -5,697       0 -6,022      0     2.79   9.47     2.96     2.79     2.79   -374     -307,311     70   6.17      0  10:35    6,565   22,020
v21-40-f55-unc  -67,340 -294,175 -15,545       0 -19,840      0     8.28   9.47     8.67     8.28     8.28 -1,860   -1,526,779      0      0      0      -   15,570   75,425
v21-40-f60       -7,495  -73,660  -6,196       0 -6,528      0     2.73   9.47     2.88     2.73     2.73   -532     -436,381   70.5   6.29      0  10:30    7,195   21,925
v21-40-f60-unc  -72,130 -301,330 -16,835       0 -21,635      0     8.24   9.47     8.65     8.24     8.24 -2,039   -1,673,642      0      0      0      -   17,680   81,875
v9-40-cATM       -7,298  -44,591  -2,637     8.3 -2,313   17.2     1.12      -    23.22     21.7    31.14    902      740,802
v20-40-cATM      -7,500  -79,850  -5,470     0.4 -5,889    0.3     3.05   9.47     3.23     3.05     3.05   -341     -280,098   68.1   5.85      0  10:30    6,190   27,190
v20-40-cATM-unc -51,305 -267,120 -13,336     0.3 -17,083    0.1     8.02   9.47     8.43     8.02     8.02 -1,639   -1,345,785      0      0      0      -   13,915   64,090
```

## 2026 only (NDX-priced days)

```
variant           worst  maxDD30  IF avg  IF>=0%  endFl locked  uncov/d  sig/d  placed/d filled/d  opens/d  avg/d        total  bind%  blk/d walk/d 1stBlk pkCapMed pkCapMax
v9-10            -1,915   -3,540    -631    18.9   -429   30.4     2.23      -    24.95    22.59    27.48    979       54,838
v20-10           -1,640   -6,785  -1,357       0 -1,389      0     1.95   5.45     2.05     1.95     1.95    172        9,610   44.6   3.16      0  10:25    1,590    4,545
v20-10-unc       -8,160  -19,576  -2,924       0 -3,357      0     4.48   5.45     4.82     4.48     4.48    176        9,839      0      0      0      -    1,635    8,160
v21-10-f50       -2,000   -8,025  -1,446     0.3 -1,498      0     2.21   5.45     2.36     2.21     2.21    174        9,772   41.1    2.7      0  10:25    1,470    4,985
v21-10-f50-unc   -7,560  -17,210  -2,800     0.3 -3,249      0     4.52   5.45      4.8     4.52     4.52    121        6,792      0      0      0      -    1,495    8,045
v21-10-f55       -1,685   -8,065  -1,393       0 -1,432      0     1.93   5.45     2.04     1.93     1.93    187       10,455   44.6   3.05      0  10:30    1,630    4,780
v21-10-f55-unc   -8,335  -20,207  -3,148       0 -3,572      0     4.59   5.45     4.86     4.59     4.59    163        9,111      0      0      0      -    1,635    9,210
v21-10-f60       -1,860   -7,957  -1,510       0 -1,529      0     1.84   5.45     1.96     1.84     1.84     87        4,863   44.6   3.18      0  10:30    1,240    4,460
v21-10-f60-unc   -8,935  -20,245  -3,513       0 -4,037      0     4.55   5.45      4.8     4.55     4.55     76        4,255      0      0      0      -    1,240    9,690

v9-20            -3,191   -3,191    -812    27.9    151   48.2     1.71      -    23.77       20    26.07  1,348       75,509
v20-20           -4,490  -17,832  -3,236       0 -3,335      0     2.32   5.45     2.48     2.32     2.32    305       17,105   37.5   2.43      0  10:25    3,285   10,570
v20-20-unc      -15,535  -34,446  -5,147       0 -5,872      0     3.93   5.45     4.38     3.93     3.93    340       19,046      0      0      0      -    3,285   15,535
v21-20-f50       -4,050  -20,100  -3,084       0 -3,092      0     2.32   5.45     2.48     2.32     2.32    324       18,134   41.1   2.57      0  10:30    2,055    9,775
v21-20-f50-unc  -14,975  -42,297  -5,502       0 -6,248      0     4.36   5.45     4.73     4.36     4.36     51        2,870      0      0      0      -    2,055   16,820
v21-20-f55       -4,445  -19,120  -3,360       0 -3,460      0     2.39   5.45     2.52     2.39     2.39    305       17,107   39.3   2.48      0  10:35    3,295   11,350
v21-20-f55-unc  -16,570  -35,229  -5,728       0 -6,557      0     4.34   5.45     4.68     4.34     4.34    305       17,105      0      0      0      -    3,300   19,035
v21-20-f60       -3,760  -12,955  -2,988       0 -3,077      0     1.82   5.45     1.96     1.82     1.82    205       11,458   41.1      3      0  10:30    2,480    9,580
v21-20-f60-unc  -18,345  -37,325  -6,389       0 -7,432      0     4.16   5.45      4.5     4.16     4.16     87        4,893      0      0      0      -    2,480   19,385
v9-20-cATM       -6,270   -8,581  -1,340    17.8 -1,117   28.6     1.95      -    25.63    24.09    30.09    879       49,233
v20-20-cATM      -6,125  -26,815  -4,110       0 -4,176      0     3.09   5.45     3.29     3.09     3.09    290       16,254   35.7   1.89      0  10:50    2,050   12,695
v20-20-cATM-unc -14,670  -41,797  -5,753       0 -6,533      0     4.64   5.45        5     4.64     4.64    183       10,232      0      0      0      -    2,050   15,670

v9-40            -6,148   -8,964  -2,181    14.1 -1,211   30.4     1.32      -    22.16    19.52    29.25  1,624       90,928
v20-40           -6,875  -30,282  -5,656       0 -5,779      0     1.82   5.45     2.04     1.82     1.82    352       19,716   41.1   2.96      0  10:30    4,520   17,710
v20-40-unc      -34,380  -64,286 -11,053       0 -12,831      0     3.82   5.45     4.29     3.82     3.82    -13         -750      0      0      0      -    4,520   36,360
v21-40-f50       -6,110  -24,420  -5,005     0.1 -5,123      0     1.93   5.45     2.07     1.93     1.93    736       41,198   42.9   3.21      0  10:25    5,940   17,645
v21-40-f50-unc  -30,025  -80,248 -11,297       0 -12,891      0     4.59   5.45     4.95     4.59     4.59    332       18,581      0      0      0      -    6,015   33,710
v21-40-f55       -6,615  -30,417  -5,641       0 -5,779      0     1.82   5.45     2.04     1.82     1.82    381       21,359   42.9      3      0  10:30    4,520   17,885
v21-40-f55-unc  -32,925  -62,121 -11,393       0 -13,238      0     3.96   5.45     4.43     3.96     3.96    227       12,731      0      0      0      -    4,520   35,145
v21-40-f60       -7,326  -36,850  -5,712       0 -5,986      0     1.77   5.45     1.93     1.77     1.77     62        3,494   44.6   3.07      0  10:30    5,025   19,210
v21-40-f60-unc  -28,665  -68,321 -11,929       0 -13,838      0     3.84   5.45     4.23     3.84     3.84    543       30,408      0      0      0      -    5,090   29,040
v9-40-cATM       -5,557  -14,186  -2,237      11 -2,300   14.3     0.75      -    20.73     19.2     27.8    405       22,681
v20-40-cATM      -6,150  -23,820  -4,999       0 -5,263      0     1.96   5.45     2.11     1.96     1.96    778       43,587   42.9   3.13      0  10:25    5,765   19,430
v20-40-cATM-unc -29,335  -79,609 -10,934       0 -12,542      0     4.52   5.45     4.88     4.52     4.52    189       10,570      0      0      0      -    6,045   34,985
```
## Notes

- v9 controls unchanged and still equal to backtest-baselines-combined.csv (612,197 / 1,576,504 / 2,073,300 / 929,971 / 740,802).
- Every opens-only book is checked per day in the sweep: no cover filled, no hedge/wing/offset/fly position, book = ladder-filled
  opens (the run throws otherwise). Capped worst day = -lossMax exactly ($2,000 / $4,500 / $6,500 / $7,500); never breached.
- No v20-10-cATM (no v9-10-cATM in the roster: a 10-wide centred on the money is off the 10-pt grid).

### Guards that can stop a qualifying signal (opens-only)
```
ON   action window 09:30-15:55 ET
ON   one working open at a time (a signal while an open works is skipped)       <- main absorber: sig 9.47/d vs placed ~3 (capped) / ~8 (unc)
ON   working open cancelled by an opposite-side signal
ON   risk cap: governor lossMax on the projected book floor incl. the working open   (OFF on -unc)
ON   risk cap on the ladder WALK (step refused if it takes the floor through lossMax) (OFF on -unc; fired 0 times)
ON   leg-uniqueness ledger (twin / shift / skip on a conflicting leg)
ON   v20 sATM: placement decline -> open fallback until 15:55 (cATM / v21 never decline)
ON   never start fully OTM (openNeverOtm)
OFF  direction stance (bidirectional: bull and bear may be held together)
OFF  riskCap / softCap / hardCap / capitalCeiling, floor ratchet, late-day floor guard, openCutoffMin, openFloorGate,
     noAddUnderwater, cover-to-open wait, stack gate, open trend block, touch filter
```

### Debit vs credit under the cap
- The cap is the governor: it gates on the BOOK FLOOR (worst settle P&L of the whole book). A debit vertical and its same-direction
  credit twin at the SAME strikes are identical to it: the backtest prices with r = 0 and a strike-only skew, so put-call parity is
  exact — credit = W - debit, max loss = debit, settle P&L identical (asserted in candle-spread-opens-only.test.js). Switching
  structure fits ZERO extra positions under the cap.
- DIFFERENT strikes: max loss depends only on the strikes and the direction, never on debit-vs-credit form. A credit spread at
  strikes K is the parity twin of the debit spread at K, so a "cheaper" credit spread is cheaper only because its strikes are
  further from the money — the same capacity is available as a debit at those strikes.
- The engine's cash ledger (capital.peakReal / depR, used by capitalRecapture) DOES differ: a debit open is +cash out, a credit open
  is cash in. But no cap reads it (capitalCeiling is unset on v9 and gates on debit-canonical uncovered risk anyway), so an arm that
  "picks the lower-capital structure" would be byte-identical in opens, fills and P&L — not run. Broker (Reg-T) margin on a credit
  vertical = W - credit = the debit, so the account view agrees with the governor.
- pkCap (peak sum of debits) can exceed lossMax on capped books: the floor of a two-sided book (bulls + bears) is better than the
  sum of debits, so the governor already lets offsetting positions fit — that, not credit spreads, is where extra room comes from.

### Findings
- 821 days: every opens-only variant loses. Capped -$43k (v20-10) .. -$436k (v21-40-f60); -unc -$166k .. -$1.67M, worst days
  -$10.9k (10W) to -$72k (40W). v9 makes $0.6-2.1M on the same days with covers.
- 2026 (56 NDX-priced days): every CAPPED variant is positive (+$4.9k .. +$43.6k; best v20-40-cATM +$43.6k, v21-40-f50 +$41.2k)
  but maxDD30 is 2-6x v9's; -unc is mixed (-$0.8k .. +$30k). Small sample; the pre-2026 days price off /NQ.
- The cap binds on 52-71% of days (36-45% in 2026), refusing 4-6 signals/day; median first refusal 10:30-10:55. It cuts filled
  opens from 7-8.4/day (-unc) to 2.7-4.8/day and is what keeps the loss bounded: -unc loses 3-6x more.
- Peak capital (sum of debits held), median / max: capped 10W 1.6-1.8k/5.5-6.5k, 20W 3.6-5.8k/12-17k, 40W 6-7.2k/22-27k;
  -unc 10W 3-4.2k/16-19k, 20W 6.6-7.5k/32-38k, 40W 13.9-17.7k/64-82k. With no covers nothing frees capital: it only grows.
- f (v21) has no stable optimum; v21 ~ v20 at every width.
