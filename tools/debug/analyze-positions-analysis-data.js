#!/usr/bin/env node
/**
 * Analyze positions-analysis-data JSON file for:
 * - Missing timestamps (gaps in the minute-by-minute timeline)
 * - Stale datetimes (candle datetime unchanged from previous entry)
 * - noData / staleData markers
 * - Entries with empty analysis blocks
 *
 * Usage:
 *   node tools/debug/analyze-positions-analysis-data.js [symbol] [date]
 *
 * Defaults to NDX and today's date (ET).
 */

const fs = require('fs');
const path = require('path');

const symbol = process.argv[2] || 'NDX';
const dateArg = process.argv[3];
const today = dateArg || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

const filePath = path.join(
  __dirname,
  '../../server/src/persistence',
  `positions-analysis-data-${symbol}-${today}.json`
);

if (!fs.existsSync(filePath)) {
  console.error(`❌ File not found: ${filePath}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const timestamps = data.map(e => e.timestamp);

const toMinutes = ts => {
  const [h, m] = ts.split(':').map(Number);
  return h * 60 + m;
};

console.log(`\n📊 Analysis: positions-analysis-data-${symbol}-${today}.json`);
console.log(`   Total entries : ${data.length}`);
console.log(`   Range         : ${timestamps[0]} – ${timestamps[timestamps.length - 1]}`);

const firstMin = toMinutes(timestamps[0]);
const lastMin  = toMinutes(timestamps[timestamps.length - 1]);
const expected = lastMin - firstMin + 1;
const missing  = expected - data.length;
console.log(`   Expected      : ${expected}   Missing: ${missing === 0 ? '✅ 0' : `❌ ${missing}`}`);

// ── Gaps ───────────────────────────────────────────────────────────────────
const gaps = [];
for (let i = 1; i < data.length; i++) {
  const diff = toMinutes(timestamps[i]) - toMinutes(timestamps[i - 1]);
  if (diff > 1) gaps.push({ from: timestamps[i - 1], to: timestamps[i], gap: diff });
}

console.log(`\n── Gaps (${gaps.length}) ${'─'.repeat(50)}`);
if (gaps.length === 0) {
  console.log('   ✅ No gaps — all minutes consecutive');
} else {
  gaps.forEach(g =>
    console.log(`   ⛔  ${g.from} → ${g.to}  (${g.gap} min missing: ${g.gap - 1} skipped)`)
  );
}

// ── Stale candle datetimes ─────────────────────────────────────────────────
const staleDt = [];
for (let i = 1; i < data.length; i++) {
  if (data[i].datetime && data[i].datetime === data[i - 1].datetime) {
    staleDt.push({ ts: data[i].timestamp, datetime: data[i].datetime });
  }
}

console.log(`\n── Stale candle datetimes (${staleDt.length}) ${'─'.repeat(37)}`);
if (staleDt.length === 0) {
  console.log('   ✅ Every entry has a unique candle datetime');
} else {
  staleDt.forEach(s =>
    console.log(`   ⚠️  ${s.ts}  datetime=${s.datetime}  (${new Date(s.datetime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })})`)
  );
}

// ── noData markers ─────────────────────────────────────────────────────────
const noDataEntries = data.filter(e => e.noData);
console.log(`\n── noData markers (${noDataEntries.length}) ${'─'.repeat(43)}`);
if (noDataEntries.length === 0) {
  console.log('   ✅ None');
} else {
  noDataEntries.forEach(e =>
    console.log(`   ℹ️  ${e.timestamp}  reason: ${e.reason || '(none)'}`)
  );
}

// ── staleData markers ──────────────────────────────────────────────────────
const staleDataEntries = data.filter(e => e.staleData);
console.log(`\n── staleData markers (${staleDataEntries.length}) ${'─'.repeat(41)}`);
if (staleDataEntries.length === 0) {
  console.log('   ✅ None');
} else {
  staleDataEntries.forEach(e =>
    console.log(`   🔁  ${e.timestamp}  stale for ${e.staleMinutes ?? '?'} min`)
  );
}

// ── Entries with empty analysis ────────────────────────────────────────────
const emptyAnalysis = data.filter(
  e => !e.noData && !e.staleData && (!e.analysis || Object.keys(e.analysis).length === 0)
);
console.log(`\n── Entries with empty analysis block (${emptyAnalysis.length}) ${'─'.repeat(26)}`);
if (emptyAnalysis.length === 0) {
  console.log('   ✅ None');
} else {
  emptyAnalysis.forEach(e => console.log(`   ⚠️  ${e.timestamp}`));
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(64)}`);
const issues = gaps.length + staleDt.length + noDataEntries.length + staleDataEntries.length + emptyAnalysis.length;
if (issues === 0 && missing === 0) {
  console.log('✅ File looks clean — no issues found.');
} else {
  if (missing > 0)               console.log(`❌ ${missing} missing minute(s) — check for gaps above`);
  if (gaps.length > 0)           console.log(`⛔  ${gaps.length} gap(s) totalling ${gaps.reduce((a,g)=>a+g.gap-1,0)} skipped minutes`);
  if (staleDt.length > 0)        console.log(`⚠️  ${staleDt.length} entry/entries with repeated candle datetime`);
  if (noDataEntries.length > 0)  console.log(`ℹ️  ${noDataEntries.length} noData marker(s)`);
  if (staleDataEntries.length > 0) console.log(`🔁 ${staleDataEntries.length} staleData marker(s)`);
  if (emptyAnalysis.length > 0)  console.log(`⚠️  ${emptyAnalysis.length} entry/entries with empty analysis block`);
}
console.log('');
