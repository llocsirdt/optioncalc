#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');

async function readJsonSafe(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    symbol: 'NDX',
    dates: [],
    actionsDir: 'optioncalc/tests/backtest/backtest-actions',
    labels: [
      'm3-gate-strict',
      'm3-gate-relax',
      'm3-cover-strong',
      'm4-gate-relax',
      'm4-cover-strong',
      'm5-gate-cover'
    ],
    includeBaselines: true,
    includeDynamic: true,
    outCsv: null,
  };
  if (args[0] && !args[0].startsWith('--')) out.symbol = args[0];
  const getFlag = (name) => {
    const i = args.findIndex(a => a === `--${name}`);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    const kv = args.find(a => a.startsWith(`--${name}=`));
    if (kv) return kv.split('=')[1];
    return null;
  };
  const datesCsv = getFlag('dates');
  if (datesCsv) out.dates = datesCsv.split(',').map(s => s.trim()).filter(Boolean);
  const labelsStr = getFlag('labels');
  if (labelsStr) {
    try { out.labels = JSON.parse(labelsStr); } catch (_) {}
  }
  const actionsDir = getFlag('actionsDir');
  if (actionsDir) out.actionsDir = actionsDir;
  const includeDynamic = getFlag('includeDynamic');
  if (includeDynamic !== null) {
    // treat explicit 'false' as false; anything else as true
    out.includeDynamic = includeDynamic === 'false' ? false : true;
  }
  const outCsv = getFlag('outCsv');
  if (outCsv) out.outCsv = outCsv;
  return out;
}

function uniq(arr) { return Array.from(new Set(arr)); }

function buildFilename(symbol, date, label) {
  if (label === 'baseline') {
    return `backtest-actions-${symbol}-${date}-State-State.json`;
  }
  return `backtest-actions-${symbol}-${date}-State-State-${label}.json`;
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch (_) { return false; }
}

async function findLatestDynamicFile(baseDir, symbol, date) {
  const prefix = `backtest-actions-${symbol}-${date}-State-State-dynamic`;
  const all = await fs.readdir(baseDir).catch(() => []);
  const matches = all.filter(name => name.startsWith(prefix) && name.endsWith('.json'));
  if (!matches.length) return null;
  let best = null;
  for (const name of matches) {
    const full = path.join(baseDir, name);
    let st = null;
    try { st = await fs.stat(full); } catch (_) { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { path: full, name, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

async function collectForDate(baseDir, symbol, date, labels, { includeDynamic }) {
  const results = [];
  for (const label of labels) {
    if (label === 'dynamic') continue; // handled separately
    const fname = buildFilename(symbol, date, label);
    const fpath = path.join(baseDir, fname);
    if (!(await fileExists(fpath))) {
      results.push({ date, label, missing: true });
      continue;
    }
    const json = await readJsonSafe(fpath);
    const pl = json?.metadata?.totalProfitLoss;
    const actions = json?.metadata?.totalActions;
    results.push({ date, label, totalProfitLoss: typeof pl === 'number' ? pl : null, totalActions: typeof actions === 'number' ? actions : null, path: fpath });
  }
  if (includeDynamic) {
    const best = await findLatestDynamicFile(baseDir, symbol, date);
    if (!best) {
      results.push({ date, label: 'dynamic', missing: true });
    } else {
      const json = await readJsonSafe(best.path);
      const pl = json?.metadata?.totalProfitLoss;
      const actions = json?.metadata?.totalActions;
      const runLabel = json?.metadata?.runLabel;
      results.push({ date, label: 'dynamic', totalProfitLoss: typeof pl === 'number' ? pl : null, totalActions: typeof actions === 'number' ? actions : null, path: best.path, runLabel });
    }
  }
  return results;
}

function toCsv(rows) {
  const header = ['date','label','totalProfitLoss','totalActions','path'];
  const body = rows.map(r => [r.date, r.label, r.totalProfitLoss ?? '', r.totalActions ?? '', r.path ?? ''].join(','));
  return [header.join(','), ...body].join('\n');
}

function sumFor(rows, where) {
  return rows
    .filter(where)
    .reduce((acc, r) => acc + (typeof r.totalProfitLoss === 'number' ? r.totalProfitLoss : 0), 0);
}

(async () => {
  const parsed = parseArgs(process.argv);
  if (!parsed.dates.length) {
    parsed.dates = [
      '2026-02-03','2026-02-12','2026-02-18','2026-02-24','2026-02-26',
      '2026-03-02','2026-03-03','2026-03-04','2026-03-05','2026-03-06','2026-03-09','2026-03-10','2026-03-11'
    ];
  }
  const febWorst = new Set(['2026-02-03','2026-02-12','2026-02-18','2026-02-24','2026-02-26']);
  const marchRest = new Set(parsed.dates.filter(d => !febWorst.has(d)));

  const baselineLabels = parsed.includeBaselines ? ['baseline','min3','min4','min5'] : [];
  const labelsAll = uniq([...baselineLabels, ...parsed.labels, ...(parsed.includeDynamic ? ['dynamic'] : [])]);

  const allRows = [];
  for (const date of parsed.dates) {
    const rows = await collectForDate(parsed.actionsDir, parsed.symbol, date, labelsAll, { includeDynamic: parsed.includeDynamic });
    allRows.push(...rows);
  }

  // Write CSV if requested
  if (parsed.outCsv) {
    const csv = toCsv(allRows);
    const outAbs = path.isAbsolute(parsed.outCsv) ? parsed.outCsv : path.resolve(process.cwd(), parsed.outCsv);
    await fs.mkdir(path.dirname(outAbs), { recursive: true });
    await fs.writeFile(outAbs, csv, 'utf8');
    console.log(`CSV written: ${outAbs}`);
  }

  // Print summaries
  console.log(`Summary Totals (All ${parsed.dates.length} dates):`);
  for (const label of labelsAll) {
    const total = sumFor(allRows, r => r.label === label);
    console.log(`  ${label.padEnd(16)} ${total.toFixed(4)}`);
  }
  console.log('\nCohort Totals:');
  for (const label of labelsAll) {
    const feb = sumFor(allRows, r => r.label === label && febWorst.has(r.date));
    const mar = sumFor(allRows, r => r.label === label && marchRest.has(r.date));
    console.log(`  ${label.padEnd(16)} FebWorst=${feb.toFixed(4)}  March=${mar.toFixed(4)}`);
  }

  // Per-date best among matrix labels vs baselines
  console.log('\nPer-date best among matrix labels (vs baselines):');
  for (const date of parsed.dates) {
    const matrixRows = allRows.filter(r => r.date === date && parsed.labels.includes(r.label));
    const best = matrixRows.reduce((a, b) => (a && typeof a.totalProfitLoss==='number' && a.totalProfitLoss >= (b.totalProfitLoss??-Infinity)) ? a : b, null);
    const baseRows = allRows.filter(r => r.date === date && baselineLabels.includes(r.label));
    const baseBest = baseRows.reduce((a, b) => (a && typeof a.totalProfitLoss==='number' && a.totalProfitLoss >= (b.totalProfitLoss??-Infinity)) ? a : b, null);
    const bestStr = best ? `${best.label} ${best.totalProfitLoss?.toFixed(4)}` : 'n/a';
    const baseStr = baseBest ? `${baseBest.label} ${baseBest.totalProfitLoss?.toFixed(4)}` : 'n/a';
    console.log(`  ${date} | matrix: ${bestStr} | baseline-set: ${baseStr}`);
  }

  if (parsed.includeDynamic) {
    console.log('\nPer-date dynamic selection:');
    for (const date of parsed.dates) {
      const row = allRows.find(r => r.date === date && r.label === 'dynamic');
      if (!row || row.missing) {
        console.log(`  ${date} | dynamic: missing`);
        continue;
      }
      const sel = row.runLabel || path.basename(row.path).replace(`backtest-actions-${parsed.symbol}-${date}-State-State-`, '').replace('.json','');
      console.log(`  ${date} | ${sel} | P/L: ${typeof row.totalProfitLoss==='number' ? row.totalProfitLoss.toFixed(4) : 'n/a'}`);
    }
  }
})();
