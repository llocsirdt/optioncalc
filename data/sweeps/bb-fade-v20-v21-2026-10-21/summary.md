# BB FADE v20 / v21 — 821 days 12/27/2022..10/7/2026 (56 NDX-priced 2026 days)

Signal (NQ 24h, every 5m close): close below BOTH the 15m and 60m lower BB(20,2) -> bull; above BOTH uppers -> bear.
Bands = last COMPLETED 15m / 60m bar as of the 5m close (analysis-builder completedAsOf). Everything after the open = v9
roster machinery (optsFor, ladder opens, 1m sub-bar fills, risk cap). v20 = v9 strike placement; v21 = strike whose BS
mark is closest to f x W (nearest the money on a tie), walk cap = f + (v9 capFrac - 0.50). v9 rows = controls.
sig/d = qualifying 5m closes 09:30-15:55 ET; placed/d / filled/d = signal opens the ladder placed / filled (after one-working-open,
caps, governor); opens/d = every position booked incl. floor-raise hedges and wings (the baselines opens/day definition).

## All days

```
variant        worst  maxDD30  IF avg  IF>=0%  endFl locked  uncov/d  sig/d  placed/d filled/d  opens/d  avg/d        total
v9-10         -2,275  -10,624    -795    14.5   -608   26.2     3.56      -    23.81    20.85    25.08    746      612,197
v20-10        -1,980   -9,680    -380    49.4   -246   50.7     0.46   9.47     5.87     4.67      5.3    100       81,862
v21-10-f50    -2,000  -11,135    -417    43.4   -285   47.2     0.53   9.47     5.95     5.06     5.83     95       78,261
v21-10-f55    -1,995  -10,708    -480    47.1   -320   45.6     0.56   9.47     5.01     4.52     5.09     11        9,335
v21-10-f60    -2,000  -13,669    -534    51.5   -325   51.7     0.59   9.47     4.64     4.09     4.53    -18      -15,058

v9-20         -4,795  -12,609  -1,396    19.1   -407     42     3.31      -    24.27    21.22    26.47  1,920    1,576,504
v20-20        -4,500  -25,045    -789    46.3   -279   58.3     0.49   9.47     6.09     4.88     5.71    226      185,795
v21-20-f50    -4,500  -24,165    -906      39   -460   47.5     0.55   9.47     6.29     5.78     6.71    149      122,240
v21-20-f55    -4,500  -22,633    -854    43.9   -319     55     0.52   9.47     5.86     4.96     5.85    220      180,585
v21-20-f60    -4,485  -28,996    -974    45.5   -355     56     0.59   9.47     5.02      4.1     5.21    118       96,723
v9-20-cATM    -6,460  -25,300  -1,801    14.5 -1,244   31.1     3.24      -    25.79    24.15    29.56  1,133      929,971
v20-20-cATM   -6,490  -29,830  -1,099    40.3   -612   50.6     0.62   9.47     7.56     6.83     7.95    101       83,193

v9-40         -7,441  -19,720  -2,560    13.2 -1,394   29.8     2.02      -    26.17    24.26    34.71  2,525    2,073,300
v20-40        -7,485  -36,071  -1,558    32.6   -577   44.9     0.26   9.47     5.94      5.4     8.13    384      314,997
v21-40-f50    -7,280  -37,210  -1,732    26.9 -1,218   33.5     0.14   9.47     7.07     6.66     9.24      7        5,754
v21-40-f55    -7,495  -35,271  -1,536    32.8   -554   44.6     0.22   9.47      6.2     5.76     8.56    464      380,931
v21-40-f60    -7,480  -34,779  -1,653    34.5   -480   47.7     0.36   9.47     5.34     4.94     8.22    386      316,714
v9-40-cATM    -7,298  -44,591  -2,637     8.3 -2,313   17.2     1.12      -    23.22     21.7    31.14    902      740,802
v20-40-cATM   -6,985  -40,441  -1,674    25.6 -1,138   37.3     0.12   9.47     7.23     6.77     9.61     36       29,257
```

## 2026 only (NDX-priced days)

```
variant        worst  maxDD30  IF avg  IF>=0%  endFl locked  uncov/d  sig/d  placed/d filled/d  opens/d  avg/d        total
v9-10         -1,915   -3,540    -631    18.9   -429   30.4     2.23      -    24.95    22.59    27.48    979       54,838
v20-10        -1,805   -4,137    -321    50.6   -162   55.6     0.27   5.45     3.73     3.27     3.71    284       15,901
v21-10-f50    -1,930   -4,494    -300    48.5   -180   59.5     0.25   5.45     3.98     3.71     4.54     57        3,174
v21-10-f55    -1,715   -5,303    -362    48.2   -243   52.8     0.29   5.45     3.34     3.07     3.46    -33       -1,869
v21-10-f60    -1,860   -4,145    -320    54.9   -184   61.1     0.29   5.45     3.21        3      3.3     13          723

v9-20         -3,191   -3,191    -812    27.9    151   48.2     1.71      -    23.77       20    26.07  1,348       75,509
v20-20        -3,450   -4,085    -349    50.7     -9   58.3     0.16   5.45        4     3.05     3.73    181       10,152
v21-20-f50    -4,435   -7,568    -504    43.8    -88   55.9     0.21   5.45     4.04     3.61     4.38    174        9,766
v21-20-f55    -4,285   -4,700    -398    54.7     27   67.6     0.18   5.45     3.79     3.25     3.86    222       12,440
v21-20-f60    -3,915   -8,405    -491    55.9    -65   58.3     0.34   5.45     3.21     2.75     3.46    224       12,528
v9-20-cATM    -6,270   -8,581  -1,340    17.8 -1,117   28.6     1.95      -    25.63    24.09    30.09    879       49,233
v20-20-cATM   -5,700   -8,040    -522    54.6   -130   69.4     0.27   5.45      4.7     4.41     5.23    222       12,418

v9-40         -6,148   -8,964  -2,181    14.1 -1,211   30.4     1.32      -    22.16    19.52    29.25  1,624       90,928
v20-40        -5,320   -6,981  -1,171    35.3   -153     50     0.18   5.45     3.61     2.93     4.43    324       18,153
v21-40-f50    -6,295  -13,516  -1,236    37.6   -686     50     0.11   5.45      4.2     3.93     5.68    -25       -1,378
v21-40-f55    -5,545  -12,080  -1,201    35.8   -376   48.6     0.11   5.45     3.63     3.04     4.63    255       14,277
v21-40-f60    -6,885  -10,080  -1,426    35.2   -462   48.6     0.23   5.45     3.27     2.82     4.68    333       18,638
v9-40-cATM    -5,557  -14,186  -2,237      11 -2,300   14.3     0.75      -    20.73     19.2     27.8    405       22,681
v20-40-cATM   -6,315  -11,307  -1,234    35.5   -592   47.2     0.09   5.45     4.16     3.79      5.5     27        1,523
```
## Notes

- Controls reproduce backtest-baselines-combined.csv exactly (total, worst, maxDD30, locked%): v9-10 612,197, v9-20 1,576,504,
  v9-40 2,073,300, v9-20-cATM 929,971, v9-40-cATM 740,802.
- No v20-10-cATM: the roster has no v9-10-cATM (a 10-wide centred on the money is off the 10-pt NDX strike grid), so there is no
  twin config to copy.
- v21 has no sATM/cATM split: price picks the strike. Built on the v9-W (sATM) config with only the open geometry replaced.
- Pricing for the v21 pick = the engine's own open pricer (legsMark: Black-Scholes on the 15m band IV x calibrated time-of-day
  mult x per-leg skew). The backtest has no real option quotes: 2026 days use real NDX underlying prices (px), pre-2026 days
  the /NQ series. Grid searched: short strike within +-12 strikes of the money.
- Covers: the parent v9 signal (v7Signal beWrong) still runs on every bar for its COVER output (trend-flip / 5m early cover /
  active cover); only its open side is replaced by the fade. The v9 be-wrong / trend-continuation / overextension opens are gone.
- Result: floor metrics far better than v9 (IF>=0% 14-19 -> 26-52, uncovered/day 3.6 -> ~0.5) because the families trade ~5
  signal opens/day instead of ~21; P&L falls 82-99% and maxDD30 is WORSE than v9 at 20W and 40W (-12.6k -> -22.6k..-29k,
  -19.7k -> -34.8k..-37.2k). 9.47 qualifying closes/day but they cluster (consecutive closes beyond the bands), so the
  one-working-open rule absorbs ~40%. v21 f is not monotone (40W: f50 $5.8k, f55 $381k, f60 $317k) — noisy, no clear optimum.
- Sweep: node scripts/candle-spread/sweep-v10.js --bbFade --workers 8 --out data/sweeps/bb-fade-v20-v21-2026-10-21 (169 s);
  summary: node scripts/candle-spread/summary-bb-fade.js data/sweeps/bb-fade-v20-v21-2026-10-21
