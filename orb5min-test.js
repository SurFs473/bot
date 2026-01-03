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
  'NVDA.OQ',
];

const BASE_DATA_DIR = path.join(__dirname, 'data');

// entry spread simulation
const SPREADS = {
  GOLD: 0.15,
  Usa500: 0.8,
  'GOOGLE.US': 0.05,
  'MSFT.US': 0.05,
  'NFLX.US': 0.05,
  'TESLA.US': 0.05,
  'NVDA.OQ': 0.05,
};

// 🔥 TRAILING SETTINGS
const STEP_R = 2;      // move SL every 2R
const CAP_R  = 10;     // exit at 10R max

/* ================================
   HELPERS
================================ */

function loadCandles(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/*
 Candle format:
 [ time, open, high, low, close ]
*/

/* ================================
   STEP-R TRAILING (2R) + CAP 10R
================================ */

function simulateTrailing2RCap10(m5, entryTime, direction, entry, sl) {
  const risk = Math.abs(entry - sl);
  let currentSL = sl;
  let maxStepReached = 0;

  for (const c of m5) {
    if (c[0] <= entryTime) continue;

    const high = c[2];
    const low  = c[3];

    // ----- check CAP @ 10R -----
    const capHit =
      direction === 'LONG'
        ? high >= entry + CAP_R * risk
        : low <= entry - CAP_R * risk;

    if (capHit) {
      return {
        realizedR: CAP_R,
        maxRR: CAP_R,
      };
    }

    // ----- step reached -----
    const stepReached =
      direction === 'LONG'
        ? Math.floor((high - entry) / (risk * STEP_R))
        : Math.floor((entry - low) / (risk * STEP_R));

    if (stepReached > maxStepReached) {
      maxStepReached = stepReached;

      if (maxStepReached > 0) {
        currentSL =
          direction === 'LONG'
            ? entry + (maxStepReached - 1) * STEP_R * risk
            : entry - (maxStepReached - 1) * STEP_R * risk;
      }
    }

    // ----- SL HIT -----
    const hitSL =
      direction === 'LONG'
        ? low <= currentSL
        : high >= currentSL;

    if (hitSL) {
      const realizedR =
        direction === 'LONG'
          ? (currentSL - entry) / risk
          : (entry - currentSL) / risk;

      return {
        realizedR,
        maxRR: maxStepReached * STEP_R,
      };
    }
  }

  return null;
}

/* ================================
   BACKTEST PER SYMBOL
================================ */

function runBacktest(symbol) {
  const FOLDER = path.join(BASE_DATA_DIR, symbol);

  const H1  = loadCandles(path.join(FOLDER, `${symbol}_H1_2y.json`));
  const M15 = loadCandles(path.join(FOLDER, `${symbol}_M15_2y.json`));
  const M5  = loadCandles(path.join(FOLDER, `${symbol}_M5_2y.json`));

  if (!H1 || !M15 || !M5) return null;

  const SPREAD = SPREADS[symbol] ?? 0;

  let trades = 0;
  let wins = 0;
  let losses = 0;
  let bes = 0;

  let sumR = 0;
  let sumWinR = 0;
  let maxRR = 0;

  for (let i = 2; i < H1.length; i++) {
    const prevH1 = H1[i - 1];
    const curH1  = H1[i];

    let bias = null;
    if (curH1[4] > prevH1[2]) bias = 'LONG';
    if (curH1[4] < prevH1[3]) bias = 'SHORT';
    if (!bias) continue;

    let m15BosTs = null;

    for (let j = 1; j < M15.length; j++) {
      const prevM15 = M15[j - 1];
      const curM15  = M15[j];

      if (curM15[0] <= curH1[0]) continue;

      if (
        (bias === 'LONG'  && curM15[4] > prevM15[2]) ||
        (bias === 'SHORT' && curM15[4] < prevM15[3])
      ) {
        m15BosTs = curM15[0];
        break;
      }
    }

    if (!m15BosTs) continue;

    const entryM5 = M5.find(c => c[0] > m15BosTs);
    if (!entryM5) continue;

    let entry, sl;

    if (bias === 'LONG') {
      entry = entryM5[4] + SPREAD;
      sl = entryM5[3];
      if (entry <= sl) continue;
    } else {
      entry = entryM5[4] - SPREAD;
      sl = entryM5[2];
      if (entry >= sl) continue;
    }

    const result = simulateTrailing2RCap10(
      M5,
      entryM5[0],
      bias,
      entry,
      sl
    );

    if (!result) continue;

    const { realizedR, maxRR: localMax } = result;

    trades++;
    sumR += realizedR;
    if (localMax > maxRR) maxRR = localMax;

    if (realizedR > 0) {
      wins++;
      sumWinR += realizedR;
    } else if (realizedR === 0) {
      bes++;
    } else {
      losses++;
    }
  }

  return {
    symbol,
    trades,
    wins,
    losses,
    bes,
    avgR: trades ? (sumR / trades).toFixed(3) : 'n/a',
    avgWinR: wins ? (sumWinR / wins).toFixed(3) : 'n/a',
    maxRR,
  };
}

/* ================================
   RUN ALL
================================ */

let totalTrades = 0;
let totalWins = 0;
let totalLosses = 0;
let totalBEs = 0;
let totalR = 0;
let totalWinR = 0;
let globalMaxRR = 0;

console.log('\n===== TRAILING 2R STEP | CAP 10R =====\n');

for (const symbol of SYMBOLS) {
  const r = runBacktest(symbol);
  if (!r) continue;

  totalTrades += r.trades;
  totalWins += r.wins;
  totalLosses += r.losses;
  totalBEs += r.bes;
  totalR += parseFloat(r.avgR) * r.trades;
  totalWinR += parseFloat(r.avgWinR) * r.wins;

  if (r.maxRR > globalMaxRR) globalMaxRR = r.maxRR;

  console.log(
    `${r.symbol.padEnd(10)} | Trades: ${r.trades
      .toString()
      .padStart(5)} | AvgR: ${r.avgR} | AvgWinR: ${r.avgWinR} | MaxRR: ${r.maxRR}`
  );
}

console.log('\n========== TOTAL ==========');
console.log('Trades:', totalTrades);
console.log('Wins:', totalWins);
console.log('Losses:', totalLosses);
console.log('BreakEven:', totalBEs);

console.log(
  'Winrate:',
  totalTrades
    ? ((totalWins / totalTrades) * 100).toFixed(2) + '%'
    : 'n/a'
);

console.log(
  'BE %:',
  totalTrades
    ? ((totalBEs / totalTrades) * 100).toFixed(2) + '%'
    : 'n/a'
);

console.log(
  'Average RR:',
  totalTrades
    ? (totalR / totalTrades).toFixed(3)
    : 'n/a'
);

console.log(
  'Average RR (wins only):',
  totalWins
    ? (totalWinR / totalWins).toFixed(3)
    : 'n/a'
);

console.log('Max RR reached:', globalMaxRR);
// s trailing SL 26%-WR 27%-BE