cd /Users/tdriscoll/Documents/surf/optioncalc
while pgrep -f "rerun-metrics.sh" >/dev/null; do sleep 30; done
V=$(for v in 0 1 2 3 4 5 6 7 8 9; do for w in 10 20 40; do printf "v$v-$w,"; done; done)
node scripts/candle-spread/sweep-loss-cap.js --revalArms --arms "roster,gu inside,range p0.03,range p0.05,range p0.08,roll 0.03,roll 0.06,range p0.05 + roll 0.03,geo offset1,geo offset1 gu tent" --variants "${V%,}" --openFillModel ladder --subBarFill 1m --sub1m signal-lab-data/raw-1m --workers 8 --dataDir tests/backtest/backtest-data-5m-combined --out data/sweeps/cover-strike-2026-10-12 > data/sweeps/cover-strike-2026-10-12/run.log 2>&1
