const axios = require('axios');
const { post } = axios;

/* =========================
   CONFIG
========================= */

const GW = 'http://127.0.0.1:5005';
const SYMBOL = 'GOLD';
const MAGIC = 90090001;

const RISK_PERCENT = 1.0;
const RR = 2.0;
const MAX_SPREAD_POINTS = 60;

/* =========================
   STATE
========================= */

const state = {
  h1Bias: null,
  h1Timestamp: null,

  m15BosDone: false,
  m15BosTimestamp: null,

  traded: false,
};

/* =========================
   HELPERS
========================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connect() {
  const r = await post(`${GW}/connect`, {});
  if (!r.data.connected) throw new Error('MT5 connect failed');
  console.log('Connected:', r.data.account?.login);
}

async function getAccount() {
  const r = await post(`${GW}/account`, {});
  return r.data.account;
}

async function getSymbolInfo() {
  const r = await post(`${GW}/symbol_info`, { symbol: SYMBOL });
  return r.data;
}

async function getTick() {
  const r = await post(`${GW}/tick`, { symbol: SYMBOL });
  return r.data.tick;
}

async function getRates(tf, count) {
  const r = await post(`${GW}/rates`, {
    symbol: SYMBOL,
    timeframe: tf,
    count,
  });
  return r.data.rates; // newest first
}

function spreadOk(lastM1) {
  return !lastM1 || lastM1[6] == null || lastM1[6] <= MAX_SPREAD_POINTS;
}

/* =========================
   POSITION SIZING
========================= */

function roundToStep(value, step) {
  return Math.floor(value / step) * step;
}

function calcLot(balance, entry, sl, symbolInfo) {
  const riskMoney = balance * (RISK_PERCENT / 100);
  const dist = Math.abs(entry - sl);
  if (dist <= 0) return null;

  const { tick_value, tick_size, volume_min, volume_step, volume_max } =
    symbolInfo;

  const valuePerPrice = tick_value / tick_size;
  let lot = riskMoney / (dist * valuePerPrice);

  lot = roundToStep(lot, volume_step);
  if (lot < volume_min) return null;
  if (lot > volume_max) lot = volume_max;

  return lot;
}

/* =========================
   STRATEGY LOGIC
========================= */

function detectH1Bias(h1) {
  if (h1.length < 3) return null;

  const last = h1[1];
  const prev = h1[2];

  if (last[4] > prev[2]) return { dir: 'LONG', ts: last[0] };
  if (last[4] < prev[3]) return { dir: 'SHORT', ts: last[0] };

  return null;
}

function detectM15Bos(m15, bias) {
  if (m15.length < 3) return null;

  const last = m15[1];
  const prev = m15[2];

  if (bias === 'LONG' && last[4] > prev[2]) return last[0];
  if (bias === 'SHORT' && last[4] < prev[3]) return last[0];

  return null;
}

function buildOrderFromM5(m5, bias, tick) {
  if (m5.length < 2) return null;

  const bar = m5[1]; // last CLOSED M5

  let entry, sl, tp;

  if (bias === 'LONG') {
    entry = tick.ask;
    sl = bar[3];
    if (entry <= sl) return null;
    tp = entry + RR * (entry - sl);
  } else {
    entry = tick.bid;
    sl = bar[2];
    if (entry >= sl) return null;
    tp = entry - RR * (sl - entry);
  }

  return { entry, sl, tp, barTs: bar[0] };
}

async function sendOrder(dir, lot, entry, sl, tp) {
  return post(`${GW}/order`, {
    symbol: SYMBOL,
    volume: lot,
    type: dir === 'LONG' ? 0 : 1,
    price: entry,
    sl,
    tp,
    deviation: 20,
    magic: MAGIC,
    comment: 'H1_M15_M5_1TO1',
  });
}

/* =========================
   MAIN LOOP
========================= */

async function main() {
  await connect();
  const symbolInfo = await getSymbolInfo();

  while (true) {
    try {
      const tick = await getTick();

      /* ----- H1 ----- */
      const h1 = await getRates('H1', 5);
      const biasInfo = detectH1Bias(h1);

      if (biasInfo && biasInfo.ts !== state.h1Timestamp) {
        state.h1Bias = biasInfo.dir;
        state.h1Timestamp = biasInfo.ts;
        state.m15BosDone = false;
        state.m15BosTimestamp = null;
        state.traded = false;

        console.log(`H1 bias: ${state.h1Bias}`);
      }

      if (!state.h1Bias || state.traded) {
        await sleep(1000);
        continue;
      }

      /* ----- M15 BOS ----- */
      if (!state.m15BosDone) {
        const m15 = await getRates('M15', 5);
        const bosTs = detectM15Bos(m15, state.h1Bias);
        if (!bosTs) {
          await sleep(1000);
          continue;
        }

        state.m15BosDone = true;
        state.m15BosTimestamp = bosTs;
        console.log('M15 BOS confirmed');
        continue;
      }

      /* ----- ENTRY: ONLY FIRST M5 AFTER BOS ----- */
      const m1 = await getRates('M1', 3);
      if (!spreadOk(m1?.[1])) {
        await sleep(1000);
        continue;
      }

      const m5 = await getRates('M5', 3);
      const order = buildOrderFromM5(m5, state.h1Bias, tick);
      if (!order) {
        await sleep(1000);
        continue;
      }

      // 🔥 CRITICAL CHECK (THIS MAKES IT 1:1)
      if (order.barTs <= state.m15BosTimestamp) {
        await sleep(1000);
        continue;
      }

      const account = await getAccount();
      const lot = calcLot(account.balance, order.entry, order.sl, symbolInfo);
      if (!lot) {
        await sleep(1000);
        continue;
      }

      console.log(
        `ENTRY ${state.h1Bias} lot=${lot} entry=${order.entry} sl=${order.sl} tp=${order.tp}`
      );

      await sendOrder(state.h1Bias, lot, order.entry, order.sl, order.tp);
      state.traded = true;
    } catch (e) {
      console.error('Loop error:', e?.response?.data || e.message);
    }

    await sleep(1000);
  }
}

main().catch(console.error);
