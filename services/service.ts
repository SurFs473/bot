import * as fs from 'fs';
import * as path from 'path';
import { BASE_DATA_DIR, GW, MAGIC } from '../core/constants';
import {
  MT5Account,
  MT5RateTuple,
  MT5SymbolInfo,
  MT5Tick,
  MT5Timeframe,
} from '../interfaces/metaTraderInterface';
import { Bias } from '../core/types';
const axios = require('axios');
const { post } = axios;
export const loadCandles = (symbol: string, timeFrame: string, time: string = '1y') => {
  const dataFolder = path.join(BASE_DATA_DIR, symbol);
  const filePath = path.join(dataFolder, `${symbol}_${timeFrame}_${time}.json`);

  if (!fs.existsSync(filePath)) {
    console.log('Missing file:', filePath);
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

export const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => setTimeout(r, ms));
};

export const connect = async (): Promise<void> => {
  const r = await post(`${GW}/connect`, {});
  if (!r.data.connected) throw new Error('MT5 connect failed');
  console.log('Connected:', r.data.account?.login);
};

export const getAccount = async (): Promise<MT5Account> => {
  const r = await post(`${GW}/account`, {});
  return r.data.account;
};

export const getPositions = async (symbol: string, magic: number) => {
  return post(`${GW}/positions`, { symbol, magic });
};

export const getSymbolInfo = async (symbol: string): Promise<MT5SymbolInfo> => {
  const r = await post(`${GW}/symbol_info`, { symbol });
  return r.data;
};

export const getTick = async (symbol: string): Promise<MT5Tick> => {
  const r = await post(`${GW}/tick`, { symbol });
  return r.data.tick;
};

export const getRates = async (
  timeframe: MT5Timeframe,
  count: number,
  symbol: string
): Promise<MT5RateTuple[]> => {
  const r = await post(`${GW}/rates`, {
    symbol,
    timeframe,
    count,
  });
  return r.data.rates;
};

export const sendOrder = async (
  symbol: string,
  bias: Bias,
  lot: number,
  entry: number,
  sl: number,
  tp: number
) => {
  return post(`${GW}/order`, {
    symbol: symbol,
    volume: lot,
    type: bias === 'LONG' ? 0 : 1,
    price: entry,
    sl,
    tp,
    deviation: 20,
    magic: MAGIC,
    comment: 'H1_M15_M5_1TO1',
  });
};

export const modifyOrder = async (
  positionId: number,
  sl?: number,
  tp?: number
) => {
  return post(`${GW}/modify`, {
    positionId,
    sl,
    tp,
  });
};

// const momentumStillValid = (
//   m5: Candle[],
//   fromIndex: number,
//   bias: Bias
// ): boolean => {
//   if (fromIndex < 3) return false;

//   const prev = m5[fromIndex - 1];

//   for (let i = fromIndex; i < fromIndex + 3 && i < m5.length; i++) {
//     const close = m5[i][4];

//     if (
//       bias === Bias.LONG &&
//       close > prev[2]
//     ) {
//       return true;
//     }

//     if (
//       bias === Bias.SHORT &&
//       close < prev[3]
//     ) {
//       return true;
//     }
//   }

//   return false;
// };

// const createFailedBosTrade = (
//   entryCandle: Candle,
//   failedBosCandle: Candle,
//   bias: Bias,
//   rr = 1.3
// ) => {
//   const entry = entryCandle[4];

//   if (bias === Bias.LONG) {
//     // контра = SHORT
//     const sl = failedBosCandle[2];
//     const risk = sl - entry;
//     if (risk <= 0) return null;

//     return {
//       entry,
//       sl,
//       tp: entry - rr * risk,
//       direction: Bias.SHORT
//     };
//   } else {
//     // контра = LONG
//     const sl = failedBosCandle[3];
//     const risk = entry - sl;
//     if (risk <= 0) return null;

//     return {
//       entry,
//       sl,
//       tp: entry + rr * risk,
//       direction: Bias.LONG
//     };
//   }
// };

// const getM15AvgRange = (
//   m15: Candle[],
//   index: number,
//   lookback = 20
// ): number => {
//   const from = Math.max(0, index - lookback);
//   let sum = 0;
//   let count = 0;

//   for (let i = from; i < index; i++) {
//     const high = m15[i][2];
//     const low  = m15[i][3];
//     sum += high - low;
//     count++;
//   }

//   return count > 0 ? sum / count : 0;
// };

// const getAvgM15Range = (
//   m15: Candle[],
//   index: number,
//   lookback = 20
// ): number => {
//   if (index < 2) return 0;

//   const from = Math.max(0, index - lookback);
//   let sum = 0;
//   let count = 0;

//   for (let i = from; i < index; i++) {
//     const high = m15[i][CandleIndex.High];
//     const low  = m15[i][CandleIndex.Low];
//     const range = high - low;
//     if (range > 0) {
//       sum += range;
//       count++;
//     }
//   }

//   return count > 0 ? sum / count : 0;
// };

// const isDeadM15  = (
//   m15: Candle[],
//   index: number,
//   deadFactor = 0.75   // колко от range-а е тяло
// ): boolean => {
//   if (index < 2) return false;

//   const avgRange = getAvgM15Range(m15, index);
//   if (avgRange <= 0) return false;

//   const high = m15[index][CandleIndex.High];
//   const low  = m15[index][CandleIndex.Low];
//   const range = high - low;

//   return range < avgRange * deadFactor;
// };