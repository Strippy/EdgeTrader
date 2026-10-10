import { OrderSide, OrderType } from '@polymarket/client';
import { CFG } from '../config.js';
import { walkAsks, type Book } from '../feeds/book.js';
import { feePerShare } from '../model/fair.js';
import type { MarketInfo } from '../markets/discovery.js';
import type { Intent } from '../strategy/decide.js';
import { secureClient, geoblock } from '../poly.js';
import { log } from '../bus.js';

export type Fill = {
  ts: number; mode: 'shadow' | 'live'; slug: string; asset: string; tf: string;
  side: 'up' | 'down'; reason: string; shares: number; price: number; notional: number; fee: number;
  pModel: number; edge: number; orderId?: string; status?: string;
};

export interface Executor {
  readonly mode: 'shadow' | 'live';
  ready(): Promise<void>;
  buy(m: MarketInfo, book: Book, it: Intent): Promise<Fill | null>;
}

/**
 * SHADOW: no orders sent. After CFG.shadowLatencyMs (network + Polymarket taker delay) it walks the
 * *live* order book with the same FAK limits a real order would carry. Real prices, hypothetical fills;
 * it cannot model queue competition, so treat results as an optimistic upper bound.
 */
export class ShadowExecutor implements Executor {
  readonly mode = 'shadow' as const;
  /** Liquidity our hypothetical fills already took, per book level, until that level's size changes. */
  private taken = new WeakMap<Book, Map<number, { sizeAtFill: number; shares: number; ts: number }>>();
  async ready() {}
  async buy(m: MarketInfo, book: Book, it: Intent): Promise<Fill | null> {
    await new Promise(r => setTimeout(r, CFG.shadowLatencyMs));
    const now = Date.now();
    const used = this.taken.get(book) ?? new Map();
    this.taken.set(book, used);
    const levels = book.askLevels().map(l => {
      const u = used.get(l.price);
      return u && u.sizeAtFill === l.size && now - u.ts < 10_000 ? { price: l.price, size: Math.max(0, l.size - u.shares) } : l;
    });
    const w = walkAsks(levels, it.usd, it.maxPrice);
    if (w.shares < m.minSize) return null;
    // record what we consumed so the same displayed size can't be "filled" twice
    let left = w.shares;
    for (const l of book.askLevels()) {
      if (left <= 1e-9 || l.price > w.worst + 1e-9) break;
      const lv = levels.find(x => x.price === l.price)!;
      const take = Math.min(lv.size, left);
      if (take <= 0) continue;
      const prev = used.get(l.price);
      const base = prev && prev.sizeAtFill === l.size && now - prev.ts < 10_000 ? prev.shares : 0;
      used.set(l.price, { sizeAtFill: l.size, shares: base + take, ts: now });
      left -= take;
    }
    const fee = feePerShare(w.vwap, m.fees) * w.shares;
    return {
      ts: Date.now(), mode: 'shadow', slug: m.slug, asset: m.asset, tf: m.tf, side: it.side, reason: it.reason,
      shares: w.shares, price: w.vwap, notional: w.spent, fee, pModel: it.p, edge: it.edge,
    };
  }
}

/** LIVE: FAK market buy with maxPrice protection and an all-in maxSpend cap, via @polymarket/client. */
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;
  private client: any;

  async ready() {
    const g = await geoblock();
    if (g.blocked) {
      throw new Error(`Polymarket geoblock reports this connection as blocked (country=${g.country}, region=${g.region}). Live trading refused. Shadow mode still works.`);
    }
    this.client = await secureClient();
    if (!this.client) throw new Error('No secure client');
    await this.client.setupTradingApprovals();
    log('info', 'exec', `LIVE ready, wallet=${this.client.account?.wallet ?? CFG.wallet}, geo=${g.country}/${g.region}`);
  }

  async buy(m: MarketInfo, _book: Book, it: Intent): Promise<Fill | null> {
    const assetId = it.side === 'up' ? m.upId : m.downId;
    const maxSpend = (it.usd + feePerShare(it.maxPrice, m.fees) * it.estShares).toFixed(2); // notional + taker fee at worst level
    const req: any = {
      assetId, side: OrderSide.BUY, amount: it.usd.toFixed(2), maxPrice: it.maxPrice.toFixed(4), maxSpend,
      orderType: OrderType.FAK, ...(CFG.builderCode ? { builderCode: CFG.builderCode } : {}),
    };
    const res = await this.client.placeMarketOrder(req);
    if (!res.ok) { log('warn', 'exec', `${m.slug} ${it.side} rejected ${res.code}: ${res.message}`); return null; }
    let shares = Number(res.takingAmount), notional = Number(res.makingAmount);
    if (res.status === 'delayed' || !(shares > 0)) {
      // Taker-delay markets: poll the order until matched or dead.
      for (let k = 0; k < 6 && !(shares > 0); k++) {
        await new Promise(r => setTimeout(r, 400));
        try {
          const o = await this.client.fetchOrder({ orderId: res.orderId });
          const matched = Number(o.sizeMatched);
          if (matched > 0) { shares = matched; notional = matched * Number(o.price); } // price = limit → upper bound
          if (o.status && !/live|delayed/i.test(o.status)) break;
        } catch (e: any) { log('warn', 'exec', `fetchOrder ${res.orderId}: ${e?.message}`); }
      }
    }
    if (!(shares > 0)) { log('info', 'exec', `${m.slug} ${it.side} FAK no fill (${res.status})`); return null; }
    const vwap = notional / shares;
    return {
      ts: Date.now(), mode: 'live', slug: m.slug, asset: m.asset, tf: m.tf, side: it.side, reason: it.reason,
      shares, price: vwap, notional, fee: feePerShare(vwap, m.fees) * shares, pModel: it.p, edge: it.edge,
      orderId: res.orderId, status: res.status,
    };
  }

  async redeem(conditionId: string) {
    const h = await this.client.redeemPositions({ conditionId });
    const o = await h.wait();
    return o.transactionHash as string;
  }
}
