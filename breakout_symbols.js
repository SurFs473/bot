const fs = require('fs');
const path = require('path');

/* ================================
   CONFIG
================================ */

// 👉 добавяй / махай символи тук
const SYMBOLS = [
  'GOLD',
  'Usa500',
  'GOOGLE.US',
  'MSFT.US',
  'NFLX.US',
  "TESLA.US",
  "NVDA.OQ"
];

const BASE_DATA_DIR = path.join(__dirname, 'data');
const RISK_REWARD_RATIO = 2.0;

/* ================================
   HELPERS
================================ */

function loadCandles(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log('❌ Missing file:', filePath);
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Simulate trade on M5 after entry
function simulateTrade(m5Candles, entryTimestamp, direction, stopLoss, takeProfit) {
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

/* ================================
   BACKTEST PER SYMBOL
================================ */

function runBacktestForSymbol(symbol) {
  const DATA_FOLDER = path.join(BASE_DATA_DIR, symbol);

  const H1_FILE = path.join(DATA_FOLDER, `${symbol}_H1_2y.json`);
  const M15_FILE = path.join(DATA_FOLDER, `${symbol}_M15_2y.json`);
  const M5_FILE = path.join(DATA_FOLDER, `${symbol}_M5_2y.json`);

  const h1Candles = loadCandles(H1_FILE);
  const m15Candles = loadCandles(M15_FILE);
  const m5Candles = loadCandles(M5_FILE);

  if (!h1Candles || !m15Candles || !m5Candles) {
    console.log(`⚠️ Skipping ${symbol} (missing data)`);
    return null;
  }

  let totalTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;

  for (let h1Index = 2; h1Index < h1Candles.length; h1Index++) {
    const previousH1 = h1Candles[h1Index - 1];
    const currentH1 = h1Candles[h1Index];

    let marketBias = null;

    if (currentH1[4] > previousH1[2]) {
      marketBias = 'LONG';
    } else if (currentH1[4] < previousH1[3]) {
      marketBias = 'SHORT';
    }

    if (!marketBias) continue;

    for (let m15Index = 1; m15Index < m15Candles.length; m15Index++) {
      const previousM15 = m15Candles[m15Index - 1];
      const currentM15 = m15Candles[m15Index];

      if (currentM15[0] <= currentH1[0]) continue;

      let hasStructureBreak = false;

      if (marketBias === 'LONG' && currentM15[4] > previousM15[2]) {
        hasStructureBreak = true;
      }

      if (marketBias === 'SHORT' && currentM15[4] < previousM15[3]) {
        hasStructureBreak = true;
      }

      if (!hasStructureBreak) continue;

      const entryM5Candle = m5Candles.find(c => c[0] > currentM15[0]);
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

      totalTrades++;
      if (tradeResult === 'TP') winningTrades++;
      if (tradeResult === 'SL') losingTrades++;

      break; // 1 trade per H1 impulse
    }
  }

  return {
    symbol,
    totalTrades,
    winningTrades,
    losingTrades,
    winrate: totalTrades
      ? ((winningTrades / totalTrades) * 100).toFixed(2)
      : 'n/a'
  };
}

/* ================================
   RUN ALL SYMBOLS
================================ */

let grandTrades = 0;
let grandWins = 0;
let grandLosses = 0;

console.log('\n========== MULTI SYMBOL RESULTS ==========\n');

for (const symbol of SYMBOLS) {
  const result = runBacktestForSymbol(symbol);
  if (!result) continue;

  grandTrades += result.totalTrades;
  grandWins += result.winningTrades;
  grandLosses += result.losingTrades;

  console.log(
    `${result.symbol.padEnd(8)} | Trades: ${result.totalTrades
      .toString()
      .padStart(4)} | WR: ${result.winrate}%`
  );
}

console.log('\n========== TOTAL ==========');
console.log('Total trades:', grandTrades);
console.log('Wins:', grandWins);
console.log('Losses:', grandLosses);
console.log(
  'Winrate:',
  grandTrades
    ? ((grandWins / grandTrades) * 100).toFixed(2) + '%'
    : 'n/a'
);
console.log('RR:', RISK_REWARD_RATIO);
