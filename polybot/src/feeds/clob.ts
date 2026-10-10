import { ReconnectingWS } from './ws.js';
import { Book } from './book.js';
import { bus, log } from '../bus.js';

export type TradePrint = { assetId: string; price: number; size: number; side: string; ts: number };
export type Resolution = { conditionId: string; winningAssetId: string; winningOutcome?: string };

/**
 * Polymarket CLOB market channel: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * Text `PING` every 10s (server replies `PONG`). custom_feature_enabled adds best_bid_ask / market_resolved.
 */
export class ClobFeed {
  books = new Map<string, Book>();
  private subscribed = new Set<string>();
  private ws: ReconnectingWS;
  onTrade: (t: TradePrint) => void = () => {};
  onResolved: (r: Resolution) => void = () => {};

  constructor() {
    this.ws = new ReconnectingWS('clob', () => process.env.CLOB_WS ?? 'wss://ws-subscriptions-clob.polymarket.com/ws/market', {
      heartbeat: { everyMs: 10_000, payload: 'PING' },
      silenceMs: 30_000,
      onOpen: () => {
        if (this.subscribed.size) this.ws.send(JSON.stringify({ assets_ids: [...this.subscribed], type: 'market', custom_feature_enabled: true }));
      },
      onMessage: (raw) => this.handle(raw),
    });
  }

  start() { this.ws.start(); return this; }
  get connected() { return this.ws.connected; }

  book(assetId: string) {
    let b = this.books.get(assetId);
    if (!b) { b = new Book(); this.books.set(assetId, b); }
    return b;
  }

  subscribe(ids: string[]) {
    const fresh = ids.filter(id => !this.subscribed.has(id));
    if (!fresh.length) return;
    const first = this.subscribed.size === 0;
    fresh.forEach(id => { this.subscribed.add(id); this.book(id); });
    if (!this.ws.connected) return; // onOpen sends the full set
    this.ws.send(JSON.stringify(first
      ? { assets_ids: fresh, type: 'market', custom_feature_enabled: true }
      : { assets_ids: fresh, operation: 'subscribe' }));
  }

  unsubscribe(ids: string[]) {
    const gone = ids.filter(id => this.subscribed.delete(id));
    gone.forEach(id => this.books.delete(id));
    if (gone.length && this.ws.connected) this.ws.send(JSON.stringify({ assets_ids: gone, operation: 'unsubscribe' }));
  }

  private handle(raw: string) {
    if (raw === 'PONG') return;
    bus.bytes += raw.length;
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const events: any[] = Array.isArray(msg) ? msg : [msg];
    for (const e of events) {
      bus.counts.clob = (bus.counts.clob ?? 0) + 1;
      switch (e.event_type) {
        case 'book':
          if (!this.subscribed.has(e.asset_id)) break;
          this.book(e.asset_id).snapshot(e.bids ?? [], e.asks ?? []);
          bus.wireEvent('clob', 'book', `${short(e.asset_id)} ${e.bids?.length ?? 0}b/${e.asks?.length ?? 0}a`, 0, false);
          break;
        case 'price_change':
          for (const c of e.price_changes ?? []) {
            if (!this.subscribed.has(c.asset_id)) continue;
            this.book(c.asset_id).set(c.side, Number(c.price), Number(c.size));
          }
          break;
        case 'tick_size_change':
          if (this.books.has(e.asset_id)) this.book(e.asset_id).tick = Number(e.new_tick_size);
          bus.wireEvent('clob', 'tick', `${short(e.asset_id)} tick→${e.new_tick_size}`, 0, false);
          break;
        case 'last_trade_price': {
          const t: TradePrint = { assetId: e.asset_id, price: Number(e.price), size: Number(e.size ?? 0), side: e.side, ts: Number(e.timestamp) || Date.now() };
          bus.wireEvent('clob', 'trade', `${short(e.asset_id)} ${e.side} ${t.size.toFixed(1)}@${t.price}`, 0, false);
          this.onTrade(t);
          break;
        }
        case 'market_resolved':
          bus.wireEvent('clob', 'resolved', `${short(e.market)} → ${e.winning_outcome}`, 0, false);
          if (e.winning_asset_id) this.onResolved({ conditionId: e.market, winningAssetId: e.winning_asset_id, winningOutcome: e.winning_outcome });
          break;
        case 'best_bid_ask':
        case 'new_market':
          break;
        default:
          if (e.event_type) log('warn', 'clob', `unknown event ${e.event_type}`);
      }
    }
  }
}

export const short = (id: string) => (id ? `${id.slice(0, 6)}…${id.slice(-4)}` : '?');
