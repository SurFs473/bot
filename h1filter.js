// === H1 BODY FILTER VERSION ===
const fs = require('fs');
const path = require('path');

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
const RR = 2.0;

// 🔴 H1 BODY FILTER PARAM
const H1_BODY_MIN = 0.5; // 50%

function load(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function bodyRatio(c) {
  const body = Math.abs(c[4] - c[1]);
  const range = c[2] - c[3];
  if (range <= 0) return 0;
  return body / range;
}

function simulate(m5, t, dir, sl, tp) {
  for (const c of m5) {
    if (c[0] <= t) continue;
    if (dir === 'LONG') {
      if (c[3] <= sl) return 'SL';
      if (c[2] >= tp) return 'TP';
    } else {
      if (c[2] >= sl) return 'SL';
      if (c[3] <= tp) return 'TP';
    }
  }
  return 'OPEN';
}

function run(symbol) {
  const dir = path.join(BASE_DATA_DIR, symbol);
  const H1 = load(`${dir}/${symbol}_H1_2y.json`);
  const M15 = load(`${dir}/${symbol}_M15_2y.json`);
  const M5 = load(`${dir}/${symbol}_M5_2y.json`);
  if (!H1 || !M15 || !M5) return null;

  let t = 0,
    w = 0,
    l = 0;

  for (let i = 2; i < H1.length; i++) {
    const prev = H1[i - 1],
      cur = H1[i];

    // 🔴 FILTER HERE
    if (bodyRatio(cur) < H1_BODY_MIN) continue;

    let bias = null;
    if (cur[4] > prev[2]) bias = 'LONG';
    if (cur[4] < prev[3]) bias = 'SHORT';
    if (!bias) continue;

    for (let j = 1; j < M15.length; j++) {
      const pm = M15[j - 1],
        cm = M15[j];
      if (cm[0] <= cur[0]) continue;

      if (
        (bias === 'LONG' && cm[4] > pm[2]) ||
        (bias === 'SHORT' && cm[4] < pm[3])
      ) {
        const e = M5.find((c) => c[0] > cm[0]);
        if (!e) break;

        const entry = e[4];
        let sl, tp;
        if (bias === 'LONG') {
          sl = e[3];
          if (entry <= sl) break;
          tp = entry + RR * (entry - sl);
        } else {
          sl = e[2];
          if (entry >= sl) break;
          tp = entry - RR * (sl - entry);
        }

        const r = simulate(M5, e[0], bias, sl, tp);
        if (r !== 'OPEN') {
          t++;
          r === 'TP' ? w++ : l++;
        }
        break;
      }
    }
  }

  return { symbol, trades: t, winrate: t ? ((w / t) * 100).toFixed(2) : 'n/a' };
}

console.log('\n=== H1 BODY FILTER ===\n');
SYMBOLS.forEach((s) => {
  const r = run(s);
  if (r) console.log(`${s.padEnd(10)} | Trades:${r.trades} | WR:${r.winrate}%`);
});
