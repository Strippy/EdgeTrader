import type { Level } from '../feeds/book.js';
import { feePerShare } from '../model/fair.js';
import type { FeeSchedule } from '../markets/discovery.js';

export type Side = 'up' | 'down';
export type Leg = { shares: number; cost: number }; // cost is all-in (notional + taker fee)
export type Inventory = { up: Leg; down: Leg };
export type Reason = 'entry' | 'hedge' | 'pair';

export type DecideParams = {
  minEdge: number; hedgeEdge: number; pairTarget: number; maxSlip: number;
  clipUsd: number; maxClipMult: number; maxMarketUsd: number; maxNetShares: number;
  noNewRiskLastSec: number; noTradeLastSec: number; minSecFromOpen: number;
};

export type DecideInput = {
  pUp: number;
  asks: { up: Level[]; down: Level[] };   // ascending
  inv: Inventory;
  fees: FeeSchedule | null;
  minShares: number;
  tauSec: number;
  sinceOpenSec: number;
};

export type Intent = {
  side: Side; reason: Reason;
  usd: number;          // pre-fee notional to spend
  maxPrice: number;     // worst level allowed
  estShares: number;
  edge: number;         // p − all-in cost at best ask
  p: number;
};

export const allIn = (px: number, fees: FeeSchedule | null) => px + feePerShare(px, fees);
export const avg = (l: Leg) => (l.shares > 0 ? l.cost / l.shares : 0);

/**
 * One decision per market per evaluation. Risk-reducing buys (pair completion / reversal hedge)
 * take priority over new directional entries.
 */
export function decide(i: DecideInput, c: DecideParams): Intent | null {
  if (i.tauSec < c.noTradeLastSec || i.sinceOpenSec < c.minSecFromOpen) return null;
  const net = i.inv.up.shares - i.inv.down.shares;
  const spent = i.inv.up.cost + i.inv.down.cost;
  const out: Intent[] = [];

  for (const side of ['up', 'down'] as Side[]) {
    const levels = i.asks[side];
    if (!levels.length) continue;
    const p = side === 'up' ? i.pUp : 1 - i.pUp;
    const best = levels[0].price;
    const reducing = (side === 'down' && net > 0) || (side === 'up' && net < 0);
    const other = side === 'up' ? i.inv.down : i.inv.up;
    const otherAvg = avg(other);

    let shareCap: number, usdCap: number, reason: Reason;
    let ok: (px: number) => boolean;

    if (reducing) {
      shareCap = Math.abs(net);
      usdCap = Math.max(0, c.maxMarketUsd * 1.5 - spent);
      const pairOk = (px: number) => otherAvg > 0 && otherAvg + allIn(px, i.fees) <= c.pairTarget;
      const hedgeOk = (px: number) => p - allIn(px, i.fees) >= c.hedgeEdge;
      ok = (px) => px <= best + c.maxSlip + 1e-9 && (pairOk(px) || hedgeOk(px));
      reason = pairOk(best) ? 'pair' : 'hedge';
    } else {
      if (i.tauSec < c.noNewRiskLastSec) continue;
      const edgeBest = p - allIn(best, i.fees);
      if (edgeBest < c.minEdge) continue;
      const mult = Math.min(c.maxClipMult, Math.max(1, edgeBest / c.minEdge));
      usdCap = Math.min(c.clipUsd * mult, c.maxMarketUsd - spent);
      shareCap = c.maxNetShares - Math.abs(net);
      ok = (px) => px <= best + c.maxSlip + 1e-9 && p - allIn(px, i.fees) >= c.minEdge;
      reason = 'entry';
    }
    if (usdCap <= 0 || shareCap <= 0) continue;

    let shares = 0, usd = 0, worst = 0;
    for (const l of levels) {
      if (!ok(l.price)) break;
      const take = Math.min(l.size, shareCap - shares, (usdCap - usd) / l.price);
      if (take <= 0) break;
      shares += take; usd += take * l.price; worst = l.price;
      if (shares >= shareCap - 1e-9 || usd >= usdCap - 1e-9) break;
    }
    if (shares < i.minShares || usd < 1) continue;
    out.push({ side, reason, usd: Math.floor(usd * 100) / 100, maxPrice: worst, estShares: shares, edge: p - allIn(best, i.fees), p });
  }

  if (!out.length) return null;
  const rank = (x: Intent) => (x.reason === 'pair' ? 2 : x.reason === 'hedge' ? 1 : 0);
  out.sort((a, b) => rank(b) - rank(a) || b.edge - a.edge);
  return out[0];
}
