/* ================================
   LIVE EXECUTION SKELETON
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

const RR = 2.0;
const RISK_PERCENT = 0.25; // 🔴 започваш МАЛКО

/* ================================
     STATE
  ================================ */

const state = {}; // per symbol state

for (const s of SYMBOLS) {
  state[s] = {
    lastH1Time: null,
    tradedThisImpulse: false,
  };
}

/* ================================
     CORE LOGIC
  ================================ */

// това се вика на CLOSE на всяка M5 свещ
async function onM5Close(symbol, candles) {
  const lastM5 = candles.m5.at(-1);
  const lastM15 = candles.m15.at(-1);
  const lastH1 = candles.h1.at(-1);
  const prevH1 = candles.h1.at(-2);

  // ---- H1 bias
  let bias = null;
  if (lastH1.close > prevH1.high) bias = 'LONG';
  if (lastH1.close < prevH1.low) bias = 'SHORT';
  if (!bias) return;

  // ---- new H1 impulse?
  if (state[symbol].lastH1Time !== lastH1.time) {
    state[symbol].lastH1Time = lastH1.time;
    state[symbol].tradedThisImpulse = false;
  }

  if (state[symbol].tradedThisImpulse) return;

  // ---- M15 structure break
  const prevM15 = candles.m15.at(-2);

  let structureBreak = false;
  if (bias === 'LONG' && lastM15.close > prevM15.high) structureBreak = true;
  if (bias === 'SHORT' && lastM15.close < prevM15.low) structureBreak = true;
  if (!structureBreak) return;

  // ---- ENTRY (market)
  const entryPrice = await getMarketPrice(symbol);
  let sl, tp;

  if (bias === 'LONG') {
    sl = lastM5.low;
    if (entryPrice <= sl) return;
    tp = entryPrice + RR * (entryPrice - sl);
  } else {
    sl = lastM5.high;
    if (entryPrice >= sl) return;
    tp = entryPrice - RR * (sl - entryPrice);
  }

  // ---- RISK CALC
  const lot = calcLot({
    symbol,
    riskPercent: RISK_PERCENT,
    entry: entryPrice,
    stop: sl,
  });

  // ---- SEND ORDER
  await placeMarketOrder({
    symbol,
    direction: bias,
    lot,
    sl,
    tp,
  });

  state[symbol].tradedThisImpulse = true;
}

/* ================================
     PLACEHOLDERS (broker specific)
  ================================ */

async function getMarketPrice(symbol) {
  // last bid/ask
}

function calcLot({ symbol, riskPercent, entry, stop }) {
  // position sizing
}

async function placeMarketOrder(order) {
  // MT5 order_send wrapper
}
