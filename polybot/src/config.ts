import 'dotenv/config';

const num = (k: string, d: number) => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${k} must be a number, got "${v}"`);
  return n;
};
const list = (k: string, d: string) => (process.env[k] ?? d).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export type Mode = 'shadow' | 'live';
export type Timeframe = '5m' | '15m';
export const TF_SECONDS: Record<Timeframe, number> = { '5m': 300, '15m': 900 };

/** Chainlink TWAP window used for both price-to-beat and settlement (Polymarket changelog, Aug 7 / Aug 14 2026). */
export const TWAP_WINDOW_SEC = num('TWAP_WINDOW_SEC', 60);

export const CFG = {
  mode: (process.env.MODE ?? 'shadow') as Mode,
  liveConfirm: process.env.LIVE_CONFIRM === 'I_UNDERSTAND_REAL_MONEY',
  assets: list('ASSETS', 'btc,eth,sol,xrp'),
  timeframes: list('TIMEFRAMES', '5m,15m') as Timeframe[],
  port: num('PORT', 8787),

  // --- sizing / risk ---
  clipUsd: num('CLIP_USD', 25),            // base order notional
  maxClipMult: num('MAX_CLIP_MULT', 3),    // clip scales with edge up to this multiple
  maxMarketUsd: num('MAX_MARKET_USD', 300),// total spend cap per market window
  maxNetShares: num('MAX_NET_SHARES', 400),// |up - down| cap per market
  dailyLossLimit: num('DAILY_LOSS_LIMIT', 500),
  cooldownMs: num('COOLDOWN_MS', 1200),

  // --- signal thresholds (in $ per share, after taker fee) ---
  minEdge: num('MIN_EDGE', 0.025),         // to ADD directional exposure
  hedgeEdge: num('HEDGE_EDGE', 0.0),       // to buy the side that REDUCES net exposure
  pairTarget: num('PAIR_TARGET', 0.985),   // complete sets if avgCost(held) + allInCost(other) <= this
  maxSlip: num('MAX_SLIP', 0.02),          // max levels walked above best ask

  // --- timing guards ---
  minSecFromOpen: num('MIN_SEC_FROM_OPEN', 2),
  noNewRiskLastSec: num('NO_NEW_RISK_LAST_SEC', 15),
  noTradeLastSec: num('NO_TRADE_LAST_SEC', 3),
  staleSpotMs: num('STALE_SPOT_MS', 1500),
  staleBookMs: num('STALE_BOOK_MS', 5000),

  // --- model ---
  volHalfLifeFast: num('VOL_HL_FAST', 60),     // seconds
  volHalfLifeSlow: num('VOL_HL_SLOW', 900),
  volFloorBps: num('VOL_FLOOR_BPS', 0.6),      // per-second sigma floor, basis points
  momWeight: num('MOM_WEIGHT', 0.35),          // shrink on 15s momentum drift
  accelWeight: num('ACCEL_WEIGHT', 0.15),
  momHorizonSec: num('MOM_HORIZON_SEC', 30),   // drift is assumed to persist this long, max
  ofiWeight: num('OFI_WEIGHT', 0.15),          // z-shift per unit of 10s signed-flow imbalance
  basisHalfLife: num('BASIS_HL', 30),

  /** Trade without a Chainlink basis (Binance USDT price vs USD settlement). Off by default: the USDT/USD basis is the same order as a minute of BTC noise. */
  allowNoChainlink: process.env.ALLOW_NO_CHAINLINK === '1',

  // --- shadow execution realism ---
  shadowLatencyMs: num('SHADOW_LATENCY_MS', 250), // network + Polymarket taker delay (150ms as of Sep 4 2026)

  // --- credentials (live, and/or Chainlink reference stream) ---
  signerKey: process.env.SIGNER_PRIVATE_KEY as `0x${string}` | undefined,
  wallet: process.env.POLYMARKET_WALLET_ADDRESS as `0x${string}` | undefined,
  relayerKey: process.env.POLYMARKET_RELAYER_API_KEY,
  relayerKeyAddress: process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS,
  builderCode: process.env.POLYMARKET_BUILDER_CODE,
};

export function assertConfig() {
  if (CFG.mode !== 'shadow' && CFG.mode !== 'live') throw new Error(`MODE must be shadow|live`);
  for (const tf of CFG.timeframes) if (!(tf in TF_SECONDS)) throw new Error(`Unsupported timeframe ${tf}`);
  if (CFG.mode === 'live') {
    if (!CFG.liveConfirm) throw new Error('Live mode needs LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY');
    if (!CFG.signerKey || !CFG.wallet) throw new Error('Live mode needs SIGNER_PRIVATE_KEY and POLYMARKET_WALLET_ADDRESS');
  }
}
