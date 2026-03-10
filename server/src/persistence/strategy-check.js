const {
  strategySimple5mBBScoreOpen,
  strategySimple15mBBScoreOpen,
  strategySimple15and60mBBScoreOpen,
  strategySimple5mBBScoreCover,
  strategySimple15mBBScoreCover,
  strategySimple15and60mBBScoreCover,
  strategy1m5m15mOpen,
  strategy1m5m15mCover,
  strategyPriceTrailOpen,
  strategyPriceTrailCover,
  strategyStateOpen,
  strategyStateCover
} = require('./strategy-logic');

function buildStateOpenAnalysis(candleAnalysis) {
  if (!candleAnalysis || !candleAnalysis.candleData) return null;

  const analysis = {};
  const mappings = [
    { key: '1m', alias: '1m' },
    { key: '5m', alias: '5m' },
    { key: '15m', alias: '15m' },
    { key: '1h', alias: '60m' }
  ];

  for (const { key, alias } of mappings) {
    const tfData = candleAnalysis.candleData[key];
    if (!tfData || !tfData.candles || tfData.candles.length === 0) continue;
    const latest = tfData.candles[0];
    const prev = tfData.candles[1];
    const bbScoreDelta = latest.bbScoreDelta !== undefined && latest.bbScoreDelta !== null
      ? latest.bbScoreDelta
      : (prev && prev.bbScore !== undefined ? latest.bbScore - prev.bbScore : null);
    analysis[alias] = {
      bbScore: latest.bbScore,
      bbScoreDelta,
      close: latest.close
    };
  }

  return analysis;
}

function buildStateCoverAnalysis(candleAnalysis) {
  if (!candleAnalysis || !candleAnalysis.candleData) return null;

  const analysis = {};
  const mappings = [
    { key: '1m', alias: '1m' },
    { key: '5m', alias: '5m' }
  ];

  for (const { key, alias } of mappings) {
    const tfData = candleAnalysis.candleData[key];
    if (!tfData || !tfData.candles || tfData.candles.length === 0) continue;
    const latest = tfData.candles[0];
    const prev = tfData.candles[1];
    const bbScoreDelta = latest.bbScoreDelta !== undefined && latest.bbScoreDelta !== null
      ? latest.bbScoreDelta
      : (prev && prev.bbScore !== undefined ? latest.bbScore - prev.bbScore : null);
    analysis[alias] = {
      bbScore: latest.bbScore,
      bbScoreDelta,
      close: latest.close
    };
  }

  return analysis;
}

async function checkSimple5mBBScoreOpen(symbol, expiration, candleAnalysis) {
  if (candleAnalysis && candleAnalysis.success) {
    const candleData5m = candleAnalysis.candleData['5m'];

    if (candleData5m && candleData5m.candles && candleData5m.candles.length > 0) {
      const latestCandle = candleData5m.candles[0];
      const bbScore = latestCandle.bbScore;

      console.log(`  ${symbol}: Latest 5m BB score: ${bbScore}`);

      const analysis = { '5m': { bbScore } };
      const result = strategySimple5mBBScoreOpen(analysis);

      if (result.action === 'open_bull') {
        console.log(`  ${symbol}: 5m BB score indicates bull signal (bb > 1), opening bull position`);
        await this.tryOpenBullPosition(symbol, expiration);
        return true;
      } else if (result.action === 'open_bear') {
        console.log(`  ${symbol}: 5m BB score indicates bear signal (bb < -1), opening bear position`);
        await this.tryOpenBearPosition(symbol, expiration);
        return true;
      } else {
        console.log(`  ${symbol}: 5m BB score neutral, skipping position opening`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: No 5m candle data available, skipping position opening`);
      return false;
    }
  } else {
    console.log(`  ${symbol}: No candle analysis available, skipping position opening`);
    return false;
  }
}

async function checkSimple15mBBScoreOpen(symbol, expiration, candleAnalysis) {
  if (candleAnalysis && candleAnalysis.success) {
    const candleData15m = candleAnalysis.candleData['15m'];

    if (candleData15m && candleData15m.candles && candleData15m.candles.length > 0) {
      const latestCandle = candleData15m.candles[0];
      const bbScore = latestCandle.bbScore;

      console.log(`  ${symbol}: Latest 15m BB score: ${bbScore}`);

      const analysis = { '15m': { bbScore } };
      const result = strategySimple15mBBScoreOpen(analysis);

      if (result.action === 'open_bull') {
        console.log(`  ${symbol}: 15m BB score indicates bull signal (bb > 1), opening bull position`);
        await this.tryOpenBullPosition(symbol, expiration);
        return true;
      } else if (result.action === 'open_bear') {
        console.log(`  ${symbol}: 15m BB score indicates bear signal (bb < -1), opening bear position`);
        await this.tryOpenBearPosition(symbol, expiration);
        return true;
      } else {
        console.log(`  ${symbol}: 15m BB score neutral, skipping position opening`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: No 15m candle data available, skipping position opening`);
      return false;
    }
  } else {
    console.log(`  ${symbol}: No candle analysis available, skipping position opening`);
    return false;
  }
}

async function checkSimple15and60mBBScoreOpen(symbol, expiration, candleAnalysis) {
  if (candleAnalysis && candleAnalysis.success) {
    const candleData15m = candleAnalysis.candleData['15m'];
    const candleData60m = candleAnalysis.candleData['1h'];

    if (
      candleData15m && candleData15m.candles && candleData15m.candles.length > 0 &&
      candleData60m && candleData60m.candles && candleData60m.candles.length > 0
    ) {
      const latestCandle15m = candleData15m.candles[0];
      const latestCandle60m = candleData60m.candles[0];
      const bbScore15m = latestCandle15m.bbScore;
      const bbScore60m = latestCandle60m.bbScore;

      console.log(`  ${symbol}: Latest 15m BB score: ${bbScore15m}, 60m BB score: ${bbScore60m}`);

      const analysis = {
        '15m': { bbScore: bbScore15m },
        '60m': { bbScore: bbScore60m }
      };
      const result = strategySimple15and60mBBScoreOpen(analysis);

      if (result.action === 'open_bull') {
        console.log(`  ${symbol}: Both 15m and 60m BB scores indicate bull signal (bb > 1), opening bull position`);
        await this.tryOpenBullPosition(symbol, expiration);
        return true;
      } else if (result.action === 'open_bear') {
        console.log(`  ${symbol}: Both 15m and 60m BB scores indicate bear signal (bb < -1), opening bear position`);
        await this.tryOpenBearPosition(symbol, expiration);
        return true;
      } else {
        console.log(`  ${symbol}: BB scores do not agree or are neutral (15m: ${bbScore15m}, 60m: ${bbScore60m}), skipping position opening`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: Missing 15m or 60m candle data, skipping position opening`);
      return false;
    }
  } else {
    console.log(`  ${symbol}: No candle analysis available, skipping position opening`);
    return false;
  }
}

async function checkSimple5mBBScoreCover(symbolExpiration, position, candleAnalysis) {
  if (candleAnalysis && candleAnalysis.success) {
    const candleData5m = candleAnalysis.candleData['5m'];

    if (candleData5m && candleData5m.candles && candleData5m.candles.length > 0) {
      const latestCandle = candleData5m.candles[0];
      const bbScore = latestCandle.bbScore;

      const [symbol] = symbolExpiration.split('_');
      console.log(`  ${symbol}: Latest 5m BB score: ${bbScore}`);

      const analysis = { '5m': { bbScore } };
      const result = strategySimple5mBBScoreCover(position, analysis);

      if (result.action === 'cover') {
        if (position.type === 'bull') {
          console.log(`  ${symbol}: 5m BB score indicates cover bull position (bb < -1), covering bull position`);
          await this.tryCoverBullPosition(symbolExpiration, position, undefined, { source: 'simple-5m' });
        } else if (position.type === 'bear') {
          console.log(`  ${symbol}: 5m BB score indicates cover bear position (bb > 1), covering bear position`);
          await this.tryCoverBearPosition(symbolExpiration, position, undefined, { source: 'simple-5m' });
        }
        return true;
      } else {
        console.log(`  ${symbol}: 5m BB score neutral, skipping position covering`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: No 5m candle data available, skipping position covering`);
      return false;
    }
  } else {
    console.log(`  ${symbol}: No candle analysis available, skipping position covering`);
    return false;
  }
}

async function checkSimple15mBBScoreCover(symbolExpiration, position, candleAnalysis) {
  if (candleAnalysis && candleAnalysis.success) {
    const candleData15m = candleAnalysis.candleData['15m'];

    if (candleData15m && candleData15m.candles && candleData15m.candles.length > 0) {
      const latestCandle = candleData15m.candles[0];
      const bbScore = latestCandle.bbScore;

      const [symbol] = symbolExpiration.split('_');
      console.log(`  ${symbol}: Latest 15m BB score: ${bbScore}`);

      const analysis = { '15m': { bbScore } };
      const result = strategySimple15mBBScoreCover(position, analysis);

      if (result.action === 'cover') {
        if (position.type === 'bull') {
          console.log(`  ${symbol}: 15m BB score indicates cover bull position (bb < -1), covering bull position`);
          await this.tryCoverBullPosition(symbolExpiration, position, undefined, { source: 'simple-15m' });
        } else if (position.type === 'bear') {
          console.log(`  ${symbol}: 15m BB score indicates cover bear position (bb > 1), covering bear position`);
          await this.tryCoverBearPosition(symbolExpiration, position, undefined, { source: 'simple-15m' });
        }
        return true;
      } else {
        console.log(`  ${symbol}: 15m BB score neutral, skipping position covering`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: No 15m candle data available, skipping position covering`);
      return false;
    }
  } else {
    console.log(`  ${symbol}: No candle analysis available, skipping position covering`);
    return false;
  }
}

async function checkSimple15and60mBBScoreCover(symbolExpiration, position, candleAnalysis) {
  if (candleAnalysis && candleAnalysis.success) {
    const candleData15m = candleAnalysis.candleData['15m'];
    const candleData60m = candleAnalysis.candleData['1h'];

    if (
      candleData15m && candleData15m.candles && candleData15m.candles.length > 0 &&
      candleData60m && candleData60m.candles && candleData60m.candles.length > 0
    ) {
      const latestCandle15m = candleData15m.candles[0];
      const latestCandle60m = candleData60m.candles[0];
      const bbScore15m = latestCandle15m.bbScore;
      const bbScore60m = latestCandle60m.bbScore;

      const [symbol] = symbolExpiration.split('_');
      console.log(`  ${symbol}: Latest 15m BB score: ${bbScore15m}, 60m BB score: ${bbScore60m}`);

      const analysis = {
        '15m': { bbScore: bbScore15m },
        '60m': { bbScore: bbScore60m }
      };
      const result = strategySimple15and60mBBScoreCover(position, analysis);

      if (result.action === 'cover') {
        if (position.type === 'bull') {
          console.log(`  ${symbol}: Both 15m and 60m BB scores indicate cover bull position (bb < -1), covering bull position`);
          await this.tryCoverBullPosition(symbolExpiration, position, undefined, { source: 'simple-15-60m' });
        } else if (position.type === 'bear') {
          console.log(`  ${symbol}: Both 15m and 60m BB scores indicate cover bear position (bb > 1), covering bear position`);
          await this.tryCoverBearPosition(symbolExpiration, position, undefined, { source: 'simple-15-60m' });
        }
        return true;
      } else {
        console.log(`  ${symbol}: BB scores do not agree or are neutral (15m: ${bbScore15m}, 60m: ${bbScore60m}), skipping position covering`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: Missing 15m or 60m candle data, skipping position covering`);
      return false;
    }
  } else {
    console.log(`  ${symbol}: No candle analysis available, skipping position covering`);
    return false;
  }
}

async function checkSimpleCover(symbolExpiration, position) {
  const strategy = position.strategy || 'unknown';

  if (strategy.includes('bull')) {
    await this.tryCoverBullPosition(symbolExpiration, position, undefined, { source: 'simple-strategy' });
    return true;
  } else if (strategy.includes('bear')) {
    await this.tryCoverBearPosition(symbolExpiration, position, undefined, { source: 'simple-strategy' });
    return true;
  } else {
    console.log(`❓ Unknown strategy for ${symbolExpiration}: ${strategy}`);
    return false;
  }
}

async function check1m5m15mCover(symbolExpiration, position, candleAnalysis) {
  const [symbol] = symbolExpiration.split('_');

  if (!candleAnalysis || !candleAnalysis.success) {
    console.log(`  ${symbol}: No candle analysis available, skipping 1m/5m/15m cover check`);
    return false;
  }

  const requiredTimeframes = ['1m', '5m', '15m'];
  const latest = {};

  for (const tf of requiredTimeframes) {
    const tfData = candleAnalysis.candleData[tf];
    if (!tfData || !tfData.candles || tfData.candles.length === 0) {
      console.log(`  ${symbol}: Missing ${tf} candle data, skipping 1m/5m/15m cover check`);
      return false;
    }
    const candle = tfData.candles[0];
    latest[tf] = { bbScore: candle.bbScore, trendScore: candle.trendScore };
  }

  console.log(`  ${symbol}: 1m/5m/15m cover bbScores = ${latest['1m'].bbScore}, ${latest['5m'].bbScore}, ${latest['15m'].bbScore}`);

  const result = strategy1m5m15mCover(position, latest);

  if (result.action === 'cover') {
    if (position.type === 'bull') {
      console.log(`  ${symbol}: 1m/5m/15m signals indicate covering bull position`);
      await this.tryCoverBullPosition(symbolExpiration, position, undefined, { source: '1m5m15m' });
    } else if (position.type === 'bear') {
      console.log(`  ${symbol}: 1m/5m/15m signals indicate covering bear position`);
      await this.tryCoverBearPosition(symbolExpiration, position, undefined, { source: '1m5m15m' });
    }
    return true;
  }

  console.log(`  ${symbol}: 1m/5m/15m signals do not call for covering`);
  return false;
}

async function checkStateOpen(symbol, expiration, position, candleAnalysis, persistenceManager) {
  const analysis = buildStateOpenAnalysis(candleAnalysis);
  if (!analysis) {
    console.log(`  ${symbol}: Missing analysis data for state open evaluation`);
    return { action: 'hold', nextState: position?.state, nextBias: position?.bias, executed: false };
  }

  const result = strategyStateOpen(position, analysis);
  const underlyingPrice = analysis['1m']?.close ?? analysis['5m']?.close ?? null;
  let executed = false;

  if (result.action === 'open_bull' || result.action === 'open_bear') {
    console.log(`  ${symbol}: State strategy recommends ${result.action} (reason=${result.reason || 'n/a'})`);
    if (!persistenceManager) {
      console.log(`  ${symbol}: No persistence manager available, skipping open execution`);
    } else if (underlyingPrice == null) {
      console.log(`  ${symbol}: Missing underlying price, cannot execute state open`);
    } else {
      try {
        if (result.action === 'open_bull') {
          await this.tryOpenBullPosition(symbol, expiration, underlyingPrice, persistenceManager);
        } else {
          await this.tryOpenBearPosition(symbol, expiration, underlyingPrice, persistenceManager);
        }
        executed = true;
      } catch (error) {
        console.error(`  ${symbol}: Failed to execute state open (${result.action}) - ${error.message}`);
      }
    }
  }

  return { ...result, executed, underlyingPrice };
}

async function checkStateCover(symbolExpiration, position, candleAnalysis) {
  const [symbol, expiration] = symbolExpiration.split('_');
  const analysis = buildStateCoverAnalysis(candleAnalysis);
  if (!analysis) {
    console.log(`  ${symbol}: Missing analysis data for state cover evaluation`);
    return { action: 'hold', nextState: position?.state, executed: false };
  }

  const positionType = this.determinePositionType ? this.determinePositionType(position) : position.type;
  const result = strategyStateCover(position, analysis, { positionType });
  const underlyingPrice = analysis['1m']?.close ?? analysis['5m']?.close ?? null;
  const diagnostics = {
    state: position?.state || 'unknown',
    bias: position?.bias || 'unknown',
    positionType: positionType || 'unknown',
    bb1m,
    bb5m,
    delta1m,
    delta5m
  };
  let executed = false;

  if (result.action === 'cover') {
    console.log(
      `  ${symbol}: State strategy recommends cover (reason=${result.reason || 'n/a'}, ` +
      `state=${diagnostics.state}, type=${diagnostics.positionType}, ` +
      `bb1m=${diagnostics.bb1m ?? 'n/a'}, bb5m=${diagnostics.bb5m ?? 'n/a'}, ` +
      `Δ1m=${diagnostics.delta1m ?? 'n/a'}, Δ5m=${diagnostics.delta5m ?? 'n/a'})`
    );
    if (!positionType || positionType === 'unknown') {
      console.log(`  ${symbol}: Unable to determine position type, skipping cover execution`);
    } else if (underlyingPrice == null) {
      console.log(`  ${symbol}: Missing underlying price, cannot execute state cover`);
    } else {
      try {
        if (positionType === 'bull') {
          await this.tryCoverBullPosition(symbolExpiration, position, underlyingPrice, { source: 'state-machine', context: diagnostics });
        } else if (positionType === 'bear') {
          await this.tryCoverBearPosition(symbolExpiration, position, underlyingPrice, { source: 'state-machine', context: diagnostics });
        } else {
          console.log(`  ${symbol}: Unsupported position type ${positionType} for cover execution`);
        }
        executed = true;
      } catch (error) {
        console.error(`  ${symbol}: Failed to execute state cover - ${error.message}`);
      }
    }
  }

  return { ...result, positionType, executed, underlyingPrice, diagnostics };
}

async function check1m5m15mOpen(symbol, expiration, candleAnalysis) {
  if (!candleAnalysis || !candleAnalysis.success) {
    console.log(`  ${symbol}: No candle analysis available, skipping 1m/5m/15m open check`);
    return false;
  }

  const requiredTimeframes = ['1m', '5m', '15m'];
  const latest = {};

  for (const tf of requiredTimeframes) {
    const tfData = candleAnalysis.candleData[tf];
    if (!tfData || !tfData.candles || tfData.candles.length === 0) {
      console.log(`  ${symbol}: Missing ${tf} candle data, skipping 1m/5m/15m open check`);
      return false;
    }
    const candle = tfData.candles[0];
    latest[tf] = { bbScore: candle.bbScore, trendScore: candle.trendScore };
  }

  console.log(`  ${symbol}: 1m/5m/15m bbScores = ${latest['1m'].bbScore}, ${latest['5m'].bbScore}, ${latest['15m'].bbScore}`);

  const result = strategy1m5m15mOpen(latest);

  if (result.action === 'open_bull') {
    console.log(`  ${symbol}: 1m/5m/15m signals aligned bullish, opening bull position`);
    await this.tryOpenBullPosition(symbol, expiration);
    return true;
  }
  if (result.action === 'open_bear') {
    console.log(`  ${symbol}: 1m/5m/15m signals aligned bearish, opening bear position`);
    await this.tryOpenBearPosition(symbol, expiration);
    return true;
  }

  console.log(`  ${symbol}: 1m/5m/15m signals neutral/mixed, skipping position opening`);
  return false;
}

async function checkPriceTrailCover(symbolExpiration, position, candleAnalysis, persistenceManager) {
  const legs = Array.isArray(position?.legs) ? position.legs : [];
  if (!legs.length || position?.state !== 'open') {
    console.log(`  ${symbolExpiration}: PT v1 cover skipped (state=${position?.state || 'unknown'}, legs=${legs.length})`);
    return false;
  }
  if (!candleAnalysis || !candleAnalysis.success) {
    console.log(`  ${symbolExpiration}: No candle analysis available, skipping PT v1 cover check`);
    return false;
  }

  const latest = {};
  for (const tf of ['1m', '5m', '15m', '1h']) {
    const tfData = candleAnalysis.candleData[tf];
    if (!tfData || tfData.candles.length === 0) {
      console.log(`  ${symbolExpiration}: Missing ${tf} candle data, skipping PT v1 cover check`);
      return false;
    }
    const candle = tfData.candles[0];
    latest[tf] = {
      close: candle.close,
      bbScore: candle.bbScore,
      bbScoreDelta: tfData.candles.length > 1 ? candle.bbScore - tfData.candles[1].bbScore : null,
      trendScore: candle.trendScore
    };
  }

  const underlyingPrice = latest['1m'].close;

  console.log(`  ${symbolExpiration}: PT v1 cover bbScores = 1m:${latest['1m'].bbScore.toFixed(3)}, 5m:${latest['5m'].bbScore.toFixed(3)}, 15m:${latest['15m'].bbScore.toFixed(3)}`);

  const positionWithStrategy = {
    ...position,
    type: this.determinePositionType(position)
  };

  const stateKey = symbolExpiration;
  const priorState = this.priceTrailState.get(stateKey) || {};

  const result = strategyPriceTrailCover(positionWithStrategy, latest, priorState);

  this.priceTrailState.set(stateKey, {
    _peakClose: positionWithStrategy._peakClose,
    _troughClose: positionWithStrategy._troughClose,
    _elapsed: positionWithStrategy._elapsed
  });

  if (result.action === 'cover') {
    const positionType = this.determinePositionType(position);
    if (positionType === 'bull') {
      console.log(`  ${symbolExpiration}: PT v1 signals indicate covering bull position`);
      await this.tryCoverBullPosition(symbolExpiration, position, underlyingPrice, { source: 'ptv1' });
    } else if (positionType === 'bear') {
      console.log(`  ${symbolExpiration}: PT v1 signals indicate covering bear position`);
      await this.tryCoverBearPosition(symbolExpiration, position, underlyingPrice, { source: 'ptv1' });
    }
    return true;
  }

  console.log(`  ${symbolExpiration}: PT v1 signals do not call for covering`);
  return false;
}

async function checkPriceTrailOpen(symbol, expiration, candleAnalysis, persistenceManager, hasExistingPositions = false) {
  if (!candleAnalysis || !candleAnalysis.success) {
    console.log(`  ${symbol}: No candle analysis available, skipping PT v1 open check`);
    return false;
  }

  const latest = {};
  for (const tf of ['1m', '5m', '15m', '1h']) {
    const tfData = candleAnalysis.candleData[tf];
    if (!tfData || tfData.candles.length === 0) {
      console.log(`  ${symbol}: Missing ${tf} candle data, skipping PT v1 open check`);
      return false;
    }
    const candle = tfData.candles[0];
    latest[tf] = {
      close: candle.close,
      bbScore: candle.bbScore,
      bbScoreDelta: tfData.candles.length > 1 ? candle.bbScore - tfData.candles[1].bbScore : null,
      trendScore: candle.trendScore,
      timestamp: candle.datetime
    };
  }

  const underlyingPrice = latest['1m'].close;

  if (!this.isWithinOpeningWindow(latest['1m'].timestamp)) {
    console.log(`  ${symbol}: Outside opening window (${latest['1m'].timestamp}), skipping PT v1 open check`);
    return false;
  }

  console.log(`  ${symbol}: PT v1 open bbScores = 1m:${latest['1m'].bbScore.toFixed(3)}, 5m:${latest['5m'].bbScore.toFixed(3)}, 15m:${latest['15m'].bbScore.toFixed(3)}`);

  const result = strategyPriceTrailOpen(latest, hasExistingPositions);

  if (result.action === 'open_bull') {
    console.log(`  ${symbol}: PT v1 signals indicate opening bull position`);
    await this.tryOpenBullPosition(symbol, expiration, underlyingPrice, persistenceManager);
    return true;
  } else if (result.action === 'open_bear') {
    console.log(`  ${symbol}: PT v1 signals indicate opening bear position`);
    await this.tryOpenBearPosition(symbol, expiration, underlyingPrice, persistenceManager);
    return true;
  }

  console.log(`  ${symbol}: PT v1 signals do not call for opening`);
  return false;
}

module.exports = {
  checkSimple5mBBScoreOpen,
  checkSimple15mBBScoreOpen,
  checkSimple15and60mBBScoreOpen,
  checkSimple5mBBScoreCover,
  checkSimple15mBBScoreCover,
  checkSimple15and60mBBScoreCover,
  checkSimpleCover,
  check1m5m15mCover,
  check1m5m15mOpen,
  checkPriceTrailCover,
  checkPriceTrailOpen,
  checkStateOpen,
  checkStateCover
};
