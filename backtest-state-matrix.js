#!/usr/bin/env node

/**
 * Backtest Matrix Runner for State Strategy
 *
 * Runs strategyStateOpen/strategyStateCover across combinations of dates and
 * configurations. Produces distinct backtest-actions files using runLabel or
 * a short hash of the config for easy A/B comparisons.
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { BacktestController } = require('./tests/backtest/backtest-controller');

function sortObjectKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (obj && typeof obj === 'object') {
    const sorted = {};
    Object.keys(obj).sort().forEach(k => { sorted[k] = sortObjectKeys(obj[k]); });
    return sorted;
  }
  return obj;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    symbol: 'NDX',
    dates: [],
    configs: [], // [{label, config}]
  };

  // Positional: symbol, datesCsv
  if (args[0] && !args[0].startsWith('--')) out.symbol = args[0];
  if (args[1] && !args[1].startsWith('--')) out.dates = args[1].split(',').map(s => s.trim()).filter(Boolean);

  // Flags
  const getFlag = (name) => {
    const i = args.findIndex(a => a === `--${name}`);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    const kv = args.find(a => a.startsWith(`--${name}=`));
    if (kv) return kv.split('=')[1];
    return null;
  };

  const configsStr = getFlag('configs'); // JSON array: [{label?, config}]
  const configsFile = getFlag('configsFile');
  const datesCsv = getFlag('dates');
  if (datesCsv) out.dates = datesCsv.split(',').map(s => s.trim()).filter(Boolean);

  out._configsStr = configsStr;
  out._configsFile = configsFile;
  return out;
}

async function loadConfigs(parsed) {
  if (parsed._configsFile) {
    const full = path.isAbsolute(parsed._configsFile) ? parsed._configsFile : path.resolve(process.cwd(), parsed._configsFile);
    const text = await fs.readFile(full, 'utf8');
    const arr = JSON.parse(text);
    return normalizeConfigArray(arr);
  }
  if (parsed._configsStr) {
    try {
      const arr = JSON.parse(parsed._configsStr);
      return normalizeConfigArray(arr);
    } catch (_) {
      const maybePath = path.resolve(process.cwd(), parsed._configsStr);
      const text = await fs.readFile(maybePath, 'utf8');
      const arr = JSON.parse(text);
      return normalizeConfigArray(arr);
    }
  }
  // Default single config: baseline defaults
  return [{ label: 'baseline', config: {} }];
}

function normalizeConfigArray(arr) {
  if (!Array.isArray(arr)) throw new Error('--configs must be a JSON array');
  return arr.map((entry, idx) => {
    if (entry && typeof entry === 'object') {
      if ('config' in entry) {
        return {
          label: entry.label || deriveLabel(entry.config),
          config: entry.config || {}
        };
      }
      // If the item is the config itself
      return {
        label: deriveLabel(entry),
        config: entry
      };
    }
    throw new Error(`Invalid config at index ${idx}`);
  });
}

function deriveLabel(cfg) {
  try {
    const norm = JSON.stringify(sortObjectKeys(cfg || {}));
    return `cfg-${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 8)}`;
  } catch (_) {
    return 'cfg-unknown';
  }
}

(async () => {
  try {
    const parsed = parseArgs(process.argv);
    const cfgs = await loadConfigs(parsed);

    if (!parsed.dates || parsed.dates.length === 0) {
      console.error('Please provide dates via positional arg or --dates YYYY-MM-DD,YYYY-MM-DD');
      process.exit(1);
    }

    console.log('Matrix backtest starting');
    console.log(`  Symbol: ${parsed.symbol}`);
    console.log(`  Dates: ${parsed.dates.join(', ')}`);
    console.log(`  Configs: ${cfgs.map(c => c.label).join(', ')}`);

    const openMethod = 'strategyStateOpen';
    const coverMethod = 'strategyStateCover';

    const summaries = [];
    for (const date of parsed.dates) {
      for (const { label, config } of cfgs) {
        const controller = new BacktestController();
        const runtimeOptions = { config, runLabel: label };
        let result = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            result = await controller.runBacktest(
              parsed.symbol,
              date,
              openMethod,
              coverMethod,
              runtimeOptions
            );
            break;
          } catch (err) {
            lastErr = err;
            console.error(`Run failed (attempt ${attempt}) for ${date} ${label}:`, err?.message || err);
          }
        }
        if (result && typeof result.totalProfitLoss === 'number') {
          const { totalProfitLoss, actionsPath } = result;
          summaries.push({ date, label, totalProfitLoss, actionsPath });
        } else {
          summaries.push({ date, label, error: lastErr?.message || 'unknown error' });
        }
      }
    }

    console.log('\nMatrix Summary:');
    summaries
      .sort((a, b) => (a.date === b.date ? a.label.localeCompare(b.label) : a.date.localeCompare(b.date)))
      .forEach(s => {
        if (s.error) {
          console.log(`  ${s.date} | ${s.label} | ERROR=${s.error}`);
        } else {
          console.log(`  ${s.date} | ${s.label} | P/L=${s.totalProfitLoss.toFixed(4)} | ${s.actionsPath}`);
        }
      });
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
