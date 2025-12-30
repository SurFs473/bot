const fs = require("fs");
const path = require("path");
const axios = require("axios");

const GW = "http://127.0.0.1:5005";

// 🔥 ВСИЧКИ СИМВОЛИ ТУК
const SYMBOLS = [
  "Usa500",
  "EURUSD",
  "USDJPY",
  "EURNZD",
  "GOLD",
];

const OUT_DIR = path.join(__dirname, "data");

const DAYS_BACK = 730; // 2 години
const RETRIES = 3;

/*
 MT5 TF names:
 M1, M5, M15, M30, H1, H4, D1
*/
const TIMEFRAMES = [
  { tf: "M1", chunkDays: 7 },
  { tf: "M5", chunkDays: 7 },
  { tf: "M15", chunkDays: 30 },
  { tf: "M30", chunkDays: 30 },
  { tf: "H1", chunkDays: 90 },
  { tf: "H4", chunkDays: 180 },
  { tf: "D1", chunkDays: 365 },
];

function nowUnix() {
  return Math.floor(Date.now() / 1000) - 60;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function connect() {
  const r = await axios.post(`${GW}/connect`, {});
  if (!r.data.connected) {
    throw new Error("MT5 connect failed: " + JSON.stringify(r.data));
  }
  console.log(
    "Connected:",
    r.data.account?.server,
    "login:",
    r.data.account?.login
  );
}

async function fetchChunk(symbol, tf, fromTs, toTs) {
  const r = await axios.post(`${GW}/rates_range`, {
    symbol,
    timeframe: tf,
    time_from: fromTs,
    time_to: toTs,
  });
  return r.data.rates || [];
}

function dedupAndSort(rows) {
  rows.sort((a, b) => a[0] - b[0]);
  const out = [];
  let lastT = null;
  for (const r of rows) {
    if (r[0] !== lastT) out.push(r);
    lastT = r[0];
  }
  return out;
}

async function downloadSymbolTF(symbol, tf, chunkDays) {
  const symbolDir = path.join(OUT_DIR, symbol);
  if (!fs.existsSync(symbolDir)) fs.mkdirSync(symbolDir, { recursive: true });

  const toTs = nowUnix();
  const fromTs = toTs - DAYS_BACK * 24 * 60 * 60;
  const step = chunkDays * 24 * 60 * 60;

  let all = [];

  for (let t = fromTs; t < toTs; t += step) {
    const a = t;
    const b = Math.min(t + step, toTs);

    let ok = false;

    for (let k = 1; k <= RETRIES; k++) {
      try {
        console.log(
          `[${symbol} ${tf}] ${new Date(a * 1000).toISOString()} -> ${new Date(
            b * 1000
          ).toISOString()} (try ${k})`
        );

        const chunk = await fetchChunk(symbol, tf, a, b);
        if (chunk.length) all = all.concat(chunk);

        ok = true;
        break;
      } catch (e) {
        console.log("chunk error:", e.response?.data || e.message);
        await sleep(800);
      }
    }

    if (!ok) {
      console.log(
        `❌ FAILED ${symbol} ${tf}. Намали chunkDays и пробвай пак.`
      );
      return;
    }
  }

  const finalRows = dedupAndSort(all);
  const outPath = path.join(
    symbolDir,
    `${symbol}_${tf}_2y.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(finalRows));

  console.log(`✅ Saved ${symbol} ${tf}: ${finalRows.length} bars`);
}

(async () => {
  await connect();

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

  for (const symbol of SYMBOLS) {
    console.log(`\n==============================`);
    console.log(`📊 SYMBOL: ${symbol}`);
    console.log(`==============================`);

    for (const cfg of TIMEFRAMES) {
      await downloadSymbolTF(symbol, cfg.tf, cfg.chunkDays);
      await sleep(1000); // защита за MT5
    }
  }

  console.log("\n🎯 DONE. Всички символи и таймфреймове са изтеглени.");
})();
