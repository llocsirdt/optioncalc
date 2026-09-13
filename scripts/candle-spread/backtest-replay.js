'use strict';
// Moved to server/src/candle-spread/backtest (deploys with the server — the compare page's overlay goes
// through /candle-spread/replay, which spawns this, and scripts/ is not in the deployment package).
// Shim keeps existing imports and the CLI path working.
module.exports = require('../../server/src/candle-spread/backtest/backtest-replay');
