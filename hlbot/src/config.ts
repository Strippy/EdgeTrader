import 'dotenv/config';

const num = (k: string, d: number) => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${k} must be a number, got "${v}"`);
  return n;
};
const list = (k: string, d: string) => (process.env[k] ?? d).split(',').map(s => s.trim()).filter(Boolean);

export type Mode = 'shadow' | 'live';

/**
 * Signal source for the reference/leading price.
 * 'binance' — original cross-venue lead-lag (Binance perp leads Hyperliquid).
 * 'hl'      — Hyperliquid-only experimental: anchor is HL's own mid, momentum/flow from HL trade tape.
 *             No external reference; lead-lag is not applicable. Live execution is force-disabled.
 */
export type SignalSource = 'binance' | 'hl';

export const CFG = {
  mode: (process.env.MODE ?? 'shadow') as Mode,
  signalSource: (process.env.SIGNAL_SOURCE ?? 'binance') as SignalSource,
  liveConfirm: process.env.LIVE_CONFIRM === 'I_UNDERSTAND_REAL_MONEY',
  /** Hyperliquid perp coin names; Binance symbol = lowercase + "usdt". */
  coins: list('COINS', 'BTC,ETH,SOL,XRP').map(c => c.toUpperCase()),
  port: num('PORT', 8788),

  // --- fees (Hyperliquid perps base tier, bps) ---
  takerFeeBps: num('TAKER_FEE_BPS', 4.5),
  makerFeeBps: num('MAKER_FEE_BPS', 1.5),
  /** Fee assumed for the exit leg when deciding an entry (exits are IOC → taker). */
  exitFeeBps: num('EXIT_FEE_BPS', 4.5),

  // --- signal thresholds (bps of mid, AFTER entry + exit fees) ---
  takeEdgeBps: num('TAKE_EDGE_BPS', 3),
  makeEdgeBps: num('MAKE_EDGE_BPS', 1.5),
  exitEdgeBps: num('EXIT_EDGE_BPS', 0),     // exit when remaining edge of holding drops below this
  horizonSec: num('HORIZON_SEC', 10),       // how far ahead the fair value projects drift

  // --- sizing / risk ---
  clipUsd: num('CLIP_USD', 200),
  maxPosUsd: num('MAX_POS_USD', 1000),      // per coin
  maxGrossUsd: num('MAX_GROSS_USD', 3000),
  minOrderUsd: num('MIN_ORDER_USD', 10),    // Hyperliquid minimum order value
  maxHoldSec: num('MAX_HOLD_SEC', 90),
  stopBps: num('STOP_BPS', 25),
  dailyLossLimit: num('DAILY_LOSS_LIMIT', 300),
  cooldownMs: num('COOLDOWN_MS', 750),
  makerTtlMs: num('MAKER_TTL_MS', 4000),
  leverage: num('LEVERAGE', 3),

  // --- staleness ---
  /** Binance reference staleness. Default 1500 for the original Binance-feed design; 5000 for
   *  Hyperliquid-only (HL per-coin trade cadence is much lower). Set via env, not per-mode, so
   *  that mixing modes doesn't silently change risk behaviour. */
  staleSpotMs: num('STALE_SPOT_MS', (process.env.SIGNAL_SOURCE === 'hl' ? 5000 : 1500)),
  staleBookMs: num('STALE_BOOK_MS', 2_000), // fast l2Book = 5 levels @ 0.5s; 4 missed updates = stale

  // --- model (shared with stats.ts) ---
  volHalfLifeFast: num('VOL_HL_FAST', 60),
  volHalfLifeSlow: num('VOL_HL_SLOW', 900),
  volFloorBps: num('VOL_FLOOR_BPS', 0.6),
  momWeight: num('MOM_WEIGHT', 0.35),
  accelWeight: num('ACCEL_WEIGHT', 0.15),
  momHorizonSec: num('MOM_HORIZON_SEC', 30),
  ofiWeightBps: num('OFI_WEIGHT_BPS', 1.0),   // bps shift per unit of 10s Binance perp flow imbalance
  basisHalfLife: num('BASIS_HL', 60),         // slow HL-vs-Binance basis; fast moves show up as edge

  // --- shadow realism ---
  shadowLatencyMs: num('SHADOW_LATENCY_MS', 120),

  // --- live credentials (use an API/agent wallet, not your main key) ---
  agentKey: process.env.HL_AGENT_PRIVATE_KEY as `0x${string}` | undefined,
  account: process.env.HL_ACCOUNT_ADDRESS as `0x${string}` | undefined,
};

export function assertConfig() {
  if (CFG.mode !== 'shadow' && CFG.mode !== 'live') throw new Error('MODE must be shadow|live');
  if (CFG.signalSource !== 'binance' && CFG.signalSource !== 'hl') throw new Error('SIGNAL_SOURCE must be binance|hl');
  if (CFG.signalSource === 'hl' && CFG.mode === 'live')
    throw new Error('SIGNAL_SOURCE=hl is experimental: live execution is not permitted in this mode');
  if (CFG.mode === 'live') {
    if (!CFG.liveConfirm) throw new Error('Live mode needs LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY');
    if (!CFG.agentKey || !CFG.account) throw new Error('Live mode needs HL_AGENT_PRIVATE_KEY and HL_ACCOUNT_ADDRESS');
  }
}
