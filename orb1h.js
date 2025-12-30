const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

/* ===== CONFIG ===== */

const SYMBOL = 'EURUSD';
const DIR = path.join(__dirname, 'data', SYMBOL);

const M15 = JSON.parse(fs.readFileSync(`${DIR}/${SYMBOL}_M15_2y.json`));
const M5  = JSON.parse(fs.readFileSync(`${DIR}/${SYMBOL}_M5_2y.json`));

const RR = 9.0;

/* ===== HELPERS ===== */

function utc(ts) {
  return DateTime.fromSeconds(ts, { zone: 'utc' });
}

/* ===== BACKTEST ===== */

let trades = 0, wins = 0, losses = 0;

// group M15 by day
const days = {};
for (const c of M15) {
  const d = utc(c[0]).toISODate();
  if (!days[d]) days[d] = [];
  days[d].push(c);
}

for (const day of Object.keys(days)) {
  const d15 = days[day];

  // --- Opening Range: 07:00–08:00 UTC (4 x M15)
  const orb = d15.filter(c => {
    const h = utc(c[0]).hour;
    return h === 7;
  });

  if (orb.length < 4) continue;

  const ORH = Math.max(...orb.map(c => c[2]));
  const ORL = Math.min(...orb.map(c => c[3]));

  let traded = false;

  // --- Look for breakout after 08:00 UTC
  for (const c of d15) {
    const t = utc(c[0]);
    if (t.hour < 8 || t.hour > 17) continue;
    if (traded) break;

    let direction = null;
    let entry, sl, tp;

    if (c[4] > ORH) {
      direction = 'LONG';
      entry = c[4];
      sl = ORL;
      tp = entry + RR * (entry - sl);
    }

    if (c[4] < ORL) {
      direction = 'SHORT';
      entry = c[4];
      sl = ORH;
      tp = entry - RR * (sl - entry);
    }

    if (!direction) continue;

    // --- simulate on M5
    const m5After = M5.filter(m => m[0] > c[0]);
    if (m5After.length < 2) continue;

    let result = null;

    for (let i = 0; i < m5After.length; i++) {
      const m = m5After[i];
      if (direction === 'LONG') {
        if (m[3] <= sl) { result = 'SL'; break; }
        if (m[2] >= tp) { result = 'TP'; break; }
      } else {
        if (m[2] >= sl) { result = 'SL'; break; }
        if (m[3] <= tp) { result = 'TP'; break; }
      }
    }

    if (!result) break;

    trades++;
    if (result === 'TP') wins++;
    if (result === 'SL') losses++;

    traded = true; // 1 trade per day
  }
}

/* ===== RESULTS ===== */

console.log('====================');
console.log('SYMBOL:', SYMBOL);
console.log('Trades:', trades);
console.log('Wins:', wins);
console.log('Losses:', losses);
console.log(
  'Winrate:',
  trades ? ((wins / trades) * 100).toFixed(2) + '%' : 'n/a'
);
console.log('RR:', RR);
console.log('====================');
