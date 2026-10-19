# Give-up regime study (2026-10-19, study only)

Days 821 (12/27/2022..10/7/2026; 56 real-NDX 2026). Roster v6-v9 x 10/20/40, baseline settings (optsFor, ladder opens, 1m sub-bars). Event = the FIRST give-up of a position. Arms are per-position counterfactuals (governor/book effects not re-simulated); actual = what the engine did. $ = position P&L (open + cover at settle) x100, summed.

Terminal check (tap must be inert; compare backtest-baselines-combined): v6-10 440,639 | v6-20 668,963 | v6-40 1,511,483 | v7-10 571,883 | v7-20 915,896 | v7-40 1,680,960 | v8-10 432,998 | v8-20 646,948 | v8-40 1,495,816 | v9-10 612,197 | v9-20 1,576,504 | v9-40 2,073,300

## 1. Events per variant

```
variant   events  /day  points  c2o  other  within-cur-allow%  cameBackBE%  betterLater%  actual-uncov%  hold-loss-med  actCoverMin-med
v6-10      4369  5.32    2970 1399      0               13.2         71.5          96.1           19.2           -495                5
v6-20      5473  6.67    3906 1567      0               13.8         71.0          96.1           15.3           -935                0
v6-40      9104 11.09    7958 1146      0               22.1         73.4          97.2            7.0           -710                0
v7-10      8459 10.30    3192 5267      0               24.4         77.3          96.8           15.0           -370                0
v7-20      9356 11.40    4151 5205      0               27.6         74.5          96.1           13.0           -395                0
v7-40     12456 15.17    9393 3063      0               27.7         74.8          96.9            7.3           -310                0
v8-10      4368  5.32    2969 1399      0               13.2         71.6          96.1           19.2           -495                5
v8-20      5468  6.66    3901 1567      0               13.8         71.1          96.1           15.2           -935                0
v8-40      9100 11.08    7953 1147      0               22.1         73.5          97.2            7.0           -705                0
v9-10      7081  8.62    7081    0      0                4.1         60.9          94.7           33.2           -500               10
v9-20      8951 10.90    8951    0      0                0.8         62.2          94.4           26.1           -970                5
v9-40     13486 16.43   13486    0      0               14.1         69.3          96.3           10.8           -860                0
```

## 2. Counterfactual arms per variant (sum $ | uncovered at close | worst position | 5th pct)

capCur = static current allowance (10W 5% / 20W 7.5% / 40W 10%); cap0 = wait for break-even; payNow = mark + tick unbounded. CI = day-clustered 95% bootstrap of (arm - capCur).

```
v6-10 points (2970 events)
  actual       -276,646  uncov   641  worst    -550  p5    -540  d vs capCur    80,455 CI [70,210, 91,500]
  capCur       -357,101  uncov   754  worst    -550  p5    -545
  payNow       -528,386  uncov     0  worst    -555  p5    -400  d vs capCur  -171,285 CI [-203,810, -144,645]
  cap0         -344,161  uncov   944  worst    -550  p5    -545  d vs capCur    12,940 CI [3,605, 30,420]
  cap0.025     -355,691  uncov   857  worst    -550  p5    -545  d vs capCur     1,410 CI [-10,540, 13,950]
  cap0.05      -357,101  uncov   754  worst    -550  p5    -545  d vs capCur         0 CI [0, 0]
  cap0.075     -379,401  uncov   687  worst    -550  p5    -540  d vs capCur   -22,300 CI [-29,720, -16,800]
  cap0.1       -405,796  uncov   631  worst    -550  p5    -540  d vs capCur   -48,695 CI [-60,595, -41,855]
  cap0.15      -432,521  uncov   435  worst    -550  p5    -535  d vs capCur   -75,420 CI [-91,565, -65,400]
  cap0.25      -482,926  uncov   164  worst    -550  p5    -355  d vs capCur  -125,825 CI [-153,405, -103,415]
  hold         -386,780  uncov  2970  worst    -550  p5    -550  d vs capCur   -29,679 CI [-90,891, 11,135]
v6-10 c2o (1399 events)
  actual        -30,056  uncov   198  worst    -550  p5    -535  d vs capCur    19,380 CI [9,225, 27,730]
  capCur        -49,436  uncov   189  worst    -550  p5    -540
  payNow        -58,486  uncov     0  worst    -495  p5    -280  d vs capCur    -9,050 CI [-16,475, 3,890]
  cap0          -53,746  uncov   296  worst    -550  p5    -545  d vs capCur    -4,310 CI [-13,150, 4,250]
  cap0.025      -46,396  uncov   230  worst    -550  p5    -540  d vs capCur     3,040 CI [-2,165, 9,835]
  cap0.05       -49,436  uncov   189  worst    -550  p5    -540  d vs capCur         0 CI [0, 0]
  cap0.075      -52,126  uncov   152  worst    -550  p5    -535  d vs capCur    -2,690 CI [-7,790, 2,710]
  cap0.1        -47,776  uncov   110  worst    -550  p5    -525  d vs capCur     1,660 CI [-4,310, 6,200]
  cap0.15       -45,971  uncov    61  worst    -550  p5    -150  d vs capCur     3,465 CI [-4,675, 12,860]
  cap0.25       -55,196  uncov    15  worst    -550  p5    -250  d vs capCur    -5,760 CI [-12,550, 5,420]
  hold          -51,477  uncov  1399  worst    -550  p5    -550  d vs capCur    -2,041 CI [-47,306, 32,382]
v6-20 points (3906 events)
  actual       -715,398  uncov   695  worst  -1,150  p5  -1,105  d vs capCur   264,876 CI [228,848, 307,262]
  capCur       -980,274  uncov   858  worst  -1,150  p5  -1,115
  payNow     -1,274,321  uncov     0  worst  -1,125  p5    -720  d vs capCur  -294,047 CI [-335,115, -224,890]
  cap0         -918,341  uncov  1253  worst  -1,150  p5  -1,125  d vs capCur    61,933 CI [29,764, 99,658]
  cap0.025     -936,401  uncov  1134  worst  -1,150  p5  -1,125  d vs capCur    43,873 CI [17,171, 66,630]
  cap0.05      -931,224  uncov   973  worst  -1,150  p5  -1,120  d vs capCur    49,050 CI [33,245, 71,615]
  cap0.075     -980,274  uncov   858  worst  -1,150  p5  -1,115  d vs capCur         0 CI [0, 0]
  cap0.1     -1,015,579  uncov   732  worst  -1,150  p5  -1,110  d vs capCur   -35,305 CI [-52,710, -12,815]
  cap0.15    -1,078,554  uncov   505  worst  -1,150  p5  -1,095  d vs capCur   -98,280 CI [-129,365, -70,080]
  cap0.25    -1,208,144  uncov   170  worst  -1,150  p5    -500  d vs capCur  -227,870 CI [-269,110, -168,680]
  hold         -899,060  uncov  3906  worst  -1,150  p5  -1,135  d vs capCur    81,214 CI [-3,262, 185,495]
v6-20 c2o (1567 events)
  actual        -48,453  uncov   141  worst  -1,150  p5  -1,080  d vs capCur    57,385 CI [43,630, 66,705]
  capCur       -105,838  uncov   164  worst  -1,150  p5  -1,100
  payNow       -107,323  uncov     0  worst  -1,050  p5    -510  d vs capCur    -1,485 CI [-15,865, 14,105]
  cap0         -117,003  uncov   331  worst  -1,150  p5  -1,125  d vs capCur   -11,165 CI [-33,770, 7,870]
  cap0.025     -113,843  uncov   265  worst  -1,150  p5  -1,120  d vs capCur    -8,005 CI [-28,450, 5,800]
  cap0.05      -104,003  uncov   204  worst  -1,150  p5  -1,110  d vs capCur     1,835 CI [-10,660, 12,315]
  cap0.075     -105,838  uncov   164  worst  -1,150  p5  -1,100  d vs capCur         0 CI [0, 0]
  cap0.1       -103,763  uncov   129  worst  -1,150  p5  -1,075  d vs capCur     2,075 CI [-5,055, 12,780]
  cap0.15       -99,428  uncov    75  worst  -1,150  p5    -300  d vs capCur     6,410 CI [-8,440, 19,670]
  cap0.25      -101,923  uncov    12  worst  -1,150  p5    -500  d vs capCur     3,915 CI [-11,530, 19,250]
  hold         -111,066  uncov  1567  worst  -1,150  p5  -1,140  d vs capCur    -5,228 CI [-85,443, 52,601]
v6-40 points (7958 events)
  actual     -1,974,482  uncov   584  worst  -2,350  p5  -1,900  d vs capCur 1,327,896 CI [1,170,366, 1,417,362]
  capCur     -3,302,378  uncov  1135  worst  -2,350  p5  -2,265
  payNow     -3,837,851  uncov     0  worst  -2,280  p5  -1,205  d vs capCur  -535,473 CI [-642,620, -471,935]
  cap0       -2,762,835  uncov  2158  worst  -2,350  p5  -2,300  d vs capCur   539,543 CI [405,299, 658,090]
  cap0.025   -2,925,444  uncov  1932  worst  -2,350  p5  -2,295  d vs capCur   376,934 CI [285,917, 465,289]
  cap0.05    -3,061,078  uncov  1678  worst  -2,350  p5  -2,290  d vs capCur   241,300 CI [153,520, 309,996]
  cap0.075   -3,189,354  uncov  1411  worst  -2,350  p5  -2,280  d vs capCur   113,024 CI [60,594, 156,144]
  cap0.1     -3,302,378  uncov  1135  worst  -2,350  p5  -2,265  d vs capCur         0 CI [0, 0]
  cap0.15    -3,518,873  uncov   658  worst  -2,350  p5  -2,180  d vs capCur  -216,495 CI [-269,700, -164,900]
  cap0.25    -3,675,983  uncov   149  worst  -2,350  p5  -1,000  d vs capCur  -373,605 CI [-471,070, -318,055]
  hold       -2,814,436  uncov  7958  worst  -2,350  p5  -2,325  d vs capCur   487,942 CI [223,103, 762,758]
v6-40 c2o (1146 events)
  actual         -5,115  uncov    53  worst  -2,350  p5    -400  d vs capCur   120,905 CI [90,945, 147,280]
  capCur       -126,020  uncov    86  worst  -2,350  p5  -2,215
  payNow        -93,130  uncov     0  worst  -1,640  p5    -815  d vs capCur    32,890 CI [2,600, 66,695]
  cap0         -151,178  uncov   259  worst  -2,350  p5  -2,310  d vs capCur   -25,158 CI [-77,528, 25,312]
  cap0.025     -155,760  uncov   205  worst  -2,350  p5  -2,305  d vs capCur   -29,740 CI [-59,797, 10,180]
  cap0.05      -143,018  uncov   158  worst  -2,350  p5  -2,285  d vs capCur   -16,998 CI [-46,948, 14,977]
  cap0.075     -137,718  uncov   123  worst  -2,350  p5  -2,250  d vs capCur   -11,698 CI [-29,745, 4,135]
  cap0.1       -126,020  uncov    86  worst  -2,350  p5  -2,215  d vs capCur         0 CI [0, 0]
  cap0.15       -96,420  uncov    29  worst  -2,350  p5    -600  d vs capCur    29,600 CI [9,800, 53,780]
  cap0.25       -93,085  uncov     3  worst  -2,275  p5    -815  d vs capCur    32,935 CI [6,165, 65,085]
  hold         -227,809  uncov  1146  worst  -2,350  p5  -2,335  d vs capCur  -101,789 CI [-183,610, 82,096]
v7-10 points (3192 events)
  actual       -291,454  uncov   685  worst    -550  p5    -540  d vs capCur   100,504 CI [88,919, 117,814]
  capCur       -391,958  uncov   801  worst    -550  p5    -545
  payNow       -581,198  uncov     0  worst    -555  p5    -405  d vs capCur  -189,240 CI [-218,690, -150,070]
  cap0         -370,838  uncov   998  worst    -550  p5    -545  d vs capCur    21,120 CI [10,320, 32,975]
  cap0.025     -385,568  uncov   906  worst    -550  p5    -545  d vs capCur     6,390 CI [220, 16,715]
  cap0.05      -391,958  uncov   801  worst    -550  p5    -545  d vs capCur         0 CI [0, 0]
  cap0.075     -408,233  uncov   715  worst    -550  p5    -540  d vs capCur   -16,275 CI [-24,520, -8,785]
  cap0.1       -431,748  uncov   636  worst    -550  p5    -540  d vs capCur   -39,790 CI [-52,805, -24,125]
  cap0.15      -465,218  uncov   442  worst    -550  p5    -535  d vs capCur   -73,260 CI [-90,850, -50,310]
  cap0.25      -526,333  uncov   164  worst    -550  p5    -250  d vs capCur  -134,375 CI [-165,550, -101,390]
  hold         -408,279  uncov  3192  worst    -550  p5    -550  d vs capCur   -16,321 CI [-48,168, 28,411]
v7-10 c2o (5267 events)
  actual        -22,515  uncov   580  worst    -550  p5    -525  d vs capCur    37,110 CI [18,670, 56,030]
  capCur        -59,625  uncov   588  worst    -550  p5    -530
  payNow       -130,805  uncov     0  worst    -555  p5    -280  d vs capCur   -71,180 CI [-100,740, -46,035]
  cap0          -35,575  uncov   916  worst    -550  p5    -540  d vs capCur    24,050 CI [3,120, 47,085]
  cap0.025      -37,145  uncov   724  worst    -550  p5    -535  d vs capCur    22,480 CI [11,080, 30,185]
  cap0.05       -59,625  uncov   588  worst    -550  p5    -530  d vs capCur         0 CI [0, 0]
  cap0.075      -80,380  uncov   494  worst    -550  p5    -520  d vs capCur   -20,755 CI [-28,325, -11,620]
  cap0.1        -95,835  uncov   423  worst    -550  p5    -510  d vs capCur   -36,210 CI [-50,355, -22,885]
  cap0.15       -95,900  uncov   269  worst    -550  p5    -150  d vs capCur   -36,275 CI [-54,830, -18,025]
  cap0.25      -119,320  uncov    95  worst    -550  p5    -250  d vs capCur   -59,695 CI [-84,260, -36,515]
  hold           23,227  uncov  5267  worst    -550  p5    -550  d vs capCur    82,852 CI [-47,922, 201,542]
v7-20 points (4151 events)
  actual       -739,067  uncov   777  worst  -1,150  p5  -1,110  d vs capCur   319,295 CI [282,355, 363,400]
  capCur     -1,058,362  uncov  1004  worst  -1,150  p5  -1,120
  payNow     -1,363,859  uncov     0  worst  -1,155  p5    -765  d vs capCur  -305,497 CI [-347,880, -216,652]
  cap0         -960,534  uncov  1379  worst  -1,150  p5  -1,125  d vs capCur    97,828 CI [51,435, 139,325]
  cap0.025     -982,117  uncov  1252  worst  -1,150  p5  -1,125  d vs capCur    76,245 CI [42,620, 117,830]
  cap0.05      -996,067  uncov  1105  worst  -1,150  p5  -1,120  d vs capCur    62,295 CI [46,995, 77,665]
  cap0.075   -1,058,362  uncov  1004  worst  -1,150  p5  -1,120  d vs capCur         0 CI [0, 0]
  cap0.1     -1,110,607  uncov   886  worst  -1,150  p5  -1,115  d vs capCur   -52,245 CI [-73,665, -33,915]
  cap0.15    -1,150,367  uncov   618  worst  -1,150  p5  -1,100  d vs capCur   -92,005 CI [-117,265, -67,245]
  cap0.25    -1,272,687  uncov   227  worst  -1,150  p5    -500  d vs capCur  -214,325 CI [-257,325, -147,150]
  hold         -936,856  uncov  4151  worst  -1,150  p5  -1,135  d vs capCur   121,506 CI [40,381, 292,384]
v7-20 c2o (5205 events)
  actual       -130,342  uncov   439  worst  -1,150  p5  -1,025  d vs capCur   139,554 CI [99,033, 153,349]
  capCur       -269,896  uncov   496  worst  -1,150  p5  -1,070
  payNow       -323,231  uncov     0  worst  -1,045  p5    -540  d vs capCur   -53,335 CI [-97,995, -25,180]
  cap0         -287,966  uncov  1001  worst  -1,150  p5  -1,115  d vs capCur   -18,070 CI [-61,345, 42,150]
  cap0.025     -289,156  uncov   818  worst  -1,150  p5  -1,105  d vs capCur   -19,260 CI [-46,070, 6,585]
  cap0.05      -269,811  uncov   642  worst  -1,150  p5  -1,085  d vs capCur        85 CI [-13,860, 15,955]
  cap0.075     -269,896  uncov   496  worst  -1,150  p5  -1,070  d vs capCur         0 CI [0, 0]
  cap0.1       -272,056  uncov   398  worst  -1,150  p5  -1,025  d vs capCur    -2,160 CI [-17,290, 13,165]
  cap0.15      -291,166  uncov   271  worst  -1,150  p5    -300  d vs capCur   -21,270 CI [-52,700, -2,690]
  cap0.25      -306,401  uncov    92  worst  -1,150  p5    -500  d vs capCur   -36,505 CI [-78,730, -7,035]
  hold         -119,289  uncov  5205  worst  -1,150  p5  -1,140  d vs capCur   150,607 CI [-97,750, 292,050]
v7-40 points (9393 events)
  actual     -2,250,941  uncov   777  worst  -2,350  p5  -2,025  d vs capCur 1,577,349 CI [1,422,774, 1,659,348]
  capCur     -3,828,290  uncov  1391  worst  -2,350  p5  -2,255
  payNow     -4,420,102  uncov     0  worst  -2,350  p5  -1,225  d vs capCur  -591,812 CI [-715,090, -449,126]
  cap0       -3,082,892  uncov  2582  worst  -2,350  p5  -2,295  d vs capCur   745,398 CI [540,366, 847,166]
  cap0.025   -3,316,682  uncov  2314  worst  -2,350  p5  -2,290  d vs capCur   511,608 CI [354,358, 603,822]
  cap0.05    -3,526,327  uncov  2031  worst  -2,350  p5  -2,285  d vs capCur   301,963 CI [190,784, 344,966]
  cap0.075   -3,668,663  uncov  1716  worst  -2,350  p5  -2,275  d vs capCur   159,627 CI [85,196, 202,667]
  cap0.1     -3,828,290  uncov  1391  worst  -2,350  p5  -2,255  d vs capCur         0 CI [0, 0]
  cap0.15    -4,047,579  uncov   817  worst  -2,350  p5  -2,160  d vs capCur  -219,289 CI [-302,465, -133,024]
  cap0.25    -4,233,140  uncov   234  worst  -2,350  p5  -1,000  d vs capCur  -404,850 CI [-502,524, -273,251]
  hold       -2,829,091  uncov  9393  worst  -2,350  p5  -2,320  d vs capCur   999,199 CI [411,862, 1,442,671]
v7-40 c2o (3063 events)
  actual        -80,204  uncov   129  worst  -2,350  p5    -400  d vs capCur   190,673 CI [166,033, 226,555]
  capCur       -270,877  uncov   168  worst  -2,350  p5  -1,600
  payNow       -297,392  uncov     0  worst  -2,095  p5    -835  d vs capCur   -26,515 CI [-68,315, 18,020]
  cap0         -254,959  uncov   560  worst  -2,350  p5  -2,295  d vs capCur    15,918 CI [-80,023, 64,216]
  cap0.025     -265,179  uncov   440  worst  -2,350  p5  -2,280  d vs capCur     5,698 CI [-62,490, 56,511]
  cap0.05      -262,519  uncov   331  worst  -2,350  p5  -2,260  d vs capCur     8,358 CI [-52,698, 34,715]
  cap0.075     -287,099  uncov   250  worst  -2,350  p5  -2,210  d vs capCur   -16,222 CI [-62,551, 5,070]
  cap0.1       -270,877  uncov   168  worst  -2,350  p5  -1,600  d vs capCur         0 CI [0, 0]
  cap0.15      -277,892  uncov    75  worst  -2,350  p5    -600  d vs capCur    -7,015 CI [-28,760, 37,440]
  cap0.25      -283,742  uncov     9  worst  -2,350  p5    -825  d vs capCur   -12,865 CI [-43,420, 31,725]
  hold          -98,581  uncov  3063  worst  -2,350  p5  -2,330  d vs capCur   172,296 CI [-246,108, 447,425]
v8-10 points (2969 events)
  actual       -276,111  uncov   640  worst    -550  p5    -540  d vs capCur    80,455 CI [70,210, 91,500]
  capCur       -356,566  uncov   753  worst    -550  p5    -545
  payNow       -527,846  uncov     0  worst    -555  p5    -400  d vs capCur  -171,280 CI [-203,805, -144,645]
  cap0         -343,626  uncov   943  worst    -550  p5    -545  d vs capCur    12,940 CI [3,605, 30,420]
  cap0.025     -355,156  uncov   856  worst    -550  p5    -545  d vs capCur     1,410 CI [-10,540, 13,950]
  cap0.05      -356,566  uncov   753  worst    -550  p5    -545  d vs capCur         0 CI [0, 0]
  cap0.075     -378,866  uncov   686  worst    -550  p5    -540  d vs capCur   -22,300 CI [-29,735, -16,650]
  cap0.1       -405,261  uncov   630  worst    -550  p5    -540  d vs capCur   -48,695 CI [-60,595, -41,855]
  cap0.15      -431,986  uncov   434  worst    -550  p5    -535  d vs capCur   -75,420 CI [-91,565, -65,385]
  cap0.25      -482,391  uncov   163  worst    -550  p5    -335  d vs capCur  -125,825 CI [-153,405, -103,415]
  hold         -386,245  uncov  2969  worst    -550  p5    -550  d vs capCur   -29,679 CI [-90,891, 9,777]
v8-10 c2o (1399 events)
  actual        -30,056  uncov   198  worst    -550  p5    -535  d vs capCur    19,380 CI [9,375, 28,395]
  capCur        -49,436  uncov   189  worst    -550  p5    -540
  payNow        -58,486  uncov     0  worst    -495  p5    -280  d vs capCur    -9,050 CI [-17,005, 2,720]
  cap0          -53,746  uncov   296  worst    -550  p5    -545  d vs capCur    -4,310 CI [-13,925, 4,605]
  cap0.025      -46,396  uncov   230  worst    -550  p5    -540  d vs capCur     3,040 CI [-2,150, 9,755]
  cap0.05       -49,436  uncov   189  worst    -550  p5    -540  d vs capCur         0 CI [0, 0]
  cap0.075      -52,126  uncov   152  worst    -550  p5    -535  d vs capCur    -2,690 CI [-7,465, 2,595]
  cap0.1        -47,776  uncov   110  worst    -550  p5    -525  d vs capCur     1,660 CI [-4,270, 6,600]
  cap0.15       -45,971  uncov    61  worst    -550  p5    -150  d vs capCur     3,465 CI [-4,300, 13,090]
  cap0.25       -55,196  uncov    15  worst    -550  p5    -250  d vs capCur    -5,760 CI [-12,175, 6,045]
  hold          -51,477  uncov  1399  worst    -550  p5    -550  d vs capCur    -2,041 CI [-49,886, 32,070]
v8-20 points (3901 events)
  actual       -712,208  uncov   691  worst  -1,150  p5  -1,105  d vs capCur   264,871 CI [228,493, 308,403]
  capCur       -977,079  uncov   855  worst  -1,150  p5  -1,115
  payNow     -1,270,206  uncov     0  worst  -1,125  p5    -715  d vs capCur  -293,127 CI [-335,164, -223,060]
  cap0         -915,446  uncov  1250  worst  -1,150  p5  -1,125  d vs capCur    61,633 CI [29,258, 99,870]
  cap0.025     -933,406  uncov  1131  worst  -1,150  p5  -1,125  d vs capCur    43,673 CI [17,059, 66,364]
  cap0.05      -928,129  uncov   970  worst  -1,150  p5  -1,120  d vs capCur    48,950 CI [33,005, 72,100]
  cap0.075     -977,079  uncov   855  worst  -1,150  p5  -1,115  d vs capCur         0 CI [0, 0]
  cap0.1     -1,012,284  uncov   729  worst  -1,150  p5  -1,110  d vs capCur   -35,205 CI [-51,905, -13,830]
  cap0.15    -1,075,059  uncov   502  worst  -1,150  p5  -1,095  d vs capCur   -97,980 CI [-128,860, -72,590]
  cap0.25    -1,204,594  uncov   168  worst  -1,150  p5    -500  d vs capCur  -227,515 CI [-266,840, -166,060]
  hold         -898,060  uncov  3901  worst  -1,150  p5  -1,135  d vs capCur    79,019 CI [685, 186,076]
v8-20 c2o (1567 events)
  actual        -48,453  uncov   141  worst  -1,150  p5  -1,080  d vs capCur    57,385 CI [43,420, 67,395]
  capCur       -105,838  uncov   164  worst  -1,150  p5  -1,100
  payNow       -107,323  uncov     0  worst  -1,050  p5    -510  d vs capCur    -1,485 CI [-15,770, 12,715]
  cap0         -117,003  uncov   331  worst  -1,150  p5  -1,125  d vs capCur   -11,165 CI [-32,850, 7,995]
  cap0.025     -113,843  uncov   265  worst  -1,150  p5  -1,120  d vs capCur    -8,005 CI [-27,910, 5,595]
  cap0.05      -104,003  uncov   204  worst  -1,150  p5  -1,110  d vs capCur     1,835 CI [-11,665, 12,265]
  cap0.075     -105,838  uncov   164  worst  -1,150  p5  -1,100  d vs capCur         0 CI [0, 0]
  cap0.1       -103,763  uncov   129  worst  -1,150  p5  -1,075  d vs capCur     2,075 CI [-4,845, 11,830]
  cap0.15       -99,428  uncov    75  worst  -1,150  p5    -300  d vs capCur     6,410 CI [-11,280, 22,985]
  cap0.25      -101,923  uncov    12  worst  -1,150  p5    -500  d vs capCur     3,915 CI [-10,785, 18,705]
  hold         -111,066  uncov  1567  worst  -1,150  p5  -1,140  d vs capCur    -5,228 CI [-83,508, 54,975]
v8-40 points (7953 events)
  actual     -1,973,367  uncov   583  worst  -2,350  p5  -1,900  d vs capCur 1,327,256 CI [1,168,858, 1,417,355]
  capCur     -3,300,623  uncov  1133  worst  -2,350  p5  -2,265
  payNow     -3,831,476  uncov     0  worst  -2,280  p5  -1,200  d vs capCur  -530,853 CI [-638,675, -464,248]
  cap0       -2,758,200  uncov  2153  worst  -2,350  p5  -2,300  d vs capCur   542,423 CI [411,532, 665,640]
  cap0.025   -2,920,809  uncov  1927  worst  -2,350  p5  -2,295  d vs capCur   379,814 CI [287,652, 466,804]
  cap0.05    -3,056,443  uncov  1673  worst  -2,350  p5  -2,290  d vs capCur   244,180 CI [157,807, 305,972]
  cap0.075   -3,186,519  uncov  1408  worst  -2,350  p5  -2,280  d vs capCur   114,104 CI [58,050, 159,854]
  cap0.1     -3,300,623  uncov  1133  worst  -2,350  p5  -2,265  d vs capCur         0 CI [0, 0]
  cap0.15    -3,516,533  uncov   656  worst  -2,350  p5  -2,180  d vs capCur  -215,910 CI [-267,560, -165,535]
  cap0.25    -3,670,113  uncov   147  worst  -2,350  p5  -1,000  d vs capCur  -369,490 CI [-472,930, -312,645]
  hold       -2,811,986  uncov  7953  worst  -2,350  p5  -2,325  d vs capCur   488,637 CI [229,637, 750,353]
v8-40 c2o (1147 events)
  actual         -4,825  uncov    53  worst  -2,350  p5    -400  d vs capCur   120,905 CI [101,735, 150,755]
  capCur       -125,730  uncov    86  worst  -2,350  p5  -2,215
  payNow        -92,840  uncov     0  worst  -1,640  p5    -815  d vs capCur    32,890 CI [10,505, 64,180]
  cap0         -150,888  uncov   259  worst  -2,350  p5  -2,310  d vs capCur   -25,158 CI [-74,000, 18,784]
  cap0.025     -155,470  uncov   205  worst  -2,350  p5  -2,305  d vs capCur   -29,740 CI [-78,422, 5,131]
  cap0.05      -142,728  uncov   158  worst  -2,350  p5  -2,285  d vs capCur   -16,998 CI [-51,430, 14,432]
  cap0.075     -137,428  uncov   123  worst  -2,350  p5  -2,250  d vs capCur   -11,698 CI [-31,995, 11,615]
  cap0.1       -125,730  uncov    86  worst  -2,350  p5  -2,215  d vs capCur         0 CI [0, 0]
  cap0.15       -96,130  uncov    29  worst  -2,350  p5    -600  d vs capCur    29,600 CI [11,000, 55,170]
  cap0.25       -92,795  uncov     3  worst  -2,275  p5    -815  d vs capCur    32,935 CI [10,335, 63,020]
  hold         -226,139  uncov  1147  worst  -2,350  p5  -2,335  d vs capCur  -100,409 CI [-227,771, 39,514]
v9-10 points (7081 events)
  actual       -898,422  uncov  2348  worst    -550  p5    -545  d vs capCur   158,059 CI [132,819, 178,147]
  capCur     -1,056,481  uncov  2301  worst    -550  p5    -545
  payNow     -1,401,898  uncov     0  worst    -555  p5    -435  d vs capCur  -345,417 CI [-386,477, -290,677]
  cap0       -1,049,261  uncov  2764  worst    -550  p5    -550  d vs capCur     7,220 CI [-18,980, 29,785]
  cap0.025   -1,058,301  uncov  2550  worst    -550  p5    -550  d vs capCur    -1,820 CI [-15,665, 19,515]
  cap0.05    -1,056,481  uncov  2301  worst    -550  p5    -545  d vs capCur         0 CI [0, 0]
  cap0.075   -1,084,216  uncov  2108  worst    -550  p5    -545  d vs capCur   -27,735 CI [-37,475, -10,000]
  cap0.1     -1,129,676  uncov  1944  worst    -550  p5    -545  d vs capCur   -73,195 CI [-87,660, -43,820]
  cap0.15    -1,190,051  uncov  1500  worst    -550  p5    -540  d vs capCur  -133,570 CI [-159,075, -101,965]
  cap0.25    -1,293,041  uncov   733  worst    -550  p5    -520  d vs capCur  -236,560 CI [-277,040, -198,270]
  hold       -1,060,106  uncov  7081  worst    -550  p5    -550  d vs capCur    -3,625 CI [-91,058, 121,724]
v9-20 points (8951 events)
  actual     -1,834,886  uncov  2337  worst  -1,150  p5  -1,120  d vs capCur   694,206 CI [585,550, 746,262]
  capCur     -2,529,092  uncov  2541  worst  -1,150  p5  -1,125
  payNow     -3,127,606  uncov     0  worst  -1,155  p5    -790  d vs capCur  -598,514 CI [-697,136, -427,667]
  cap0       -2,391,178  uncov  3379  worst  -1,150  p5  -1,130  d vs capCur   137,914 CI [67,178, 201,650]
  cap0.025   -2,429,331  uncov  3107  worst  -1,150  p5  -1,130  d vs capCur    99,761 CI [32,307, 134,513]
  cap0.05    -2,444,760  uncov  2802  worst  -1,150  p5  -1,125  d vs capCur    84,332 CI [36,929, 113,275]
  cap0.075   -2,529,092  uncov  2541  worst  -1,150  p5  -1,125  d vs capCur         0 CI [0, 0]
  cap0.1     -2,612,847  uncov  2273  worst  -1,150  p5  -1,120  d vs capCur   -83,755 CI [-109,660, -32,115]
  cap0.15    -2,742,077  uncov  1730  worst  -1,150  p5  -1,110  d vs capCur  -212,985 CI [-278,965, -120,785]
  cap0.25    -2,952,237  uncov   716  worst  -1,150  p5    -970  d vs capCur  -423,145 CI [-520,745, -268,275]
  hold       -2,267,501  uncov  8951  worst  -1,150  p5  -1,140  d vs capCur   261,591 CI [41,133, 463,908]
v9-40 points (13486 events)
  actual     -3,403,957  uncov  1456  worst  -2,350  p5  -2,145  d vs capCur 2,408,108 CI [2,157,172, 2,571,962]
  capCur     -5,812,065  uncov  2368  worst  -2,350  p5  -2,270
  payNow     -6,489,428  uncov     0  worst  -2,275  p5  -1,240  d vs capCur  -677,363 CI [-887,037, -470,144]
  cap0       -4,950,330  uncov  4139  worst  -2,350  p5  -2,305  d vs capCur   861,735 CI [565,369, 1,075,686]
  cap0.025   -5,215,787  uncov  3737  worst  -2,350  p5  -2,300  d vs capCur   596,278 CI [402,235, 721,367]
  cap0.05    -5,457,072  uncov  3321  worst  -2,350  p5  -2,295  d vs capCur   354,993 CI [208,198, 446,778]
  cap0.075   -5,643,473  uncov  2863  worst  -2,350  p5  -2,285  d vs capCur   168,592 CI [90,435, 218,190]
  cap0.1     -5,812,065  uncov  2368  worst  -2,350  p5  -2,270  d vs capCur         0 CI [0, 0]
  cap0.15    -6,023,791  uncov  1449  worst  -2,350  p5  -2,205  d vs capCur  -211,726 CI [-315,411, -97,934]
  cap0.25    -6,230,273  uncov   476  worst  -2,350  p5  -1,000  d vs capCur  -418,208 CI [-632,247, -217,244]
  hold       -4,894,324  uncov 13486  worst  -2,350  p5  -2,325  d vs capCur   917,741 CI [87,866, 1,572,516]
```

Sections 3-5 use the 75911 points-trigger give-ups only (c2o escalations: 21760, section 2 only).

## 3. Feature buckets (pooled v6-v9, per width)

n | cameBackBE% | mean gainLater (x W) | sum (payNow - cap0) $ [CI] | sum (payNow - capCur) $ [CI] | hold-loss mean. Positive (payNow - X) = paying now beat X in that bucket.

### 10W (16212 events)

```
z15
  [-inf,0)       n  1225  back  70.4%  gain 0.430  pay-cap0   -93,455 [-126,010, -69,685]    pay-cur   -92,905 [-127,220, -68,490]    hold -115
  [0,0.5)        n  1389  back  64.2%  gain 0.370  pay-cap0   -29,415 [-42,000, -3,040]      pay-cur   -32,350 [-44,325, -10,710]     hold -124
  [0.5,1)        n  3054  back  62.3%  gain 0.360  pay-cap0   -73,330 [-102,205, -27,110]    pay-cur   -97,775 [-128,285, -57,875]    hold -144
  [1,1.5)        n  3750  back  65.1%  gain 0.390  pay-cap0  -177,802 [-233,725, -137,402]   pay-cur  -175,002 [-219,064, -139,477]   hold -134
  [1.5,2)        n  2740  back  67.9%  gain 0.410  pay-cap0  -203,940 [-244,245, -153,265]   pay-cur  -180,730 [-218,060, -147,945]   hold -136
  [2,+inf)       n  4054  back  64.0%  gain 0.420  pay-cap0  -353,500 [-415,815, -278,510]   pay-cur  -298,460 [-350,005, -244,530]   hold -151
adv15
  [-inf,0)       n  1225  back  70.4%  gain 0.430  pay-cap0   -93,455 [-127,460, -67,810]    pay-cur   -92,905 [-127,835, -68,395]    hold -115
  [0,10)         n  1273  back  60.1%  gain 0.360  pay-cap0   -31,080 [-63,265, -14,335]     pay-cur   -37,930 [-66,690, -25,160]     hold -126
  [10,20)        n  2751  back  60.2%  gain 0.360  pay-cap0   -91,380 [-135,240, -41,925]    pay-cur   -93,570 [-133,060, -44,230]    hold -122
  [20,35)        n  4813  back  63.9%  gain 0.380  pay-cap0  -224,782 [-275,014, -160,801]   pay-cur  -217,837 [-263,404, -165,715]   hold -158
  [35,60)        n  4129  back  68.5%  gain 0.420  pay-cap0  -300,180 [-350,330, -228,840]   pay-cur  -276,050 [-305,535, -233,465]   hold -134
  [60,+inf)      n  2021  back  67.6%  gain 0.440  pay-cap0  -190,565 [-237,485, -134,430]   pay-cur  -158,930 [-197,460, -115,065]   hold -144
adv45
  [-inf,0)       n  4138  back  68.6%  gain 0.410  pay-cap0  -272,192 [-329,427, -227,199]   pay-cur  -257,187 [-303,725, -213,599]   hold -115
  [0,20)         n  3055  back  60.0%  gain 0.370  pay-cap0  -123,540 [-167,470, -81,565]    pay-cur  -133,015 [-166,915, -97,955]    hold -167
  [20,40)        n  3438  back  58.3%  gain 0.370  pay-cap0  -103,985 [-154,775, -63,760]    pay-cur  -110,010 [-162,720, -64,330]    hold -153
  [40,70)        n  2846  back  68.2%  gain 0.420  pay-cap0  -203,315 [-267,910, -160,250]   pay-cur  -188,865 [-244,230, -145,730]   hold -115
  [70,110)       n  1589  back  67.3%  gain 0.410  pay-cap0  -105,600 [-139,860, -63,785]    pay-cur   -94,630 [-120,625, -62,370]    hold -151
  [110,+inf)     n  1146  back  75.7%  gain 0.450  pay-cap0  -122,810 [-156,870, -87,945]    pay-cur   -93,515 [-121,655, -66,595]    hold -143
adv5
  [0,5)          n   522  back  60.3%  gain 0.350  pay-cap0   -10,450 [-26,625, 6,830]       pay-cur   -17,880 [-32,025, -3,565]      hold -104
  [5,10)         n  1649  back  56.7%  gain 0.340  pay-cap0   -25,370 [-64,130, 2,775]       pay-cur   -36,475 [-73,725, -17,520]     hold -160
  [10,20)        n  4332  back  59.4%  gain 0.360  pay-cap0  -140,765 [-198,365, -89,670]    pay-cur  -144,790 [-180,670, -106,610]   hold -161
  [20,+inf)      n  9701  back  69.3%  gain 0.420  pay-cap0  -755,237 [-912,197, -695,625]   pay-cur  -678,727 [-809,747, -599,150]   hold -126
runAdv
  [-inf,0)       n   605  back  58.7%  gain 0.340  pay-cap0   -30,695 [-52,475, -11,585]     pay-cur   -28,870 [-47,330, -10,840]     hold -132
  [0,40)         n  5425  back  62.8%  gain 0.370  pay-cap0  -225,627 [-299,772, -160,280]   pay-cur  -231,132 [-295,590, -180,104]   hold -127
  [40,80)        n  7019  back  65.8%  gain 0.410  pay-cap0  -410,170 [-465,550, -325,855]   pay-cur  -398,185 [-444,425, -334,670]   hold -146
  [80,120)       n  1996  back  66.9%  gain 0.420  pay-cap0  -152,580 [-194,895, -110,540]   pay-cur  -125,900 [-158,220, -99,205]    hold -150
  [120,+inf)     n  1167  back  71.6%  gain 0.450  pay-cap0  -112,370 [-144,885, -76,765]    pay-cur   -93,135 [-126,575, -60,265]    hold -128
pb15
  [-inf,0.2)     n  2519  back  69.0%  gain 0.400  pay-cap0  -140,925 [-187,555, -95,965]    pay-cur  -132,210 [-162,005, -91,405]    hold -109
  [0.2,0.5)      n  5770  back  63.0%  gain 0.390  pay-cap0  -334,172 [-418,547, -287,930]   pay-cur  -345,687 [-404,342, -303,595]   hold -145
  [0.5,0.8)      n  3035  back  58.5%  gain 0.380  pay-cap0  -137,375 [-223,545, -75,390]    pay-cur  -146,655 [-221,110, -104,320]   hold -152
  [0.8,1)        n  1722  back  66.5%  gain 0.400  pay-cap0  -113,040 [-163,750, -87,030]    pay-cur   -86,320 [-129,580, -56,055]    hold -162
  [1,+inf)       n  3166  back  71.4%  gain 0.420  pay-cap0  -205,930 [-263,680, -155,520]   pay-cur  -166,350 [-215,195, -122,305]   hold -123
pb60
  [-inf,0.2)     n  5488  back  62.9%  gain 0.380  pay-cap0  -264,770 [-316,435, -199,255]   pay-cur  -284,940 [-334,095, -215,305]   hold -137
  [0.2,0.5)      n  3466  back  62.9%  gain 0.390  pay-cap0  -174,772 [-238,325, -137,187]   pay-cur  -176,917 [-235,627, -141,205]   hold -147
  [0.5,0.8)      n  2738  back  68.7%  gain 0.420  pay-cap0  -217,175 [-264,665, -179,385]   pay-cur  -198,330 [-233,755, -168,500]   hold -139
  [0.8,1)        n  1588  back  65.2%  gain 0.410  pay-cap0  -105,600 [-141,470, -73,365]    pay-cur  -104,680 [-129,120, -78,520]    hold -131
  [1,+inf)       n  2932  back  68.4%  gain 0.410  pay-cap0  -169,125 [-214,400, -111,440]   pay-cur  -112,355 [-161,395, -61,620]    hold -134
ride15
  [-inf,0.5)     n 11986  back  63.0%  gain 0.390  pay-cap0  -645,487 [-705,719, -485,527]   pay-cur  -652,747 [-706,984, -536,117]   hold -142
  [0.5,1.5)      n  1221  back  69.1%  gain 0.420  pay-cap0  -104,735 [-138,025, -78,170]    pay-cur   -76,160 [-108,030, -52,385]    hold -118
  [1.5,3.5)      n   951  back  69.1%  gain 0.430  pay-cap0   -55,035 [-78,230, -17,975]     pay-cur   -51,345 [-73,585, -26,545]     hold -101
  [3.5,+inf)     n  2054  back  72.9%  gain 0.410  pay-cap0  -126,185 [-154,325, -69,330]    pay-cur   -96,970 [-118,315, -59,195]    hold -147
ride60
  [-inf,0.5)     n 12392  back  64.3%  gain 0.390  pay-cap0  -712,897 [-845,196, -560,627]   pay-cur  -711,917 [-813,086, -600,162]   hold -141
  [0.5,1.5)      n   934  back  61.8%  gain 0.400  pay-cap0   -53,570 [-80,260, -32,040]     pay-cur   -51,095 [-71,805, -29,255]     hold -119
  [1.5,3.5)      n   566  back  71.0%  gain 0.420  pay-cap0   -43,545 [-66,775, -23,065]     pay-cur   -34,845 [-54,385, -18,860]     hold -84
  [3.5,+inf)     n  2320  back  69.0%  gain 0.410  pay-cap0  -121,430 [-159,880, -72,150]    pay-cur   -79,365 [-111,525, -45,380]    hold -143
t15
  [-inf,-0.5)    n  4447  back  69.3%  gain 0.410  pay-cap0  -269,300 [-329,205, -202,345]   pay-cur  -219,050 [-265,700, -176,820]   hold -125
  [-0.5,0.5)     n  1723  back  65.6%  gain 0.400  pay-cap0  -116,485 [-150,965, -80,260]    pay-cur  -101,855 [-127,545, -66,095]    hold -142
  [0.5,+inf)     n 10042  back  63.1%  gain 0.390  pay-cap0  -545,657 [-615,759, -468,747]   pay-cur  -556,317 [-616,290, -500,070]   hold -143
t60
  [-inf,-0.5)    n  4888  back  66.8%  gain 0.410  pay-cap0  -307,575 [-368,495, -241,525]   pay-cur  -248,070 [-305,700, -195,380]   hold -136
  [-0.5,0.5)     n  2470  back  68.4%  gain 0.410  pay-cap0  -175,695 [-238,865, -136,715]   pay-cur  -151,480 [-206,890, -113,685]   hold -114
  [0.5,+inf)     n  8854  back  63.2%  gain 0.390  pay-cap0  -448,172 [-569,939, -321,162]   pay-cur  -477,672 [-593,544, -412,970]   hold -147
tA
  [-inf,-0.5)    n  3567  back  70.4%  gain 0.420  pay-cap0  -229,445 [-315,040, -163,105]   pay-cur  -176,060 [-242,525, -120,235]   hold -128
  [-0.5,0.5)     n  5126  back  63.5%  gain 0.390  pay-cap0  -279,970 [-341,405, -213,040]   pay-cur  -267,640 [-308,405, -222,130]   hold -142
  [0.5,+inf)     n  7519  back  63.6%  gain 0.390  pay-cap0  -422,027 [-527,929, -368,350]   pay-cur  -433,522 [-534,897, -399,467]   hold -140
dEma15
  [-inf,-0.5)    n   710  back  75.3%  gain 0.430  pay-cap0   -55,315 [-83,645, -35,890]     pay-cur   -43,370 [-65,020, -29,655]     hold -126
  [-0.5,0)       n  4505  back  67.1%  gain 0.400  pay-cap0  -284,750 [-370,100, -246,165]   pay-cur  -279,690 [-353,755, -246,025]   hold -108
  [0,0.5)        n  5947  back  59.6%  gain 0.380  pay-cap0  -257,082 [-357,417, -207,620]   pay-cur  -269,222 [-346,959, -225,161]   hold -161
  [0.5,1)        n  2932  back  66.0%  gain 0.410  pay-cap0  -176,755 [-205,225, -120,075]   pay-cur  -160,735 [-194,535, -119,130]   hold -156
  [1,+inf)       n  2118  back  71.5%  gain 0.420  pay-cap0  -157,540 [-197,225, -116,205]   pay-cur  -124,205 [-154,195, -89,285]    hold -120
dMid15
  [-inf,-0.5)    n  3557  back  69.0%  gain 0.400  pay-cap0  -221,255 [-292,575, -192,450]   pay-cur  -212,035 [-269,340, -170,945]   hold -108
  [-0.5,0)       n  4781  back  61.5%  gain 0.380  pay-cap0  -252,892 [-294,640, -200,762]   pay-cur  -265,097 [-311,850, -217,387]   hold -153
  [0,0.5)        n  2612  back  58.5%  gain 0.380  pay-cap0  -124,405 [-164,835, -81,035]    pay-cur  -126,505 [-173,540, -86,235]    hold -158
  [0.5,1)        n  2118  back  65.4%  gain 0.400  pay-cap0  -129,545 [-175,600, -101,935]   pay-cur  -108,970 [-151,225, -87,085]    hold -152
  [1,+inf)       n  3144  back  71.3%  gain 0.420  pay-cap0  -203,345 [-246,785, -132,625]   pay-cur  -164,615 [-215,490, -104,035]   hold -124
dEma60
  [-inf,-0.5)    n  3709  back  66.3%  gain 0.400  pay-cap0  -192,840 [-270,355, -148,600]   pay-cur  -196,725 [-255,785, -155,360]   hold -108
  [-0.5,0)       n  4949  back  60.7%  gain 0.380  pay-cap0  -253,090 [-346,810, -201,735]   pay-cur  -268,135 [-339,305, -229,760]   hold -162
  [0,0.5)        n  3175  back  64.9%  gain 0.400  pay-cap0  -200,847 [-247,772, -154,044]   pay-cur  -189,682 [-225,042, -146,496]   hold -149
  [0.5,1)        n  2207  back  68.3%  gain 0.420  pay-cap0  -147,895 [-206,935, -95,865]    pay-cur  -121,655 [-170,065, -79,040]    hold -111
  [1,+inf)       n  2172  back  70.1%  gain 0.410  pay-cap0  -136,770 [-197,180, -75,060]    pay-cur  -101,025 [-149,095, -46,635]    hold -146
dMid60
  [-inf,-0.5)    n  6205  back  62.9%  gain 0.380  pay-cap0  -294,765 [-366,180, -212,605]   pay-cur  -320,515 [-391,720, -263,855]   hold -136
  [-0.5,0)       n  2781  back  62.9%  gain 0.390  pay-cap0  -146,747 [-198,835, -103,222]   pay-cur  -142,847 [-199,217, -100,287]   hold -152
  [0,0.5)        n  2303  back  70.0%  gain 0.430  pay-cap0  -193,610 [-246,590, -154,805]   pay-cur  -171,605 [-219,145, -137,580]   hold -136
  [0.5,1)        n  2013  back  64.6%  gain 0.410  pay-cap0  -130,725 [-149,235, -83,305]    pay-cur  -132,530 [-145,895, -87,340]    hold -131
  [1,+inf)       n  2910  back  68.3%  gain 0.400  pay-cap0  -165,595 [-227,025, -115,350]   pay-cur  -109,725 [-175,025, -59,425]    hold -137
tod
  [09:30,10:30)  n  3467  back  73.6%  gain 0.410  pay-cap0  -156,255 [-225,710, -110,415]   pay-cur  -166,245 [-212,305, -129,825]   hold -114
  [10:30,12:00)  n  4398  back  73.3%  gain 0.420  pay-cap0  -238,710 [-282,320, -195,140]   pay-cur  -231,965 [-280,590, -193,425]   hold -114
  [12:00,14:00)  n  4549  back  67.6%  gain 0.410  pay-cap0  -282,640 [-358,185, -242,435]   pay-cur  -250,910 [-311,780, -210,090]   hold -118
  [14:00,15:00)  n  2210  back  56.6%  gain 0.400  pay-cap0  -151,985 [-194,160, -105,990]   pay-cur  -135,795 [-177,705, -94,615]    hold -180
  [15:00,16:00)  n  1588  back  28.2%  gain 0.260  pay-cap0  -101,852 [-136,760, -73,900]    pay-cur   -92,307 [-127,445, -65,265]    hold -259
overBE
  [-inf,0)       n    21  back 100.0%  gain 0.390  pay-cap0         0 [0, 0]                 pay-cur         0 [0, 0]                 hold -28
  [0,0.05)       n   551  back  84.4%  gain 0.300  pay-cap0    29,580 [16,485, 46,580]       pay-cur         0 [0, 0]                 hold -81
  [0.05,0.1)     n   978  back  79.5%  gain 0.330  pay-cap0    43,670 [21,620, 69,700]       pay-cur    20,205 [10,010, 33,225]       hold -62
  [0.1,0.2)      n  4691  back  73.4%  gain 0.390  pay-cap0  -118,995 [-174,220, -79,400]    pay-cur   -94,100 [-141,970, -60,285]    hold -92
  [0.2,+inf)     n  9971  back  58.6%  gain 0.410  pay-cap0  -885,697 [-976,897, -813,360]   pay-cur  -803,327 [-889,872, -747,716]   hold -171
openFrac
  [-inf,0.15)    n   872  back  28.9%  gain 0.260  pay-cap0  -101,887 [-124,652, -80,153]    pay-cur   -92,427 [-114,122, -70,842]    hold -265
  [0.15,0.3)     n  4383  back  58.2%  gain 0.400  pay-cap0  -292,270 [-374,910, -215,655]   pay-cur  -244,275 [-320,435, -179,370]   hold -179
  [0.3,0.45)     n  7926  back  68.0%  gain 0.400  pay-cap0  -376,170 [-439,290, -286,260]   pay-cur  -395,190 [-436,940, -336,555]   hold -134
  [0.45,+inf)    n  3031  back  77.7%  gain 0.420  pay-cap0  -161,115 [-216,395, -105,675]   pay-cur  -145,330 [-191,400, -107,050]   hold -54
```

### 20W (20909 events)

```
z15
  [-inf,0)       n  1832  back  70.3%  gain 0.400  pay-cap0  -265,810 [-328,645, -215,050]   pay-cur  -181,665 [-235,700, -148,920]   hold -152
  [0,0.5)        n  2153  back  61.8%  gain 0.340  pay-cap0   -42,235 [-128,500, 47,420]     pay-cur   -55,685 [-127,890, 4,100]      hold -210
  [0.5,1)        n  4276  back  63.1%  gain 0.360  pay-cap0  -128,425 [-268,690, -6,895]     pay-cur  -168,500 [-243,555, -108,870]   hold -215
  [1,1.5)        n  4447  back  65.3%  gain 0.380  pay-cap0  -267,600 [-391,294, -139,790]   pay-cur  -205,275 [-299,375, -98,853]    hold -248
  [1.5,2)        n  3383  back  68.4%  gain 0.400  pay-cap0  -395,566 [-476,790, -325,645]   pay-cur  -281,880 [-343,710, -206,180]   hold -250
  [2,+inf)       n  4818  back  64.6%  gain 0.420  pay-cap0  -750,857 [-894,967, -580,082]   pay-cur  -598,180 [-718,740, -451,665]   hold -291
adv15
  [-inf,0)       n  1832  back  70.3%  gain 0.400  pay-cap0  -265,810 [-327,850, -212,140]   pay-cur  -181,665 [-235,095, -145,130]   hold -152
  [0,10)         n  2114  back  60.4%  gain 0.340  pay-cap0   -72,605 [-157,430, -19,100]    pay-cur   -70,080 [-128,445, -42,000]    hold -207
  [10,20)        n  3985  back  61.0%  gain 0.350  pay-cap0  -163,250 [-333,025, -94,155]    pay-cur  -170,090 [-253,095, -114,050]   hold -212
  [20,35)        n  5735  back  64.9%  gain 0.380  pay-cap0  -364,399 [-538,499, -211,595]   pay-cur  -298,030 [-382,563, -185,432]   hold -251
  [35,60)        n  4748  back  69.2%  gain 0.410  pay-cap0  -603,092 [-700,392, -462,320]   pay-cur  -466,835 [-534,160, -338,905]   hold -247
  [60,+inf)      n  2495  back  65.9%  gain 0.430  pay-cap0  -381,337 [-477,309, -247,582]   pay-cur  -304,485 [-371,390, -220,785]   hold -331
adv45
  [-inf,0)       n  5623  back  66.7%  gain 0.390  pay-cap0  -608,044 [-676,552, -510,340]   pay-cur  -488,402 [-560,582, -368,690]   hold -197
  [0,20)         n  4145  back  61.4%  gain 0.350  pay-cap0  -224,950 [-356,590, -163,370]   pay-cur  -165,040 [-264,845, -101,245]   hold -293
  [20,40)        n  4283  back  62.9%  gain 0.370  pay-cap0  -232,092 [-349,127, -155,789]   pay-cur  -233,680 [-350,950, -159,210]   hold -221
  [40,70)        n  3704  back  68.3%  gain 0.410  pay-cap0  -416,548 [-513,473, -303,355]   pay-cur  -321,958 [-371,823, -248,268]   hold -213
  [70,110)       n  1988  back  66.0%  gain 0.390  pay-cap0  -171,604 [-253,584, -86,425]    pay-cur  -118,115 [-184,180, -40,070]    hold -316
  [110,+inf)     n  1166  back  70.5%  gain 0.440  pay-cap0  -197,255 [-263,585, -97,865]    pay-cur  -163,990 [-216,765, -113,510]   hold -271
adv5
  [0,5)          n   786  back  60.4%  gain 0.330  pay-cap0   -20,700 [-66,460, 17,115]      pay-cur   -14,565 [-40,560, 20,110]      hold -162
  [5,10)         n  2562  back  60.3%  gain 0.330  pay-cap0   -36,938 [-79,905, 45,420]      pay-cur   -61,283 [-105,708, 9,096]      hold -247
  [10,20)        n  6195  back  62.4%  gain 0.360  pay-cap0  -272,495 [-402,125, -136,410]   pay-cur  -181,905 [-261,485, -94,925]    hold -236
  [20,+inf)      n 11360  back  68.3%  gain 0.420  pay-cap0 -1,520,820 [-1,701,026, -1,283,834] pay-cur -1,232,682 [-1,327,150, -1,086,344] hold -245
runAdv
  [-inf,0)       n  2036  back  60.0%  gain 0.330  pay-cap0  -105,665 [-181,395, -43,400]    pay-cur   -87,800 [-148,040, -41,295]    hold -175
  [0,40)         n  6523  back  63.2%  gain 0.360  pay-cap0  -341,147 [-502,392, -228,654]   pay-cur  -291,917 [-398,482, -191,724]   hold -207
  [40,80)        n  8533  back  66.9%  gain 0.400  pay-cap0  -882,712 [-1,054,728, -655,159] pay-cur  -695,203 [-831,296, -543,963]   hold -266
  [80,120)       n  2519  back  68.0%  gain 0.430  pay-cap0  -336,479 [-456,195, -274,584]   pay-cur  -265,015 [-340,670, -197,910]   hold -277
  [120,+inf)     n  1298  back  68.0%  gain 0.430  pay-cap0  -184,490 [-285,190, -121,430]   pay-cur  -151,250 [-234,070, -95,575]    hold -253
pb15
  [-inf,0.2)     n  3105  back  70.1%  gain 0.410  pay-cap0  -421,746 [-553,265, -322,085]   pay-cur  -291,570 [-387,065, -200,300]   hold -125
  [0.2,0.5)      n  7965  back  63.4%  gain 0.370  pay-cap0  -617,610 [-760,133, -387,923]   pay-cur  -528,572 [-686,942, -409,012]   hold -244
  [0.5,0.8)      n  4068  back  61.2%  gain 0.370  pay-cap0  -325,884 [-452,865, -220,849]   pay-cur  -272,970 [-348,530, -176,190]   hold -285
  [0.8,1)        n  2191  back  67.5%  gain 0.390  pay-cap0  -205,023 [-325,549, -118,458]   pay-cur  -131,528 [-220,511, -75,573]    hold -269
  [1,+inf)       n  3580  back  68.5%  gain 0.400  pay-cap0  -280,230 [-349,965, -174,590]   pay-cur  -266,545 [-328,335, -190,270]   hold -258
pb60
  [-inf,0.2)     n  7206  back  63.9%  gain 0.380  pay-cap0  -630,572 [-775,390, -523,537]   pay-cur  -477,345 [-562,205, -373,605]   hold -205
  [0.2,0.5)      n  4512  back  63.2%  gain 0.380  pay-cap0  -347,553 [-481,912, -140,053]   pay-cur  -318,397 [-461,876, -198,092]   hold -250
  [0.5,0.8)      n  3868  back  67.9%  gain 0.390  pay-cap0  -375,900 [-507,830, -156,275]   pay-cur  -289,020 [-344,860, -154,200]   hold -275
  [0.8,1)        n  1936  back  67.2%  gain 0.410  pay-cap0  -252,668 [-349,328, -191,405]   pay-cur  -217,963 [-288,828, -172,775]   hold -222
  [1,+inf)       n  3387  back  67.0%  gain 0.390  pay-cap0  -243,800 [-348,380, -97,020]    pay-cur  -188,460 [-260,460, -78,210]    hold -267
ride15
  [-inf,0.5)     n 15929  back  64.0%  gain 0.380  pay-cap0 -1,413,265 [-1,756,536, -1,040,611] pay-cur -1,123,157 [-1,349,886, -841,132] hold -236
  [0.5,1.5)      n  1544  back  68.3%  gain 0.430  pay-cap0  -207,330 [-304,375, -111,560]   pay-cur  -148,485 [-209,825, -80,980]    hold -237
  [1.5,3.5)      n  1227  back  70.0%  gain 0.400  pay-cap0  -103,173 [-166,970, -35,364]    pay-cur   -75,773 [-129,368, -30,385]    hold -208
  [3.5,+inf)     n  2209  back  69.3%  gain 0.390  pay-cap0  -126,725 [-216,285, -540]       pay-cur  -143,770 [-206,200, -88,450]    hold -280
ride60
  [-inf,0.5)     n 16454  back  64.7%  gain 0.380  pay-cap0 -1,473,773 [-1,687,302, -1,218,573] pay-cur -1,198,340 [-1,361,103, -982,247] hold -238
  [0.5,1.5)      n  1029  back  65.5%  gain 0.410  pay-cap0  -129,700 [-192,940, -77,125]    pay-cur  -103,220 [-143,315, -68,095]    hold -210
  [1.5,3.5)      n   715  back  68.4%  gain 0.400  pay-cap0   -77,125 [-131,845, -26,725]    pay-cur   -60,110 [-92,135, -22,410]     hold -164
  [3.5,+inf)     n  2711  back  67.6%  gain 0.390  pay-cap0  -169,895 [-281,295, -10,015]    pay-cur  -129,515 [-197,995, -38,010]    hold -276
t15
  [-inf,-0.5)    n  5394  back  68.8%  gain 0.390  pay-cap0  -447,628 [-559,248, -260,875]   pay-cur  -356,308 [-445,498, -257,756]   hold -248
  [-0.5,0.5)     n  2102  back  65.3%  gain 0.390  pay-cap0  -198,975 [-284,725, -120,835]   pay-cur  -162,780 [-232,720, -99,755]    hold -277
  [0.5,+inf)     n 13413  back  63.9%  gain 0.380  pay-cap0 -1,203,890 [-1,315,512, -913,887] pay-cur  -972,097 [-1,096,302, -785,542] hold -230
t60
  [-inf,-0.5)    n  6074  back  66.6%  gain 0.390  pay-cap0  -551,899 [-773,241, -427,566]   pay-cur  -387,113 [-555,095, -294,130]   hold -249
  [-0.5,0.5)     n  3271  back  68.9%  gain 0.400  pay-cap0  -369,076 [-457,608, -228,690]   pay-cur  -316,855 [-391,950, -200,565]   hold -196
  [0.5,+inf)     n 11564  back  63.5%  gain 0.380  pay-cap0  -929,518 [-1,216,379, -656,954] pay-cur  -787,217 [-995,547, -661,739]   hold -246
tA
  [-inf,-0.5)    n  4251  back  69.4%  gain 0.400  pay-cap0  -386,295 [-480,400, -299,475]   pay-cur  -307,575 [-404,225, -230,955]   hold -246
  [-0.5,0.5)     n  6788  back  64.2%  gain 0.380  pay-cap0  -554,380 [-683,458, -443,005]   pay-cur  -433,083 [-568,733, -325,181]   hold -244
  [0.5,+inf)     n  9870  back  64.2%  gain 0.380  pay-cap0  -909,818 [-1,048,388, -699,323] pay-cur  -750,527 [-847,210, -632,335]   hold -233
dEma15
  [-inf,-0.5)    n   806  back  73.2%  gain 0.430  pay-cap0  -129,470 [-191,980, -83,575]    pay-cur   -96,715 [-141,270, -65,570]    hold -200
  [-0.5,0)       n  6249  back  66.0%  gain 0.390  pay-cap0  -619,406 [-735,145, -506,152]   pay-cur  -466,825 [-560,345, -362,855]   hold -177
  [0,0.5)        n  7931  back  63.1%  gain 0.370  pay-cap0  -610,689 [-785,550, -431,214]   pay-cur  -474,882 [-578,902, -358,107]   hold -266
  [0.5,1)        n  3572  back  65.3%  gain 0.390  pay-cap0  -285,033 [-395,365, -147,395]   pay-cur  -252,133 [-324,175, -156,950]   hold -274
  [1,+inf)       n  2351  back  67.9%  gain 0.410  pay-cap0  -205,895 [-312,910, -112,445]   pay-cur  -200,630 [-286,160, -120,565]   hold -274
dMid15
  [-inf,-0.5)    n  4558  back  68.9%  gain 0.400  pay-cap0  -575,476 [-733,627, -433,217]   pay-cur  -413,425 [-512,720, -277,775]   hold -157
  [-0.5,0)       n  6563  back  62.7%  gain 0.370  pay-cap0  -466,640 [-623,722, -283,364]   pay-cur  -417,687 [-550,760, -321,789]   hold -246
  [0,0.5)        n  3495  back  60.9%  gain 0.370  pay-cap0  -289,059 [-391,664, -221,092]   pay-cur  -220,590 [-293,965, -157,490]   hold -285
  [0.5,1)        n  2735  back  66.7%  gain 0.390  pay-cap0  -239,238 [-365,670, -141,491]   pay-cur  -175,088 [-276,930, -120,791]   hold -281
  [1,+inf)       n  3558  back  68.5%  gain 0.400  pay-cap0  -280,080 [-385,840, -184,675]   pay-cur  -264,395 [-335,485, -183,905]   hold -256
dEma60
  [-inf,-0.5)    n  4810  back  65.5%  gain 0.390  pay-cap0  -460,401 [-560,206, -354,056]   pay-cur  -330,335 [-404,645, -252,300]   hold -173
  [-0.5,0)       n  6648  back  63.5%  gain 0.380  pay-cap0  -594,597 [-779,502, -468,373]   pay-cur  -492,945 [-636,575, -391,900]   hold -250
  [0,0.5)        n  4282  back  64.0%  gain 0.380  pay-cap0  -318,510 [-428,886, -206,023]   pay-cur  -292,485 [-344,531, -191,197]   hold -261
  [0.5,1)        n  2718  back  69.2%  gain 0.410  pay-cap0  -295,625 [-392,230, -161,460]   pay-cur  -218,030 [-287,595, -142,820]   hold -275
  [1,+inf)       n  2451  back  67.3%  gain 0.390  pay-cap0  -181,360 [-256,705, -85,235]    pay-cur  -157,390 [-220,205, -93,725]    hold -263
dMid60
  [-inf,-0.5)    n  8194  back  63.8%  gain 0.380  pay-cap0  -699,676 [-975,935, -482,898]   pay-cur  -555,950 [-780,165, -394,930]   hold -203
  [-0.5,0)       n  3547  back  63.1%  gain 0.380  pay-cap0  -283,404 [-406,053, -161,621]   pay-cur  -242,197 [-328,982, -145,859]   hold -267
  [0,0.5)        n  3282  back  68.8%  gain 0.390  pay-cap0  -344,450 [-512,565, -224,845]   pay-cur  -251,565 [-360,400, -177,845]   hold -264
  [0.5,1)        n  2521  back  66.2%  gain 0.400  pay-cap0  -283,178 [-369,220, -193,385]   pay-cur  -254,178 [-347,320, -183,163]   hold -241
  [1,+inf)       n  3365  back  66.9%  gain 0.390  pay-cap0  -239,785 [-329,250, -102,700]   pay-cur  -187,295 [-247,670, -97,065]    hold -272
tod
  [09:30,10:30)  n  3823  back  71.9%  gain 0.400  pay-cap0  -229,175 [-343,405, -73,710]    pay-cur  -198,990 [-265,325, -75,760]    hold -232
  [10:30,12:00)  n  5395  back  72.5%  gain 0.400  pay-cap0  -410,394 [-561,169, -244,364]   pay-cur  -341,165 [-446,255, -254,925]   hold -212
  [12:00,14:00)  n  6312  back  69.3%  gain 0.400  pay-cap0  -594,420 [-749,030, -450,105]   pay-cur  -453,255 [-543,290, -360,815]   hold -200
  [14:00,15:00)  n  3291  back  58.5%  gain 0.380  pay-cap0  -303,425 [-427,755, -188,520]   pay-cur  -247,755 [-342,280, -130,790]   hold -287
  [15:00,16:00)  n  2088  back  33.0%  gain 0.270  pay-cap0  -313,079 [-398,172, -222,332]   pay-cur  -250,020 [-333,107, -182,130]   hold -364
overBE
  [0.05,0.1)     n  1301  back  79.3%  gain 0.340  pay-cap0    70,150 [28,245, 126,570]      pay-cur    35,575 [8,840, 64,970]        hold -86
  [0.1,0.2)      n  6674  back  73.7%  gain 0.370  pay-cap0     9,667 [-135,709, 180,527]    pay-cur     9,755 [-65,130, 139,815]     hold -109
  [0.2,+inf)     n 12931  back  59.5%  gain 0.400  pay-cap0 -1,930,090 [-2,264,927, -1,680,508] pay-cur -1,536,515 [-1,789,127, -1,436,381] hold -322
openFrac
  [-inf,0.15)    n   741  back  27.7%  gain 0.270  pay-cap0  -217,127 [-282,279, -179,732]   pay-cur  -180,657 [-236,940, -145,775]   hold -465
  [0.15,0.3)     n  2586  back  51.9%  gain 0.410  pay-cap0  -566,852 [-673,327, -443,180]   pay-cur  -463,233 [-558,888, -361,323]   hold -327
  [0.3,0.45)     n 11498  back  65.0%  gain 0.400  pay-cap0 -1,024,986 [-1,209,645, -747,071] pay-cur  -812,480 [-988,805, -684,235]   hold -265
  [0.45,+inf)    n  6084  back  76.1%  gain 0.370  pay-cap0   -41,528 [-147,852, 4,725]      pay-cur   -34,815 [-124,790, 35,765]     hold -125
```

### 40W (38790 events)

```
z15
  [-inf,0)       n  7555  back  75.3%  gain 0.370  pay-cap0 -1,134,417 [-1,347,231, -782,816] pay-cur  -411,414 [-519,483, -241,430]   hold -188
  [0,0.5)        n  7201  back  70.9%  gain 0.340  pay-cap0  -277,899 [-568,339, 63,530]     pay-cur   -21,419 [-146,449, 115,726]    hold -236
  [0.5,1)        n  8375  back  69.9%  gain 0.350  pay-cap0  -391,368 [-730,083, -39,756]    pay-cur  -120,048 [-228,035, 76,066]     hold -332
  [1,1.5)        n  6580  back  72.1%  gain 0.380  pay-cap0  -886,334 [-1,148,078, -656,276] pay-cur  -424,880 [-576,545, -258,425]   hold -427
  [1.5,2)        n  3933  back  73.1%  gain 0.390  pay-cap0  -884,737 [-1,090,530, -578,225] pay-cur  -429,220 [-611,730, -237,510]   hold -481
  [2,+inf)       n  5146  back  67.8%  gain 0.420  pay-cap0 -1,449,845 [-1,807,255, -1,134,085] pay-cur  -928,520 [-1,089,530, -715,805] hold -533
adv15
  [-inf,0)       n  7555  back  75.3%  gain 0.370  pay-cap0 -1,134,417 [-1,355,779, -816,291] pay-cur  -411,414 [-531,178, -241,915]   hold -188
  [0,10)         n  6864  back  69.7%  gain 0.340  pay-cap0  -356,809 [-795,299, -7,504]     pay-cur   -12,259 [-210,483, 179,843]    hold -238
  [10,20)        n  8155  back  70.3%  gain 0.350  pay-cap0  -546,843 [-766,193, -185,942]   pay-cur  -240,393 [-443,917, -68,944]    hold -312
  [20,35)        n  8119  back  70.6%  gain 0.370  pay-cap0  -915,178 [-1,133,337, -671,121] pay-cur  -454,960 [-645,260, -213,630]   hold -449
  [35,60)        n  5476  back  73.2%  gain 0.400  pay-cap0 -1,237,853 [-1,524,198, -937,830] pay-cur  -679,875 [-876,365, -508,985]   hold -465
  [60,+inf)      n  2621  back  68.9%  gain 0.430  pay-cap0  -833,500 [-1,086,300, -559,040] pay-cur  -536,600 [-690,955, -369,055]   hold -595
adv45
  [-inf,0)       n 13918  back  72.1%  gain 0.360  pay-cap0 -1,564,034 [-2,057,185, -857,393] pay-cur  -663,819 [-788,994, -375,743]   hold -247
  [0,20)         n  8092  back  69.7%  gain 0.340  pay-cap0  -681,996 [-993,953, -333,445]   pay-cur  -208,646 [-427,526, -53,946]    hold -334
  [20,40)        n  6714  back  70.5%  gain 0.360  pay-cap0  -693,398 [-955,457, -356,115]   pay-cur  -357,987 [-548,092, -39,173]    hold -346
  [40,70)        n  5548  back  72.8%  gain 0.390  pay-cap0  -955,493 [-1,233,946, -678,118] pay-cur  -443,389 [-594,174, -217,779]   hold -438
  [70,110)       n  2813  back  72.2%  gain 0.390  pay-cap0  -562,034 [-731,707, -327,090]   pay-cur  -273,585 [-394,590, -125,695]   hold -571
  [110,+inf)     n  1705  back  75.0%  gain 0.430  pay-cap0  -567,645 [-761,450, -389,270]   pay-cur  -388,075 [-527,960, -273,440]   hold -501
adv5
  [-inf,0)       n  1115  back  73.2%  gain 0.320  pay-cap0   -61,763 [-185,855, 17,880]     pay-cur     3,837 [-38,528, 20,277]      hold -34
  [0,5)          n  3518  back  72.8%  gain 0.330  pay-cap0  -234,246 [-484,614, -111,691]   pay-cur   -17,355 [-104,935, 57,975]     hold -151
  [5,10)         n  6730  back  71.8%  gain 0.340  pay-cap0  -285,322 [-594,561, -12,113]    pay-cur   -17,429 [-118,995, 141,766]    hold -252
  [10,20)        n 12341  back  71.8%  gain 0.360  pay-cap0 -1,130,420 [-1,362,914, -755,228] pay-cur  -410,169 [-694,161, -192,979]   hold -327
  [20,+inf)      n 15086  back  70.8%  gain 0.400  pay-cap0 -3,312,849 [-3,730,882, -2,465,853] pay-cur -1,894,385 [-2,081,155, -1,275,715] hold -467
runAdv
  [-inf,0)       n  9782  back  73.3%  gain 0.350  pay-cap0  -897,797 [-1,265,455, -606,776] pay-cur  -231,161 [-468,824, -152,044]   hold -132
  [0,40)         n 12287  back  70.2%  gain 0.350  pay-cap0  -862,372 [-1,513,720, -346,515] pay-cur  -296,794 [-568,359, -19,362]    hold -347
  [40,80)        n 11200  back  71.4%  gain 0.390  pay-cap0 -1,992,118 [-2,303,261, -1,522,189] pay-cur -1,059,346 [-1,291,209, -766,695] hold -445
  [80,120)       n  3486  back  71.5%  gain 0.400  pay-cap0  -725,593 [-997,636, -509,362]   pay-cur  -388,410 [-526,740, -291,130]   hold -505
  [120,+inf)     n  2035  back  72.7%  gain 0.420  pay-cap0  -546,720 [-721,215, -322,045]   pay-cur  -359,790 [-490,470, -242,245]   hold -514
pb15
  [-inf,0.2)     n  8523  back  73.8%  gain 0.370  pay-cap0  -974,175 [-1,329,195, -738,770] pay-cur  -320,260 [-417,975, -130,765]   hold -161
  [0.2,0.5)      n 13979  back  69.7%  gain 0.360  pay-cap0 -1,529,347 [-2,162,291, -910,431] pay-cur  -724,056 [-1,058,417, -421,828] hold -365
  [0.5,0.8)      n  6186  back  70.1%  gain 0.370  pay-cap0  -980,181 [-1,358,108, -450,654] pay-cur  -497,411 [-707,268, -186,630]   hold -392
  [0.8,1)        n  4331  back  74.0%  gain 0.380  pay-cap0  -762,721 [-961,772, -405,214]   pay-cur  -342,674 [-472,302, -194,484]   hold -439
  [1,+inf)       n  5771  back  72.3%  gain 0.390  pay-cap0  -778,176 [-1,057,681, -524,375] pay-cur  -451,100 [-680,570, -241,950]   hold -442
pb60
  [-inf,0.2)     n 15413  back  71.1%  gain 0.360  pay-cap0 -1,624,179 [-2,355,774, -1,003,256] pay-cur  -519,094 [-857,277, -67,199]    hold -266
  [0.2,0.5)      n  7504  back  71.1%  gain 0.370  pay-cap0  -935,587 [-1,252,705, -490,533] pay-cur  -487,018 [-698,750, -304,743]   hold -382
  [0.5,0.8)      n  6548  back  73.0%  gain 0.370  pay-cap0 -1,167,660 [-1,709,104, -726,538] pay-cur  -697,430 [-982,660, -446,905]   hold -380
  [0.8,1)        n  3185  back  72.1%  gain 0.380  pay-cap0  -605,448 [-824,271, -365,930]   pay-cur  -291,999 [-434,899, -176,189]   hold -352
  [1,+inf)       n  6140  back  71.3%  gain 0.380  pay-cap0  -691,726 [-949,251, -292,140]   pay-cur  -339,960 [-454,540, -35,750]    hold -453
ride15
  [-inf,0.5)     n 29923  back  70.8%  gain 0.360  pay-cap0 -3,615,679 [-4,095,330, -2,210,699] pay-cur -1,651,756 [-2,062,349, -1,200,807] hold -321
  [0.5,1.5)      n  2163  back  72.8%  gain 0.400  pay-cap0  -488,610 [-737,175, -345,900]   pay-cur  -282,520 [-394,210, -180,950]   hold -425
  [1.5,3.5)      n  2159  back  75.1%  gain 0.390  pay-cap0  -363,380 [-469,055, -221,505]   pay-cur  -121,455 [-214,525, -38,765]    hold -361
  [3.5,+inf)     n  4545  back  74.5%  gain 0.380  pay-cap0  -556,931 [-712,868, -344,810]   pay-cur  -279,770 [-415,920, -140,360]   hold -453
ride60
  [-inf,0.5)     n 30612  back  71.5%  gain 0.370  pay-cap0 -3,949,893 [-4,788,547, -3,085,508] pay-cur -1,868,897 [-2,249,964, -1,447,115] hold -326
  [0.5,1.5)      n  1440  back  69.3%  gain 0.380  pay-cap0  -232,100 [-399,210, -94,160]    pay-cur  -116,495 [-226,890, -4,465]     hold -425
  [1.5,3.5)      n  1087  back  73.3%  gain 0.400  pay-cap0  -227,278 [-333,679, -88,334]    pay-cur   -96,219 [-169,002, -12,948]    hold -292
  [3.5,+inf)     n  5651  back  72.2%  gain 0.370  pay-cap0  -615,329 [-1,041,290, -241,028] pay-cur  -253,890 [-437,215, -57,460]    hold -434
t15
  [-inf,-0.5)    n 10540  back  73.6%  gain 0.380  pay-cap0 -1,614,923 [-2,036,772, -970,652] pay-cur  -795,963 [-1,010,503, -580,907] hold -378
  [-0.5,0.5)     n  3062  back  72.6%  gain 0.390  pay-cap0  -559,592 [-803,307, -421,475]   pay-cur  -298,957 [-424,245, -206,747]   hold -407
  [0.5,+inf)     n 25188  back  70.6%  gain 0.360  pay-cap0 -2,850,085 [-3,571,376, -2,236,854] pay-cur -1,240,581 [-1,702,236, -831,837] hold -323
t60
  [-inf,-0.5)    n 11242  back  71.8%  gain 0.370  pay-cap0 -1,472,194 [-2,029,577, -960,326] pay-cur  -659,227 [-913,306, -386,365]   hold -400
  [-0.5,0.5)     n  5959  back  72.4%  gain 0.380  pay-cap0  -932,469 [-1,397,542, -600,858] pay-cur  -495,130 [-702,230, -291,910]   hold -309
  [0.5,+inf)     n 21589  back  71.2%  gain 0.360  pay-cap0 -2,619,937 [-3,150,025, -1,881,240] pay-cur -1,181,144 [-1,539,204, -669,637] hold -325
tA
  [-inf,-0.5)    n  8543  back  74.0%  gain 0.380  pay-cap0 -1,344,238 [-1,816,053, -980,049] pay-cur  -666,308 [-902,847, -544,386]   hold -379
  [-0.5,0.5)     n 11380  back  71.5%  gain 0.370  pay-cap0 -1,617,896 [-2,125,878, -1,213,552] pay-cur  -653,581 [-806,062, -477,883]   hold -374
  [0.5,+inf)     n 18867  back  70.5%  gain 0.360  pay-cap0 -2,062,466 [-2,875,612, -1,310,738] pay-cur -1,015,612 [-1,228,709, -723,022] hold -310
dEma15
  [-inf,-0.5)    n  2742  back  75.0%  gain 0.370  pay-cap0  -312,160 [-548,685, -198,115]   pay-cur  -144,925 [-232,550, -64,195]    hold -169
  [-0.5,0)       n 14268  back  71.7%  gain 0.360  pay-cap0 -1,622,750 [-2,077,527, -1,122,090] pay-cur  -579,084 [-811,049, -305,944]   hold -256
  [0,0.5)        n 12688  back  69.9%  gain 0.360  pay-cap0 -1,599,148 [-1,937,973, -1,264,433] pay-cur  -780,273 [-1,116,155, -558,732] hold -386
  [0.5,1)        n  6077  back  73.3%  gain 0.380  pay-cap0  -972,011 [-1,202,514, -615,421] pay-cur  -481,534 [-663,918, -298,432]   hold -442
  [1,+inf)       n  3015  back  71.2%  gain 0.390  pay-cap0  -518,531 [-829,636, -306,155]   pay-cur  -349,685 [-531,555, -159,810]   hold -549
dMid15
  [-inf,-0.5)    n 11560  back  72.8%  gain 0.360  pay-cap0 -1,301,231 [-1,723,336, -837,701] pay-cur  -529,365 [-722,435, -265,265]   hold -201
  [-0.5,0)       n 11011  back  69.6%  gain 0.360  pay-cap0 -1,211,991 [-1,552,505, -823,872] pay-cur  -521,871 [-768,928, -272,962]   hold -379
  [0,0.5)        n  5224  back  70.1%  gain 0.370  pay-cap0  -881,662 [-1,220,527, -629,375] pay-cur  -422,065 [-602,596, -260,752]   hold -391
  [0.5,1)        n  5266  back  73.2%  gain 0.370  pay-cap0  -843,260 [-951,726, -547,047]   pay-cur  -411,660 [-498,124, -182,571]   hold -438
  [1,+inf)       n  5729  back  72.4%  gain 0.390  pay-cap0  -786,456 [-1,157,586, -476,220] pay-cur  -450,540 [-665,175, -289,965]   hold -438
dEma60
  [-inf,-0.5)    n 11582  back  72.0%  gain 0.360  pay-cap0 -1,182,231 [-1,751,692, -893,225] pay-cur  -316,370 [-598,560, -100,730]   hold -210
  [-0.5,0)       n 11229  back  70.2%  gain 0.360  pay-cap0 -1,332,050 [-1,754,361, -477,746] pay-cur  -677,592 [-963,940, -492,414]   hold -402
  [0,0.5)        n  6821  back  71.7%  gain 0.370  pay-cap0 -1,150,089 [-1,530,585, -783,210] pay-cur  -680,168 [-867,732, -514,464]   hold -340
  [0.5,1)        n  4949  back  72.8%  gain 0.380  pay-cap0  -743,614 [-1,077,917, -378,649] pay-cur  -313,466 [-516,805, -115,385]   hold -439
  [1,+inf)       n  4209  back  72.3%  gain 0.390  pay-cap0  -616,616 [-822,121, -259,196]   pay-cur  -347,905 [-501,770, -173,075]   hold -455
dMid60
  [-inf,-0.5)    n 16973  back  71.3%  gain 0.360  pay-cap0 -1,881,293 [-2,537,329, -1,329,415] pay-cur  -656,999 [-994,731, -383,969]   hold -264
  [-0.5,0)       n  6000  back  70.8%  gain 0.370  pay-cap0  -691,388 [-871,975, -296,856]   pay-cur  -354,933 [-473,480, -184,998]   hold -419
  [0,0.5)        n  5644  back  73.1%  gain 0.370  pay-cap0  -997,778 [-1,243,701, -674,831] pay-cur  -618,840 [-764,480, -446,370]   hold -396
  [0.5,1)        n  4070  back  72.3%  gain 0.380  pay-cap0  -780,510 [-1,101,668, -588,422] pay-cur  -369,809 [-570,212, -230,999]   hold -328
  [1,+inf)       n  6103  back  71.2%  gain 0.380  pay-cap0  -673,631 [-1,015,521, -314,285] pay-cur  -334,920 [-530,590, -115,565]   hold -458
tod
  [09:30,10:30)  n  6109  back  76.7%  gain 0.380  pay-cap0  -392,295 [-588,830, -83,070]    pay-cur  -195,615 [-308,605, -10,815]    hold -362
  [10:30,12:00)  n  9747  back  76.8%  gain 0.380  pay-cap0 -1,133,816 [-1,490,685, -688,623] pay-cur  -484,845 [-630,990, -325,150]   hold -339
  [12:00,14:00)  n 12864  back  74.4%  gain 0.380  pay-cap0 -1,860,246 [-2,300,745, -1,394,205] pay-cur  -634,100 [-1,004,765, -308,050] hold -291
  [14:00,15:00)  n  6757  back  66.5%  gain 0.360  pay-cap0  -985,876 [-1,185,737, -618,156] pay-cur  -571,030 [-741,580, -347,650]   hold -381
  [15:00,16:00)  n  3313  back  45.9%  gain 0.280  pay-cap0  -652,367 [-814,886, -496,583]   pay-cur  -449,911 [-583,248, -282,062]   hold -459
overBE
  [0,0.05)       n   560  back  95.0%  gain 0.340  pay-cap0   -28,716 [-61,820, 4,757]       pay-cur         0 [0, 0]                 hold 239
  [0.05,0.1)     n  3919  back  84.6%  gain 0.350  pay-cap0    81,334 [-186,026, 231,235]    pay-cur         0 [0, 0]                 hold -67
  [0.1,0.2)      n 21735  back  75.1%  gain 0.360  pay-cap0 -1,612,946 [-2,056,877, -969,952] pay-cur  -104,905 [-320,415, 174,329]    hold -255
  [0.2,+inf)     n 12576  back  60.3%  gain 0.380  pay-cap0 -3,464,272 [-3,717,056, -2,943,873] pay-cur -2,230,596 [-2,451,996, -1,910,982] hold -610
openFrac
  [-inf,0.15)    n   376  back  30.1%  gain 0.310  pay-cap0  -210,370 [-287,075, -144,385]   pay-cur  -187,300 [-248,995, -129,505]   hold -1,154
  [0.15,0.3)     n  1762  back  52.2%  gain 0.420  pay-cap0  -911,935 [-1,075,080, -740,706] pay-cur  -747,945 [-916,005, -622,895]   hold -696
  [0.3,0.45)     n 14331  back  66.6%  gain 0.390  pay-cap0 -2,894,416 [-3,365,598, -2,434,913] pay-cur -1,466,291 [-1,830,242, -1,127,454] hold -483
  [0.45,+inf)    n 22321  back  77.0%  gain 0.350  pay-cap0 -1,007,879 [-1,495,411, -437,010] pay-cur    66,035 [-146,702, 199,329]    hold -213
```

## 4. Simple regime rules (selected on the early half of pre-2026 days, tested on the late half and on 2026)

Rule R(feature, thr, dirn, hi, lo): event with feature on the 'hi' side of thr -> arm hi, else arm lo. Score = sum $ vs capCur and uncovered-at-close vs capCur (negative uncov = fewer uncovered).

```
10W — early 6518 / late 8371 / 2026 1323 events. Top 6 by $ on early, then top 6 by fewest uncovered on early:
  overBE < 0.16 -> cap0.15, else cap0            early    44,715 u  227 | late    64,190 u  181 | 2026    8,295 u -12
  overBE < 0.16 -> payNow, else cap0             early    44,405 u  227 | late    65,065 u  178 | 2026    8,235 u -12
  openFrac >= 0.38 -> capCur, else cap0          early    38,575 u  198 | late    56,345 u  196 | 2026    5,405 u  19
  overBE < 0.16 -> capCur, else cap0             early    36,640 u  316 | late    59,035 u  358 | 2026    9,575 u  36
  t60 >= 1 -> capCur, else cap0                  early    30,645 u  133 | late    45,365 u  200 | 2026    7,710 u  25
  overBE < 0.2 -> capCur, else cap0              early    29,925 u  226 | late    49,050 u  245 | 2026    3,395 u  30
  --
  all -> payNow                                  early  -315,800 u-2115 | late  -502,240 u-2223 | 2026  -59,182 u-271
  overBE >= 0.16 -> payNow, else capCur          early  -323,565 u-2026 | late  -508,270 u-2043 | 2026  -57,842 u-223
  overBE >= 0.16 -> payNow, else cap0.05         early  -323,565 u-2026 | late  -508,270 u-2043 | 2026  -57,842 u-223
  overBE >= 0.16 -> payNow, else cap0            early  -339,455 u-1940 | late  -535,125 u-1852 | 2026  -66,127 u-170
  openFrac < 0.44 -> payNow, else capCur         early  -241,395 u-1926 | late  -395,800 u-1874 | 2026  -31,482 u-237
  openFrac < 0.44 -> payNow, else cap0.05        early  -241,395 u-1926 | late  -395,800 u-1874 | 2026  -31,482 u-237
  -- reference
  all -> cap0                                    early    20,750 u  402 | late    32,180 u  549 | 2026    1,290 u  89
  all -> hold                                    early   -40,895 u 4403 | late    57,380 u 6148 | 2026  -95,789 u1052
  all -> cap0.15                                 early  -136,905 u -740 | late  -190,945 u -942 | 2026  -29,820 u-116
  all -> payNow                                  early  -315,800 u-2115 | late  -502,240 u-2223 | 2026  -59,182 u-271
20W — early 8863 / late 10476 / 2026 1570 events. Top 6 by $ on early, then top 6 by fewest uncovered on early:
  all -> hold                                    early   303,830 u 6366 | late   332,225 u 8014 | 2026  -92,725 u1271
  adv5 >= 39.75 -> capCur, else cap0             early   162,505 u  717 | late    60,970 u  853 | 2026   -8,441 u 120
  adv5 >= 39.75 -> cap0.15, else cap0            early   154,530 u  622 | late   -56,225 u  628 | 2026  -29,566 u  83
  openFrac >= 0.45 -> capCur, else cap0          early   153,880 u  553 | late   182,320 u  631 | 2026   16,395 u  68
  overBE < 0.12 -> payNow, else cap0             early   149,755 u  626 | late   284,720 u  623 | 2026   43,215 u  63
  overBE < 0.12 -> cap0.15, else cap0            early   149,755 u  626 | late   284,720 u  623 | 2026   43,215 u  63
  --
  all -> payNow                                  early  -578,245 u-2497 | late  -840,490 u-2462 | 2026  -72,450 u-299
  overBE >= 0.12 -> payNow, else capCur          early  -594,135 u-2429 | late  -895,560 u-2323 | 2026  -88,605 u-266
  overBE >= 0.12 -> payNow, else cap0.05         early  -582,065 u-2395 | late  -883,950 u-2252 | 2026  -95,143 u-243
  overBE >= 0.12 -> payNow, else cap0            early  -583,565 u-2309 | late  -929,070 u-2056 | 2026  -96,932 u-202
  openFrac < 0.45 -> payNow, else capCur         early  -534,285 u-2306 | late  -849,810 u-2028 | 2026  -72,275 u-219
  openFrac < 0.45 -> payNow, else cap0.05        early  -513,470 u-2237 | late  -823,595 u-1908 | 2026  -74,818 u-186
  -- reference
  all -> hold                                    early   303,830 u 6366 | late   332,225 u 8014 | 2026  -92,725 u1271
  all -> cap0                                    early   144,435 u  814 | late   196,140 u 1029 | 2026   18,733 u 160
  all -> cap0.15                                 early  -220,635 u -824 | late  -249,020 u -958 | 2026  -31,595 u-121
  all -> payNow                                  early  -578,245 u-2497 | late  -840,490 u-2462 | 2026  -72,450 u-299
40W — early 18061 / late 18378 / 2026 2351 events. Top 6 by $ on early, then top 6 by fewest uncovered on early:
  all -> hold                                    early 1,529,810 u15001 | late 1,481,400 u15696 | 2026 -117,691 u2066
  all -> cap0                                    early 1,324,135 u 2256 | late 1,162,450 u 2475 | 2026  202,514 u 274
  overBE < 0.11 -> payNow, else cap0             early 1,227,240 u 1999 | late 1,346,435 u 1882 | 2026  151,557 u 179
  overBE < 0.11 -> cap0.15, else cap0            early 1,227,240 u 1999 | late 1,346,435 u 1882 | 2026  151,557 u 179
  adv45 >= 49.5 -> capCur, else cap0             early 1,227,140 u 1924 | late   606,325 u 2018 | 2026   77,624 u 204
  overBE < 0.11 -> capCur, else cap0             early 1,222,040 u 2004 | late 1,320,630 u 1899 | 2026  152,262 u 179
  --
  all -> payNow                                  early  -871,055 u-3060 | late -1,416,355 u-2682 | 2026  -48,091 u-285
  overBE >= 0.11 -> payNow, else capCur          early  -876,255 u-3055 | late -1,442,160 u-2665 | 2026  -47,386 u-285
  overBE >= 0.11 -> payNow, else cap0.05         early  -838,135 u-2951 | late -1,556,210 u-2424 | 2026  -43,791 u-246
  overBE >= 0.11 -> payNow, else cap0            early  -774,160 u-2803 | late -1,600,340 u-2089 | 2026    2,866 u-190
  overBE >= 0.15 -> payNow, else capCur          early  -898,845 u-2786 | late -1,513,110 u-2391 | 2026  -79,273 u-241
  tod >= 640 -> payNow, else capCur              early  -798,730 u-2682 | late -1,252,020 u-2362 | 2026  -56,351 u-247
  -- reference
  all -> hold                                    early 1,529,810 u15001 | late 1,481,400 u15696 | 2026 -117,691 u2066
  all -> cap0                                    early 1,324,135 u 2256 | late 1,162,450 u 2475 | 2026  202,514 u 274
  all -> cap0.15                                 early  -375,680 u-1234 | late  -452,175 u-1106 | 2026  -35,565 u-107
  all -> payNow                                  early  -871,055 u-3060 | late -1,416,355 u-2682 | 2026  -48,091 u-285
```

## 6. Hand-written regime rules and best two-feature rules (day-level risk)

Per rule and part: sum $ vs capCur | uncovered-at-close vs capCur | worst day and 5th-pct day of the give-up positions' summed P&L (rule vs capCur). Two-feature rules are selected on the EARLY half (top 4 by $, then top 4 by fewest uncovered with $ >= capCur), tested on late + 2026.

```
10W                                              early                                   | late                                    | 2026
  tod>=15:00 -> payNow, else capCur                -25,690 u -458 wd    260 p5d   -100 |   -66,130 u -559 wd   -525 p5d   -200 |      -487 u  -84 wd -3,065 p5d    -50
  tod>=14:00 -> payNow, else capCur                -71,525 u -868 wd   -760 p5d   -350 |  -148,190 u -946 wd -1,755 p5d   -685 |    -8,387 u -129 wd -3,965 p5d    345
  tod>=15:00 -> payNow, else cap0                   -7,695 u  -72 wd -2,195 p5d   -190 |   -40,855 u  -28 wd -1,030 p5d   -525 |       918 u    0 wd -1,515 p5d     45
  overBE<0.12 -> payNow, else cap0                  47,350 u  304 wd -2,390 p5d    100 |    68,325 u  369 wd    650 p5d   -135 |    14,115 u   32 wd    895 p5d    695
  overBE<0.12 -> payNow, else capCur                 9,625 u  -33 wd      0 p5d     90 |     3,235 u  -38 wd    -20 p5d    -30 |     4,895 u  -23 wd   -110 p5d   -110
  z15>=2 & pb15>=1 -> payNow, else capCur          -33,385 u -188 wd      0 p5d      0 |   -57,590 u -178 wd -3,040 p5d   -285 |      -150 u  -22 wd   -580 p5d      0
  z15>=2 & ride15>=4 -> payNow, else capCur        -15,100 u  -69 wd      0 p5d   -120 |   -20,645 u -110 wd -3,840 p5d   -110 |      -220 u   -7 wd   -580 p5d      0
  z15>=1.5 & t60 against -> payNow, else capCur    -41,955 u -321 wd      0 p5d   -215 |   -83,525 u -285 wd   -165 p5d   -105 |    -5,295 u  -34 wd -1,640 p5d   -590
  z15>=1.5 & tA against -> payNow, else capCur     -32,975 u -199 wd   -820 p5d   -160 |   -76,050 u -216 wd -2,500 p5d   -170 |    -4,460 u  -29 wd -1,640 p5d      0
  z15<1 & pb15>=0.8 -> cap0, else capCur             5,975 u   13 wd      0 p5d     40 |     6,505 u   47 wd    400 p5d     85 |    -2,200 u   12 wd    200 p5d      0
  pb15>=1 | pb60>=1 -> cap0, else capCur            14,815 u   80 wd -1,130 p5d      0 |    34,500 u  107 wd    845 p5d    230 |     5,320 u    9 wd    600 p5d      0
  runAdv>=80 -> cap0, else capCur                    2,200 u   48 wd -1,080 p5d      0 |    37,910 u   81 wd    795 p5d    280 |     5,805 u   11 wd    700 p5d    230
  all -> cap0                                       20,750 u  402 wd -2,390 p5d   -140 |    32,180 u  549 wd   -790 p5d   -185 |     1,290 u   89 wd   -145 p5d     50
  all -> payNow                                   -315,800 u-2115 wd -6,640 p5d -1,475 |  -502,240 u-2223 wd -7,925 p5d -2,655 |   -59,182 u -271 wd -6,005 p5d -2,305
  all -> cap0.15                                  -136,905 u -740 wd -2,680 p5d   -610 |  -190,945 u -942 wd -1,030 p5d   -720 |   -29,820 u -116 wd -2,230 p5d   -331
  -- best two-feature by $ (early), then fewest uncovered with $ >= capCur (early)
  tod<725 & overBE<0.16 -> payNow, else cap0        46,865 u  234 wd -2,390 p5d    105 |    54,570 u  269 wd     70 p5d   -215 |    -1,115 u   27 wd    325 p5d    300
  openFrac<0.44 & overBE<0.16 -> payNow, else cap0    46,840 u  259 wd -2,390 p5d     30 |    64,610 u  313 wd     70 p5d   -215 |     6,490 u   50 wd    885 p5d    827
  tod<850 & overBE<0.16 -> payNow, else cap0        44,405 u  227 wd -2,390 p5d     30 |    64,285 u  183 wd     70 p5d    -85 |     7,520 u   -9 wd    895 p5d    470
  openFrac>=0.36 & overBE<0.16 -> payNow, else cap0    43,670 u  284 wd -2,390 p5d    105 |    63,035 u  278 wd    650 p5d    -80 |    11,780 u   -3 wd    895 p5d    470
  dEma15<0.76 & dMid60>=0.91 -> payNow, else capCur     3,215 u -214 wd   -480 p5d   -100 |   -37,750 u -211 wd   -540 p5d   -235 |    -4,810 u  -19 wd    450 p5d      0
  pb60>=0.96 & dEma15<0.76 -> payNow, else capCur     2,910 u -213 wd   -480 p5d   -100 |   -37,330 u -210 wd   -540 p5d   -235 |    -4,810 u  -19 wd    450 p5d      0
  openFrac<0.36 & overBE<0.22 -> payNow, else capCur     2,580 u -201 wd   -480 p5d     90 |    -5,295 u -239 wd   -960 p5d     35 |     3,585 u  -38 wd   -690 p5d    109
  pb60>=0.96 & overBE<0.22 -> payNow, else capCur     1,880 u -151 wd   -480 p5d     -5 |     7,870 u -191 wd      0 p5d      0 |      -195 u  -24 wd    450 p5d      0
20W                                              early                                   | late                                    | 2026
  tod>=15:00 -> payNow, else capCur                -81,480 u -605 wd   -830 p5d    250 |  -163,970 u -586 wd -1,285 p5d     -5 |    -4,570 u  -89 wd -3,505 p5d    373
  tod>=14:00 -> payNow, else capCur               -174,505 u-1128 wd -3,615 p5d    -90 |  -296,725 u-1067 wd -4,910 p5d   -910 |   -26,545 u -136 wd -1,945 p5d   -345
  tod>=15:00 -> payNow, else cap0                   48,560 u  162 wd -4,870 p5d -1,590 |    -8,785 u  376 wd -1,520 p5d   -475 |     6,454 u   67 wd -4,700 p5d -2,195
  overBE<0.12 -> payNow, else cap0                 149,755 u  626 wd   -150 p5d   -620 |   284,720 u  623 wd  1,965 p5d    630 |    43,215 u   63 wd -1,830 p5d -1,255
  overBE<0.12 -> payNow, else capCur                15,890 u  -68 wd  2,630 p5d    -30 |    55,070 u -139 wd   -220 p5d    620 |    16,155 u  -33 wd   -255 p5d    420
  z15>=2 & pb15>=1 -> payNow, else capCur          -58,525 u -188 wd   -770 p5d    -60 |  -110,345 u -185 wd -2,280 p5d   -285 |      -480 u  -25 wd      0 p5d    480
  z15>=2 & ride15>=4 -> payNow, else capCur        -33,210 u  -65 wd   -770 p5d      0 |   -40,680 u  -93 wd   -880 p5d    -55 |       760 u   -8 wd      0 p5d    360
  z15>=1.5 & t60 against -> payNow, else capCur    -59,350 u -296 wd -1,870 p5d   -635 |  -169,955 u -289 wd -1,320 p5d   -730 |    -3,970 u  -47 wd  1,235 p5d    720
  z15>=1.5 & tA against -> payNow, else capCur     -83,265 u -183 wd -1,870 p5d    -80 |  -141,600 u -230 wd -1,510 p5d   -730 |    -6,315 u  -33 wd      0 p5d    230
  z15<1 & pb15>=0.8 -> cap0, else capCur            17,425 u   46 wd    600 p5d    330 |   -20,340 u  115 wd      0 p5d   -775 |    -4,900 u   20 wd     40 p5d      0
  pb15>=1 | pb60>=1 -> cap0, else capCur            25,905 u  190 wd -5,550 p5d    330 |    34,425 u  254 wd    900 p5d   -285 |   -12,025 u   47 wd -5,665 p5d -1,370
  runAdv>=80 -> cap0, else capCur                   11,905 u   90 wd -3,480 p5d    -80 |    83,120 u  207 wd  1,800 p5d   -220 |     9,679 u   36 wd -3,765 p5d    585
  all -> cap0                                      144,435 u  814 wd -3,000 p5d -1,565 |   196,140 u 1029 wd -2,560 p5d    155 |    18,733 u  160 wd -4,185 p5d -1,875
  all -> payNow                                   -578,245 u-2497 wd-13,525 p5d -3,395 |  -840,490 u-2462 wd-10,760 p5d -6,170 |   -72,450 u -299 wd -8,375 p5d -2,995
  all -> cap0.15                                  -220,635 u -824 wd -2,220 p5d -1,635 |  -249,020 u -958 wd -5,170 p5d -1,230 |   -31,595 u -121 wd -2,470 p5d -3,520
  -- best two-feature by $ (early), then fewest uncovered with $ >= capCur (early)
  dEma15>=0.17 & overBE<0.12 -> payNow, else cap0   175,465 u  687 wd -1,220 p5d   -755 |   269,170 u  813 wd -2,755 p5d    380 |    30,636 u  119 wd -1,675 p5d -1,875
  pb15>=0.46 & overBE<0.12 -> payNow, else cap0    171,340 u  689 wd -1,235 p5d   -620 |   264,900 u  810 wd -2,755 p5d    380 |    25,918 u  120 wd -1,675 p5d -1,875
  pb15>=0.23 & openFrac>=0.45 -> capCur, else cap0   171,165 u  589 wd -3,300 p5d     75 |   220,085 u  693 wd  3,295 p5d    525 |    18,416 u   85 wd -2,285 p5d  1,180
  adv45>=-10.25 & openFrac>=0.45 -> capCur, else cap0   169,540 u  584 wd -3,300 p5d     75 |   197,170 u  705 wd  2,655 p5d    120 |     2,246 u  104 wd -2,285 p5d    265
  z15<1.24 & pb15>=0.23 -> payNow, else cap0        13,980 u -427 wd -2,425 p5d   -595 |    39,430 u -399 wd    -30 p5d    380 |     8,638 u  -50 wd -2,970 p5d   -904
  z15<1.24 & adv45>=-10.25 -> payNow, else cap0      5,410 u -403 wd -2,225 p5d   -785 |    68,365 u -360 wd    950 p5d    275 |   -10,342 u  -13 wd -2,970 p5d   -904
  z15<1.24 & dEma15>=-0.14 -> payNow, else cap0     26,005 u -368 wd -1,445 p5d   -785 |    80,310 u -338 wd    -30 p5d    635 |    11,373 u  -43 wd -2,970 p5d  1,055
  adv15<47.5 & tod>=860 -> payNow, else cap0         6,295 u -265 wd -3,455 p5d -1,040 |   -40,960 u   29 wd -2,260 p5d   -275 |     1,184 u   28 wd -4,055 p5d -3,205
40W                                              early                                   | late                                    | 2026
  tod>=15:00 -> payNow, else capCur               -164,735 u -659 wd      0 p5d -1,450 |  -282,520 u -613 wd-10,030 p5d -2,305 |    -2,656 u  -88 wd  1,798 p5d -1,583
  tod>=14:00 -> payNow, else capCur               -357,330 u-1337 wd  2,930 p5d -3,070 |  -632,110 u-1173 wd -7,300 p5d -2,910 |   -31,501 u -141 wd    478 p5d   -323
  tod>=15:00 -> payNow, else cap0                1,100,245 u 1403 wd-14,175 p5d -4,555 |   750,430 u 1650 wd -9,785 p5d -3,930 |   186,057 u  158 wd -2,610 p5d -5,162
  overBE<0.12 -> payNow, else cap0               1,206,120 u 1846 wd-11,300 p5d -1,980 | 1,403,940 u 1665 wd -4,245 p5d  1,315 |   139,952 u  155 wd  8,380 p5d    472
  overBE<0.12 -> payNow, else capCur                24,590 u  -34 wd   -140 p5d    -55 |    40,190 u  -43 wd    -60 p5d   -180 |     7,060 u   -7 wd  7,400 p5d  3,399
  z15>=2 & pb15>=1 -> payNow, else capCur         -102,550 u -163 wd  3,975 p5d   -555 |  -193,635 u -180 wd -6,585 p5d -1,290 |    11,220 u  -28 wd  8,330 p5d      0
  z15>=2 & ride15>=4 -> payNow, else capCur        -50,865 u  -66 wd -1,490 p5d   -555 |   -72,730 u -104 wd -9,945 p5d   -570 |     3,070 u  -12 wd  2,280 p5d      0
  z15>=1.5 & t60 against -> payNow, else capCur   -130,340 u -244 wd      0 p5d   -570 |  -250,115 u -260 wd -5,980 p5d   -270 |    14,095 u  -35 wd      0 p5d   -640
  z15>=1.5 & tA against -> payNow, else capCur    -150,935 u -185 wd  3,975 p5d   -595 |  -215,170 u -241 wd -9,945 p5d -1,285 |    10,495 u  -37 wd  7,390 p5d      0
  z15<1 & pb15>=0.8 -> cap0, else capCur           135,205 u  238 wd   -280 p5d    -20 |    78,990 u  338 wd  1,600 p5d -1,655 |    37,140 u   16 wd    800 p5d    500
  pb15>=1 | pb60>=1 -> cap0, else capCur           236,975 u  446 wd -6,080 p5d -3,015 |   245,600 u  571 wd  4,400 p5d -2,510 |    43,191 u   45 wd  4,000 p5d    500
  runAdv>=80 -> cap0, else capCur                  118,690 u  199 wd    400 p5d   -620 |   340,465 u  368 wd  2,485 p5d    970 |    64,958 u   43 wd  2,400 p5d  2,862
  all -> cap0                                    1,324,135 u 2256 wd-11,085 p5d -3,835 | 1,162,450 u 2475 wd-10,125 p5d -2,120 |   202,514 u  274 wd    220 p5d -6,688
  all -> payNow                                   -871,055 u-3060 wd-18,795 p5d -4,650 | -1,416,355 u-2682 wd-16,490 p5d -9,870 |   -48,091 u -285 wd  1,837 p5d -3,183
  all -> cap0.15                                  -375,680 u-1234 wd -1,270 p5d -1,540 |  -452,175 u-1106 wd -1,395 p5d -2,260 |   -35,565 u -107 wd  9,125 p5d    -56
  -- best two-feature by $ (early), then fewest uncovered with $ >= capCur (early)
  dMid60<-1.02 & tod<640 -> payNow, else cap0    1,376,300 u 2150 wd-11,085 p5d -1,880 | 1,120,845 u 2395 wd-10,745 p5d -2,180 |   202,759 u  266 wd   -475 p5d -6,688
  pb60<-0.01 & tod<640 -> payNow, else cap0      1,374,430 u 2152 wd-11,085 p5d -1,880 | 1,123,505 u 2395 wd-10,745 p5d -2,180 |   202,759 u  266 wd   -475 p5d -6,688
  tA<0 & overBE>=0.23 -> capCur, else cap0       1,366,665 u 2150 wd-11,085 p5d -3,835 |   968,015 u 2412 wd -3,945 p5d -3,485 |   185,794 u  267 wd -1,050 p5d -8,288
  tA<0 & tod>=860 -> capCur, else cap0           1,358,860 u 2163 wd-11,085 p5d -4,010 | 1,062,790 u 2394 wd-11,725 p5d -2,415 |   181,321 u  267 wd    220 p5d -6,688
  adv15<35.75 & ride15<1 -> payNow, else cap0       36,610 u-1579 wd-22,745 p5d -4,260 |   215,830 u -729 wd -1,610 p5d -3,190 |   166,357 u  -74 wd  6,725 p5d  4,375
  z15<1.64 & adv45<49.5 -> payNow, else cap0         3,260 u-1568 wd-21,310 p5d -3,490 |   287,975 u -950 wd  3,105 p5d -3,140 |   169,776 u  -86 wd 12,625 p5d  7,122
  z15<1.64 & tod>=640 -> payNow, else cap0          31,320 u-1462 wd-11,235 p5d -4,230 |  -204,685 u-1046 wd  1,095 p5d -2,495 |   112,796 u -139 wd 12,723 p5d  6,422
  z15<1.64 & dEma15<0.57 -> payNow, else cap0      112,790 u-1403 wd-19,595 p5d -2,970 |   -36,095 u -960 wd -5,660 p5d -6,135 |   112,471 u -128 wd 14,145 p5d  6,422
```

## 5. Came-back rate cross-tab: z15 bucket x pb15 bucket (pooled, per width) — n / cameBackBE%

```
10W
  z15\pb15           [-inf,0.2)      [0.2,0.5)      [0.5,0.8)        [0.8,1)       [1,+inf)
  [-inf,0)             552/69%        339/68%        116/72%        111/70%        107/86%
  [0,0.5)              308/69%        580/62%        235/62%        113/48%        153/77%
  [0.5,1)              503/68%       1268/60%        588/54%        370/71%        325/66%
  [1,1.5)              520/75%       1501/61%        719/56%        424/69%        586/75%
  [1.5,2)              320/71%        994/69%        523/59%        301/71%        602/71%
  [2,+inf)             316/59%       1088/63%        854/60%        403/60%       1393/69%
20W
  z15\pb15           [-inf,0.2)      [0.2,0.5)      [0.5,0.8)        [0.8,1)       [1,+inf)
  [-inf,0)             706/69%        642/69%        238/73%        158/75%         88/77%
  [0,0.5)              407/70%       1026/59%        390/58%        161/57%        169/70%
  [0.5,1)              629/69%       1947/61%        817/56%        508/70%        375/70%
  [1,1.5)              554/76%       1798/64%        929/59%        530/68%        636/68%
  [1.5,2)              427/71%       1148/68%        719/63%        373/75%        716/70%
  [2,+inf)             382/65%       1404/64%        975/64%        461/59%       1596/67%
40W
  z15\pb15           [-inf,0.2)      [0.2,0.5)      [0.5,0.8)        [0.8,1)       [1,+inf)
  [-inf,0)            3399/74%       2295/74%        920/76%        577/79%        364/85%
  [0,0.5)             1804/72%       3082/68%       1075/72%        682/74%        558/77%
  [0.5,1)             1567/73%       3365/69%       1332/66%       1136/72%        975/70%
  [1,1.5)              887/79%       2476/68%       1121/71%        941/75%       1155/75%
  [1.5,2)              475/75%       1256/73%        736/71%        471/77%        995/72%
  [2,+inf)             391/68%       1505/68%       1002/68%        524/68%       1724/68%
```

Wall 242s, workers 8. Script: scripts/candle-spread/study-giveup-regime.js (hook: runDay5m opts.giveUpTap, default unset = inert).
