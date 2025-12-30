const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const SYMBOL = 'Usa500';
const DATA_FOLDER = path.join(__dirname, 'data');

// Data files
const H1_FILE = path.join(DATA_FOLDER, `${SYMBOL}_H1_2y.json`);
const M15_FILE = path.join(DATA_FOLDER, `${SYMBOL}_M15_2y.json`);
const M5_FILE = path.join(DATA_FOLDER, `${SYMBOL}_M5_2y.json`);

const RISK_REWARD_RATIO = 2.0;

function loadCandles(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/*
 Candle format:
 [
   time,   // unix timestamp (seconds)
   open,
   high,
   low,
   close
 ]
*/

// Simulate trade on M5 after entry
function simulateTrade(
  m5Candles,
  entryTimestamp,
  direction,
  stopLoss,
  takeProfit
) {
  for (const candle of m5Candles) {
    if (candle[0] <= entryTimestamp) continue;

    const high = candle[2];
    const low = candle[3];

    if (direction === 'LONG') {
      if (low <= stopLoss) return 'SL';
      if (high >= takeProfit) return 'TP';
    } else {
      if (high >= stopLoss) return 'SL';
      if (low <= takeProfit) return 'TP';
    }
  }
  return 'OPEN';
}

function runBacktest() {
  const h1Candles = loadCandles(H1_FILE);
  const m15Candles = loadCandles(M15_FILE);
  const m5Candles = loadCandles(M5_FILE);

  let totalTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;

  // Loop through H1 candles to define daily bias
  for (let h1Index = 2; h1Index < h1Candles.length; h1Index++) {
    const previousH1 = h1Candles[h1Index - 1];
    const currentH1 = h1Candles[h1Index];

    // Determine market bias from H1 structure
    let marketBias = null;

    if (currentH1[4] > previousH1[2]) {
      marketBias = 'LONG'; // Break of previous high
    } else if (currentH1[4] < previousH1[3]) {
      marketBias = 'SHORT'; // Break of previous low
    }

    // If no clear bias → skip this H1 candle
    if (!marketBias) continue;

    /* =============================================
       M15 CONFIRMATION (BREAK OF STRUCTURE)
    ============================================= */

    for (let m15Index = 1; m15Index < m15Candles.length; m15Index++) {
      const previousM15 = m15Candles[m15Index - 1];
      const currentM15 = m15Candles[m15Index];

      // We only care about M15 candles after the H1 candle
      if (currentM15[0] <= currentH1[0]) continue;

      let hasStructureBreak = false;

      if (marketBias === 'LONG' && currentM15[4] > previousM15[2]) {
        hasStructureBreak = true;
      }

      if (marketBias === 'SHORT' && currentM15[4] < previousM15[3]) {
        hasStructureBreak = true;
      }

      if (!hasStructureBreak) continue;

      /* =============================================
         M5 ENTRY
      ============================================= */

      const entryM5Candle = m5Candles.find((c) => c[0] > currentM15[0]);

      if (!entryM5Candle) continue;

      const entryPrice = entryM5Candle[4];

      let stopLoss, takeProfit, tradeResult;

      if (marketBias === 'LONG') {
        stopLoss = entryM5Candle[3];
        const risk = entryPrice - stopLoss;
        if (risk <= 0) continue;

        takeProfit = entryPrice + RISK_REWARD_RATIO * risk;

        tradeResult = simulateTrade(
          m5Candles,
          entryM5Candle[0],
          'LONG',
          stopLoss,
          takeProfit
        );
      }

      if (marketBias === 'SHORT') {
        stopLoss = entryM5Candle[2];
        const risk = stopLoss - entryPrice;
        if (risk <= 0) continue;

        takeProfit = entryPrice - RISK_REWARD_RATIO * risk;

        tradeResult = simulateTrade(
          m5Candles,
          entryM5Candle[0],
          'SHORT',
          stopLoss,
          takeProfit
        );
      }

      // Record trade statistics
      totalTrades++;

      if (tradeResult === 'TP') winningTrades++;
      if (tradeResult === 'SL') losingTrades++;

      // Only one trade per H1 impulse
      break;
    }
  }

  /* =====================================================
     RESULTS
  ===================================================== */

  console.log('========== RESULTS ==========');
  console.log('Total trades:', totalTrades);
  console.log('Winning trades:', winningTrades);
  console.log('Losing trades:', losingTrades);
  console.log(
    'Winrate:',
    totalTrades ? ((winningTrades / totalTrades) * 100).toFixed(2) + '%' : 'n/a'
  );
}

runBacktest();
