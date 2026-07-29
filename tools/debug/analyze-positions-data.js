const fs = require('fs');
const path = require('path');

const date = process.argv[2] || '2026-04-16';
const filePath = path.join(__dirname, '..', '..', 'server', 'src', 'persistence', `positions-analysis-data-NDX-${date}.json`);

const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
console.log(`Analyzing: ${filePath}`);
console.log(`Total entries: ${data.length}`);
console.log(`First timestamp: ${data[0].timestamp}`);
console.log(`Last timestamp: ${data[data.length - 1].timestamp}`);

// Find timestamp gaps
const gaps = [];
for (let i = 1; i < data.length; i++) {
  const prev = data[i - 1].timestamp;
  const curr = data[i].timestamp;
  const [ph, pm] = prev.split(':').map(Number);
  const [ch, cm] = curr.split(':').map(Number);
  const prevMins = ph * 60 + pm;
  const currMins = ch * 60 + cm;
  const diff = currMins - prevMins;
  if (diff > 1) gaps.push({ from: prev, to: curr, gapMins: diff });
}
console.log(`\nTimestamp gaps (>1 min): ${gaps.length}`);
gaps.forEach(g => console.log(`  ${g.from} -> ${g.to} (${g.gapMins} min gap)`));

// Find entries with stale (unchanged) 1m close vs previous
let staleRuns = [];
let currentRun = null;
for (let i = 1; i < data.length; i++) {
  const prev = data[i - 1].analysis?.['1m']?.close;
  const curr = data[i].analysis?.['1m']?.close;
  if (curr === prev) {
    if (!currentRun) currentRun = { start: data[i - 1].timestamp, count: 1 };
    currentRun.count++;
    currentRun.end = data[i].timestamp;
  } else {
    if (currentRun) { staleRuns.push(currentRun); currentRun = null; }
  }
}
if (currentRun) staleRuns.push(currentRun);

console.log(`\nStale data runs (consecutive unchanged 1m close): ${staleRuns.length}`);
staleRuns.forEach(r => console.log(`  ${r.start} -> ${r.end} (${r.count} entries unchanged)`));

// Also check if datetime changes
let staleDatetime = 0;
for (let i = 1; i < data.length; i++) {
  if (data[i].datetime === data[i - 1].datetime) staleDatetime++;
}
console.log(`\nEntries with same datetime as previous: ${staleDatetime} of ${data.length - 1}`);
