import { ExchangeClient, HttpTransport, SubscriptionClient, WebSocketTransport } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { CFG } from '../config.js';
import type { HlBook, HlTrade, AssetMeta } from '../feeds/hyperliquid.js';
import type { Side } from '../strategy/decide.js';
import { log } from '../bus.js';

export type Fill = {
  ts: number; mode: 'shadow' | 'live'; coin: string; side: Side; sz: number; px: number;
  fee: number; liquidity: 'maker' | 'taker'; reason: string; edgeBps: number; oid?: number | string;
};

export interface Executor {
  readonly mode: 'shadow' | 'live';
  onMakerFill: (f: Fill) => void;
  ready(meta: Map<string, AssetMeta>): Promise<void>;
  take(coin: string, side: Side, sz: number, limitPx: number, reduceOnly: boolean, reason: string, edgeBps: number): Promise<Fill | null>;
  make(coin: string, side: Side, sz: number, px: number, edgeBps: number): Promise<number | string | null>;
  cancel(coin: string, oid: number | string): Promise<void>;
  /** shadow only: drive maker fill simulation from live prints/books */
  onTrade?(t: HlTrade): void;
  onBook?(b: HlBook): void;
}

/**
 * SHADOW: no orders. Taker = walk the live Hyperliquid book after CFG.shadowLatencyMs.
 * Maker = resting virtual order filled only when a real print trades THROUGH its price
 * (or the opposite side crosses it). Conservative on queue position, blind to adverse selection beyond that.
 */
export class ShadowExecutor implements Executor {
  readonly mode = 'shadow' as const;
  onMakerFill: (f: Fill) => void = () => {};
  private orders = new Map<string, { oid: string; coin: string; side: Side; sz: number; px: number; edgeBps: number }>();
  private seq = 0;
  constructor(private books: Map<string, HlBook>) {}
  async ready() {}

  async take(coin: string, side: Side, sz: number, limitPx: number, _ro: boolean, reason: string, edgeBps: number): Promise<Fill | null> {
    await new Promise(r => setTimeout(r, CFG.shadowLatencyMs));
    const b = this.books.get(coin);
    if (!b) return null;
    const levels = side === 'buy' ? b.asks : b.bids;
    let left = sz, filled = 0, notional = 0;
    for (const l of levels) {
      if (side === 'buy' ? l.price > limitPx : l.price < limitPx) break;
      const q = Math.min(l.size, left);
      filled += q; notional += q * l.price; left -= q;
      if (left <= 1e-12) break;
    }
    if (filled <= 0) return null;
    return { ts: Date.now(), mode: 'shadow', coin, side, sz: filled, px: notional / filled, fee: notional * CFG.takerFeeBps / 1e4, liquidity: 'taker', reason, edgeBps };
  }

  async make(coin: string, side: Side, sz: number, px: number, edgeBps: number) {
    const b = this.books.get(coin);
    // ALO semantics: reject if it would cross
    if (b && (side === 'buy' ? b.asks[0] && px >= b.asks[0].price : b.bids[0] && px <= b.bids[0].price)) return null;
    const oid = `s${++this.seq}`;
    this.orders.set(oid, { oid, coin, side, sz, px, edgeBps });
    return oid;
  }

  async cancel(_coin: string, oid: number | string) { this.orders.delete(String(oid)); }

  private fill(o: { oid: string; coin: string; side: Side; sz: number; px: number; edgeBps: number }) {
    this.orders.delete(o.oid);
    this.onMakerFill({ ts: Date.now(), mode: 'shadow', coin: o.coin, side: o.side, sz: o.sz, px: o.px, fee: o.sz * o.px * CFG.makerFeeBps / 1e4, liquidity: 'maker', reason: 'entry', edgeBps: o.edgeBps, oid: o.oid });
  }

  onTrade(t: HlTrade) {
    for (const o of [...this.orders.values()]) {
      if (o.coin !== t.coin) continue;
      // Maker fills ONLY on a real trade printing STRICTLY THROUGH our price with the opposite
      // aggressor direction. No book-touch, no exact-level (queue position) inference.
      // resting buy at p fills if a sell-aggressor prints strictly < p.
      // resting sell at p fills if a buy-aggressor prints strictly > p.
      if (o.side === 'buy' && t.side === 'A' && t.px < o.px) this.fill(o);
      else if (o.side === 'sell' && t.side === 'B' && t.px > o.px) this.fill(o);
    }
  }
  onBook(b: HlBook) {
    // Book touch alone does NOT fill a maker order. Per user spec, maker fills count only when a real trade goes through the quoted price.
  }
}

/** LIVE via @nktkas/hyperliquid. Use an API (agent) wallet key; it can trade but cannot withdraw. */
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;
  onMakerFill: (f: Fill) => void = () => {};
  private ex!: ExchangeClient;
  private meta!: Map<string, AssetMeta>;
  private resting = new Map<number, { coin: string; side: Side; edgeBps: number }>();

  async ready(meta: Map<string, AssetMeta>) {
    this.meta = meta;
    const wallet = privateKeyToAccount(CFG.agentKey!);
    this.ex = new ExchangeClient({ transport: new HttpTransport(), wallet });
    for (const c of CFG.coins) {
      const m = meta.get(c); if (!m) continue;
      await this.ex.updateLeverage({ asset: m.index, isCross: true, leverage: Math.min(CFG.leverage, m.maxLeverage) });
    }
    const subs = new SubscriptionClient({ transport: new WebSocketTransport() });
    await subs.userFills({ user: CFG.account! }, (d: any) => {
      if (d.isSnapshot) return;
      for (const f of d.fills ?? []) {
        const r = this.resting.get(Number(f.oid));
        if (!r || f.crossed) continue; // taker fills are booked from the order response
        this.onMakerFill({ ts: Number(f.time), mode: 'live', coin: f.coin, side: f.side === 'B' ? 'buy' : 'sell', sz: Number(f.sz), px: Number(f.px), fee: Number(f.fee), liquidity: 'maker', reason: 'entry', edgeBps: r.edgeBps, oid: f.oid });
      }
    });
    log('info', 'exec', `LIVE ready account=${CFG.account} agent=${wallet.address}`);
  }

  private asset(coin: string) { const m = this.meta.get(coin); if (!m) throw new Error(`no meta for ${coin}`); return m; }

  async take(coin: string, side: Side, sz: number, limitPx: number, reduceOnly: boolean, reason: string, edgeBps: number): Promise<Fill | null> {
    const m = this.asset(coin);
    try {
      const r: any = await this.ex.order({ orders: [{ a: m.index, b: side === 'buy', p: String(limitPx), s: String(sz), r: reduceOnly, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' });
      const st = r.response.data.statuses[0];
      if (!st?.filled) return null;
      const fsz = Number(st.filled.totalSz), px = Number(st.filled.avgPx);
      return { ts: Date.now(), mode: 'live', coin, side, sz: fsz, px, fee: fsz * px * CFG.takerFeeBps / 1e4, liquidity: 'taker', reason, edgeBps, oid: st.filled.oid };
    } catch (e: any) { log('warn', 'exec', `${coin} IOC ${side} ${sz}@${limitPx}: ${e?.message}`); return null; }
  }

  async make(coin: string, side: Side, sz: number, px: number, edgeBps: number) {
    const m = this.asset(coin);
    try {
      const r: any = await this.ex.order({ orders: [{ a: m.index, b: side === 'buy', p: String(px), s: String(sz), r: false, t: { limit: { tif: 'Alo' } } }], grouping: 'na' });
      const st = r.response.data.statuses[0];
      if (st?.resting) { this.resting.set(st.resting.oid, { coin, side, edgeBps }); return st.resting.oid; }
      return null;
    } catch (e: any) { log('warn', 'exec', `${coin} ALO ${side}: ${e?.message}`); return null; }
  }

  async cancel(coin: string, oid: number | string) {
    try { await this.ex.cancel({ cancels: [{ a: this.asset(coin).index, o: Number(oid) }] }); }
    // keep `resting` entry: a fill can race the cancel and must still be booked
    catch (e: any) { log('warn', 'exec', `cancel ${coin} ${oid}: ${e?.message}`); }
    if (this.resting.size > 5000) this.resting.delete(this.resting.keys().next().value!);
  }
}
