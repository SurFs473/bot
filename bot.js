const axios = require("axios");

// ---------------- CONFIG
const GW = "http://127.0.0.1:5005";
const SYMBOL = "Usa500"; // смени ако при теб е US500.cash / US500m
const MAGIC = 50015002;

const RISK_PCT = 1.0; // 0.5 ако искаш
const RR = 3.0;
const MAX_SPREAD_POINTS = 60;
const ONE_POSITION_ONLY = true;

// session opens in BROKER SERVER TIME (Dec, Bulgaria winter time usually matches UTC+2 server)
// London 10:00, NY 16:30
const SESSIONS = [
  { name: "LONDON", hour: 10, min: 0 },
  { name: "NY", hour: 16, min: 30 },
];

// how long after open to search for FVG + retest (minutes)
const SEARCH_WINDOW_MIN = 120;

// ---------------- STATE
const state = {
  dayKey: null,
  sessions: {}, // sessionName -> sessionState
};

// sessionState fields:
// openTs (unix sec), orbReady, orbHigh, orbLow, fvgFound, zoneTop, zoneBottom, dir, sl, traded
function newSessionState(openTs) {
  return {
    openTs,
    endTs: openTs + SEARCH_WINDOW_MIN * 60,
    orbReady: false,
    orbHigh: null,
    orbLow: null,
    fvgFound: false,
    waitingRetest: false,
    zoneTop: null,
    zoneBottom: null,
    dir: null, // "LONG" | "SHORT"
    sl: null,
    traded: false,
  };
}

// ---------------- HELPERS
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ymdKeyFromUnix(ts) {
  const d = new Date(ts * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// We use server time from tick.time (unix seconds)
async function getTick() {
  const r = await axios.post(`${GW}/tick`, { symbol: SYMBOL });
  return r.data.tick; // {time, bid, ask, ...}
}

async function getRates(timeframe, count) {
  const r = await axios.post(`${GW}/rates`, {
    symbol: SYMBOL,
    timeframe, // "M1" or "M5"
    count,
  });
  // rates rows are arrays from MT5: [time, open, high, low, close, tick_volume, spread, real_volume]
  return r.data.rates;
}

async function connect() {
  const r = await axios.post(`${GW}/connect`, {});
  if (!r.data.connected) throw new Error(`MT5 connect failed: ${JSON.stringify(r.data)}`);
  return r.data.account;
}

// spread in "points": (ask-bid)/point, but we don't know point here;
// We'll approximate with symbol_info in gateway later; for now use spread field from M1 last bar if available.
// Better: check tick.ask - tick.bid against a guessed point? We'll just use the "spread" from last M1 bar if returned.
function spreadOkFromRates(lastM1BarSpread) {
  if (lastM1BarSpread == null) return true;
  return lastM1BarSpread <= MAX_SPREAD_POINTS;
}

// ---------- STRATEGY LOGIC

// Find the FIRST M5 bar that starts at open time.
// We'll scan last N M5 bars and pick one with time == openTs, else first bar within [openTs, openTs+300).
function findFirstM5BarAtOpen(m5Rates, openTs) {
  // m5Rates comes newest->oldest? In gateway we return as given by MT5 (usually newest->oldest if pos=0)
  // We'll just search all.
  for (const r of m5Rates) {
    const t = r[0];
    if (t === openTs) return r;
  }
  for (const r of m5Rates) {
    const t = r[0];
    if (t >= openTs && t < openTs + 5 * 60) return r;
  }
  return null;
}

// Detect FVG on last 3 CLOSED M1 candles:
// Using r[3]=bar2, r[2]=bar1, r[1]=bar0 if array is newest->oldest with [0]=latest forming bar
// We'll assume the returned rates are newest first.
// Bullish FVG: bar2.high < bar0.low => zone [bar2.high, bar0.low]
// Bearish FVG: bar2.low > bar0.high => zone [bar0.high, bar2.low]
function detectFVG(m1Rates) {
  if (!m1Rates || m1Rates.length < 5) return null;

  const bar0 = m1Rates[1]; // newest closed
  const bar1 = m1Rates[2];
  const bar2 = m1Rates[3];

  const bar0High = bar0[2], bar0Low = bar0[3];
  const bar2High = bar2[2], bar2Low = bar2[3];

  // bullish
  if (bar2High < bar0Low) {
    return {
      dir: "LONG",
      bottom: bar2High,
      top: bar0Low,
      slRef: bar0Low, // SL "под свещта с FVG-то": use bar0 low
    };
  }

  // bearish
  if (bar2Low > bar0High) {
    return {
      dir: "SHORT",
      bottom: bar0High,
      top: bar2Low,
      slRef: bar0High, // SL above bar0 high
    };
  }

  return null;
}

function fvgInsideORB(fvg, orbHigh, orbLow) {
  return fvg.bottom >= orbLow && fvg.top <= orbHigh;
}

// Retest: price touches within the zone
function touchedZone(dir, bid, ask, bottom, top) {
  if (dir === "LONG") return bid >= bottom && bid <= top;
  if (dir === "SHORT") return ask >= bottom && ask <= top;
  return false;
}

// Risk sizing in JS is tricky without symbol contract info.
// Easiest: send a FIXED lot for now, then we enhance gateway with symbol_info endpoint.
// For now: start with micro lot-ish.
const FIXED_LOT_FALLBACK = 0.10;

// Calculate SL/TP based on RR
function calcOrder(dir, tick, bottom, top, slRef) {
  const entry = dir === "LONG" ? tick.ask : tick.bid;

  // SL just beyond fvg candle ref (1 "tick" buffer is unknown). We'll use tiny buffer 0.1 for indices, but safer:
  // We'll set SL = slRef (exactly) for now; later we add point from symbol_info.
  const sl = dir === "LONG" ? slRef : slRef;

  const riskDist = dir === "LONG" ? (entry - sl) : (sl - entry);
  if (riskDist <= 0) return null;

  const tp = dir === "LONG" ? entry + RR * riskDist : entry - RR * riskDist;

  return { entry, sl, tp };
}

async function sendOrder(dir, lot, entry, sl, tp) {
  const type = dir === "LONG" ? 0 /* BUY in mt5 gateway */ : 1 /* SELL */;

  const req = {
    symbol: SYMBOL,
    volume: lot,
    type,
    price: entry,
    sl,
    tp,
    deviation: 20,
    magic: MAGIC,
    comment: "ORB5_FVG_retest_js",
  };

  const r = await axios.post(`${GW}/order`, req);
  return r.data;
}

// NOTE: Our gateway uses MT5 ORDER_TYPE values (BUY=0 SELL=1) if we coded it like python mt5 enums.
// If your gateway expects mt5.ORDER_TYPE_BUY constant value, it is 0 and SELL is 1 in MT5 Python.
// So it's ok.

// ---------------- MAIN LOOP
async function main() {
  const acc = await connect();
  console.log("Connected. Account:", acc?.login, acc?.server);

  while (true) {
    try {
      const tick = await getTick();
      const serverTs = tick.time;

      // Daily reset based on UTC date of server timestamp (good enough)
      const dk = ymdKeyFromUnix(serverTs);
      if (state.dayKey !== dk) {
        state.dayKey = dk;
        state.sessions = {};
        for (const s of SESSIONS) {
          // Build openTs in SERVER time by using today's server date but with session hh:mm.
          // We don't have direct server timezone offset here; easiest:
          // - use tick.time (unix) -> local Date -> set hours in LOCAL time might drift.
          // We'll approximate by using local time since you said server == BG time in Dec.
          // Practical method: build from your local Date and treat as server.
          const d = new Date(serverTs * 1000);
          d.setHours(s.hour, s.min, 0, 0);
          const openTs = Math.floor(d.getTime() / 1000);

          state.sessions[s.name] = newSessionState(openTs);
        }
        console.log("New day state reset:", state.dayKey);
      }

      // One-position rule: if you already have an open position, you can skip everything
      // (we didn't implement /positions endpoint; simplest: rely on OneTradePerSession)
      for (const s of SESSIONS) {
        const ss = state.sessions[s.name];
        if (!ss) continue;

        // wait until open
        if (serverTs < ss.openTs) continue;
        if (serverTs > ss.endTs) continue;
        if (OneTradePerSession && ss.traded) continue;

        // 1) Capture ORB from FIRST M5 candle after open (needs it closed => now >= open+300s)
        if (!ss.orbReady && serverTs >= ss.openTs + 5 * 60) {
          const m5 = await getRates("M5", 200);
          const bar = findFirstM5BarAtOpen(m5, ss.openTs);
          if (bar) {
            ss.orbHigh = bar[2];
            ss.orbLow = bar[3];
            ss.orbReady = true;
            console.log(`[${s.name}] ORB ready. High=${ss.orbHigh} Low=${ss.orbLow} at openTs=${ss.openTs}`);
          }
        }

        // 2) Find FVG on M1 INSIDE ORB (no breakout)
        if (ss.orbReady && !ss.fvgFound) {
          const m1 = await getRates("M1", 10);
          const lastSpread = m1?.[1]?.[6]; // spread field in rates
          if (!spreadOkFromRates(lastSpread)) {
            // too wide spread; skip this tick
            continue;
          }

          const fvg = detectFVG(m1);
          if (fvg && fvgInsideORB(fvg, ss.orbHigh, ss.orbLow)) {
            ss.fvgFound = true;
            ss.waitingRetest = true;
            ss.dir = fvg.dir;
            ss.zoneBottom = fvg.bottom;
            ss.zoneTop = fvg.top;

            // SL "под свещта": use slRef directly for now
            ss.sl = fvg.slRef;

            console.log(
              `[${s.name}] FVG found dir=${ss.dir} zone=[${ss.zoneBottom}, ${ss.zoneTop}] SLref=${ss.sl}`
            );
          }
        }

        // 3) Retest entry
        if (ss.waitingRetest && ss.fvgFound && !ss.traded) {
          const touched = touchedZone(ss.dir, tick.bid, tick.ask, ss.zoneBottom, ss.zoneTop);
          if (!touched) continue;

          const ord = calcOrder(ss.dir, tick, ss.zoneBottom, ss.zoneTop, ss.sl);
          if (!ord) continue;

          // For now: fixed lot fallback (we can add true risk sizing next)
          const lot = FIXED_LOT_FALLBACK;

          console.log(`[${s.name}] RETEST touched -> sending order ${ss.dir} lot=${lot} entry=${ord.entry} sl=${ord.sl} tp=${ord.tp}`);

          const res = await sendOrder(ss.dir, lot, ord.entry, ord.sl, ord.tp);
          console.log("order result:", res);

          ss.traded = true;
          ss.waitingRetest = false;
        }
      }
    } catch (e) {
      console.error("Loop error:", e?.response?.data || e.message);
    }

    // poll once per second
    await sleep(1000);
  }
}

main().catch(console.error);
