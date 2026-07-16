// Download multi-year M1 index history from histdata.com, aggregate to M15, and
// write the tuple JSON loadCandles expects: [time(sec),o,h,l,c,vol,spread,real].
//
//   node download_histdata.js            # whole basket (skips symbols already done)
//   node download_histdata.js US500      # one symbol
//   FORCE=1 node download_histdata.js    # re-download even if the file exists
//
// HistData flow per file: GET the year/month page -> scrape the `tk` token +
// hidden fields -> POST get.php with the session cookie + Referer -> unzip the
// M1 CSV -> aggregate to M15. Indices have volume=0 on HistData.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// our SYMBOL -> histdata instrument (Dow/US30 is not on histdata; dropped)
const BASKET = {
  US500: 'SPXUSD',
  US100: 'NSXUSD',
  GER40: 'GRXEUR',
  UK100: 'UKXGBP',
  FRA40: 'FRXEUR',
  EU50: 'ETXEUR',
  JPN225: 'JPXJPY',
  AUS200: 'AUXAUD',
  HK50: 'HKXHKD',
};

const START_YEAR = 2011; // 2010 exists too but is partial for some; 2011+ is clean
const SUFFIX = '15y';
const DATA_DIR = path.resolve(__dirname, 'data');
const UA = 'Mozilla/5.0';
const EST_OFFSET = 5 * 3600; // histdata M1 is EST (UTC-5), no DST -> +5h to reach UTC
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pageUrl = (pair, year, month) =>
  `https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/${pair.toLowerCase()}/${year}${
    month ? '/' + month : ''
  }`;

const field = (html, name) => {
  const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
  return m ? m[1] : '';
};

// GET the page, return { html, cookie }
async function getPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  return { html: await res.text(), cookie };
}

// POST get.php, return a Buffer (the zip) or null on non-zip response
async function postDownload(referer, cookie, fields) {
  const body = new URLSearchParams(fields).toString();
  const res = await fetch('https://www.histdata.com/get.php', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: referer,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return null; // not a PK zip
  return buf;
}

// Download one page (year or year/month) -> array of M1 [sec,o,h,l,c,v]
async function fetchBars(pair, year, month) {
  const url = pageUrl(pair, year, month);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { html, cookie } = await getPage(url);
      const tk = field(html, 'tk');
      if (!tk) throw new Error('no token (page missing?)');
      const fields = {
        tk,
        date: field(html, 'date') || String(year),
        datemonth: field(html, 'datemonth') || String(year),
        platform: field(html, 'platform') || 'ASCII',
        timeframe: field(html, 'timeframe') || 'M1',
        fxpair: field(html, 'fxpair') || pair,
      };
      const zipBuf = await postDownload(url, cookie, fields);
      if (!zipBuf) throw new Error('non-zip response');
      const entry = new AdmZip(zipBuf).getEntries().find((e) => /\.csv$/i.test(e.entryName));
      if (!entry) throw new Error('no csv in zip');
      return parseCsv(entry.getData().toString('latin1'));
    } catch (e) {
      if (attempt === 4) {
        console.log(`    ${pair} ${year}${month ? '/' + month : ''} failed: ${e.message}`);
        return null;
      }
      await sleep(3000 * attempt);
    }
  }
  return null;
}

// "YYYYMMDD HHMMSS;o;h;l;c;v" (EST) -> [utcSec,o,h,l,c,v]
function parseCsv(text) {
  const out = [];
  for (const lineRaw of text.split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    const [dt, o, h, l, c, v] = line.split(';');
    if (!dt || dt.length < 15) continue;
    const Y = +dt.slice(0, 4);
    const Mo = +dt.slice(4, 6);
    const D = +dt.slice(6, 8);
    const HH = +dt.slice(9, 11);
    const MM = +dt.slice(11, 13);
    const SS = +dt.slice(13, 15);
    const sec = Math.floor(Date.UTC(Y, Mo - 1, D, HH, MM, SS) / 1000) + EST_OFFSET;
    out.push([sec, +o, +h, +l, +c, +v || 0]);
  }
  return out;
}

// aggregate a batch of M1 bars into an existing M15 bucket map (in place)
function aggregateInto(byBucket, m1) {
  for (const [sec, o, h, l, c, v] of m1) {
    const b = Math.floor(sec / 900) * 900;
    const cur = byBucket.get(b);
    if (!cur) byBucket.set(b, [b, o, h, l, c, v, 0, 0]);
    else {
      if (h > cur[2]) cur[2] = h;
      if (l < cur[3]) cur[3] = l;
      cur[4] = c;
      cur[5] += v;
    }
  }
}

async function downloadSymbol(sym, pair) {
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const byBucket = new Map();
  for (let y = START_YEAR; y <= curYear; y++) {
    if (y < curYear) {
      const bars = await fetchBars(pair, y);
      if (bars) {
        aggregateInto(byBucket, bars);
        console.log(`  ${sym} ${y}: ${bars.length} M1`);
      }
      await sleep(1200);
    } else {
      // current (incomplete) year -> monthly files
      for (let mo = 1; mo <= now.getUTCMonth() + 1; mo++) {
        const bars = await fetchBars(pair, y, mo);
        if (bars) {
          aggregateInto(byBucket, bars);
          console.log(`  ${sym} ${y}/${String(mo).padStart(2, '0')}: ${bars.length} M1`);
        }
        await sleep(1000);
      }
    }
  }

  const rows = [...byBucket.values()].sort((a, b) => a[0] - b[0]);
  const dir = path.join(DATA_DIR, sym);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sym}_M15_${SUFFIX}.json`);
  fs.writeFileSync(file, JSON.stringify(rows));
  const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const span = rows.length ? `${iso(rows[0][0])}..${iso(rows[rows.length - 1][0])}` : 'EMPTY';
  console.log(`DONE ${sym}: ${rows.length} M15 bars ${span} -> ${file}\n`);
}

(async () => {
  const only = process.argv.slice(2); // zero or more symbols; empty = whole basket
  for (const [sym, pair] of Object.entries(BASKET)) {
    if (only.length && !only.includes(sym)) continue;
    const file = path.join(DATA_DIR, sym, `${sym}_M15_${SUFFIX}.json`);
    if (!process.env.FORCE && fs.existsSync(file)) {
      console.log(`skip ${sym} (exists)`);
      continue;
    }
    console.log(`=== ${sym} (${pair}) ===`);
    await downloadSymbol(sym, pair);
  }
  console.log('ALL DONE');
})();
