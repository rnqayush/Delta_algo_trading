// Historical candle downloader with an on-disk cache.
//
// Delta Exchange caps /v2/history/candles at 4000 rows per request and returns
// them NEWEST FIRST, so this walks the window backwards until it reaches the
// requested `from` time (or the instrument's listing date) and stitches the
// batches together into one ascending series.
//
// Uses Node's global fetch, so it needs no dependencies.

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';
const MAX_ROWS_PER_REQUEST = 4000;
const DATA_DIR = path.join(__dirname, '..', 'data');

const RESOLUTION_SECONDS = {
  '5s': 5,
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// One raw request. Returns ascending candles within [start, end].
async function fetchBatch(symbol, resolution, startSec, endSec) {
  const url =
    `${BASE}/v2/history/candles?resolution=${resolution}&symbol=${encodeURIComponent(symbol)}` +
    `&start=${startSec}&end=${endSec}`;

  const body = await fetchJson(url);
  const rows = Array.isArray(body.result) ? body.result : [];

  return rows
    .map((row) => ({
      time: Number(row.time ?? row.start_time ?? 0),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume ?? 0),
    }))
    .filter((c) => c.time > 0 && c.high > 0 && c.low > 0)
    .sort((a, b) => a.time - b.time);
}

// Full download: pages backwards until `fromSec` is reached.
async function downloadCandles({ symbol, resolution, fromSec, toSec }) {
  const period = RESOLUTION_SECONDS[resolution];
  if (!period) throw new Error(`Unsupported resolution: ${resolution}`);

  const byTime = new Map();
  let end = toSec;
  let requests = 0;

  while (end > fromSec && requests < 200) {
    const batch = await fetchBatch(symbol, resolution, fromSec, end);
    requests += 1;

    if (!batch.length) break;
    for (const candle of batch) byTime.set(candle.time, candle);

    const oldest = batch[0].time;
    // Delta silently clamps every response to its newest MAX_ROWS_PER_REQUEST
    // candles, so a "short" batch does NOT mean the window is complete — only
    // stop once the oldest returned candle reaches the start of the window.
    if (oldest <= fromSec) break;

    const nextEnd = oldest - 1;
    if (nextEnd >= end) break; // no progress — stop rather than spin
    end = nextEnd;

    await sleep(120); // be gentle with the public endpoint
  }

  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { candles, requests };
}

function cachePath(symbol, resolution) {
  return path.join(DATA_DIR, `${symbol}_${resolution}.json`);
}

function loadCache(symbol, resolution) {
  const file = cachePath(symbol, resolution);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.candles) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function saveCache(symbol, resolution, payload) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(cachePath(symbol, resolution), JSON.stringify(payload));
}

// Returns cached candles when they are fresh enough, otherwise downloads.
async function getCandles({ symbol, resolution, days, force = false }) {
  const cached = force ? null : loadCache(symbol, resolution);

  if (cached && cached.symbol === symbol && cached.resolution === resolution && cached.candles.length) {
    const ageHours = (Date.now() - new Date(cached.downloadedAt).getTime()) / 3.6e6;
    if (ageHours < 12 && cached.candles.length > 0) {
      return { candles: cached.candles, source: 'cache', requests: 0 };
    }
  }

  const toSec = Math.floor(Date.now() / 1000);
  const fromSec = toSec - days * 86400;

  const { candles, requests } = await downloadCandles({ symbol, resolution, fromSec, toSec });
  if (!candles.length) throw new Error(`No candles downloaded for ${symbol} ${resolution}`);

  saveCache(symbol, resolution, {
    symbol,
    resolution,
    downloadedAt: new Date().toISOString(),
    candles,
  });

  return { candles, source: 'delta', requests };
}

module.exports = {
  RESOLUTION_SECONDS,
  downloadCandles,
  getCandles,
  loadCache,
  saveCache,
  cachePath,
  DATA_DIR,
};
