// Deterministic simulated market data for SBC QA.
// Same symbol + same timestamp + same seed => same quote path.
// This lets Test Clock scenarios be reproduced exactly.

const DEFAULT_SEED = 1337;

function hash32(text, seed = DEFAULT_SEED) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 2654435761) >>> 0;
    h ^= h >>> 13;
  }
  return h >>> 0;
}

function unitNoise(symbol, bucket, seed = DEFAULT_SEED) {
  const h = hash32(`${symbol}:${bucket}`, seed);
  return (h % 1_000_000) / 1_000_000;
}

function sessionProgress(date) {
  // Caller provides a real Date instant. We intentionally use ET calendar
  // parts so the price path lines up with the SBC market sessions.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit'
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return Math.max(0, Math.min(390, minutes - 570)) / 390;
}

function simulatedPrice(symbol, basePrice, date, seed = DEFAULT_SEED) {
  if (!(basePrice > 0)) throw new Error(`Invalid base price for ${symbol}`);
  const minuteBucket = Math.floor(date.getTime() / 60_000);
  const progress = sessionProgress(date);
  const phase = hash32(symbol, seed) % 1000 / 1000 * Math.PI * 2;
  const noise = (unitNoise(symbol, minuteBucket, seed) - 0.5) * 0.007;
  const wave = Math.sin(progress * Math.PI * 2 + phase) * 0.014;
  const trendDirection = ((hash32(symbol + ':trend', seed) % 2001) - 1000) / 1000;
  const trend = (progress - 0.5) * 0.018 * trendDirection;
  return Number((basePrice * (1 + wave + trend + noise)).toFixed(2));
}

function getSimulatedQuote(meta, date, seed = DEFAULT_SEED) {
  const price = simulatedPrice(meta.symbol, meta.base, date, seed);
  const prevClose = Number(meta.base.toFixed(2));
  const changePct = ((price - prevClose) / prevClose) * 100;
  return {
    symbol: meta.symbol,
    name: meta.name,
    exchange: meta.exchange,
    currency: meta.currency,
    price,
    prevClose,
    changePct: Number(changePct.toFixed(2)),
    marketCap: meta.marketCap,
    timestamp: date.toISOString(),
    source: 'sim'
  };
}

function intervalMs(interval) {
  return ({ tick: 5000, '1m': 60000, '5m': 300000, '15m': 900000,
    '1h': 3600000, '1D': 86400000 })[interval] || 60000;
}

function getSimulatedBars(meta, interval, from, to, seed = DEFAULT_SEED) {
  const step = intervalMs(interval);
  const bars = [];
  for (let t = from.getTime(); t < to.getTime(); t += step) {
    const start = new Date(t);
    const end = new Date(Math.min(t + step, to.getTime()));
    const open = simulatedPrice(meta.symbol, meta.base, start, seed);
    const closeAt = new Date(Math.max(start.getTime(), end.getTime() - 1));
    const close = simulatedPrice(meta.symbol, meta.base, closeAt, seed);
    const mid = simulatedPrice(meta.symbol, meta.base, new Date((start.getTime() + end.getTime()) / 2), seed);
    const wiggle = 0.001 + unitNoise(meta.symbol, t, seed) * 0.0015;
    bars.push({
      time: start.toISOString(),
      open,
      high: Number((Math.max(open, close, mid) * (1 + wiggle)).toFixed(2)),
      low: Number((Math.min(open, close, mid) * (1 - wiggle)).toFixed(2)),
      close,
      volume: 100000 + Math.floor(unitNoise(meta.symbol + ':vol', t, seed) * 2_000_000)
    });
  }
  return bars;
}

module.exports = { DEFAULT_SEED, simulatedPrice, getSimulatedQuote, getSimulatedBars };
