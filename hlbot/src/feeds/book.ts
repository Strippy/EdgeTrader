export type Level = { price: number; size: number };

/** L2 book for one outcome asset, maintained from CLOB `book` snapshots + `price_change` deltas. */
export class Book {
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  ts = 0;        // local receive time of last update
  tick = 0.01;

  snapshot(bids: { price: string; size: string }[], asks: { price: string; size: string }[]) {
    this.bids.clear(); this.asks.clear();
    for (const l of bids) this.set('BUY', Number(l.price), Number(l.size));
    for (const l of asks) this.set('SELL', Number(l.price), Number(l.size));
    this.ts = Date.now();
  }

  set(side: 'BUY' | 'SELL', price: number, size: number) {
    const m = side === 'BUY' ? this.bids : this.asks;
    const p = round6(price);
    if (!(size > 0)) m.delete(p); else m.set(p, size);
    this.ts = Date.now();
  }

  askLevels(): Level[] { return [...this.asks].map(([price, size]) => ({ price, size })).sort((a, b) => a.price - b.price); }
  bidLevels(): Level[] { return [...this.bids].map(([price, size]) => ({ price, size })).sort((a, b) => b.price - a.price); }
  bestAsk(): Level | null { let b: Level | null = null; for (const [price, size] of this.asks) if (!b || price < b.price) b = { price, size }; return b; }
  bestBid(): Level | null { let b: Level | null = null; for (const [price, size] of this.bids) if (!b || price > b.price) b = { price, size }; return b; }
}

export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Walk asks to spend up to `usd` (pre-fee notional) without paying more than `maxPrice`.
 * Returns shares bought, notional spent, VWAP and the worst level touched. Pure; book unchanged.
 */
export function walkAsks(levels: Level[], usd: number, maxPrice: number) {
  let left = usd, shares = 0, spent = 0, worst = 0;
  for (const l of levels) {
    if (l.price > maxPrice + 1e-9 || left <= 1e-9) break;
    const cap = l.price * l.size;
    const take = Math.min(cap, left);
    shares += take / l.price; spent += take; left -= take; worst = l.price;
  }
  return { shares, spent, vwap: shares > 0 ? spent / shares : 0, worst };
}
