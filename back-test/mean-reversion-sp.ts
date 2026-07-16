import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { loadCandles } from '../services/service';
import { Bias, Candle, CandleIndex, TimeFrames } from '../core/types';

// ============================================================================
// MEAN REVERSION on S&P (US500) M15 + hgboost edge filter
// ----------------------------------------------------------------------------
// Thesis: when price is stretched too far from its mean (z-score >= Z_ENTRY),
// fade the move and target the snap-back to the mean.
//   z <= -Z_ENTRY  -> too low  -> LONG  (expect snap up to mean)
//   z >= +Z_ENTRY  -> too high -> SHORT (expect snap down to mean)
//
// Trade geometry (all concrete prices, known live at signal time):
//   entry = signal close, SL = signal wick +/- SL_BUFFER*range, TP = the mean.
//   TP is STATIC at the entry-time mean (not retrailed) so live == backtest.
//   rrGeom = reward/risk is derived from those two prices; it is only used for
//   the EV filter + reporting, never "applied" to the broker.
//
// Modes (env MR_MODE):
//   generate : build the TRAIN-era dataset from the BASKET of indices (more
//              reversion examples) and print per-symbol baselines.
//   sweep    : grid-search EV_MARGIN over the SUMMED basket samples, chosen on
//              TRAIN era, shown on holdout.
//   filter   : run one EV_MARGIN across the whole basket's holdout and sum the
//              trades (the honest OOS number over a large sample).
//
// Out-of-sample hygiene: the model is trained only on data older than
// HOLDOUT_DAYS; the last HOLDOUT_DAYS are never trained on and are the only
// window filter/sweep execute on -> leak-free win rate.
// ============================================================================

// -------------------------------- CONFIG ------------------------------------
const TF = TimeFrames.m15; // 'M15'
const DATA_PERIOD = '15y'; // dukascopy multi-year pull (download_dukascopy.js)
const MODE = (process.env.MR_MODE || 'generate') as 'generate' | 'filter' | 'sweep' | 'dashboard';

// dashboard-mode: which symbol's candles to draw on the chart (stats are all-basket)
const CHART_SYMBOL = process.env.CHART_SYMBOL || 'US500';
const DASH_DATA_PATH = path.resolve(__dirname, 'dashboard-data.js');

// Broad global basket: dataset is built from all of these (train era), and
// filter/sweep EXECUTE across all of them and SUM the trades for a bigger,
// more trustworthy sample. Adding Asia/Europe decorrelates from the US names.
const TRAIN_SYMBOLS = ['US500', 'US100', 'GER40', 'UK100', 'FRA40', 'EU50', 'JPN225', 'AUS200', 'HK50'];
const EXEC_SYMBOLS = TRAIN_SYMBOLS; // test/execute across the whole basket
const SYMBOL_IDS: Record<string, number> = {
  US500: 1,
  US100: 2,
  GER40: 3,
  UK100: 4,
  FRA40: 5,
  EU50: 6,
  JPN225: 7,
  AUS200: 8,
  HK50: 9,
};

const SMA_PERIOD = 20; // mean + std lookback (the "band")
const Z_ENTRY = 2.0; // how many std devs from the mean counts as "too far"
const SL_BUFFER = 0.2; // extra SL room beyond the wick, as % of signal-candle range
const MAX_HOLD_BARS = 32; // give the snap-back time (~8h on M15) before giving up
const MIN_RR = 0.5; // skip setups whose reward/risk geometry is degenerate

// EXIT ENGINE — "take the profit before it goes against us again".
//   'full'  = original: hard TP at the mean, hard SL at the wick (binary +rr / -1).
//   'trail' = once the trade runs TRAIL_ACTIVATE_R in our favor, ratchet a stop
//             TRAIL_GAP_R behind the best excursion, locking partial profit if it
//             reverses. Still lets runners reach the mean. Raises win rate by
//             converting would-be -1R reversals into small green exits.
const EXIT_MODE = (process.env.EXIT_MODE || 'trail') as 'full' | 'trail';
const TRAIL_ACTIVATE_R = process.env.TRAIL_ACTIVATE_R ? Number(process.env.TRAIL_ACTIVATE_R) : 1.0;
const TRAIL_GAP_R = process.env.TRAIL_GAP_R ? Number(process.env.TRAIL_GAP_R) : 1.0;

// TRADING COST — round-trip spread (+slippage) as basis points of price, subtracted
// from every trade's R. 1 bp = 0.01% of price (~0.6 pts on S&P). Default 0 = GROSS.
// The stops are only ~3 pts wide, so even ~1 bp of spread eats most of the gross edge.
//   COST_BPS=0.8 npm run mean-reversion   -> the realistic NET number
const COST_BPS = process.env.COST_BPS ? Number(process.env.COST_BPS) : 0;

const ATR_PERIOD = 14;
const RSI_PERIOD = 14;
const EMA_TREND = 200; // long EMA for trend context
const EFF_PERIOD = 20; // Kaufman efficiency ratio window
const AUTOCORR_WIN = 50; // window for return autocorrelation (mean-reversion regime)
const VOL_PERIOD = 20; // rolling volume mean/std window
const ATR_PCT_WIN = 200; // window for the ATR percentile (vol regime)

const HOLDOUT_DAYS = 365; // last 1 year held out of training (never trained on)

// filter-mode only (main.py served on port 8000)
const ML_URL = 'http://127.0.0.1:8000/predict';
// Accept a fade only if positive expected-value: reward/risk varies per trade,
// so we combine the model's P(win) with the trade's RR geometry.
//   EV(R) = winProb * rrGeom - (1 - winProb)
// 9-index basket, trained on 15y-but-last-year (156k rows), summed across the
// 8 indices with recent data, 1-year holdout (2025-06 -> 2026-06), engine-accurate:
//   0.00 -> 7767 trades, +0.038 R (+294 R total)   -- max volume
//   0.15 -> 3449 trades, +0.114 R (+395 R total)   -- best total return (default)
//   0.30 -> 1515 trades, +0.238 R (+361 R total)   -- max edge, fewer trades
// Positive at every margin on thousands of trades / 8 markets. US100 & FRA40 fade
// poorly even filtered. NOTE: spread/commission are NOT modelled yet - the tight
// SLs make this spread-sensitive, so real net edge will be lower.
// NOTE: TP is 20SMA as fixed price
const EV_MARGIN = process.env.EV_MARGIN ? Number(process.env.EV_MARGIN) : 0.15;

// sweep-mode grid + min train trades a threshold must keep to be eligible
const EV_GRID = [-0.2, -0.1, 0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0];
const MIN_SWEEP_TRADES = 40;

const DATASET_PATH = path.resolve(process.cwd(), '..', '..', 'hg-boost', 'ml_dataset.csv');
const FEATURE_HEADER = [
  // local / signal-candle
  'z',
  'absZ',
  'distAtr',
  'rsi14',
  'ret3',
  'ret5',
  'bodyPct',
  'wickImbalance',
  'rangeAtr',
  'bandWidthPct',
  'consecMove',
  'rrGeom',
  // regime / context (the "is this a range or a trend?" signal)
  'effRatio',
  'distEma200',
  'ema200Slope',
  'retAutocorr',
  'volZ',
  'atrPct',
  'minuteOfDay',
  'dayOfWeek',
  // meta
  'bias',
  'symbol_id',
];

const WARMUP = Math.max(SMA_PERIOD, EMA_TREND, AUTOCORR_WIN + 2, ATR_PERIOD + ATR_PCT_WIN) + 5;

// ------------------------------- HELPERS ------------------------------------
// "true range" = how big one candle was, in price. Bigger number = wilder candle.
const trueRange = (last: Candle, prev: Candle): number => {
  const hl = last[CandleIndex.High] - last[CandleIndex.Low]; // top minus bottom of this candle
  const hc = Math.abs(last[CandleIndex.High] - prev[CandleIndex.Close]); // how far the top is from last candle's close
  const lc = Math.abs(last[CandleIndex.Low] - prev[CandleIndex.Close]); // how far the bottom is from last candle's close
  return Math.max(hl, hc, lc); // pick the biggest of the three = the true size
};

// ATR = the average candle size over the last `period` candles (how jumpy the market is)
const computeAtr = (c: Candle[], period: number): number[] => {
  const atr: number[] = new Array(c.length).fill(NaN); // one empty slot per candle to fill in
  let sum = 0; // running total to start the average
  for (let i = 1; i <= period; i++) sum += trueRange(c[i], c[i - 1]); // add up the first `period` candle sizes
  let prev = sum / period; // the first ATR = simple average of those
  atr[period] = prev; // remember it at that spot
  for (let i = period + 1; i < c.length; i++) { // now walk forward through every later candle
    prev = (prev * (period - 1) + trueRange(c[i], c[i - 1])) / period; // smoothly nudge the average with the new candle
    atr[i] = prev; // save the ATR for this candle
  }
  return atr; // hand back the full list of "how jumpy" values
};

// RSI = a 0-100 speedometer of recent up-moves vs down-moves (high = went up a lot lately)
const computeRsi = (c: Candle[], period: number): number[] => {
  const rsi: number[] = new Array(c.length).fill(NaN); // empty slot per candle
  let gain = 0; // total of up-steps so far
  let loss = 0; // total of down-steps so far
  for (let i = 1; i <= period; i++) { // look at the first `period` steps between candles
    const d = c[i][CandleIndex.Close] - c[i - 1][CandleIndex.Close]; // price change from one candle to the next
    if (d >= 0) gain += d; // went up: add to the up pile
    else loss -= d; // went down: add the size to the down pile
  }
  let avgGain = gain / period; // average up-step
  let avgLoss = loss / period; // average down-step
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss); // turn the up/down ratio into 0-100
  for (let i = period + 1; i < c.length; i++) { // walk forward candle by candle
    const d = c[i][CandleIndex.Close] - c[i - 1][CandleIndex.Close]; // this candle's price change
    const g = d >= 0 ? d : 0; // the up part (0 if it fell)
    const l = d < 0 ? -d : 0; // the down part (0 if it rose)
    avgGain = (avgGain * (period - 1) + g) / period; // gently update the average up-step
    avgLoss = (avgLoss * (period - 1) + l) / period; // gently update the average down-step
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss); // save the 0-100 score here
  }
  return rsi; // hand back the full list of speedometer readings
};

// EMA = a smooth average line that leans toward recent prices (a "trend line")
const computeEma = (values: number[], period: number): number[] => {
  const out: number[] = new Array(values.length).fill(NaN); // empty slot per value
  const alpha = 2 / (period + 1); // how much weight each new price gets (smaller = smoother)
  let ema = values[0]; // start the line at the first price
  out[0] = ema; // save that starting point
  for (let i = 1; i < values.length; i++) { // walk forward through all prices
    ema = ema + alpha * (values[i] - ema); // nudge the line a little toward the new price
    out[i] = ema; // save the line's value here
  }
  return out; // hand back the whole smooth line
};

// for each candle, the average and the "spread" (std) of volume over the last `period` candles
const computeRollingVol = (c: Candle[], period: number): { avg: number[]; std: number[] } => {
  const n = c.length; // how many candles there are
  const avg: number[] = new Array(n).fill(NaN); // empty slot for each average
  const std: number[] = new Array(n).fill(NaN); // empty slot for each spread
  for (let i = period - 1; i < n; i++) { // for every candle that has enough history behind it
    let s = 0; // running total of volume
    for (let k = i - period + 1; k <= i; k++) s += c[k][CandleIndex.Volume]; // add up volume of the last `period` candles
    const m = s / period; // the average volume
    let v = 0; // running total of squared differences
    for (let k = i - period + 1; k <= i; k++) { // look at the same candles again
      const d = c[k][CandleIndex.Volume] - m; // how far this volume is from the average
      v += d * d; // square it and add (squaring makes all differences positive)
    }
    avg[i] = m; // save the average volume here
    std[i] = Math.sqrt(v / period); // save the typical spread (square root of the average squared difference)
  }
  return { avg, std }; // hand back both lists
};

// the "normal" price (mean) and how spread out prices are (std) over the last `period` candles
const meanStd = (c: Candle[], i: number, period: number): { mean: number; std: number } => {
  let sum = 0; // running total of prices
  for (let k = i - period + 1; k <= i; k++) sum += c[k][CandleIndex.Close]; // add up the last `period` closing prices
  const mean = sum / period; // the average = the "normal" price
  let v = 0; // running total of squared differences
  for (let k = i - period + 1; k <= i; k++) { // look at the same candles again
    const d = c[k][CandleIndex.Close] - mean; // how far this price is from normal
    v += d * d; // square and add it up
  }
  return { mean, std: Math.sqrt(v / period) }; // give back the normal price and the typical wiggle size
};

// how much price changed over the last `lookback` candles, as a fraction (e.g. 0.01 = up 1%)
const getReturn = (c: Candle[], i: number, lookback: number): number => {
  if (i - lookback < 0) return 0; // not enough history yet -> say "no change"
  const now = c[i][CandleIndex.Close]; // price right now
  const past = c[i - lookback][CandleIndex.Close]; // price `lookback` candles ago
  return past === 0 ? 0 : (now - past) / past; // change divided by old price = the % move
};

// count how many candles in a row have been moving in the "stretch" direction ending at i
const consecutiveMove = (c: Candle[], i: number, bias: Bias): number => {
  let n = 0; // counter
  for (let k = i; k > 0; k--) { // walk backwards from the signal candle
    const up = c[k][CandleIndex.Close] >= c[k - 1][CandleIndex.Close]; // did this candle close higher than the one before?
    if (bias === Bias.LONG ? !up : up) n++; // if we're fading a drop, count red candles; fading a rise, count green
    else break; // the streak ended, stop counting
  }
  return n; // how long the run was
};

// Kaufman efficiency ratio: net change / total path over `period`. Low = choppy
// (mean-reverting friendly), high ~ 1 = clean trend (fade at your peril).
// "as the crow flies" distance vs the wiggly path walked. Near 1 = straight trend; near 0 = choppy.
const efficiencyRatio = (c: Candle[], i: number, period: number): number => {
  const change = Math.abs(c[i][CandleIndex.Close] - c[i - period][CandleIndex.Close]); // straight-line move over the window
  let pathLen = 0; // running total of every little step
  for (let k = i - period + 1; k <= i; k++) pathLen += Math.abs(c[k][CandleIndex.Close] - c[k - 1][CandleIndex.Close]); // add up each candle-to-candle step
  return pathLen > 0 ? change / pathLen : 0; // straight distance divided by total walking = how "trendy" it was
};

// lag-1 autocorrelation of simple returns over `win` bars. Negative => price is
// currently mean-reverting; positive => momentum/trending.
// does an up-move tend to be followed by another up-move (+, trending) or a down-move (-, mean-reverting)?
const returnAutocorr = (c: Candle[], i: number, win: number): number => {
  const r: number[] = []; // list of candle-to-candle % changes
  for (let k = i - win + 1; k <= i; k++) { // over the last `win` candles
    const p = c[k - 1][CandleIndex.Close]; // the previous close
    r.push(p ? c[k][CandleIndex.Close] / p - 1 : 0); // save the % change for this candle
  }
  const n = r.length; // how many changes we collected
  if (n < 3) return 0; // too few to judge -> say "no pattern"
  const mean = r.reduce((s, x) => s + x, 0) / n; // the average change
  let num = 0; // top of the fraction (do neighbors move together?)
  let den = 0; // bottom of the fraction (how spread out the changes are)
  for (let k = 0; k < n; k++) { // walk through the changes
    den += (r[k] - mean) ** 2; // add this change's distance-from-average, squared
    if (k > 0) num += (r[k] - mean) * (r[k - 1] - mean); // multiply this change's gap by the previous one's gap
  }
  return den > 0 ? num / den : 0; // + means "keeps going", - means "snaps back"
};

// fraction of the prior `win` ATR readings below the current one (0..1 vol regime)
// is today's jumpiness high or low compared to the recent past? 0 = calmest, 1 = wildest.
const atrPercentile = (atr: number[], i: number, win: number): number => {
  const from = Math.max(0, i - win); // start of the look-back window (don't go before the data)
  const ref = atr[i]; // today's jumpiness we're ranking
  if (!isFinite(ref)) return 0; // no value yet -> say 0
  let cnt = 0; // how many past days we compared against
  let below = 0; // how many of them were calmer than today
  for (let k = from; k < i; k++) { // look at each past day in the window
    const v = atr[k]; // that day's jumpiness
    if (!isFinite(v)) continue; // skip empty ones
    cnt++; // count this comparison
    if (v < ref) below++; // was that day calmer than today? tally it
  }
  return cnt ? below / cnt : 0; // fraction of past days calmer than today
};

// ask the Python model (over the network) how likely this trade is to win
const getMlPrediction = async (features: number[]): Promise<any | null> => {
  try {
    const res = await axios.post(ML_URL, { features }); // send the trade's numbers to the model server
    return res.data; // give back its answer {win_probability, ...}
  } catch (err) {
    console.error('ML error (is `uvicorn main:app --port 8000` running?)', (err as Error).message); // server down? say so
    return null; // no answer available
  }
};

// ------------------------------- TYPES --------------------------------------
// a bundle of pre-computed lines (one value per candle) so we don't recompute them constantly
type Indicators = {
  atr: number[]; // jumpiness at each candle
  rsi: number[]; // up/down speedometer at each candle
  ema200: number[]; // slow trend line at each candle
  volAvg: number[]; // average volume at each candle
  volStd: number[]; // volume spread at each candle
};

// do all the slow math ONCE for a symbol, so the main loop can just look values up fast
const computeIndicators = (c: Candle[]): Indicators => {
  const closes = c.map((x) => x[CandleIndex.Close]); // pull out just the closing prices into their own list
  const { avg, std } = computeRollingVol(c, VOL_PERIOD); // volume average + spread for every candle
  return {
    atr: computeAtr(c, ATR_PERIOD), // jumpiness line
    rsi: computeRsi(c, RSI_PERIOD), // up/down speedometer line
    ema200: computeEma(closes, EMA_TREND), // slow trend line
    volAvg: avg, // average-volume line
    volStd: std, // volume-spread line
  };
};

// a full trade plan produced by buildSetup
type Setup = {
  bias: Bias; // betting up (LONG) or down (SHORT)
  entry: number; // the price we get in at
  sl: number; // the stop-loss price (bail out here)
  tp: number; // the take-profit price (the mean)
  rrGeom: number; // reward-to-risk of the plan
  features: number[]; // the list of clues for the AI model
};

type SimOutcome = { r: number; exitIndex: number }; // r = actual R achieved (signed)

// a little scorecard: how many trades, how many won/lost, total profit in R, and bars held
type Stats = { trades: number; wins: number; losses: number; totalR: number; holdBars: number };
const mkStats = (): Stats => ({ trades: 0, wins: 0, losses: 0, totalR: 0, holdBars: 0 }); // a fresh, empty scorecard
// add one finished trade to a scorecard (r = its profit in risk-units, bars = how long it was open)
const record = (s: Stats, r: number, bars: number) => {
  s.trades++; // one more trade taken
  s.holdBars += bars; // add how long we held it
  s.totalR += r; // add its profit (or loss) to the pile
  if (r > 0) s.wins++; // made money -> a win
  else s.losses++; // didn't -> a loss
};
// pour one scorecard's totals into another (used to sum all symbols into one grand total)
const addStats = (into: Stats, s: Stats) => {
  into.trades += s.trades; // add up trades
  into.wins += s.wins; // add up wins
  into.losses += s.losses; // add up losses
  into.totalR += s.totalR; // add up profit
  into.holdBars += s.holdBars; // add up hold time
};
// turn a scorecard into one neat printable line of text
const line = (name: string, s: Stats): string => {
  const wr = s.trades ? (s.wins / s.trades) * 100 : 0; // win rate = wins out of all trades, as a %
  const exp = s.trades ? s.totalR / s.trades : 0; // expectancy = average profit per trade, in R
  return (
    `${name.padEnd(8)} | trades ${String(s.trades).padStart(5)} | WR ${wr.toFixed(2).padStart(6)}% | ` + // name, count, win rate
    `totalR ${s.totalR.toFixed(2).padStart(8)} | exp ${exp.toFixed(4).padStart(8)} R` // total profit and per-trade profit
  );
};

// Build the fade setup at bar i (or null if no/degenerate signal).
const buildSetup = (c: Candle[], i: number, ind: Indicators, symbolId: number): Setup | null => {
  const { mean, std } = meanStd(c, i, SMA_PERIOD); // find the normal price and the typical wiggle
  if (!(std > 0)) return null; // prices were flat -> no trade

  const close = c[i][CandleIndex.Close]; // the price where this candle finished
  const z = (close - mean) / std; // how many "wiggles" away from normal we are (the stretch)
  if (Math.abs(z) < Z_ENTRY) return null; // not stretched far enough -> no trade

  const bias = z <= -Z_ENTRY ? Bias.LONG : Bias.SHORT; // too low -> bet up (LONG); too high -> bet down (SHORT)
  const high = c[i][CandleIndex.High]; // the top of the signal candle
  const low = c[i][CandleIndex.Low]; // the bottom of the signal candle
  const range = high - low; // how tall the candle is
  const a = ind.atr[i]; // how jumpy the market is right now
  const ema200 = ind.ema200[i]; // where the slow trend line sits
  if (!(a > 0) || !(range > 0) || !(ema200 > 0)) return null; // any of these missing/zero -> skip to be safe

  const entry = close; // we jump in at the candle's close price
  const tp = mean; // our target to take profit is the normal price (the snap-back)
  let sl: number; // where we bail out if we're wrong
  let risk: number; // how far the stop is (our "1 unit of risk")
  let reward: number; // how far the target is
  if (bias === Bias.LONG) { // betting up
    sl = low - SL_BUFFER * range; // stop just below the candle's low (plus a little breathing room)
    risk = entry - sl; // distance down to the stop
    reward = tp - entry; // distance up to the target
  } else { // betting down
    sl = high + SL_BUFFER * range; // stop just above the candle's high (plus breathing room)
    risk = sl - entry; // distance up to the stop
    reward = entry - tp; // distance down to the target
  }
  if (!(risk > 0) || !(reward > 0)) return null; // numbers don't make sense -> skip
  const rrGeom = reward / risk; // reward-to-risk: how many times bigger the target is than the stop
  if (rrGeom < MIN_RR) return null; // target too small vs the stop -> not worth it

  const body = Math.abs(close - c[i][CandleIndex.Open]); // size of the candle's solid part (open to close)
  const upperWick = high - Math.max(close, c[i][CandleIndex.Open]); // the thin line sticking out the top
  const lowerWick = Math.min(close, c[i][CandleIndex.Open]) - low; // the thin line sticking out the bottom
  const wickImbalance = range > 0 ? (lowerWick - upperWick) / range : 0; // is the tail bigger on top or bottom?

  const ema200Past = ind.ema200[i - 10]; // where the trend line was 10 candles ago
  const ema200Slope = ema200Past ? ((ema200 - ema200Past) / ema200Past) * 10000 : 0; // is the trend line rising or falling, and how fast
  const volStd = ind.volStd[i]; // typical spread of volume right now
  const volZ = volStd > 0 ? (c[i][CandleIndex.Volume] - ind.volAvg[i]) / volStd : 0; // is this candle's volume unusually big/small (0 for indices)

  const d = new Date(c[i][CandleIndex.Time] * 1000); // turn the candle's timestamp into a real date/time

  // the list of clues we hand to the AI model, in a fixed order it was trained on
  const features = [
    z, // how stretched (signed)
    Math.abs(z), // how stretched (always positive)
    (close - mean) / a, // distance from normal, measured in jumpiness units
    ind.rsi[i], // the up/down speedometer
    getReturn(c, i, 3), // % move over last 3 candles
    getReturn(c, i, 5), // % move over last 5 candles
    range > 0 ? body / range : 0, // how much of the candle is solid body vs wick
    wickImbalance, // tail bigger on top or bottom
    range / a, // how tall this candle is vs normal jumpiness
    mean > 0 ? std / mean : 0, // how wide the wiggle band is, as a fraction of price
    consecutiveMove(c, i, bias), // how many candles in a row pushed the stretch
    rrGeom, // reward-to-risk of this setup
    efficiencyRatio(c, i, EFF_PERIOD), // trendy (1) vs choppy (0)
    (close - ema200) / ema200, // how far price is from the slow trend line
    ema200Slope, // is the big trend rising or falling
    returnAutocorr(c, i, AUTOCORR_WIN), // is the market currently snapping back or trending
    volZ, // volume surprise (0 for indices)
    atrPercentile(ind.atr, i, ATR_PCT_WIN), // is it a calm or wild period
    d.getUTCHours() * 60 + d.getUTCMinutes(), // time of day in minutes (sessions matter)
    d.getUTCDay(), // day of the week
    bias === Bias.LONG ? 1 : -1, // are we betting up (1) or down (-1)
    symbolId, // which market this is (S&P, DAX, etc.)
  ];

  return { bias, entry, sl, tp, rrGeom, features }; // hand back the whole trade plan
};

// Simulate the fade forward and return the ACTUAL R achieved (signed), resolving
// pessimistically (stop checked before target within a bar). In 'trail' mode a
// ratcheting stop locks partial profit once the trade runs in our favor.
const simTrade = (c: Candle[], i: number, s: Setup): SimOutcome => {
  const end = Math.min(c.length - 1, i + MAX_HOLD_BARS); // latest candle we'll wait until before giving up
  const long = s.bias === Bias.LONG; // true if we bet up, false if we bet down
  const risk = long ? s.entry - s.sl : s.sl - s.entry; // one "risk unit" = distance from entry to the stop
  const cost = COST_BPS > 0 && risk > 0 ? (s.entry * COST_BPS) / 10000 / risk : 0; // round-trip spread cost, in R units
  let bestFavR = 0; // the best profit (in risk units) the trade has reached so far

  for (let k = i + 1; k <= end; k++) { // walk forward candle by candle, starting the next candle after entry
    const high = c[k][CandleIndex.High]; // this future candle's top
    const low = c[k][CandleIndex.Low]; // this future candle's bottom

    // work out where the stop is now: it starts at the original SL and creeps up once we're in profit
    let effSL = s.sl; // begin with the original stop
    if (EXIT_MODE === 'trail' && bestFavR >= TRAIL_ACTIVATE_R) { // if trailing is on and we've run far enough in profit
      const lockR = bestFavR - TRAIL_GAP_R; // lock in the best profit minus a small give-back cushion
      effSL = long ? s.entry + lockR * risk : s.entry - lockR * risk; // turn that locked profit into an actual stop price
      effSL = long ? Math.max(effSL, s.sl) : Math.min(effSL, s.sl); // never move the stop the wrong way (only tighten)
    }

    if (long) { // betting up
      if (low <= effSL) return { r: (effSL - s.entry) / risk - cost, exitIndex: k }; // price fell to our stop -> exit there, bank that R (minus spread)
      if (high >= s.tp) return { r: (s.tp - s.entry) / risk - cost, exitIndex: k }; // price rose to the target -> take the win (minus spread)
    } else { // betting down
      if (high >= effSL) return { r: (s.entry - effSL) / risk - cost, exitIndex: k }; // price rose to our stop -> exit there (minus spread)
      if (low <= s.tp) return { r: (s.entry - s.tp) / risk - cost, exitIndex: k }; // price fell to the target -> take the win (minus spread)
    }

    // only AFTER checking exits do we update the best-profit-so-far with this candle's extreme
    // (so a candle's own spike can't trigger the trailing stop it just created — no cheating with the future)
    const favR = long ? (high - s.entry) / risk : (s.entry - low) / risk; // how far in profit this candle reached
    if (favR > bestFavR) bestFavR = favR; // remember it if it's a new best
  }

  // we ran out of waiting time: just close at the last candle's price, whatever profit/loss that is
  const cl = c[end][CandleIndex.Close]; // the final close price
  return { r: (long ? cl - s.entry : s.entry - cl) / risk - cost, exitIndex: end }; // exit at market, report the R (minus spread)
};

// ONE global holdout cutoff for the whole basket = (latest bar across all
// symbols) - HOLDOUT_DAYS. Symbols whose data ends earlier (e.g. EU50 stops in
// 2019) contribute only training rows and never appear in the shared holdout.
const globalCutoff = (): number => {
  let maxLast = 0; // the newest candle time we've seen across all markets
  for (const sym of TRAIN_SYMBOLS) { // check every market in the basket
    const c = loadCandles(sym, TF, DATA_PERIOD) as Candle[] | null; // load that market's candles from disk
    if (c && c.length) maxLast = Math.max(maxLast, c[c.length - 1][CandleIndex.Time]); // keep the latest last-candle time
  }
  return maxLast - HOLDOUT_DAYS * 86400; // the line in time: everything after this is the untouched test year (86400 = seconds in a day)
};

// --------------------------- MODE: GENERATE ---------------------------------
// Build the TRAIN-era dataset from the whole basket; print per-symbol baselines.
const generate = (): void => {
  const rows: { t: number; csv: string }[] = []; // the training examples we'll write to a file for the AI
  const cutoff = globalCutoff(); // the time line: before it = teach the AI, after it = test only
  const allTrain = mkStats(); // grand scorecard for the teaching years
  const allHoldout = mkStats(); // grand scorecard for the test year
  const holdoutTrades: { exit: number; r: number }[] = []; // every test-year trade, for the money sim
  console.log(`\n===== BACKTEST  basket=[${TRAIN_SYMBOLS.join(', ')}] =====`); // header
  console.log('LEARN = older years the model studies  |  TEST = last year, never trained on (the honest score)'); // legend
  console.log(`global holdout cutoff: ${new Date(cutoff * 1000).toISOString().slice(0, 10)}`); // show the time line date
  console.log(`exit: ${EXIT_MODE}${EXIT_MODE === 'trail' ? ` (activate ${TRAIL_ACTIVATE_R}R, gap ${TRAIL_GAP_R}R)` : ''}`); // show the exit settings
  for (const sym of TRAIN_SYMBOLS) { // go through each market in the basket
    const c = loadCandles(sym, TF, DATA_PERIOD) as Candle[] | null; // load its candles
    if (!c) { // no data file?
      console.warn(`  skip (no data): ${sym}`); // say we're skipping it
      continue; // move to the next market
    }
    const ind = computeIndicators(c); // pre-compute all the indicator lines for this market
    const train = mkStats(); // this market's teaching-years scorecard
    const holdout = mkStats(); // this market's test-year scorecard
    let symRows = 0; // how many training examples this market added
    let i = WARMUP; // start after enough candles exist to compute indicators
    while (i < c.length - 1) { // walk through the candles
      const setup = buildSetup(c, i, ind, SYMBOL_IDS[sym] ?? 0); // is there a trade at this candle?
      if (!setup) { // no trade here
        i++; // step to the next candle
        continue; // and check again
      }
      const { r, exitIndex } = simTrade(c, i, setup); // play the trade out; get its profit R and when it closed
      const inHoldout = c[i][CandleIndex.Time] >= cutoff; // did this trade start in the test year?
      record(inHoldout ? holdout : train, r, exitIndex - i); // add it to the right scorecard
      if (inHoldout) { // test-year trade
        holdoutTrades.push({ exit: c[exitIndex][CandleIndex.Time], r }); // save it for the money sim (NOT for teaching)
      } else { // teaching-year trade
        const csv = setup.features.map((f) => (Number.isFinite(f) ? f : 0)).join(',') + ',' + (r > 0 ? 1 : 0); // clues + did-it-win label, as one CSV line
        rows.push({ t: c[i][CandleIndex.Time], csv }); // keep it (with its time so we can sort later)
        symRows++; // count it
      }
      i = exitIndex + 1; // jump past this trade so we don't overlap positions on the same market
    }
    addStats(allTrain, train); // fold this market into the grand teaching total
    addStats(allHoldout, holdout); // fold into the grand test total
    console.log(`  ${sym.padEnd(6)}  ${line('LEARN', train)}   ||   ${line('TEST', holdout)}  (+${symRows} rows)`); // print this market's row
  }
  console.log(`  ${'-'.repeat(72)}`); // a divider line
  console.log(`  ALL     ${line('LEARN', allTrain)}   ||   ${line('TEST', allHoldout)}`); // print the grand totals
  // sort every training example by time so the AI's train/test split is by DATE, not by market
  rows.sort((a, b) => a.t - b.t); // oldest first
  fs.writeFileSync(DATASET_PATH, FEATURE_HEADER.join(',') + ',label\n' + rows.map((r) => r.csv).join('\n') + '\n'); // write the CSV the AI trains on
  console.log(`\nWrote ${rows.length} train-era rows -> ${DATASET_PATH}`); // say how many examples we saved
  // finally, run a pretend $1k account over the test-year trades so we see win-rate + drawdown of the raw exit
  equityReport(holdoutTrades);
};

// Simulate a $1,000 account over the test-year trades (in the order they closed),
// betting a flat 1% of the STARTING balance ($10) per trade. Reports win rate,
// expectancy, profit factor, streaks, biggest win, ending balance + worst drawdown.
// (Compounding 1% of a GROWING balance is deliberately NOT shown - over thousands
// of overlapping trades it explodes to a meaningless fantasy number.)
const equityReport = (trades: { exit: number; r: number }[]): void => {
  if (!trades.length) { // no trades at all?
    console.log('\n(no trades to simulate)'); // say so
    return; // and stop
  }
  trades.sort((a, b) => a.exit - b.exit); // put trades in the real order they closed (by time)
  const n = trades.length; // total number of trades
  const START = 1000; // pretend we start with $1,000
  const RISK_PCT = 0.01; // we risk 1% per trade

  let wins = 0; // how many trades made money
  let grossWinR = 0; // total R from winners
  let grossLossR = 0; // total R lost by losers (as a positive number)
  let maxR = -Infinity; // biggest single winning trade (in R)
  let curWin = 0; // current run of wins in a row
  let curLoss = 0; // current run of losses in a row
  let maxWinStreak = 0; // longest winning run
  let maxLossStreak = 0; // longest losing run

  let flat = START; // the $ account, betting a flat $10 (1% of the start) each trade
  let flatPeak = START; // highest the account ever reached
  let flatMaxDD$ = 0; // biggest drop from a peak, in dollars
  let flatMaxDDpct = 0; // biggest drop from a peak, as a %

  for (const t of trades) { // go through every trade in time order
    if (t.r > 0) { // a winner
      wins++; // count the win
      grossWinR += t.r; // add its profit to the winners pile
      curWin++; // extend the win streak
      curLoss = 0; // reset the loss streak
      if (curWin > maxWinStreak) maxWinStreak = curWin; // remember the longest win streak
    } else { // a loser
      grossLossR += -t.r; // add its loss (flipped positive) to the losers pile
      curLoss++; // extend the loss streak
      curWin = 0; // reset the win streak
      if (curLoss > maxLossStreak) maxLossStreak = curLoss; // remember the longest loss streak
    }
    if (t.r > maxR) maxR = t.r; // track the single biggest win in R

    flat += t.r * (START * RISK_PCT); // update the $ account: profit = R times the fixed $10 bet
    if (flat > flatPeak) flatPeak = flat; // new high-water mark?
    const fdd = flatPeak - flat; // how far below the peak we are now (in $)
    if (fdd > flatMaxDD$) flatMaxDD$ = fdd; // remember the worst dollar drop
    const fddp = flatPeak > 0 ? (fdd / flatPeak) * 100 : 0; // that drop as a % of the peak
    if (fddp > flatMaxDDpct) flatMaxDDpct = fddp; // remember the worst % drop
  }

  const losses = n - wins; // trades that lost = all minus the winners
  const totalR = grossWinR - grossLossR; // net profit in R = winners pile minus losers pile
  const pf = grossLossR > 0 ? grossWinR / grossLossR : Infinity; // profit factor = money won per money lost (>1 is good)
  const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10); // helper: turn a timestamp into a YYYY-MM-DD date

  console.log(`\n===== ACCOUNT SIM  $${START} start, 1% risk  (${iso(trades[0].exit)}..${iso(trades[n - 1].exit)}) =====`); // header with the date range
  console.log(`Trades ${n} | wins ${wins} / losses ${losses} | win rate ${((wins / n) * 100).toFixed(1)}%`); // counts and win rate
  console.log(`Expectancy ${(totalR / n).toFixed(3)} R/trade | profit factor ${pf.toFixed(2)}`); // average profit per trade + profit factor
  console.log(`Avg win +${(grossWinR / Math.max(1, wins)).toFixed(2)}R | avg loss -1.00R | biggest win +${maxR.toFixed(2)}R | biggest loss -1.00R`); // typical and biggest trades
  console.log(`Longest WIN streak ${maxWinStreak} | longest LOSS streak ${maxLossStreak}`); // best and worst runs in a row
  console.log(`Final $${flat.toFixed(0)} | profit $${(flat - START).toFixed(0)} | max drawdown $${flatMaxDD$.toFixed(0)} (${flatMaxDDpct.toFixed(0)}%)`); // ending money + worst dip
};

// ----------------------- MODE: FILTER / SWEEP -------------------------------
// Both execute across the whole basket's holdout windows (leak-free) and sum.
const runFilter = async (): Promise<void> => {
  const total = mkStats(); // grand scorecard across all markets
  const trades: { exit: number; r: number }[] = []; // every taken trade, for the money sim
  let totalSkipped = 0; // how many trades the AI told us to skip
  const cutoff = globalCutoff(); // the start of the test year (we only trade after this)
  console.log(`\n===== FILTER (basket)  EV_MARGIN=${EV_MARGIN}  HOLDOUT=${HOLDOUT_DAYS}d  from ${new Date(cutoff * 1000).toISOString().slice(0, 10)} =====`); // header
  for (const sym of EXEC_SYMBOLS) { // go through each market
    const c = loadCandles(sym, TF, DATA_PERIOD) as Candle[] | null; // load its candles
    if (!c) { // missing file?
      console.log(`  ${sym.padEnd(8)} | no data (${sym}_M15_${DATA_PERIOD}.json missing)`); // note it
      continue; // skip this market
    }
    const ind = computeIndicators(c); // pre-compute indicator lines
    const s = mkStats(); // this market's scorecard
    let skipped = 0; // trades skipped on this market

    let i = WARMUP; // start once indicators are ready
    while (i < c.length - 1) { // walk the candles
      const setup = buildSetup(c, i, ind, SYMBOL_IDS[sym] ?? 0); // any trade here?
      if (!setup) { // no
        i++; // next candle
        continue;
      }
      if (c[i][CandleIndex.Time] < cutoff) { // this candle is in the teaching years, not the test year
        i++; // skip it (we only measure the untouched test year)
        continue;
      }
      const prediction = await getMlPrediction(setup.features); // ask the AI how good this trade looks
      if (!prediction) { // AI server didn't answer
        i++; // skip
        continue;
      }
      const p = prediction.win_probability; // the AI's chance-of-winning
      const ev = p * setup.rrGeom - (1 - p); // expected value = chance-to-win times reward, minus chance-to-lose
      if (ev <= EV_MARGIN) { // not good enough?
        skipped++; // count the skip
        i++; // move on without trading
        continue;
      }
      const { r, exitIndex } = simTrade(c, i, setup); // take the trade and see how it ends
      record(s, r, exitIndex - i); // add it to this market's scorecard
      trades.push({ exit: c[exitIndex][CandleIndex.Time], r }); // save it for the money sim
      i = exitIndex + 1; // jump past it (one position per market at a time)
    }
    addStats(total, s); // fold this market into the grand total
    totalSkipped += skipped; // add its skips
    console.log(`  ${line(sym, s)}`); // print this market's row
  }
  console.log(`  ${'-'.repeat(70)}`); // divider
  console.log(`  ${line('ALL', total)}`); // print the summed-across-markets total
  console.log(`Skipped by ML: ${totalSkipped}`); // how many trades the AI vetoed
  equityReport(trades); // run the $1k account sim over everything
};

// One model call per signal across the whole basket, then evaluate each EV_MARGIN
// on the SUMMED samples. Threshold chosen on train era; holdout shown to check it.
const runSweep = async (): Promise<void> => {
  type Sample = { holdout: boolean; ev: number; p: number; r: number }; // era, EV score, win-probability, and result
  const samples: Sample[] = []; // collect every trade once so we can try many cutoffs cheaply
  const cutoff = globalCutoff(); // the test-year line
  for (const sym of EXEC_SYMBOLS) { // each market
    const c = loadCandles(sym, TF, DATA_PERIOD) as Candle[] | null; // load candles
    if (!c) { // missing?
      console.log(`  skip ${sym} (no data)`); // note it
      continue; // skip
    }
    const ind = computeIndicators(c); // indicator lines
    for (let i = WARMUP; i < c.length - 1; i++) { // walk every candle
      const setup = buildSetup(c, i, ind, SYMBOL_IDS[sym] ?? 0); // trade here?
      if (!setup) continue; // no -> next
      const prediction = await getMlPrediction(setup.features); // ask the AI
      if (!prediction) continue; // no answer -> skip
      const p = prediction.win_probability; // chance to win
      const ev = p * setup.rrGeom - (1 - p); // expected value score
      const { r } = simTrade(c, i, setup); // play it out for the result
      samples.push({ holdout: c[i][CandleIndex.Time] >= cutoff, ev, p, r }); // store it (era, EV, win-prob, result)
    }
    console.log(`  scanned ${sym} (${samples.length} cumulative samples)`); // progress note
  }

  const expOf = (arr: Sample[]) => (arr.length ? arr.reduce((s, x) => s + x.r, 0) / arr.length : NaN); // helper: average R of a group of trades

  console.log(`\n===== EV_MARGIN SWEEP (basket ${TF}) =====`); // header
  console.log('margin |  trainN  trainExp |  holdN  holdExp   (choose on train)'); // column titles
  let chosen = { margin: NaN, trainExp: -Infinity, trainN: 0, holdExp: NaN, holdN: 0 }; // the best cutoff we find (judged on teaching years)
  for (const m of EV_GRID) { // try each candidate cutoff value
    const tr = samples.filter((s) => !s.holdout && s.ev > m); // teaching-year trades that pass this cutoff
    const ho = samples.filter((s) => s.holdout && s.ev > m); // test-year trades that pass this cutoff
    const trExp = expOf(tr); // average profit of the teaching-year survivors
    const hoExp = expOf(ho); // average profit of the test-year survivors
    console.log(
      `${m.toFixed(2).padStart(5)}  | ${String(tr.length).padStart(6)}  ${trExp.toFixed(4).padStart(8)} | ` + // print cutoff + teaching numbers
        `${String(ho.length).padStart(5)}  ${hoExp.toFixed(4).padStart(8)}` // print test numbers
    );
    if (tr.length >= MIN_SWEEP_TRADES && trExp > chosen.trainExp) { // if it kept enough trades AND beat our best so far
      chosen = { margin: m, trainExp: trExp, trainN: tr.length, holdExp: hoExp, holdN: ho.length }; // make it the new best
    }
  }
  console.log(
    `\nChosen on TRAIN: EV_MARGIN=${chosen.margin} (train ${chosen.trainN} trades, exp ${chosen.trainExp.toFixed(4)} R)` // the cutoff we picked using only teaching years
  );
  console.log(
    `Applied to HOLDOUT: ${chosen.holdN} trades, exp ${Number(chosen.holdExp).toFixed(4)} R/trade ` + // how that pick did on the untouched test year
      `(run MR_MODE=filter EV_MARGIN=${chosen.margin} for the engine-accurate number)` // hint to get the exact number
  );

  // ---- WIN-PROBABILITY sweep: does filtering on the model's P(win) actually help? ----
  // This bypasses the (stale for trailing) rrGeom EV score and just keeps trades whose
  // win-probability clears a threshold. If holdExp rises with the threshold, the model
  // adds real value; if it stays flat, the binary r>0 label isn't magnitude-aware enough.
  const wrOf = (arr: Sample[]) => (arr.length ? (arr.filter((x) => x.r > 0).length / arr.length) * 100 : NaN); // win-rate of a group
  console.log(`\n===== WIN-PROBABILITY SWEEP (basket ${TF}) =====`); // header
  console.log('minP  |  trainN  trainWR trainExp |  holdN  holdWR holdExp'); // column titles
  for (const q of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6]) { // try each win-probability floor
    const tr = samples.filter((s) => !s.holdout && s.p >= q); // teaching-year trades whose P(win) clears the floor
    const ho = samples.filter((s) => s.holdout && s.p >= q); // test-year trades that clear it
    console.log(
      `${q.toFixed(2)}  | ${String(tr.length).padStart(6)}  ${wrOf(tr).toFixed(1).padStart(6)}  ${expOf(tr).toFixed(4).padStart(8)} | ` + // teaching numbers
        `${String(ho.length).padStart(5)}  ${wrOf(ho).toFixed(1).padStart(6)}  ${expOf(ho).toFixed(4).padStart(8)}` // test numbers
    );
  }
};

// --------------------------- MODE: DASHBOARD --------------------------------
// Run the holdout (raw trailing exit, no ML) across the basket, gather each
// trade's entry/exit, compute all the stats + an equity curve, and write
// dashboard-data.js which back-test/dashboard.html reads to draw everything.
const runDashboard = (): void => {
  const cutoff = globalCutoff(); // start of the test year
  type Trade = { symbol: string; entryTime: number; entryPrice: number; exitTime: number; exitPrice: number; bias: string; r: number };
  const trades: Trade[] = []; // every test-year trade across the basket
  let chartCandles: number[][] = []; // [time,o,h,l,c] for the one symbol we draw

  for (const sym of EXEC_SYMBOLS) { // each market
    const c = loadCandles(sym, TF, DATA_PERIOD) as Candle[] | null; // load candles
    if (!c) continue; // missing -> skip
    const ind = computeIndicators(c); // indicator lines
    let i = WARMUP; // start once indicators are ready
    while (i < c.length - 1) { // walk the candles
      const setup = buildSetup(c, i, ind, SYMBOL_IDS[sym] ?? 0); // trade here?
      if (!setup) { i++; continue; } // no -> next
      if (c[i][CandleIndex.Time] < cutoff) { i++; continue; } // only the test year
      const { r, exitIndex } = simTrade(c, i, setup); // play it out
      const risk = Math.abs(setup.entry - setup.sl); // one risk unit in price
      const exitPrice = setup.bias === Bias.LONG ? setup.entry + r * risk : setup.entry - r * risk; // where it exited
      trades.push({
        symbol: sym,
        entryTime: c[i][CandleIndex.Time], entryPrice: setup.entry, // where/when we got in
        exitTime: c[exitIndex][CandleIndex.Time], exitPrice, // where/when we got out
        bias: setup.bias === Bias.LONG ? 'long' : 'short', r, // direction and profit in R
      });
      i = exitIndex + 1; // one position per market at a time
    }
    if (sym === CHART_SYMBOL) { // this is the symbol we draw candles for
      chartCandles = c
        .filter((k) => k[CandleIndex.Time] >= cutoff) // only test-year candles
        .map((k) => [k[CandleIndex.Time], k[CandleIndex.Open], k[CandleIndex.High], k[CandleIndex.Low], k[CandleIndex.Close]]); // slim tuples
    }
  }

  // ---- crunch the stats over all trades, in the order they closed ----
  trades.sort((a, b) => a.exitTime - b.exitTime); // chronological by exit
  const n = trades.length; // total trades
  let wins = 0, grossWin = 0, grossLoss = 0, maxR = -Infinity, minR = Infinity; // tallies
  let curW = 0, curL = 0, maxWStreak = 0, maxLStreak = 0; // streaks
  const START = 1000, RISK_PCT = 0.01; // $1k account, 1% flat risk for the curve
  let flat = START, flatPeak = START, flatMaxDDpct = 0; // equity + worst drawdown
  const equity: { t: number; v: number }[] = []; // the equity curve points
  for (const t of trades) { // walk trades in time order
    if (t.r > 0) { wins++; grossWin += t.r; curW++; curL = 0; if (curW > maxWStreak) maxWStreak = curW; } // a win
    else { grossLoss += -t.r; curL++; curW = 0; if (curL > maxLStreak) maxLStreak = curL; } // a loss
    if (t.r > maxR) maxR = t.r; // biggest win
    if (t.r < minR) minR = t.r; // biggest loss
    flat += t.r * START * RISK_PCT; // update the flat-risk account
    if (flat > flatPeak) flatPeak = flat; // new peak?
    const dd = flatPeak > 0 ? ((flatPeak - flat) / flatPeak) * 100 : 0; // drop from peak, %
    if (dd > flatMaxDDpct) flatMaxDDpct = dd; // worst drop
    equity.push({ t: t.exitTime, v: Math.round(flat) }); // record the equity point
  }
  const losses = n - wins; // losing trades
  const totalR = grossWin - grossLoss; // net R

  // per-market table
  const perSymbol = EXEC_SYMBOLS.map((s) => { // for each market
    const ts = trades.filter((t) => t.symbol === s); // its trades
    const w = ts.filter((t) => t.r > 0).length; // its wins
    const tr = ts.reduce((acc, t) => acc + t.r, 0); // its net R
    return { symbol: s, trades: ts.length, wr: ts.length ? (w / ts.length) * 100 : 0, totalR: tr, exp: ts.length ? tr / ts.length : 0 };
  }).filter((x) => x.trades > 0); // drop empty ones (e.g. EU50)

  const stats = {
    from: new Date(cutoff * 1000).toISOString().slice(0, 10), // test-year start date
    trades: n, wins, losses,
    winRate: n ? (wins / n) * 100 : 0, // %
    expectancy: n ? totalR / n : 0, // R per trade
    totalR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : 999, // won-per-lost
    avgWin: wins ? grossWin / wins : 0, // avg winning R
    avgLoss: losses ? grossLoss / losses : 0, // avg losing R
    biggestWin: maxR, biggestLoss: minR, // extremes in R
    maxWinStreak: maxWStreak, maxLossStreak: maxLStreak, // runs
    flatFinal: Math.round(flat), flatProfit: Math.round(flat - START), flatMaxDDpct, // $ results at 1% flat
    riskPct: RISK_PCT * 100, // the risk % used for the curve
  };

  // bundle everything and write it as a JS file the HTML can <script>-load (works from file://)
  const data = { chartSymbol: CHART_SYMBOL, candles: chartCandles, trades: trades.filter((t) => t.symbol === CHART_SYMBOL), stats, perSymbol, equity };
  fs.writeFileSync(DASH_DATA_PATH, 'window.DASH = ' + JSON.stringify(data) + ';\n'); // write dashboard-data.js
  console.log(`Wrote dashboard data -> ${DASH_DATA_PATH}`);
  console.log(`Chart ${CHART_SYMBOL}: ${data.trades.length} trades over ${chartCandles.length} candles`);
  console.log(`All-basket: ${n} trades | WR ${stats.winRate.toFixed(1)}% | exp ${stats.expectancy.toFixed(3)}R | PF ${stats.profitFactor.toFixed(2)}`);
  console.log(`Now open back-test/dashboard.html in your browser.`);
};

// --------------------------------- MAIN -------------------------------------
// pick which job to run based on the MR_MODE setting, then do it
const run = async (): Promise<void> => {
  if (MODE === 'generate') generate(); // build the teaching file + show the raw results
  else if (MODE === 'sweep') await runSweep(); // try many AI cutoffs and print a table
  else if (MODE === 'dashboard') runDashboard(); // export trades/candles/stats for the HTML dashboard
  else await runFilter(); // run the AI-filtered strategy on the test year
};

run(); // start the program
