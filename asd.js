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

const SPREADS = {
  GOLD: 0.15,
  Usa500: 0.8,
  'GOOGLE.US': 0.05,
  'MSFT.US': 0.05,
  'NFLX.US': 0.05,
  'TESLA.US': 0.05,
  'NVDA.OQ': 0.05,
};

// 🔒 MICRO M5 FILTER
const MIN_M5_RANGE = {
  GOLD: 0.5,
  Usa500: 2.0,
  'GOOGLE.US': 0.3,
  'MSFT.US': 0.3,
  'NFLX.US': 0.6,
  'TESLA.US': 0.6,
  'NVDA.OQ': 0.3,
};

const CAP_R = 10;

/* ================================
   HELPERS
================================ */

function loadCandles(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/*
 Candle:
 [ time, open, high, low, close ]
*/

/* ================================
   TRAILING: 1R LADDER + CAP 10R
================================ */

function simulateTrailing1RLadderCap10(m5, entryTime, direction, entry, sl) {
  const risk = Math.abs(entry - sl);
  let currentSL = sl;
  let maxRReached = 0;

  for (const c of m5) {
    if (c[0] <= entryTime) continue;

    const high = c[2];
    const low = c[3];

    // ---- CAP @ 10R ----
    if (
      (direction === 'LONG' && high >= entry + CAP_R * risk) ||
      (direction === 'SHORT' && low <= entry - CAP_R * risk)
    ) {
      return { realizedR: CAP_R, maxRR: CAP_R };
    }

    // ---- current R reached ----
    const currentR =
      direction === 'LONG'
        ? Math.floor((high - entry) / risk)
        : Math.floor((entry - low) / risk);

    if (currentR > maxRReached) {
      maxRReached = currentR;

      if (maxRReached >= 1) {
        currentSL =
          direction === 'LONG'
            ? entry + (maxRReached - 1) * risk
            : entry - (maxRReached - 1) * risk;
      }
    }

    // ---- SL HIT ----
    const hitSL = direction === 'LONG' ? low <= currentSL : high >= currentSL;

    if (hitSL) {
      const realizedR =
        direction === 'LONG'
          ? (currentSL - entry) / risk
          : (entry - currentSL) / risk;

      return { realizedR, maxRR: maxRReached };
    }
  }

  return null;
}

/* ================================
   BACKTEST PER SYMBOL
================================ */

function runBacktest(symbol, R_BUCKETS) {
  const FOLDER = path.join(BASE_DATA_DIR, symbol);

  const H1 = loadCandles(path.join(FOLDER, `${symbol}_H1_2y.json`));
  const M15 = loadCandles(path.join(FOLDER, `${symbol}_M15_2y.json`));
  const M5 = loadCandles(path.join(FOLDER, `${symbol}_M5_2y.json`));

  if (!H1 || !M15 || !M5) return null;

  const SPREAD = SPREADS[symbol] ?? 0;
  const MIN_RANGE = MIN_M5_RANGE[symbol] ?? 0;

  let trades = 0;
  let wins = 0;
  let losses = 0;
  let bes = 0;
  let sumR = 0;
  let sumWinR = 0;
  let maxRR = 0;

  for (let i = 2; i < H1.length; i++) {
    const prevH1 = H1[i - 1];
    const curH1 = H1[i];

    let bias = null;
    if (curH1[4] > prevH1[2]) bias = 'LONG';
    if (curH1[4] < prevH1[3]) bias = 'SHORT';
    if (!bias) continue;

    let bosTs = null;

    for (let j = 1; j < M15.length; j++) {
      const prev = M15[j - 1];
      const cur = M15[j];
      if (cur[0] <= curH1[0]) continue;

      if (
        (bias === 'LONG' && cur[4] > prev[2]) ||
        (bias === 'SHORT' && cur[4] < prev[3])
      ) {
        bosTs = cur[0];
        break;
      }
    }

    if (!bosTs) continue;

    const entryM5 = M5.find((c) => c[0] > bosTs);
    if (!entryM5) continue;

    const m5Range = entryM5[2] - entryM5[3];
    if (m5Range < MIN_RANGE) continue;

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

    const result = simulateTrailing1RLadderCap10(
      M5,
      entryM5[0],
      bias,
      entry,
      sl
    );

    if (!result) continue;

    const r = result.realizedR;

    trades++;
    sumR += r;
    if (result.maxRR > maxRR) maxRR = result.maxRR;

    if (r > 0) {
      wins++;
      sumWinR += r;
    } else if (r === 0) {
      bes++;
    } else {
      losses++;
    }

    if (r < 0) R_BUCKETS['-1']++;
    else if (r === 0) R_BUCKETS['0']++;
    else if (r < 1) R_BUCKETS['0-1']++;
    else if (r < 2) R_BUCKETS['1-2']++;
    else if (r < 4) R_BUCKETS['2-4']++;
    else if (r < 6) R_BUCKETS['4-6']++;
    else R_BUCKETS['6-10']++;
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

const R_BUCKETS = {
  '-1': 0,
  0: 0,
  '0-1': 0,
  '1-2': 0,
  '2-4': 0,
  '4-6': 0,
  '6-10': 0,
};

let totalTrades = 0;
let totalWins = 0;
let totalLosses = 0;
let totalBEs = 0;
let totalR = 0;
let totalWinR = 0;
let globalMaxRR = 0;

console.log('\n===== TRAILING 1R LADDER + CAP 10R | FULL LOGS =====\n');

for (const symbol of SYMBOLS) {
  const r = runBacktest(symbol, R_BUCKETS);
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
      .padStart(5)} | AvgR: ${r.avgR} | AvgWinR: ${r.avgWinR} | MaxRR: ${
      r.maxRR
    }`
  );
}

console.log('\n========== TOTAL ==========');
console.log('Trades:', totalTrades);
console.log('Wins:', totalWins);
console.log('Losses:', totalLosses);
console.log('BreakEven:', totalBEs);

console.log(
  'Winrate:',
  totalTrades ? ((totalWins / totalTrades) * 100).toFixed(2) + '%' : 'n/a'
);

console.log(
  'BE %:',
  totalTrades ? ((totalBEs / totalTrades) * 100).toFixed(2) + '%' : 'n/a'
);

console.log(
  'Average RR:',
  totalTrades ? (totalR / totalTrades).toFixed(3) : 'n/a'
);

console.log(
  'Average RR (wins only):',
  totalWins ? (totalWinR / totalWins).toFixed(3) : 'n/a'
);

console.log('Max RR reached:', globalMaxRR);

console.log('\n===== R DISTRIBUTION =====');
for (const k of Object.keys(R_BUCKETS)) {
  console.log(
    `${k.padEnd(5)} : ${R_BUCKETS[k]} (${(
      (R_BUCKETS[k] / totalTrades) *
      100
    ).toFixed(2)}%)`
  );
}
