// Connectivity + data-availability recon for the breakout backtest.
// Uses Node's global fetch (Node >= 18) so it needs no dependencies.

const BASE = process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange';
const SYMBOL = process.env.TRADING_SYMBOL || 'BTCUSD';

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

async function main() {
  console.log(`base=${BASE} symbol=${SYMBOL}`);

  const product = await get(`/v2/products/${SYMBOL}`);
  const p = product.result || {};
  console.log(
    `product: id=${p.id} tick=${p.tick_size} contractValue=${p.contract_value} ` +
      `launch=${p.launch_time}`
  );

  // 15m candles over the last 3 days, epoch seconds per Delta's contract.
  const end = Math.floor(Date.now() / 1000);
  const start = end - 3 * 24 * 60 * 60;
  const res = await get(
    `/v2/history/candles?resolution=15m&symbol=${SYMBOL}&start=${start}&end=${end}`
  );
  const rows = res.result || [];
  console.log(`15m candles returned for 3 days: ${rows.length}`);
  if (rows.length) {
    console.log('first:', JSON.stringify(rows[0]));
    console.log('last :', JSON.stringify(rows[rows.length - 1]));
    const first = rows[0].time ?? rows[0].start_time;
    const last = rows[rows.length - 1].time ?? rows[rows.length - 1].start_time;
    console.log(`span seconds: ${last - first} (${((last - first) / 86400).toFixed(2)} days)`);
  }

  // Probe how far back a single large request can go.
  for (const days of [30, 90, 200]) {
    const s = end - days * 24 * 60 * 60;
    const r = await get(
      `/v2/history/candles?resolution=15m&symbol=${SYMBOL}&start=${s}&end=${end}`
    );
    const n = (r.result || []).length;
    console.log(`request ${days}d -> ${n} candles`);
  }
}

main().catch((error) => {
  console.error('RECON FAILED:', error.message);
  process.exit(1);
});
