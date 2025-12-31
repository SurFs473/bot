/* =====================================================
   LIVE STRATEGY – BACKTEST-FAITHFUL VERSION
   Timeframes: H1 / M15 / M5
   Execution: M5 close → market order
===================================================== */

const SYMBOLS = [
    'GOLD',
    'Usa500',
    'GOOGLE.US',
    'MSFT.US',
    'NFLX.US',
    'TESLA.US',
    'NVDA.OQ'
  ];
  
  const RR = 2.0;
  const RISK_PERCENT = 1.0;   // 🔴 1% риск
  const ACCOUNT_BALANCE = 10000; // €
  
  // ================================
  // STATE
  // ================================
  
  const state = {};
  
  for (const s of SYMBOLS) {
    state[s] = {
      lastH1Time: null,
      tradedThisImpulse: false
    };
  }
  
  // ================================
  // CORE EVENT – CALLED ON M5 CLOSE
  // ================================
  
  async function onM5Close(symbol, candles) {
    const m5 = candles.m5;
    const m15 = candles.m15;
    const h1 = candles.h1;
  
    if (m5.length < 2 || m15.length < 2 || h1.length < 2) return;
  
    const lastM5 = m5[m5.length - 1];
    const lastM15 = m15[m15.length - 1];
    const prevM15 = m15[m15.length - 2];
    const lastH1 = h1[h1.length - 1];
    const prevH1 = h1[h1.length - 2];
  
    /* ================================
       H1 MARKET BIAS
    ================================ */
  
    let bias = null;
  
    if (lastH1.close > prevH1.high) bias = 'LONG';
    if (lastH1.close < prevH1.low) bias = 'SHORT';
    if (!bias) return;
  
    /* ================================
       NEW H1 IMPULSE
    ================================ */
  
    if (state[symbol].lastH1Time !== lastH1.time) {
      state[symbol].lastH1Time = lastH1.time;
      state[symbol].tradedThisImpulse = false;
    }
  
    if (state[symbol].tradedThisImpulse) return;
  
    /* ================================
       M15 STRUCTURE BREAK
    ================================ */
  
    let structureBreak = false;
  
    if (bias === 'LONG' && lastM15.close > prevM15.high) {
      structureBreak = true;
    }
  
    if (bias === 'SHORT' && lastM15.close < prevM15.low) {
      structureBreak = true;
    }
  
    if (!structureBreak) return;
  
    /* ================================
       ENTRY (MARKET ON NEXT TICK)
    ================================ */
  
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
  
    /* ================================
       POSITION SIZE (1% RISK)
    ================================ */
  
    const riskAmount = ACCOUNT_BALANCE * (RISK_PERCENT / 100);
    const stopDistance = Math.abs(entryPrice - sl);
  
    if (stopDistance <= 0) return;
  
    const lotSize = calculateLotSize(symbol, riskAmount, stopDistance);
  
    if (lotSize <= 0) return;
  
    /* ================================
       SEND ORDER
    ================================ */
  
    await placeMarketOrder({
      symbol,
      direction: bias,
      volume: lotSize,
      sl,
      tp
    });
  
    state[symbol].tradedThisImpulse = true;
  }
  
  /* =====================================================
     BROKER-SPECIFIC PLACEHOLDERS
     (to be wired to MT5 gateway)
  ===================================================== */
  
  async function getMarketPrice(symbol) {
    // return mid / ask / bid depending on direction
  }
  
  function calculateLotSize(symbol, riskAmount, stopDistance) {
    /*
      You MUST adapt this per symbol:
      - pip value
      - contract size
      - tick size
    */
  
    // Example generic CFD logic:
    const valuePerPoint = getValuePerPoint(symbol);
    return riskAmount / (stopDistance * valuePerPoint);
  }
  
  function getValuePerPoint(symbol) {
    // ⚠️ broker specific
    // GOLD, indices, stocks all differ
  }
  
  async function placeMarketOrder({ symbol, direction, volume, sl, tp }) {
    /*
      mt5.order_send({
        symbol,
        type,
        volume,
        sl,
        tp
      })
    */
  }
  
  /* =====================================================
     EXPORT
  ===================================================== */
  
  module.exports = {
    onM5Close
  };
  