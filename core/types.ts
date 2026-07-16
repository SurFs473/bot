export type Candle = [
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  tick_volume: number,
  spread: number,
  real_volume: number
];

export enum Bias {
  LONG = 'LONG',
  SHORT = 'SHORT',
}
export enum TradeResult {
  Open = 'OPEN',
  StopLoss = 'SL',
  TakeProfit = 'TP',
  BreakEven = 'BE'
}

export const TimeFrames = {
  h1: 'H1',
  m15: 'M15',
  m5: 'M5',
  m1: "M1"
};

export const enum CandleIndex {
  Time = 0,
  Open = 1,
  High = 2,
  Low = 3,
  Close = 4,
  Volume = 5,
  Spread = 6,
}

