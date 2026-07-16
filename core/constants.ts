import * as path from 'path';
import { Bias, Candle, TradeResult } from './types';
export const SYMBOLS = [
  // 'Us100',
  'US500',
  // 'GER30',
  // 'UK100',
  // 'FRA40',
  // 'EU50',

  'XAUUSD',
  // 'XAGUSD',  
  // 'XPDUSD',
  // 'XPTUSD',

  // 'GOOGLE.US',
  // 'MSFT.US',
  // 'NFLX.US',
  // 'TESLA.US',
  // 'NVDA.OQ',

  // 'EURUSD',
  // 'EURNZD',
  // 'USDJPY',
  'GBPUSD',

  // "BTCUSD",
  // 'ETHUSD'
];

export const MAGIC = 90090001;

export const MIN_SL_PRICE = 2;

export const MAX_SPREAD_POINTS = 60;

export const RISK_PERCENT = 0.4;

export const BASE_DATA_DIR = path.resolve(process.cwd(), 'data');

export const RR = 1.0;

export const GW = 'http://127.0.0.1:5005';

export const SPREADS = {
  GOLD: 0.15,
  Usa500: 0.8,
  'GOOGLE.US': 0.05,
  'MSFT.US': 0.05,
  'NFLX.US': 0.05,
  'TESLA.US': 0.05,
  'NVDA.OQ': 0.05,
};

export class Trade {
  readonly entryTime: number;
  public sl: number;
  readonly tp: number;
  public closeTime?: number;

  public constructor(entryTime: number, sl: number, tp: number) {
    this.entryTime = entryTime;
    this.sl = sl;
    this.tp = tp;
  }
}

export class LiveTrade {
  readonly entry: number;
  readonly sl: number;
  readonly tp: number;
  readonly barTs: number;

  public constructor(entry: number, sl: number, tp: number, barTs: number) {
    this.entry = entry;
    this.sl = sl;
    this.tp = tp;
    this.barTs = barTs;
  }
}

export class CsvTrade {
  symbol: string;
  side: 'long' | 'short';
  entry_time: string;
  exit_time: string;
  entry_price: number;
  exit_price: number;
  qty: number;

  constructor(params: {
    symbol: string;
    bias: Bias;
    entryTime: number; // unix seconds
    exitTime: number; // unix seconds
    entryPrice: number;
    result: TradeResult;
    tp: number;
    sl: number;
  }) {
    this.symbol = params.symbol;
    this.side = params.bias === Bias.LONG ? 'long' : 'short';
    this.entry_time = new Date(params.entryTime * 1000).toISOString();
    this.exit_time = new Date(params.exitTime * 1000).toISOString();
    this.entry_price = params.entryPrice;
    this.exit_price =
      params.result === TradeResult.TakeProfit ? params.tp : params.sl;
    this.qty = 1;
  }

  static csvHeader(): string {
    return 'symbol,side,entry_time,exit_time,entry_price,exit_price,qty';
  }

  toCsvRow(): string {
    return [
      this.symbol,
      this.side,
      this.entry_time,
      this.exit_time,
      this.entry_price,
      this.exit_price,
      this.qty,
    ].join(',');
  }
}

// export class BiasLive {
//   readonly bias?: Bias;
//   readonly timeStamp: number;

//   constructor(timeStamp: number, bias?: Bias) {
//     this.timeStamp = timeStamp;
//     this.bias = bias;
//   }
// }

export class State {
  public bias?: Bias;
  public h1Timestamp?: number | null;
  public m15BosDone: boolean;
  public m15BosTimestamp?: number | null;
  public traded: boolean;
  public m15BosTraded: boolean;
  public lastM15Candle?: Candle;
  //be logic
  public beMoved: boolean = false;
  public entryPrice?: number;
  public sl?: number;
  public risk?: number;
  public positionId?: number;
  public lastCheckedM5Ts?: number;

  public simM5Close?: number;

  constructor(m15BosDone: boolean, traded: boolean, m15BosTraded: boolean) {
    this.m15BosDone = m15BosDone;
    this.traded = traded;
    this.m15BosTraded = m15BosTraded;
  }
}

export class TradeData {
  readonly symbol: string;
  readonly bias: Bias;
  readonly h1Time: string;
  readonly m15Time: string;
  readonly entryTime: string;
  readonly entry: number;
  readonly sl: number;
  readonly tp: number;
  readonly result: TradeResult;

  public constructor(
    symbol: string,
    bias: Bias,
    h1Time: string,
    m15Time: string,
    entryTime: string,
    entry: number,
    sl: number,
    tp: number,
    result: TradeResult
  ) {
    this.symbol = symbol;
    this.bias = bias;
    this.h1Time = h1Time;
    this.m15Time = m15Time;
    this.entryTime = entryTime;
    this.entry = entry;
    this.sl = sl;
    this.tp = tp;
    this.result = result;
  }
}
