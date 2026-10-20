// Thin re-export so the backtest always uses the SAME indicator maths as the
// live strategy (src/strategies/lib/indicators.js). Never duplicate the maths.
'use strict';

module.exports = require('../../src/strategies/lib/indicators');
