cd /Users/tdriscoll/Documents/surf/optioncalc
while kill -0 88142 2>/dev/null; do sleep 30; done
V=$(for v in 0 1 2 3 4 5 6 7 8 9; do for w in 10 20 40; do printf "v$v-$w,"; done; done)
node scripts/candle-spread/sweep-loss-cap.js --revalArms --arms "roster,step k1/5m,step k1/10m,step k2/5m,step k2/10m,step k2/5m in,step k2/5m p0.03" --variants "${V%,}" --openFillModel ladder --subBarFill 1m --sub1m signal-lab-data/raw-1m --workers 8 --dataDir tests/backtest/backtest-data-5m-combined --out data/sweeps/strike-ladder-2026-10-13 > data/sweeps/strike-ladder-2026-10-13/run.log 2>&1
