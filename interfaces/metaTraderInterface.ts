export interface MT5Account {
  login: number;
  trade_mode: number;
  leverage: number;
  limit_orders: number;
  margin_so_mode: number;
  trade_allowed: boolean;
  trade_expert: boolean;

  balance: number;
  credit: number;
  profit: number;
  equity: number;

  margin: number;
  margin_free: number;
  margin_level: number;

  margin_so_call: number;
  margin_so_so: number;

  margin_initial: number;
  margin_maintenance: number;

  assets: number;
  liabilities: number;

  commission_blocked: number;

  currency: string;
  company: string;
  name: string;
  server: string;
}
export interface MT5SymbolInfo {
  custom: boolean;
  chart_mode: number;
  select: boolean;
  visible: boolean;
  session_deals: number;
  session_buy_orders: number;
  session_sell_orders: number;
  volume: number;
  volumehigh: number;
  volumelow: number;

  time: number;
  digits: number;
  spread: number;
  spread_float: boolean;
  ticks_bookdepth: number;
  trade_calc_mode: number;
  trade_mode: number;

  start_time: number;
  expiration_time: number;

  trade_stops_level: number;
  trade_freeze_level: number;

  trade_exemode: number;
  swap_mode: number;

  swap_long: number;
  swap_short: number;
  swap_rollover3days: number;

  margin_initial: number;
  margin_maintenance: number;

  margin_long: number;
  margin_short: number;
  margin_limit: number;

  margin_stop: number;
  margin_stoplimit: number;

  volume_min: number;
  volume_max: number;
  volume_step: number;
  volume_limit: number;

  trade_tick_value: number;
  tick_value_profit: number;
  tick_value_loss: number;

  trade_tick_size: number;
  contract_size: number;

  profit_mode: number;
  filling_mode: number;
  filling_modes: number;

  expiration_mode: number;

  order_mode: number;
  order_gtc_mode: number;

  option_mode: number;

  option_right: number;
  option_strike: number;

  bid: number;
  ask: number;
  last: number;

  name: string;
  description: string;
  path: string;
  currency_base: string;
  currency_profit: string;
  currency_margin: string;
}

export type MT5Timeframe = 'M1' | 'M5' | 'M15' | 'H1';

export interface MT5Tick {
  time: number;
  time_msc: number;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  volume_real: number;
  flags: number;
}

export type MT5RateTuple = [
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  tick_volume: number,
  spread: number,
  real_volume: number
];
