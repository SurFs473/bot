import {
  connect,
  getAccount,
  getSymbolInfo,
  getTick,
  getRates,
  getPositions,
  modifyOrder,
  sendOrder,
  sleep,
} from '../services/service';
import { Bias, Candle, CandleIndex } from '../core/types';
import { MT5SymbolInfo } from '../interfaces/metaTraderInterface';
import { MAGIC } from '../core/constants';

// ============================================================================
// LIVE mean-reversion (z-score fade + trailing stop) — same logic as
// back-test/mean-reversion-sp.ts, wired to the MT5 gateway for a DEMO account.
//
// WHY no ML here: the win-probability sweep showed the model does NOT improve
// out-of-sample expectancy (it just picks smaller, more frequent wins), and
// CatBoost tied XGBoost at ~0.557 AUC (near coin-flip). The edge is entirely
// the fade + trailing exit, so the model is off by default (USE_ML_FILTER).
//
// SAFETY: DRY_RUN defaults to true -> it only PRINTS what it would do. Watch it
// for a bit, then run with DRY_RUN=false to actually trade the demo:
//   DRY_RUN=false node -r ts-node/register live/mean-reversion-live.ts
// ============================================================================

// -------------------------------- CONFIG ------------------------------------
// NOTE: these are the LIVE BROKER's symbol names — adjust to whatever your demo
// broker calls them (they may differ from the HistData names used in backtest).
const SYMBOLS = ['US500'];
const TF = 'M15' as const;

const RISK_PERCENT = 0.5; // % of balance risked per trade (drawdown work said 0.25-0.5%)
const SMA_PERIOD = 20; // the mean/band lookback
const Z_ENTRY = 2.0; // how many std devs from the mean = "too far"
const SL_BUFFER = 0.2; // extra stop room beyond the wick, as % of the signal candle's range
const MIN_RR = 0.5; // skip setups whose reward/risk is degenerate
const MAX_HOLD_BARS = 32; // give the snap-back ~8h, then close at market
const MAX_SPREAD_POINTS = 60; // skip if the spread is silly-wide

// trailing exit (mirrors the backtest 'trail' mode)
const TRAIL_ACTIVATE_R = 1.0; // once the trade runs this many R in profit, start trailing
const TRAIL_GAP_R = 1.0; // keep the stop this many R behind the best excursion

const USE_ML_FILTER = false; // proven not to help OOS; leave off
const ML_URL = 'http://127.0.0.1:8000/predict';
const ML_MAX_LOSS_PROB = 0.5;

const DRY_RUN = process.env.DRY_RUN !== 'false'; // default true = print only, don't send orders
const POLL_MS = 20000; // check every 20s (M15 candles close every 15 min)

const CANDLES_TO_FETCH = SMA_PERIOD + 5; // enough closed candles to compute the mean/std

// ------------------------- STRATEGY HELPERS ---------------------------------
// (pure math, identical to the backtest — kept local as the repo's live files do)

// mean + population std of the last `period` closes ending at the last element
const meanStd = (closes: number[], period: number): { mean: number; std: number } => {
  const start = closes.length - period; // first candle of the window
  let sum = 0;
  for (let k = start; k < closes.length; k++) sum += closes[k]; // add up the last `period` closes
  const mean = sum / period; // the average = the "normal" price
  let v = 0;
  for (let k = start; k < closes.length; k++) v += (closes[k] - mean) ** 2; // squared distances from normal
  return { mean, std: Math.sqrt(v / period) }; // normal price + typical wiggle
};

// a full trade plan, or null if there's no valid signal on the last CLOSED candle
type Signal = { bias: Bias; sl: number; tp: number };
const buildSignal = (closedCandles: Candle[]): Signal | null => {
  if (closedCandles.length < SMA_PERIOD) return null; // not enough history yet
  const closes = closedCandles.map((c) => c[CandleIndex.Close]); // just the closing prices
  const { mean, std } = meanStd(closes, SMA_PERIOD); // find normal price + wiggle
  if (!(std > 0)) return null; // flat market -> skip

  const sig = closedCandles[closedCandles.length - 1]; // the just-closed candle is the signal
  const close = sig[CandleIndex.Close]; // its close
  const z = (close - mean) / std; // how stretched we are
  if (Math.abs(z) < Z_ENTRY) return null; // not stretched enough -> skip

  const bias = z <= -Z_ENTRY ? Bias.LONG : Bias.SHORT; // too low -> buy; too high -> sell
  const high = sig[CandleIndex.High]; // signal candle top
  const low = sig[CandleIndex.Low]; // signal candle bottom
  const range = high - low; // its height
  if (!(range > 0)) return null; // zero-height candle -> skip

  // stop just past the wick, target = the mean (the snap-back)
  const sl = bias === Bias.LONG ? low - SL_BUFFER * range : high + SL_BUFFER * range;
  const tp = mean;
  return { bias, sl, tp };
};

// broker's minimum allowed stop distance, in price (tight stops can be rejected!)
const minStopPrice = (info: MT5SymbolInfo): number => {
  const point = info.trade_tick_size || Math.pow(10, -info.digits); // one price "point"
  return (info.trade_stops_level || 0) * point; // min points the broker requires between price and stop
};

// convert risk-money + stop distance into a broker-legal lot size (same as breakout-live)
const calcLot = (balance: number, entry: number, sl: number, info: MT5SymbolInfo): number | null => {
  const riskMoney = balance * (RISK_PERCENT / 100); // dollars we're willing to lose
  const dist = Math.abs(entry - sl); // stop distance in price
  if (dist <= 0) return null;
  const valuePerPrice = info.trade_tick_value / info.trade_tick_size; // $ per 1 price unit per 1 lot
  let lot = riskMoney / (dist * valuePerPrice); // lots so that a stop-out loses ~riskMoney
  lot = Math.floor(lot / info.volume_step) * info.volume_step; // round down to a legal step
  if (lot < info.volume_min) return null; // too small to trade
  if (lot > info.volume_max) lot = info.volume_max; // cap at the max
  return lot;
};

const mlOk = async (features: number[]): Promise<boolean> => {
  if (!USE_ML_FILTER) return true; // filter off -> always allow
  try {
    const axios = require('axios');
    const res = await axios.post(ML_URL, { features }); // ask the model
    return res.data && res.data.loss_probability <= ML_MAX_LOSS_PROB; // allow unless it's clearly a loser
  } catch {
    return false; // no answer -> don't trade blind
  }
};

// ------------------------- POSITION BOOK-KEEPING ----------------------------
// we remember our own trades so we can trail their stops in risk-units.
type Managed = { entry: number; risk: number; bias: Bias; tp: number; entryTime: number; sl: number };
const managed: Record<string, Managed> = {}; // one open trade per symbol (keyed by symbol)

// pull our open position on a symbol from the broker (defensive about the gateway's shape)
const getOurPosition = async (symbol: string): Promise<any | null> => {
  try {
    const res: any = await getPositions(symbol, MAGIC); // ask the gateway
    const arr = res?.data?.positions ?? res?.data ?? []; // could be {positions:[]} or []
    const list = Array.isArray(arr) ? arr : []; // make sure it's a list
    return list.find((p: any) => (p.magic ?? MAGIC) === MAGIC) ?? list[0] ?? null; // our tagged one
  } catch {
    return null; // couldn't read -> assume none
  }
};

// ------------------------------- ENTRY --------------------------------------
const tryEnter = async (symbol: string, info: MT5SymbolInfo, closed: Candle[]): Promise<void> => {
  const sig = buildSignal(closed); // is there a fade signal on the last closed candle?
  if (!sig) return; // no -> done

  const tick = await getTick(symbol); // current live price
  const entry = sig.bias === Bias.LONG ? tick.ask : tick.bid; // buy at ask, sell at bid
  const risk = sig.bias === Bias.LONG ? entry - sig.sl : sig.sl - entry; // distance to the stop
  const reward = sig.bias === Bias.LONG ? sig.tp - entry : entry - sig.tp; // distance to the target
  if (!(risk > 0) || !(reward > 0)) return; // geometry broke (price moved) -> skip
  if (reward / risk < MIN_RR) return; // reward too small vs the stop -> skip

  // broker won't accept a stop closer than its minimum distance
  if (risk < minStopPrice(info)) {
    console.log(`  ${symbol}: skip — stop ${risk.toFixed(2)} tighter than broker min ${minStopPrice(info).toFixed(2)}`);
    return;
  }

  const lastM1 = closed[closed.length - 1]; // use the signal candle's spread as a rough check
  if (lastM1[CandleIndex.Spread] != null && lastM1[CandleIndex.Spread] > MAX_SPREAD_POINTS) {
    console.log(`  ${symbol}: skip — spread ${lastM1[CandleIndex.Spread]} too wide`);
    return;
  }

  if (!(await mlOk([]))) return; // optional ML gate (off by default)

  const account = await getAccount(); // current balance for sizing
  const lot = calcLot(account.balance, entry, sig.sl, info); // legal lot for RISK_PERCENT
  if (!lot) {
    console.log(`  ${symbol}: skip — lot too small`);
    return;
  }

  const side = sig.bias === Bias.LONG ? 'BUY' : 'SELL';
  console.log(
    `  ${symbol}: ${side} lot ${lot} @ ${entry.toFixed(2)} sl ${sig.sl.toFixed(2)} tp ${sig.tp.toFixed(2)} (risk ${risk.toFixed(2)})`
  );

  if (DRY_RUN) {
    console.log(`  [DRY] would send the order above`); // safe mode: don't actually trade
    return;
  }

  const res: any = await sendOrder(symbol, sig.bias, lot, entry, sig.sl, sig.tp); // fire it
  const ok = res?.data?.comment === 'Request executed' || res?.data?.retcode === 10009; // filled?
  if (ok) {
    console.log(`  ${symbol}: ✅ FILLED`);
    managed[symbol] = { entry, risk, bias: sig.bias, tp: sig.tp, entryTime: closed[closed.length - 1][CandleIndex.Time], sl: sig.sl }; // remember it for trailing
  } else {
    console.error(`  ${symbol}: ❌ order failed`, res?.data ?? res); // log the reason
  }
};

// ------------------------------- TRAILING -----------------------------------
const manageTrail = async (symbol: string, pos: any, closed: Candle[]): Promise<void> => {
  const m = managed[symbol]; // our remembered info for this trade
  if (!m) {
    // a position we don't have memory of (e.g. after a restart) — leave its broker SL/TP alone
    console.log(`  ${symbol}: holding an un-tracked position (restart?) — not trailing it`);
    return;
  }

  const long = m.bias === Bias.LONG; // direction
  const sinceEntry = closed.filter((c) => c[CandleIndex.Time] >= m.entryTime); // closed candles since we entered
  if (!sinceEntry.length) return;

  // TIMEOUT: open too long -> close at market by sending an opposite order
  if (sinceEntry.length > MAX_HOLD_BARS) {
    console.log(`  ${symbol}: held ${sinceEntry.length} bars > ${MAX_HOLD_BARS} — closing at market`);
    if (!DRY_RUN) {
      const tick = await getTick(symbol); // current price
      const exitBias = long ? Bias.SHORT : Bias.LONG; // opposite side flattens the position
      await sendOrder(symbol, exitBias, pos.volume ?? 0, long ? tick.bid : tick.ask, 0, 0); // market close (no sl/tp)
    }
    delete managed[symbol]; // forget it
    return;
  }

  // best profit reached so far, in risk-units, from the closed candles since entry
  let bestFavR = 0;
  for (const c of sinceEntry) {
    const favR = long ? (c[CandleIndex.High] - m.entry) / m.risk : (m.entry - c[CandleIndex.Low]) / m.risk;
    if (favR > bestFavR) bestFavR = favR; // track the high-water mark
  }
  if (bestFavR < TRAIL_ACTIVATE_R) return; // not far enough in profit to start trailing

  const lockR = bestFavR - TRAIL_GAP_R; // how many R we want to lock in
  let newSL = long ? m.entry + lockR * m.risk : m.entry - lockR * m.risk; // that lock as a stop price
  newSL = long ? Math.max(newSL, m.sl) : Math.min(newSL, m.sl); // only ever tighten, never loosen

  const improved = long ? newSL > m.sl + 1e-9 : newSL < m.sl - 1e-9; // did the stop actually move?
  if (!improved) return; // no change -> nothing to do

  console.log(`  ${symbol}: trail SL ${m.sl.toFixed(2)} -> ${newSL.toFixed(2)} (locked ${lockR.toFixed(2)}R)`);
  if (DRY_RUN) return; // safe mode: don't actually modify

  const posId = pos.ticket ?? pos.identifier ?? pos.position_id; // the broker's id for this position
  await modifyOrder(posId, newSL, m.tp); // push the new stop to the broker
  m.sl = newSL; // remember the new stop
};

// ------------------------------- MAIN LOOP ----------------------------------
const main = async (): Promise<void> => {
  await connect(); // open the MT5 gateway session
  console.log(`Mean-reversion LIVE | symbols=${SYMBOLS.join(',')} | risk=${RISK_PERCENT}% | DRY_RUN=${DRY_RUN}`);

  const info: Record<string, MT5SymbolInfo> = {}; // cache each symbol's trading rules
  for (const s of SYMBOLS) info[s] = await getSymbolInfo(s);

  const lastSeen: Record<string, number> = {}; // remember the last closed-candle time we acted on

  while (true) { // run forever
    for (const symbol of SYMBOLS) { // go through each market
      try {
        const rates = (await getRates(TF, CANDLES_TO_FETCH, symbol)) as unknown as Candle[]; // recent candles
        if (!rates || rates.length < SMA_PERIOD + 2) continue; // not enough -> skip this pass
        const asc = [...rates].sort((a, b) => a[CandleIndex.Time] - b[CandleIndex.Time]); // oldest -> newest
        const closed = asc.slice(0, asc.length - 1); // drop the still-forming last candle
        const lastClosedTime = closed[closed.length - 1][CandleIndex.Time]; // time of the newest CLOSED candle

        const pos = await getOurPosition(symbol); // do we already have a trade on?

        if (pos) {
          await manageTrail(symbol, pos, closed); // yes -> just manage the trailing stop
        } else {
          if (managed[symbol]) delete managed[symbol]; // broker shows flat -> forget any stale memory
          if (lastSeen[symbol] !== lastClosedTime) { // only look for a new entry once per NEW closed candle
            lastSeen[symbol] = lastClosedTime; // mark this candle as handled
            await tryEnter(symbol, info[symbol], closed); // check for a fade signal + maybe enter
          }
        }
      } catch (e: any) {
        console.error(`  ${symbol}: loop error`, e?.response?.data || e?.message || e); // don't let one symbol crash the loop
      }
    }
    await sleep(POLL_MS); // wait, then check again
  }
};

main().catch((e) => console.error('fatal', e)); // start the bot
