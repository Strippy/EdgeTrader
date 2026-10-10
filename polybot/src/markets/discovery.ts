import { TF_SECONDS, type Timeframe } from '../config.js';

export type FeeSchedule = { rate: number; exponent: number; takerOnly: boolean };

export type MarketInfo = {
  slug: string;
  asset: string;
  tf: Timeframe;
  start: number;          // window start, ms
  end: number;            // window end, ms
  conditionId: string;
  version: string;
  upId: string;
  downId: string;
  tick: number;
  minSize: number;
  fees: FeeSchedule | null;
  acceptingOrders: boolean;
  closed: boolean;
  restricted: boolean;
  secondsDelay: number;
  priceToBeat: number | null;
  finalPrice: number | null;
  outcomePrices: number[] | null;
};

const GAMMA = process.env.GAMMA_API ?? 'https://gamma-api.polymarket.com';

/** Slug convention: {asset}-updown-{tf}-{windowStartEpochSec}; window = [T, T+duration). */
export function windowStart(nowMs: number, tf: Timeframe) {
  const d = TF_SECONDS[tf];
  return Math.floor(nowMs / 1000 / d) * d;
}
export const slugFor = (asset: string, tf: Timeframe, startSec: number) => `${asset}-updown-${tf}-${startSec}`;

const parseArr = (v: unknown): any[] | null => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; } }
  return null;
};
const n = (v: unknown) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/** Parse a Gamma market object (GET /markets/slug/{slug}). Field names verified against a live 15m market. */
export function parseGammaMarket(m: any, asset: string, tf: Timeframe, startSec: number): MarketInfo | null {
  const labels = parseArr(m.outcomes)?.map(String) ?? [];
  const ids = (m.version === 'v2' ? parseArr(m.positionIds) : parseArr(m.clobTokenIds))?.map(String) ?? [];
  const iu = labels.findIndex(l => l.toLowerCase() === 'up');
  const id = labels.findIndex(l => l.toLowerCase() === 'down');
  if (iu < 0 || id < 0 || !ids[iu] || !ids[id]) return null;
  const meta = m.events?.[0]?.eventMetadata ?? m.eventMetadata ?? {};
  const fs = m.feeSchedule;
  const ptb = n(meta.priceToBeat);
  const fin = n(meta.finalPrice);
  const op = parseArr(m.outcomePrices)?.map(Number) ?? null;
  return {
    slug: m.slug,
    asset, tf,
    start: startSec * 1000,
    end: (startSec + TF_SECONDS[tf]) * 1000,
    conditionId: m.conditionId,
    version: m.version ?? 'v1',
    upId: ids[iu],
    downId: ids[id],
    tick: n(m.orderPriceMinTickSize) || 0.01,
    minSize: n(m.orderMinSize) || 5,
    fees: m.feesEnabled && fs ? { rate: Number(fs.rate), exponent: Number(fs.exponent ?? 1), takerOnly: !!fs.takerOnly } : null,
    acceptingOrders: !!m.acceptingOrders,
    closed: !!m.closed,
    restricted: !!m.restricted,
    secondsDelay: n(m.secondsDelay) || 0,
    priceToBeat: Number.isFinite(ptb) ? ptb : null,
    finalPrice: Number.isFinite(fin) ? fin : null,
    outcomePrices: op && iu >= 0 ? [op[iu], op[id]] : null,
  };
}

export async function fetchMarket(asset: string, tf: Timeframe, startSec: number): Promise<MarketInfo | null> {
  const slug = slugFor(asset, tf, startSec);
  const r = await fetch(`${GAMMA}/markets/slug/${slug}`, { signal: AbortSignal.timeout(6000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`gamma ${slug} HTTP ${r.status}`);
  return parseGammaMarket(await r.json(), asset, tf, startSec);
}
