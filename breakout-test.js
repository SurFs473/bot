const fs = require('fs');
const path = require('path');

/* ================================
   CONFIG
================================ */

const SYMBOLS = [
  'GOLD',
  'Usa500',
  'GOOGLE.US',
  'MSFT.US',
  'NFLX.US',
  'TESLA.US',
  'NVDA.OQ'
];

const BASE_DATA_DIR = path.join(__dirname, 'data');
const RR = 2.0;

// 🔴 Spread per symbol (adjust if needed)
const SPREADS = {
  GOLD: 0.15,
  Usa500: 0.8,
  'GOOGLE.US': 0.05,
  'MSFT.US': 0.05,
  'NFLX.US': 0.05,
  'TESLA.US': 0.05,
  'NVDA.OQ': 0.05
};

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

/*
 Candle:
 [ time, open, high, low, close ]
*/

// 🔴 REALISTIC simulation (no TP+SL in same M5)
function simulateTradeRealistic(m5, entryTime, direction, sl, tp) {
  for (const c of m5) {
    if (c[0] <= entryTime) continue;

    const high = c[2];
    const low  = c[3];

    const hitSL = direction === 'LONG'
      ? low <= sl
      : high >= sl;

    const hitTP = direction === 'LONG'
      ? high >= tp
      : low <= tp;

    // 🚨 BOTH hit in same candle → LOSS
    if (hitSL && hitTP) return 'SL';

    if (hitSL) return 'SL';
    if (hitTP) return 'TP';
  }
  return 'OPEN';
}

/* ================================
   BACKTEST PER SYMBOL
================================ */

function runBacktestForSymbol(symbol) {
  const DATA_FOLDER = path.join(BASE_DATA_DIR, symbol);

  const H1_FILE  = path.join(DATA_FOLDER, `${symbol}_H1_2y.json`);
  const M15_FILE = path.join(DATA_FOLDER, `${symbol}_M15_2y.json`);
  const M5_FILE  = path.join(DATA_FOLDER, `${symbol}_M5_2y.json`);

  const H1  = loadCandles(H1_FILE);
  const M15 = loadCandles(M15_FILE);
  const M5  = loadCandles(M5_FILE);

  if (!H1 || !M15 || !M5) {
    console.log(`⚠️ Skipping ${symbol} (missing data)`);
    return null;
  }

  const SPREAD = SPREADS[symbol] ?? 0;

  let trades = 0;
  let wins = 0;
  let losses = 0;

  for (let i = 2; i < H1.length; i++) {
    const prevH1 = H1[i - 1];
    const curH1  = H1[i];

    let bias = null;
    if (curH1[4] > prevH1[2]) bias = 'LONG';
    if (curH1[4] < prevH1[3]) bias = 'SHORT';
    if (!bias) continue;

    for (let j = 1; j < M15.length; j++) {
      const prevM15 = M15[j - 1];
      const curM15  = M15[j];

      if (curM15[0] <= curH1[0]) continue;

      let structure = false;
      if (bias === 'LONG'  && curM15[4] > prevM15[2]) structure = true;
      if (bias === 'SHORT' && curM15[4] < prevM15[3]) structure = true;
      if (!structure) continue;

      const entryM5 = M5.find(c => c[0] > curM15[0]);
      if (!entryM5) continue;

      const entry = entryM5[4];
      let sl, tp;

      if (bias === 'LONG') {
        sl = entryM5[3] - SPREAD;
        const risk = entry - sl;
        if (risk <= 0) continue;
        tp = entry + RR * risk;
      } else {
        sl = entryM5[2] + SPREAD;
        const risk = sl - entry;
        if (risk <= 0) continue;
        tp = entry - RR * risk;
      }

      const result = simulateTradeRealistic(
        M5,
        entryM5[0],
        bias,
        sl,
        tp
      );

      if (result === 'OPEN') continue;

      trades++;
      if (result === 'TP') wins++;
      if (result === 'SL') losses++;

      break; // 1 trade per H1 impulse
    }
  }

  return {
    symbol,
    trades,
    wins,
    losses,
    winrate: trades ? ((wins / trades) * 100).toFixed(2) : 'n/a'
  };
}

/* ================================
   RUN ALL SYMBOLS
================================ */

let totalTrades = 0;
let totalWins = 0;
let totalLosses = 0;

console.log('\n========== REALISTIC MULTI-SYMBOL RESULTS ==========\n');

for (const symbol of SYMBOLS) {
  const r = runBacktestForSymbol(symbol);
  if (!r) continue;

  totalTrades += r.trades;
  totalWins   += r.wins;
  totalLosses += r.losses;

  console.log(
    `${r.symbol.padEnd(10)} | Trades: ${r.trades
      .toString()
      .padStart(5)} | WR: ${r.winrate}%`
  );
}

console.log('\n========== TOTAL ==========');
console.log('Trades:', totalTrades);
console.log('Wins:', totalWins);
console.log('Losses:', totalLosses);
console.log(
  'Winrate:',
  totalTrades
    ? ((totalWins / totalTrades) * 100).toFixed(2) + '%'
    : 'n/a'
);
console.log('RR:', RR);
