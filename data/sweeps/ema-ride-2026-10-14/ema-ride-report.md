# EMA-ride study — generated 2026-10-15T02:59:26.855Z

Days: 795 total = 733 NQ-proxy (2023-2025, dataset) + 62 NDX (2026, raw-1m). Dataset: 56 dual 2026 files skipped (taken from raw-1m), 160 ET dates without RTH bars, 29 dates without a 16:00 NQ bar (half days) excluded. Raw skipped: 2026-07-26:no-NDX, 2026-08-02:no-NDX, 2026-08-09:no-NDX, 2026-08-16:no-NDX, 2026-08-23:no-NDX, 2026-08-30:no-NDX, 2026-09-06:no-NDX, 2026-09-07:no-NDX, 2026-09-13:no-NDX, 2026-09-20:no-NDX, 2026-09-27:no-NDX, 2026-10-04:no-NDX, 2026-10-11:no-NDX.
Parity raw-1m vs dataset 15m (ema/mid/lower): 1438 bars compared, max |diff| = 0.08 pts.
Thresholds: base={N:4,K:2,REJ_TOL:0.15,BAND_TOL:0.1}  N3={N:3,K:2,REJ_TOL:0.15,BAND_TOL:0.1}  N6={N:6,K:2,REJ_TOL:0.15,BAND_TOL:0.1}  loose={N:4,K:1,REJ_TOL:0.25,BAND_TOL:0.5}  tight={N:4,K:3,REJ_TOL:0.1,BAND_TOL:0}. EM = mean |close-P_T| of prior 20 days, same series & checkpoint. THIN = n<20.

## Variant base (N=4, K=2, REJ_TOL=0.15, BAND_TOL=0.1) — BASE

### BEAR · T=10:30 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 73 | 37.0 (±11.1) | -0.09 | -0.17 | -16.8 | -0.18 | -0.31 | 39.7 | 45.2 | 37.0 | 0.92 | 0.57 |
| trend-only (trend state, no ride) | 224 | 49.1 (±6.5) | 0.04 | -0.01 | 9.2 | 0.11 | -0.02 | 50.9 | 36.2 | 22.8 | 0.74 | 0.48 |
| trend state (all, incl. ride) | 297 | 46.1 (±5.7) | 0.01 | -0.06 | 2.8 | 0.04 | -0.11 | 48.1 | 38.4 | 26.3 | 0.79 | 0.50 |
| ALL days | 794 | 42.8 (±3.4) | -0.03 | -0.11 | -4.8 | -0.04 | -0.21 | 28.6 | 56.3 | 54.2 | 0.79 | 0.51 |
| no trend state either side | 171 | 45.6 (±7.5) | -0.04 | -0.08 | -6.7 | -0.08 | -0.14 | 28.1 | 55.0 | 55.0 | 0.76 | 0.50 |
| opposite trend state (bull) | 326 | 38.3 (±5.3) | -0.07 | -0.15 | -10.6 | -0.09 | -0.29 | 11.0 | 73.3 | 79.1 | 0.81 | 0.51 |
| opposite RIDE (bull) | 91 | 41.8 (±10.1) | -0.01 | -0.15 | 1.1 | -0.00 | -0.22 | 11.0 | 70.3 | 79.1 | 0.74 | 0.48 |

### BEAR · T=11:00 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 81 | 45.7 (±10.8) | -0.03 | -0.06 | -6.2 | -0.02 | -0.17 | 43.2 | 46.9 | 29.6 | 0.98 | 0.55 |
| trend-only (trend state, no ride) | 224 | 46.4 (±6.5) | -0.01 | -0.05 | -0.3 | -0.00 | -0.10 | 43.3 | 37.9 | 25.9 | 0.85 | 0.48 |
| trend state (all, incl. ride) | 305 | 46.2 (±5.6) | -0.01 | -0.06 | -1.9 | -0.01 | -0.12 | 43.3 | 40.3 | 26.9 | 0.91 | 0.50 |
| ALL days | 794 | 42.8 (±3.4) | -0.05 | -0.09 | -7.9 | -0.07 | -0.19 | 25.1 | 57.2 | 54.8 | 0.85 | 0.49 |
| no trend state either side | 177 | 42.4 (±7.3) | -0.10 | -0.12 | -16.5 | -0.13 | -0.26 | 22.6 | 58.8 | 59.9 | 0.92 | 0.54 |
| opposite trend state (bull) | 312 | 39.7 (±5.4) | -0.05 | -0.12 | -8.9 | -0.11 | -0.22 | 8.7 | 72.8 | 79.2 | 0.79 | 0.44 |
| opposite RIDE (bull) | 72 | 38.9 (±11.3) | -0.07 | -0.16 | -9.3 | -0.19 | -0.27 | 8.3 | 73.6 | 81.9 | 0.85 | 0.48 |

### BEAR · T=11:30 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 83 | 48.2 (±10.7) | -0.03 | -0.01 | -7.5 | -0.00 | -0.03 | 43.4 | 42.2 | 27.7 | 0.89 | 0.48 |
| trend-only (trend state, no ride) | 210 | 46.2 (±6.7) | 0.00 | -0.06 | 3.2 | 0.08 | -0.10 | 38.1 | 38.1 | 26.7 | 0.79 | 0.45 |
| trend state (all, incl. ride) | 293 | 46.8 (±5.7) | -0.01 | -0.03 | 0.1 | 0.05 | -0.06 | 39.6 | 39.2 | 27.0 | 0.81 | 0.46 |
| ALL days | 794 | 43.8 (±3.5) | -0.04 | -0.07 | -6.5 | -0.05 | -0.15 | 22.7 | 56.9 | 54.9 | 0.83 | 0.45 |
| no trend state either side | 169 | 43.2 (±7.5) | -0.02 | -0.09 | -5.8 | -0.06 | -0.21 | 21.9 | 58.0 | 55.0 | 0.94 | 0.47 |
| opposite trend state (bull) | 332 | 41.6 (±5.3) | -0.07 | -0.08 | -12.7 | -0.12 | -0.17 | 8.1 | 72.0 | 79.5 | 0.78 | 0.42 |
| opposite RIDE (bull) | 73 | 41.1 (±11.3) | -0.03 | -0.06 | -0.9 | -0.02 | -0.17 | 8.2 | 68.5 | 79.5 | 0.78 | 0.39 |

### BEAR · T=12:00 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 59 | 40.7 (±12.5) | -0.02 | -0.10 | -3.8 | -0.06 | -0.26 | 35.6 | 47.5 | 28.8 | 0.82 | 0.39 |
| trend-only (trend state, no ride) | 197 | 50.3 (±7.0) | 0.00 | 0.00 | 0.7 | 0.07 | 0.01 | 39.1 | 36.5 | 21.8 | 0.91 | 0.46 |
| trend state (all, incl. ride) | 256 | 48.0 (±6.1) | -0.00 | -0.04 | -0.4 | 0.03 | -0.09 | 38.3 | 39.1 | 23.4 | 0.86 | 0.45 |
| ALL days | 794 | 46.0 (±3.5) | -0.02 | -0.05 | -3.6 | -0.01 | -0.13 | 20.3 | 57.7 | 55.4 | 0.82 | 0.41 |
| no trend state either side | 191 | 46.6 (±7.1) | -0.07 | -0.06 | -10.7 | -0.07 | -0.15 | 18.3 | 57.6 | 53.9 | 0.80 | 0.45 |
| opposite trend state (bull) | 347 | 44.1 (±5.2) | -0.01 | -0.05 | -2.2 | -0.02 | -0.14 | 8.1 | 71.5 | 79.8 | 0.77 | 0.36 |
| opposite RIDE (bull) | 77 | 46.8 (±11.1) | 0.05 | -0.01 | 11.7 | 0.19 | -0.02 | 14.3 | 66.2 | 76.6 | 0.67 | 0.34 |

### BULL · T=10:30 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 91 | 58.2 (±10.1) | 0.01 | 0.15 | -1.1 | 0.00 | 0.22 | 56.0 | 29.7 | 20.9 | 0.71 | 0.50 |
| trend-only (trend state, no ride) | 235 | 63.0 (±6.2) | 0.09 | 0.15 | 15.2 | 0.12 | 0.29 | 61.7 | 25.5 | 20.9 | 0.73 | 0.51 |
| trend state (all, incl. ride) | 326 | 61.7 (±5.3) | 0.07 | 0.15 | 10.6 | 0.09 | 0.29 | 60.1 | 26.7 | 20.9 | 0.73 | 0.51 |
| ALL days | 794 | 57.2 (±3.4) | 0.03 | 0.11 | 4.8 | 0.04 | 0.21 | 36.0 | 43.7 | 45.8 | 0.77 | 0.53 |
| no trend state either side | 171 | 54.4 (±7.5) | 0.04 | 0.08 | 6.7 | 0.08 | 0.14 | 32.2 | 45.0 | 45.0 | 0.79 | 0.53 |
| opposite trend state (bear) | 297 | 53.9 (±5.7) | -0.01 | 0.06 | -2.8 | -0.04 | 0.11 | 11.8 | 61.6 | 73.7 | 0.79 | 0.55 |
| opposite RIDE (bear) | 73 | 63.0 (±11.1) | 0.09 | 0.17 | 16.8 | 0.18 | 0.31 | 9.6 | 54.8 | 63.0 | 0.78 | 0.54 |

### BULL · T=11:00 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 72 | 61.1 (±11.3) | 0.07 | 0.16 | 9.3 | 0.19 | 0.27 | 56.9 | 26.4 | 18.1 | 0.51 | 0.41 |
| trend-only (trend state, no ride) | 240 | 60.0 (±6.2) | 0.04 | 0.10 | 8.8 | 0.09 | 0.21 | 53.3 | 27.5 | 21.7 | 0.61 | 0.42 |
| trend state (all, incl. ride) | 312 | 60.3 (±5.4) | 0.05 | 0.12 | 8.9 | 0.11 | 0.22 | 54.2 | 27.2 | 20.8 | 0.61 | 0.42 |
| ALL days | 794 | 57.2 (±3.4) | 0.05 | 0.09 | 7.9 | 0.07 | 0.19 | 32.4 | 42.8 | 45.2 | 0.71 | 0.47 |
| no trend state either side | 177 | 57.6 (±7.3) | 0.10 | 0.12 | 16.5 | 0.13 | 0.26 | 32.8 | 41.2 | 40.1 | 0.74 | 0.51 |
| opposite trend state (bear) | 305 | 53.8 (±5.6) | 0.01 | 0.06 | 1.9 | 0.01 | 0.12 | 9.8 | 59.7 | 73.1 | 0.83 | 0.51 |
| opposite RIDE (bear) | 81 | 54.3 (±10.8) | 0.03 | 0.06 | 6.2 | 0.02 | 0.17 | 11.1 | 53.1 | 70.4 | 0.84 | 0.52 |

### BULL · T=11:30 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 73 | 58.9 (±11.3) | 0.03 | 0.06 | 0.9 | 0.02 | 0.17 | 54.8 | 31.5 | 20.5 | 0.54 | 0.39 |
| trend-only (trend state, no ride) | 259 | 58.3 (±6.0) | 0.09 | 0.08 | 16.0 | 0.15 | 0.16 | 46.7 | 27.0 | 20.5 | 0.64 | 0.38 |
| trend state (all, incl. ride) | 332 | 58.4 (±5.3) | 0.07 | 0.08 | 12.7 | 0.12 | 0.17 | 48.5 | 28.0 | 20.5 | 0.62 | 0.39 |
| ALL days | 794 | 56.0 (±3.5) | 0.04 | 0.07 | 6.5 | 0.05 | 0.15 | 28.8 | 43.1 | 45.1 | 0.74 | 0.44 |
| no trend state either side | 169 | 56.8 (±7.5) | 0.02 | 0.09 | 5.8 | 0.06 | 0.21 | 26.6 | 42.0 | 45.0 | 0.77 | 0.48 |
| opposite trend state (bear) | 293 | 52.9 (±5.7) | 0.01 | 0.03 | -0.1 | -0.05 | 0.06 | 7.8 | 60.8 | 73.0 | 0.85 | 0.48 |
| opposite RIDE (bear) | 83 | 50.6 (±10.8) | 0.03 | 0.01 | 7.5 | 0.00 | 0.03 | 6.0 | 57.8 | 72.3 | 0.92 | 0.49 |

### BULL · T=12:00 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 77 | 53.2 (±11.1) | -0.05 | 0.01 | -11.7 | -0.19 | 0.02 | 40.3 | 33.8 | 23.4 | 0.76 | 0.45 |
| trend-only (trend state, no ride) | 270 | 56.7 (±5.9) | 0.03 | 0.07 | 6.1 | 0.08 | 0.17 | 41.1 | 27.0 | 19.3 | 0.65 | 0.37 |
| trend state (all, incl. ride) | 347 | 55.9 (±5.2) | 0.01 | 0.05 | 2.2 | 0.02 | 0.14 | 40.9 | 28.5 | 20.2 | 0.68 | 0.38 |
| ALL days | 794 | 54.0 (±3.5) | 0.02 | 0.05 | 3.6 | 0.01 | 0.13 | 24.8 | 42.3 | 44.6 | 0.78 | 0.42 |
| no trend state either side | 191 | 53.4 (±7.1) | 0.07 | 0.06 | 10.7 | 0.07 | 0.15 | 19.4 | 42.4 | 46.1 | 0.81 | 0.42 |
| opposite trend state (bear) | 256 | 52.0 (±6.1) | 0.00 | 0.04 | 0.4 | -0.03 | 0.09 | 7.0 | 60.9 | 76.6 | 0.88 | 0.46 |
| opposite RIDE (bear) | 59 | 59.3 (±12.5) | 0.02 | 0.10 | 3.8 | 0.06 | 0.26 | 6.8 | 52.5 | 71.2 | 0.70 | 0.40 |

## Variant N3 (N=3, K=2, REJ_TOL=0.15, BAND_TOL=0.1)

### N3 · BEAR · T=10:30 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 69 | 42.0 (±11.6) | -0.03 | -0.17 | -3.9 | -0.11 | -0.29 | 42.0 | 46.4 | 34.8 | 0.92 | 0.55 |
| trend-only (trend state, no ride) | 228 | 47.4 (±6.5) | 0.02 | -0.04 | 4.8 | 0.08 | -0.07 | 50.0 | 36.0 | 23.7 | 0.75 | 0.49 |
| ALL days | 794 | 42.8 (±3.4) | -0.03 | -0.11 | -4.8 | -0.04 | -0.21 | 28.6 | 56.3 | 54.2 | 0.79 | 0.51 |

### N3 · BEAR · T=11:00 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 77 | 45.5 (±11.1) | -0.02 | -0.08 | -6.7 | -0.02 | -0.19 | 42.9 | 44.2 | 29.9 | 0.95 | 0.51 |
| trend-only (trend state, no ride) | 228 | 46.5 (±6.5) | -0.01 | -0.05 | -0.3 | -0.00 | -0.09 | 43.4 | 39.0 | 25.9 | 0.90 | 0.50 |
| ALL days | 794 | 42.8 (±3.4) | -0.05 | -0.09 | -7.9 | -0.07 | -0.19 | 25.1 | 57.2 | 54.8 | 0.85 | 0.49 |

### N3 · BEAR · T=11:30 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 70 | 47.1 (±11.7) | -0.04 | -0.01 | -8.9 | 0.00 | -0.03 | 47.1 | 42.9 | 30.0 | 0.87 | 0.51 |
| trend-only (trend state, no ride) | 223 | 46.6 (±6.5) | 0.00 | -0.06 | 3.0 | 0.07 | -0.10 | 37.2 | 38.1 | 26.0 | 0.80 | 0.44 |
| ALL days | 794 | 43.8 (±3.5) | -0.04 | -0.07 | -6.5 | -0.05 | -0.15 | 22.7 | 56.9 | 54.9 | 0.83 | 0.45 |

### N3 · BEAR · T=12:00 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 47 | 38.3 (±13.9) | -0.03 | -0.10 | -6.1 | -0.15 | -0.26 | 31.9 | 46.8 | 29.8 | 0.82 | 0.36 |
| trend-only (trend state, no ride) | 209 | 50.2 (±6.8) | 0.00 | 0.00 | 0.9 | 0.08 | 0.01 | 39.7 | 37.3 | 22.0 | 0.88 | 0.46 |
| ALL days | 794 | 46.0 (±3.5) | -0.02 | -0.05 | -3.6 | -0.01 | -0.13 | 20.3 | 57.7 | 55.4 | 0.82 | 0.41 |

### N3 · BULL · T=10:30 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 85 | 67.1 (±10.0) | 0.09 | 0.21 | 13.4 | 0.17 | 0.42 | 65.9 | 24.7 | 21.2 | 0.67 | 0.50 |
| trend-only (trend state, no ride) | 241 | 59.8 (±6.2) | 0.06 | 0.14 | 9.7 | 0.06 | 0.25 | 58.1 | 27.4 | 20.7 | 0.74 | 0.51 |
| ALL days | 794 | 57.2 (±3.4) | 0.03 | 0.11 | 4.8 | 0.04 | 0.21 | 36.0 | 43.7 | 45.8 | 0.77 | 0.53 |

### N3 · BULL · T=11:00 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 62 | 53.2 (±12.4) | 0.01 | 0.03 | -4.1 | -0.07 | 0.05 | 51.6 | 32.3 | 24.2 | 0.66 | 0.48 |
| trend-only (trend state, no ride) | 250 | 62.0 (±6.0) | 0.06 | 0.13 | 12.1 | 0.15 | 0.26 | 54.8 | 26.0 | 20.0 | 0.60 | 0.41 |
| ALL days | 794 | 57.2 (±3.4) | 0.05 | 0.09 | 7.9 | 0.07 | 0.19 | 32.4 | 42.8 | 45.2 | 0.71 | 0.47 |

### N3 · BULL · T=11:30 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 57 | 63.2 (±12.5) | 0.08 | 0.08 | 14.1 | 0.14 | 0.21 | 54.4 | 29.8 | 21.1 | 0.64 | 0.39 |
| trend-only (trend state, no ride) | 275 | 57.5 (±5.8) | 0.07 | 0.08 | 12.4 | 0.12 | 0.16 | 47.3 | 27.6 | 20.4 | 0.62 | 0.39 |
| ALL days | 794 | 56.0 (±3.5) | 0.04 | 0.07 | 6.5 | 0.05 | 0.15 | 28.8 | 43.1 | 45.1 | 0.74 | 0.44 |

### N3 · BULL · T=12:00 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 52 | 42.3 (±13.4) | -0.10 | -0.05 | -22.3 | -0.29 | -0.17 | 30.8 | 38.5 | 30.8 | 0.76 | 0.46 |
| trend-only (trend state, no ride) | 295 | 58.3 (±5.6) | 0.03 | 0.09 | 6.5 | 0.08 | 0.22 | 42.7 | 26.8 | 18.3 | 0.65 | 0.37 |
| ALL days | 794 | 54.0 (±3.5) | 0.02 | 0.05 | 3.6 | 0.01 | 0.13 | 24.8 | 42.3 | 44.6 | 0.78 | 0.42 |

## Variant N6 (N=6, K=2, REJ_TOL=0.15, BAND_TOL=0.1)

### N6 · BEAR · T=10:30 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 63 | 46.0 (±12.3) | 0.03 | -0.12 | 7.9 | -0.00 | -0.20 | 52.4 | 38.1 | 25.4 | 0.74 | 0.49 |
| trend-only (trend state, no ride) | 234 | 46.2 (±6.4) | 0.01 | -0.06 | 1.4 | 0.05 | -0.09 | 47.0 | 38.5 | 26.5 | 0.80 | 0.50 |
| ALL days | 794 | 42.8 (±3.4) | -0.03 | -0.11 | -4.8 | -0.04 | -0.21 | 28.6 | 56.3 | 54.2 | 0.79 | 0.51 |

### N6 · BEAR · T=11:00 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 72 | 40.3 (±11.3) | -0.08 | -0.09 | -13.0 | -0.15 | -0.19 | 36.1 | 47.2 | 26.4 | 0.90 | 0.52 |
| trend-only (trend state, no ride) | 233 | 48.1 (±6.4) | 0.01 | -0.03 | 1.6 | 0.04 | -0.07 | 45.5 | 38.2 | 27.0 | 0.91 | 0.49 |
| ALL days | 794 | 42.8 (±3.4) | -0.05 | -0.09 | -7.9 | -0.07 | -0.19 | 25.1 | 57.2 | 54.8 | 0.85 | 0.49 |

### N6 · BEAR · T=11:30 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 74 | 47.3 (±11.4) | -0.02 | -0.01 | -6.2 | 0.03 | -0.03 | 37.8 | 41.9 | 21.6 | 0.88 | 0.46 |
| trend-only (trend state, no ride) | 219 | 46.6 (±6.6) | -0.00 | -0.05 | 2.3 | 0.06 | -0.10 | 40.2 | 38.4 | 28.8 | 0.80 | 0.46 |
| ALL days | 794 | 43.8 (±3.5) | -0.04 | -0.07 | -6.5 | -0.05 | -0.15 | 22.7 | 56.9 | 54.9 | 0.83 | 0.45 |

### N6 · BEAR · T=12:00 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 81 | 44.4 (±10.8) | -0.01 | -0.09 | -3.6 | -0.03 | -0.20 | 39.5 | 40.7 | 21.0 | 0.85 | 0.41 |
| trend-only (trend state, no ride) | 175 | 49.7 (±7.4) | -0.00 | -0.02 | 1.2 | 0.06 | -0.03 | 37.7 | 38.3 | 24.6 | 0.88 | 0.46 |
| ALL days | 794 | 46.0 (±3.5) | -0.02 | -0.05 | -3.6 | -0.01 | -0.13 | 20.3 | 57.7 | 55.4 | 0.82 | 0.41 |

### N6 · BULL · T=10:30 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 77 | 59.7 (±11.0) | -0.04 | 0.21 | -4.6 | 0.01 | 0.36 | 58.4 | 29.9 | 20.8 | 0.80 | 0.58 |
| trend-only (trend state, no ride) | 249 | 62.2 (±6.0) | 0.10 | 0.15 | 15.3 | 0.11 | 0.27 | 60.6 | 25.7 | 20.9 | 0.73 | 0.49 |
| ALL days | 794 | 57.2 (±3.4) | 0.03 | 0.11 | 4.8 | 0.04 | 0.21 | 36.0 | 43.7 | 45.8 | 0.77 | 0.53 |

### N6 · BULL · T=11:00 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 85 | 58.8 (±10.5) | 0.05 | 0.20 | 9.3 | 0.13 | 0.32 | 55.3 | 25.9 | 17.6 | 0.61 | 0.43 |
| trend-only (trend state, no ride) | 227 | 60.8 (±6.4) | 0.05 | 0.09 | 8.7 | 0.10 | 0.21 | 53.7 | 27.8 | 22.0 | 0.60 | 0.42 |
| ALL days | 794 | 57.2 (±3.4) | 0.05 | 0.09 | 7.9 | 0.07 | 0.19 | 32.4 | 42.8 | 45.2 | 0.71 | 0.47 |

### N6 · BULL · T=11:30 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 88 | 62.5 (±10.1) | 0.06 | 0.13 | 8.1 | 0.13 | 0.23 | 54.5 | 28.4 | 17.0 | 0.47 | 0.35 |
| trend-only (trend state, no ride) | 244 | 57.0 (±6.2) | 0.08 | 0.07 | 14.3 | 0.12 | 0.15 | 46.3 | 27.9 | 21.7 | 0.68 | 0.40 |
| ALL days | 794 | 56.0 (±3.5) | 0.04 | 0.07 | 6.5 | 0.05 | 0.15 | 28.8 | 43.1 | 45.1 | 0.74 | 0.44 |

### N6 · BULL · T=12:00 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 91 | 48.4 (±10.3) | -0.06 | -0.01 | -15.9 | -0.22 | -0.01 | 36.3 | 34.1 | 19.8 | 0.72 | 0.41 |
| trend-only (trend state, no ride) | 256 | 58.6 (±6.0) | 0.04 | 0.08 | 8.6 | 0.11 | 0.19 | 42.6 | 26.6 | 20.3 | 0.67 | 0.38 |
| ALL days | 794 | 54.0 (±3.5) | 0.02 | 0.05 | 3.6 | 0.01 | 0.13 | 24.8 | 42.3 | 44.6 | 0.78 | 0.42 |

## Variant loose (N=4, K=1, REJ_TOL=0.25, BAND_TOL=0.5)

### loose · BEAR · T=10:30 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 132 | 41.7 (±8.4) | -0.04 | -0.14 | -5.6 | -0.05 | -0.27 | 44.7 | 41.7 | 28.0 | 0.82 | 0.52 |
| trend-only (trend state, no ride) | 165 | 49.7 (±7.6) | 0.05 | -0.01 | 9.5 | 0.11 | -0.02 | 50.9 | 35.8 | 24.8 | 0.74 | 0.48 |
| ALL days | 794 | 42.8 (±3.4) | -0.03 | -0.11 | -4.8 | -0.04 | -0.21 | 28.6 | 56.3 | 54.2 | 0.79 | 0.51 |

### loose · BEAR · T=11:00 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 137 | 48.2 (±8.4) | 0.01 | -0.02 | 2.5 | 0.04 | -0.04 | 45.3 | 40.9 | 21.9 | 0.87 | 0.50 |
| trend-only (trend state, no ride) | 168 | 44.6 (±7.5) | -0.03 | -0.09 | -5.5 | -0.04 | -0.20 | 41.7 | 39.9 | 31.0 | 0.92 | 0.50 |
| ALL days | 794 | 42.8 (±3.4) | -0.05 | -0.09 | -7.9 | -0.07 | -0.19 | 25.1 | 57.2 | 54.8 | 0.85 | 0.49 |

### loose · BEAR · T=11:30 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 146 | 46.6 (±8.1) | -0.02 | -0.03 | -3.7 | -0.02 | -0.07 | 39.7 | 40.4 | 25.3 | 0.88 | 0.47 |
| trend-only (trend state, no ride) | 147 | 46.9 (±8.1) | 0.00 | -0.04 | 4.0 | 0.13 | -0.04 | 39.5 | 38.1 | 28.6 | 0.79 | 0.45 |
| ALL days | 794 | 43.8 (±3.5) | -0.04 | -0.07 | -6.5 | -0.05 | -0.15 | 22.7 | 56.9 | 54.9 | 0.83 | 0.45 |

### loose · BEAR · T=12:00 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 142 | 47.2 (±8.2) | -0.01 | -0.04 | -1.3 | 0.01 | -0.15 | 38.7 | 38.7 | 19.0 | 0.83 | 0.43 |
| trend-only (trend state, no ride) | 114 | 49.1 (±9.2) | 0.00 | -0.03 | 0.8 | 0.06 | -0.03 | 37.7 | 39.5 | 28.9 | 0.98 | 0.47 |
| ALL days | 794 | 46.0 (±3.5) | -0.02 | -0.05 | -3.6 | -0.01 | -0.13 | 20.3 | 57.7 | 55.4 | 0.82 | 0.41 |

### loose · BULL · T=10:30 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 156 | 64.1 (±7.5) | 0.02 | 0.19 | 4.0 | 0.04 | 0.36 | 61.5 | 25.0 | 18.6 | 0.71 | 0.51 |
| trend-only (trend state, no ride) | 170 | 59.4 (±7.4) | 0.12 | 0.15 | 16.7 | 0.13 | 0.27 | 58.8 | 28.2 | 22.9 | 0.75 | 0.50 |
| ALL days | 794 | 57.2 (±3.4) | 0.03 | 0.11 | 4.8 | 0.04 | 0.21 | 36.0 | 43.7 | 45.8 | 0.77 | 0.53 |

### loose · BULL · T=11:00 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 150 | 58.7 (±7.9) | 0.04 | 0.16 | 6.7 | 0.13 | 0.25 | 55.3 | 26.0 | 18.0 | 0.59 | 0.42 |
| trend-only (trend state, no ride) | 162 | 61.7 (±7.5) | 0.06 | 0.11 | 10.9 | 0.09 | 0.21 | 53.1 | 28.4 | 23.5 | 0.62 | 0.42 |
| ALL days | 794 | 57.2 (±3.4) | 0.05 | 0.09 | 7.9 | 0.07 | 0.19 | 32.4 | 42.8 | 45.2 | 0.71 | 0.47 |

### loose · BULL · T=11:30 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 170 | 59.4 (±7.4) | 0.03 | 0.07 | 3.7 | 0.06 | 0.15 | 49.4 | 27.1 | 17.6 | 0.58 | 0.38 |
| trend-only (trend state, no ride) | 162 | 57.4 (±7.6) | 0.12 | 0.10 | 22.0 | 0.20 | 0.22 | 47.5 | 29.0 | 23.5 | 0.70 | 0.39 |
| ALL days | 794 | 56.0 (±3.5) | 0.04 | 0.07 | 6.5 | 0.05 | 0.15 | 28.8 | 43.1 | 45.1 | 0.74 | 0.44 |

### loose · BULL · T=12:00 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 185 | 56.2 (±7.1) | 0.00 | 0.05 | -0.1 | -0.01 | 0.14 | 41.1 | 27.6 | 18.4 | 0.62 | 0.38 |
| trend-only (trend state, no ride) | 162 | 55.6 (±7.7) | 0.03 | 0.04 | 4.8 | 0.07 | 0.15 | 40.7 | 29.6 | 22.2 | 0.73 | 0.39 |
| ALL days | 794 | 54.0 (±3.5) | 0.02 | 0.05 | 3.6 | 0.01 | 0.13 | 24.8 | 42.3 | 44.6 | 0.78 | 0.42 |

## Variant tight (N=4, K=3, REJ_TOL=0.1, BAND_TOL=0)

### tight · BEAR · T=10:30 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 31 | 32.3 (±16.5) | -0.10 | -0.19 | -15.0 | -0.21 | -0.37 | 35.5 | 51.6 | 45.2 | 0.93 | 0.61 |
| trend-only (trend state, no ride) | 266 | 47.7 (±6.0) | 0.02 | -0.03 | 4.9 | 0.07 | -0.07 | 49.6 | 36.8 | 24.1 | 0.74 | 0.49 |
| ALL days | 794 | 42.8 (±3.4) | -0.03 | -0.11 | -4.8 | -0.04 | -0.21 | 28.6 | 56.3 | 54.2 | 0.79 | 0.51 |

### tight · BEAR · T=11:00 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 30 | 50.0 (±17.9) | -0.06 | -0.01 | -13.8 | -0.14 | -0.05 | 46.7 | 40.0 | 30.0 | 0.95 | 0.57 |
| trend-only (trend state, no ride) | 275 | 45.8 (±5.9) | -0.01 | -0.06 | -0.6 | 0.01 | -0.14 | 42.9 | 40.4 | 26.5 | 0.90 | 0.49 |
| ALL days | 794 | 42.8 (±3.4) | -0.05 | -0.09 | -7.9 | -0.07 | -0.19 | 25.1 | 57.2 | 54.8 | 0.85 | 0.49 |

### tight · BEAR · T=11:30 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 37 | 48.6 (±16.1) | 0.01 | -0.01 | -3.8 | 0.08 | -0.03 | 43.2 | 45.9 | 29.7 | 0.97 | 0.47 |
| trend-only (trend state, no ride) | 256 | 46.5 (±6.1) | -0.01 | -0.05 | 0.7 | 0.05 | -0.09 | 39.1 | 38.3 | 26.6 | 0.79 | 0.46 |
| ALL days | 794 | 43.8 (±3.5) | -0.04 | -0.07 | -6.5 | -0.05 | -0.15 | 22.7 | 56.9 | 54.9 | 0.83 | 0.45 |

### tight · BEAR · T=12:00 (all moves signed in the bear direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 23 | 47.8 (±20.4) | 0.03 | -0.01 | 10.5 | 0.14 | -0.01 | 39.1 | 39.1 | 26.1 | 0.82 | 0.31 |
| trend-only (trend state, no ride) | 233 | 48.1 (±6.4) | -0.01 | -0.04 | -1.4 | 0.02 | -0.11 | 38.2 | 39.1 | 23.2 | 0.88 | 0.46 |
| ALL days | 794 | 46.0 (±3.5) | -0.02 | -0.05 | -3.6 | -0.01 | -0.13 | 20.3 | 57.7 | 55.4 | 0.82 | 0.41 |

### tight · BULL · T=10:30 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 48 | 62.5 (±13.7) | -0.00 | 0.16 | -5.2 | 0.01 | 0.22 | 62.5 | 31.3 | 27.1 | 0.64 | 0.55 |
| trend-only (trend state, no ride) | 278 | 61.5 (±5.7) | 0.08 | 0.15 | 13.4 | 0.10 | 0.29 | 59.7 | 25.9 | 19.8 | 0.73 | 0.50 |
| ALL days | 794 | 57.2 (±3.4) | 0.03 | 0.11 | 4.8 | 0.04 | 0.21 | 36.0 | 43.7 | 45.8 | 0.77 | 0.53 |

### tight · BULL · T=11:00 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 29 | 58.6 (±17.9) | 0.11 | 0.10 | 16.8 | 0.28 | 0.22 | 55.2 | 24.1 | 17.2 | 0.55 | 0.44 |
| trend-only (trend state, no ride) | 283 | 60.4 (±5.7) | 0.04 | 0.12 | 8.1 | 0.09 | 0.22 | 54.1 | 27.6 | 21.2 | 0.61 | 0.42 |
| ALL days | 794 | 57.2 (±3.4) | 0.05 | 0.09 | 7.9 | 0.07 | 0.19 | 32.4 | 42.8 | 45.2 | 0.71 | 0.47 |

### tight · BULL · T=11:30 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 22 | 72.7 (±18.6) | 0.14 | 0.15 | 27.4 | 0.33 | 0.66 | 59.1 | 18.2 | 13.6 | 0.39 | 0.32 |
| trend-only (trend state, no ride) | 310 | 57.4 (±5.5) | 0.07 | 0.08 | 11.6 | 0.11 | 0.15 | 47.7 | 28.7 | 21.0 | 0.62 | 0.39 |
| ALL days | 794 | 56.0 (±3.5) | 0.04 | 0.07 | 6.5 | 0.05 | 0.15 | 28.8 | 43.1 | 45.1 | 0.74 | 0.44 |

### tight · BULL · T=12:00 (all moves signed in the bull direction)
| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RIDE | 25 | 60.0 (±19.2) | 0.02 | 0.04 | 6.2 | 0.08 | 0.13 | 52.0 | 24.0 | 20.0 | 0.72 | 0.36 |
| trend-only (trend state, no ride) | 322 | 55.6 (±5.4) | 0.01 | 0.05 | 1.9 | 0.02 | 0.14 | 40.1 | 28.9 | 20.2 | 0.68 | 0.39 |
| ALL days | 794 | 54.0 (±3.5) | 0.02 | 0.05 | 3.6 | 0.01 | 0.13 | 24.8 | 42.3 | 44.6 | 0.78 | 0.42 |

## Year split — BASE variant: RIDE vs trend-only (cont %, mean move EM, n)

| side | T | 2023 RIDE n | cont % | move EM | 2023 trend-only n | cont % | move EM | 2024 RIDE n | cont % | move EM | 2024 trend-only n | cont % | move EM | 2025 RIDE n | cont % | move EM | 2025 trend-only n | cont % | move EM | 2026 RIDE n | cont % | move EM | 2026 trend-only n | cont % | move EM |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bear | 10:30 | 20 | 30.0 | -0.53 | 67 | 52.2 | 0.08 | 18* | 50.0 | 0.06 | 74 | 50.0 | 0.13 | 32 | 31.3 | -0.14 | 58 | 46.6 | 0.24 | 3* | 66.7 | 0.66 | 24 | 41.7 | -0.35 |
| bear | 11:00 | 25 | 52.0 | 0.04 | 67 | 49.3 | -0.05 | 21 | 52.4 | -0.05 | 76 | 47.4 | -0.00 | 26 | 46.2 | 0.11 | 68 | 42.6 | 0.04 | 9* | 11.1 | -0.70 | 12* | 41.7 | 0.05 |
| bear | 11:30 | 25 | 60.0 | 0.21 | 64 | 40.6 | -0.14 | 18* | 38.9 | -0.08 | 73 | 49.3 | 0.10 | 32 | 46.9 | -0.03 | 58 | 48.3 | 0.30 | 8* | 37.5 | -0.49 | 13* | 46.2 | -0.20 |
| bear | 12:00 | 18* | 38.9 | -0.36 | 67 | 53.7 | 0.03 | 17* | 47.1 | 0.03 | 58 | 55.2 | 0.27 | 21 | 42.9 | 0.21 | 55 | 43.6 | -0.01 | 3* | 0.0 | -1.12 | 16* | 37.5 | -0.50 |
| bull | 10:30 | 29 | 65.5 | 0.38 | 72 | 63.9 | 0.21 | 34 | 55.9 | -0.05 | 64 | 60.9 | 0.18 | 23 | 56.5 | -0.25 | 77 | 64.9 | 0.02 | 5* | 40.0 | -0.36 | 21 | 57.1 | -0.08 |
| bull | 11:00 | 23 | 73.9 | 0.51 | 74 | 64.9 | 0.14 | 25 | 60.0 | 0.10 | 70 | 58.6 | 0.12 | 16* | 62.5 | 0.25 | 82 | 54.9 | 0.02 | 8* | 25.0 | -0.76 | 13* | 69.2 | -0.03 |
| bull | 11:30 | 22 | 68.2 | 0.30 | 87 | 58.6 | 0.15 | 21 | 52.4 | -0.14 | 84 | 56.0 | 0.14 | 22 | 63.6 | 0.11 | 72 | 61.1 | 0.23 | 8* | 37.5 | -0.75 | 15* | 53.3 | -0.26 |
| bull | 12:00 | 32 | 53.1 | -0.21 | 82 | 62.2 | 0.09 | 18* | 44.4 | -0.13 | 87 | 51.7 | 0.08 | 24 | 62.5 | 0.04 | 77 | 55.8 | 0.05 | 3* | 33.3 | -3.19 | 22 | 59.1 | 0.23 |

(* = n<20, thin. 2023-2025 priced on NQ RTH as a proxy; 2026 on cash NDX. 3 late-Dec-2022 days are in the aggregates but not shown here.)

## Day-level, BASE: first checkpoint at which the ride fires vs days in trend state at some checkpoint but never riding (outcome from the first qualifying T)

| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bear RIDE first fire | 198 | 40.9 (±6.8) | -0.05 | -0.12 | -9.5 | -0.09 | -0.28 | 39.4 | 46.0 | 32.3 | 0.90 | 0.51 |
| bear trend state, never ride | 231 | 46.8 (±6.4) | -0.03 | -0.05 | -1.9 | 0.02 | -0.11 | 42.9 | 41.1 | 35.1 | 0.93 | 0.52 |
| bull RIDE first fire | 200 | 58.0 (±6.8) | 0.01 | 0.07 | -2.3 | -0.03 | 0.14 | 52.5 | 30.0 | 22.0 | 0.66 | 0.47 |
| bull trend state, never ride | 267 | 57.3 (±5.9) | 0.04 | 0.09 | 6.5 | 0.08 | 0.19 | 51.3 | 30.3 | 26.6 | 0.76 | 0.52 |

## 2026-10-14 verification (raw-1m NQ signal, NDX price)

| 15m bar end | open | high | low | close | 9EMA | BB mid | BB lower | ema<mid | close<ema | rejection (base) | band touch (base) |
|---|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|:-:|
| 09:30 | 30588 | 30591.75 | 30535 | 30551.5 | 30656.36 | 30734.96 | 30562.06 | Y | Y | . | Y |
| 09:45 | 30551.5 | 30625.5 | 30498 | 30587 | 30642.49 | 30724.3 | 30542.74 | Y | Y | . | Y |
| 10:00 | 30586.5 | 30660.75 | 30465.75 | 30474.5 | 30608.89 | 30709.01 | 30499.53 | Y | Y | Y | Y |
| 10:15 | 30475.5 | 30538.25 | 30457.5 | 30491.5 | 30585.41 | 30694.01 | 30467.99 | Y | Y | . | Y |
| 10:30 | 30492 | 30526.75 | 30454.5 | 30476.25 | 30563.58 | 30680.54 | 30437 | Y | Y | . | . |
| 10:45 | 30476.75 | 30513.25 | 30453 | 30482.5 | 30547.36 | 30665.11 | 30412.61 | Y | Y | . | . |
| 11:00 | 30483.25 | 30520.75 | 30417.75 | 30488.5 | 30535.59 | 30649.85 | 30393.42 | Y | Y | Y | . |
| 11:15 | 30489 | 30491 | 30364.75 | 30390.25 | 30506.52 | 30629.99 | 30358.2 | Y | Y | Y | Y |
| 11:30 | 30390.5 | 30439.25 | 30382.25 | 30392.5 | 30483.72 | 30610.58 | 30329.34 | Y | Y | . | . |
| 11:45 | 30393.75 | 30401.75 | 30310.25 | 30328.25 | 30452.62 | 30589.29 | 30290.78 | Y | Y | . | . |
| 12:00 | 30328.75 | 30364.25 | 30314.75 | 30330.75 | 30428.25 | 30567.96 | 30259.72 | Y | Y | . | . |
| 12:15 | 30330.25 | 30343.5 | 30233 | 30236 | 30389.8 | 30542.25 | 30213.97 | Y | Y | . | . |
| 12:30 | 30235.75 | 30262 | 30214.5 | 30231.25 | 30358.09 | 30517.04 | 30174.84 | Y | Y | . | . |
| 12:45 | 30231.5 | 30297.75 | 30194.25 | 30285.75 | 30343.62 | 30494.06 | 30154.55 | Y | Y | . | . |
| 13:00 | 30285.75 | 30296 | 30251.25 | 30295.25 | 30333.95 | 30470.73 | 30144.17 | Y | Y | . | . |
| 13:15 | 30295.5 | 30309.75 | 30239 | 30244.75 | 30316.11 | 30442.65 | 30140.68 | Y | Y | Y | . |
| 13:30 | 30245.5 | 30247.25 | 30168.25 | 30177.75 | 30288.44 | 30409.55 | 30146.31 | Y | Y | . | . |
| 13:45 | 30178.75 | 30208.5 | 30155.25 | 30173.5 | 30265.45 | 30389.13 | 30119.26 | Y | Y | . | . |
| 14:00 | 30173.25 | 30191.75 | 30133.5 | 30146.25 | 30241.61 | 30368.59 | 30090.56 | Y | Y | . | . |
| 14:15 | 30146.5 | 30200.25 | 30103.25 | 30188.25 | 30230.94 | 30348.61 | 30079.17 | Y | Y | . | . |
| 14:30 | 30187.75 | 30196 | 30150.75 | 30173.5 | 30219.45 | 30329.71 | 30066.9 | Y | Y | . | . |
| 14:45 | 30173.5 | 30173.5 | 30118 | 30126.75 | 30200.91 | 30306.7 | 30057.8 | Y | Y | . | . |
| 15:00 | 30126.5 | 30165.75 | 30118.5 | 30132 | 30187.13 | 30289.58 | 30042.08 | Y | Y | Y | . |
| 15:15 | 30132.25 | 30134.5 | 30078 | 30126.25 | 30174.95 | 30271.31 | 30032.36 | Y | Y | . | . |
| 15:30 | 30126.25 | 30199 | 30106.5 | 30192.75 | 30178.51 | 30257.14 | 30035.49 | Y | . | . | . |
| 15:45 | 30193.25 | 30237 | 30162.5 | 30184 | 30179.61 | 30242.21 | 30044.35 | Y | . | . | . |
| 16:00 | 30183.5 | 30206.75 | 30147.25 | 30185 | 30180.69 | 30227.04 | 30063.47 | Y | . | . | . |

| T | base bear | N3 bear | N6 bear | loose bear | tight bear | base bull | N3 bull | N6 bull | loose bull | tight bull | trend bear | NDX P_T | NDX close (NDX 15:59 1m close) | bear move pts | beyond lower band | rev past 9EMA |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---:|---:|---:|:-:|:-:|
| 10:30 | no | no | no | YES | no | no | no | no | no | no | YES | 30259.47 | 29960.80 | 298.7 | YES | no |
| 11:00 | no | no | YES | YES | no | no | no | no | no | no | YES | 30267.33 | 29960.80 | 306.5 | YES | no |
| 11:30 | YES | YES | YES | YES | no | no | no | no | no | no | YES | 30176.25 | 29960.80 | 215.5 | YES | no |
| 12:00 | no | no | YES | YES | no | no | no | no | no | no | YES | 30112.81 | 29960.80 | 152.0 | YES | no |

