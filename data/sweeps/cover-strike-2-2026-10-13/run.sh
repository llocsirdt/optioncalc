cd /Users/tdriscoll/Documents/surf/optioncalc
V=$(for v in 0 1 2 3 4 5 6 7 8 9; do for w in 10 20 40; do printf "v$v-$w,"; done; done)
node scripts/candle-spread/sweep-loss-cap.js --revalArms --arms "range p0.01,range p0.02,range p0.02 + roll 0.03,range p0.03 + roll 0.03" --variants "${V%,}" --openFillModel ladder --subBarFill 1m --sub1m signal-lab-data/raw-1m --workers 8 --dataDir tests/backtest/backtest-data-5m-combined --out data/sweeps/cover-strike-2-2026-10-13 > data/sweeps/cover-strike-2-2026-10-13/run.log 2>&1
