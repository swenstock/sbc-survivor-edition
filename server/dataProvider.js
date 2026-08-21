// Market data layer — pluggable by design.
//
// DEMO mode is deterministic and driven by the shared SBC Test Clock:
// same symbol + same simulated time => same quote. That means QA can jump
// to Monday open, Friday close, Degen Hours, etc. and reproduce bugs exactly.
// LIVE mode remains a separate provider slot for a licensed vendor later.

const testClock = require('./testClock');
const { getSimulatedQuote, simulatedPrice } = require('./simulatedQuoteEngine');

const MIN_MARKET_CAP = 2_000_000_000;

const SYMBOLS = {
  AAPL: { name: "Apple Inc.", exchange: "NASDAQ", currency: "USD", base: 231.4, marketCap: 3_600_000_000_000 },
  MSFT: { name: "Microsoft Corp.", exchange: "NASDAQ", currency: "USD", base: 512.9, marketCap: 3_800_000_000_000 },
  NVDA: { name: "NVIDIA Corp.", exchange: "NASDAQ", currency: "USD", base: 220.3, marketCap: 5_400_000_000_000 },
  TSLA: { name: "Tesla Inc.", exchange: "NASDAQ", currency: "USD", base: 332.9, marketCap: 1_050_000_000_000 },
  AMZN: { name: "Amazon.com Inc.", exchange: "NASDAQ", currency: "USD", base: 272.5, marketCap: 2_900_000_000_000 },
  GOOGL: { name: "Alphabet Inc.", exchange: "NASDAQ", currency: "USD", base: 345.1, marketCap: 2_100_000_000_000 },
  HOOD: { name: "Robinhood Markets", exchange: "NASDAQ", currency: "USD", base: 61.85, marketCap: 90_000_000_000 },
  COIN: { name: "Coinbase Global", exchange: "NASDAQ", currency: "USD", base: 288.55, marketCap: 68_000_000_000 },
  JPM: { name: "JPMorgan Chase", exchange: "NYSE", currency: "USD", base: 362.3, marketCap: 780_000_000_000 },
  WMT: { name: "Walmart Inc.", exchange: "NYSE", currency: "USD", base: 113.1, marketCap: 780_000_000_000 },
  META: { name: "Meta Platforms", exchange: "NASDAQ", currency: "USD", base: 590.2, marketCap: 1_500_000_000_000 },
  NFLX: { name: "Netflix Inc.", exchange: "NASDAQ", currency: "USD", base: 780.4, marketCap: 340_000_000_000 },
  ORCL: { name: "Oracle Corp.", exchange: "NYSE", currency: "USD", base: 168.3, marketCap: 470_000_000_000 },
  ADBE: { name: "Adobe Inc.", exchange: "NASDAQ", currency: "USD", base: 520.6, marketCap: 235_000_000_000 },
  AVGO: { name: "Broadcom Inc.", exchange: "NASDAQ", currency: "USD", base: 330.0, marketCap: 1_550_000_000_000 },
  CRM: { name: "Salesforce Inc.", exchange: "NYSE", currency: "USD", base: 330.1, marketCap: 315_000_000_000 },
  INTC: { name: "Intel Corp.", exchange: "NASDAQ", currency: "USD", base: 22.4, marketCap: 95_000_000_000 },
  AMD: { name: "Advanced Micro Devices", exchange: "NASDAQ", currency: "USD", base: 165.8, marketCap: 267_000_000_000 },
  QCOM: { name: "Qualcomm Inc.", exchange: "NASDAQ", currency: "USD", base: 168.2, marketCap: 187_000_000_000 },
  CSCO: { name: "Cisco Systems", exchange: "NASDAQ", currency: "USD", base: 58.3, marketCap: 232_000_000_000 },
  IBM: { name: "IBM Corp.", exchange: "NYSE", currency: "USD", base: 225.7, marketCap: 208_000_000_000 },
  UBER: { name: "Uber Technologies", exchange: "NYSE", currency: "USD", base: 72.1, marketCap: 150_000_000_000 },
  PYPL: { name: "PayPal Holdings", exchange: "NASDAQ", currency: "USD", base: 78.4, marketCap: 82_000_000_000 },
  SNOW: { name: "Snowflake Inc.", exchange: "NYSE", currency: "USD", base: 165.2, marketCap: 53_000_000_000 },
  PLTR: { name: "Palantir Technologies", exchange: "NASDAQ", currency: "USD", base: 42.6, marketCap: 95_000_000_000 },
  MSTR: { name: "Strategy Inc.", exchange: "NASDAQ", currency: "USD", base: 185.0, marketCap: 52_000_000_000 },
  BAC: { name: "Bank of America", exchange: "NYSE", currency: "USD", base: 42.3, marketCap: 325_000_000_000 },
  WFC: { name: "Wells Fargo & Co.", exchange: "NYSE", currency: "USD", base: 68.5, marketCap: 240_000_000_000 },
  GS: { name: "Goldman Sachs Group", exchange: "NYSE", currency: "USD", base: 480.9, marketCap: 155_000_000_000 },
  MS: { name: "Morgan Stanley", exchange: "NYSE", currency: "USD", base: 105.3, marketCap: 175_000_000_000 },
  V: { name: "Visa Inc.", exchange: "NYSE", currency: "USD", base: 280.4, marketCap: 590_000_000_000 },
  MA: { name: "Mastercard Inc.", exchange: "NYSE", currency: "USD", base: 480.1, marketCap: 450_000_000_000 },
  AXP: { name: "American Express", exchange: "NYSE", currency: "USD", base: 265.7, marketCap: 190_000_000_000 },
  JNJ: { name: "Johnson & Johnson", exchange: "NYSE", currency: "USD", base: 155.2, marketCap: 375_000_000_000 },
  PFE: { name: "Pfizer Inc.", exchange: "NYSE", currency: "USD", base: 27.1, marketCap: 155_000_000_000 },
  UNH: { name: "UnitedHealth Group", exchange: "NYSE", currency: "USD", base: 560.8, marketCap: 515_000_000_000 },
  ABBV: { name: "AbbVie Inc.", exchange: "NYSE", currency: "USD", base: 175.4, marketCap: 310_000_000_000 },
  MRK: { name: "Merck & Co.", exchange: "NYSE", currency: "USD", base: 105.6, marketCap: 265_000_000_000 },
  LLY: { name: "Eli Lilly and Co.", exchange: "NYSE", currency: "USD", base: 780.3, marketCap: 740_000_000_000 },
  KO: { name: "Coca-Cola Co.", exchange: "NYSE", currency: "USD", base: 62.4, marketCap: 268_000_000_000 },
  PEP: { name: "PepsiCo Inc.", exchange: "NASDAQ", currency: "USD", base: 168.1, marketCap: 230_000_000_000 },
  MCD: { name: "McDonald's Corp.", exchange: "NYSE", currency: "USD", base: 295.3, marketCap: 215_000_000_000 },
  SBUX: { name: "Starbucks Corp.", exchange: "NASDAQ", currency: "USD", base: 95.2, marketCap: 108_000_000_000 },
  NKE: { name: "Nike Inc.", exchange: "NYSE", currency: "USD", base: 78.6, marketCap: 118_000_000_000 },
  DIS: { name: "Walt Disney Co.", exchange: "NYSE", currency: "USD", base: 92.4, marketCap: 168_000_000_000 },
  COST: { name: "Costco Wholesale", exchange: "NASDAQ", currency: "USD", base: 890.5, marketCap: 395_000_000_000 },
  TGT: { name: "Target Corp.", exchange: "NYSE", currency: "USD", base: 148.2, marketCap: 68_000_000_000 },
  HD: { name: "Home Depot Inc.", exchange: "NYSE", currency: "USD", base: 385.6, marketCap: 385_000_000_000 },
  LOW: { name: "Lowe's Companies", exchange: "NYSE", currency: "USD", base: 260.3, marketCap: 150_000_000_000 },
  XOM: { name: "Exxon Mobil Corp.", exchange: "NYSE", currency: "USD", base: 112.4, marketCap: 460_000_000_000 },
  CVX: { name: "Chevron Corp.", exchange: "NYSE", currency: "USD", base: 155.7, marketCap: 290_000_000_000 },
  BA: { name: "Boeing Co.", exchange: "NYSE", currency: "USD", base: 178.3, marketCap: 105_000_000_000 },
  CAT: { name: "Caterpillar Inc.", exchange: "NYSE", currency: "USD", base: 355.2, marketCap: 175_000_000_000 },
  GE: { name: "General Electric", exchange: "NYSE", currency: "USD", base: 175.6, marketCap: 195_000_000_000 },
  F: { name: "Ford Motor Co.", exchange: "NYSE", currency: "USD", base: 11.2, marketCap: 44_000_000_000 },
  GM: { name: "General Motors", exchange: "NYSE", currency: "USD", base: 47.3, marketCap: 55_000_000_000 },
  TSM: { name: "Taiwan Semiconductor Manufacturing", exchange: "NYSE", currency: "USD", base: 250.0, marketCap: 1_300_000_000_000 },
  T: { name: "AT&T Inc.", exchange: "NYSE", currency: "USD", base: 21.4, marketCap: 150_000_000_000 },
  VZ: { name: "Verizon Communications", exchange: "NYSE", currency: "USD", base: 40.2, marketCap: 170_000_000_000 },
  // Added for sector coverage (energy/materials/utilities had none) - the
  // knockout game needed these, but real symbol coverage benefits the main
  // trading contests too, not just this one feature.
  UPS: { name: "United Parcel Service", exchange: "NYSE", currency: "USD", base: 115.0, marketCap: 95_000_000_000 },
  MRNA: { name: "Moderna Inc.", exchange: "NASDAQ", currency: "USD", base: 28.0, marketCap: 10_500_000_000 },
  SLB: { name: "Schlumberger Ltd.", exchange: "NYSE", currency: "USD", base: 38.0, marketCap: 53_000_000_000 },
  OXY: { name: "Occidental Petroleum", exchange: "NYSE", currency: "USD", base: 48.0, marketCap: 44_000_000_000 },
  LIN: { name: "Linde plc", exchange: "NASDAQ", currency: "USD", base: 425.0, marketCap: 198_000_000_000 },
  NEM: { name: "Newmont Corp.", exchange: "NYSE", currency: "USD", base: 105.0, marketCap: 114_000_000_000 },
  DOW: { name: "Dow Inc.", exchange: "NYSE", currency: "USD", base: 28.0, marketCap: 20_000_000_000 },
  FCX: { name: "Freeport-McMoRan", exchange: "NYSE", currency: "USD", base: 42.0, marketCap: 60_000_000_000 },
  NEE: { name: "NextEra Energy", exchange: "NYSE", currency: "USD", base: 72.0, marketCap: 148_000_000_000 },
  DUK: { name: "Duke Energy Corp.", exchange: "NYSE", currency: "USD", base: 115.0, marketCap: 90_000_000_000 },
  SO: { name: "Southern Co.", exchange: "NYSE", currency: "USD", base: 92.0, marketCap: 100_000_000_000 },
  AEP: { name: "American Electric Power", exchange: "NASDAQ", currency: "USD", base: 105.0, marketCap: 56_000_000_000 },
};

const LOGO_DOMAINS = {
  AAPL: "apple.com", MSFT: "microsoft.com", NVDA: "nvidia.com", TSLA: "tesla.com",
  AMZN: "amazon.com", GOOGL: "abc.xyz", HOOD: "robinhood.com", COIN: "coinbase.com",
  JPM: "jpmorganchase.com", WMT: "walmart.com", META: "meta.com", NFLX: "netflix.com",
  ORCL: "oracle.com", ADBE: "adobe.com", AVGO: "broadcom.com", CRM: "salesforce.com", INTC: "intel.com",
  AMD: "amd.com", QCOM: "qualcomm.com", CSCO: "cisco.com", IBM: "ibm.com",
  UBER: "uber.com", PYPL: "paypal.com", SNOW: "snowflake.com", PLTR: "palantir.com", MSTR: "strategy.com",
  BAC: "bankofamerica.com", WFC: "wellsfargo.com", GS: "goldmansachs.com", MS: "morganstanley.com",
  V: "visa.com", MA: "mastercard.com", AXP: "americanexpress.com", JNJ: "jnj.com",
  PFE: "pfizer.com", UNH: "unitedhealthgroup.com", ABBV: "abbvie.com", MRK: "merck.com",
  LLY: "lilly.com", KO: "coca-cola.com", PEP: "pepsico.com", MCD: "mcdonalds.com",
  SBUX: "starbucks.com", NKE: "nike.com", DIS: "disney.com", COST: "costco.com",
  TGT: "target.com", HD: "homedepot.com", LOW: "lowes.com", XOM: "exxonmobil.com",
  CVX: "chevron.com", BA: "boeing.com", CAT: "caterpillar.com", GE: "ge.com",
  F: "ford.com", GM: "gm.com", TSM: "tsmc.com", T: "att.com", VZ: "verizon.com",
};

function listSymbols() {
  return Object.entries(SYMBOLS).map(([symbol, s]) => ({
    symbol, name: s.name, exchange: s.exchange, currency: s.currency,
    marketCap: s.marketCap,
    logoUrl: LOGO_DOMAINS[symbol] ? `https://logo.clearbit.com/${LOGO_DOMAINS[symbol]}` : null,
  }));
}

function demoQuote(symbol) {
  const key = String(symbol || '').toUpperCase();
  const meta = SYMBOLS[key];
  if (!meta) return null;
  const now = testClock.getNow();
  const quote = getSimulatedQuote({ ...meta, symbol: key }, now);
  // Lightweight session high/low approximation for existing screens. Full
  // chart candles come from simulatedQuoteEngine.getSimulatedBars().
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const earlier = simulatedPrice(key, meta.base, hourAgo);
  quote.sessionHigh = Number(Math.max(meta.base, earlier, quote.price).toFixed(2));
  quote.sessionLow = Number(Math.min(meta.base, earlier, quote.price).toFixed(2));
  return quote;
}

function getQuotes(symbols) {
  return symbols.map(demoQuote).filter(Boolean);
}

function getQuote(symbol) {
  return demoQuote(symbol);
}

// LIVE provider remains intentionally separate. No production screen should
// ever label simulated data as live; setting MARKET_DATA_PROVIDER=live without
// a real vendor fails loudly instead of silently falling back to fake prices.
const MARKET_DATA_PROVIDER = process.env.MARKET_DATA_PROVIDER || 'demo';

let provider;
if (MARKET_DATA_PROVIDER === 'demo') {
  provider = { listSymbols, getQuotes, getQuote, SYMBOLS, MIN_MARKET_CAP, source: 'sim' };
} else if (MARKET_DATA_PROVIDER === 'live') {
  const notImplemented = () => {
    throw new Error('MARKET_DATA_PROVIDER=live is set, but no licensed live market data vendor is connected yet.');
  };
  provider = { listSymbols: notImplemented, getQuotes: notImplemented, getQuote: notImplemented, SYMBOLS: {}, MIN_MARKET_CAP, source: 'live-unconfigured' };
} else {
  throw new Error(`Unknown MARKET_DATA_PROVIDER: ${MARKET_DATA_PROVIDER}`);
}

module.exports = provider;
