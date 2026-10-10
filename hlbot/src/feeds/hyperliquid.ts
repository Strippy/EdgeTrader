import { ReconnectingWS } from './ws.js';
import { bus } from '../bus.js';
import type { Level } from './book.js';

export type HlBook = { coin: string; bids: Level[]; asks: Level[]; time: number; recvAt: number };
export type HlTrade = { coin: string; side: 'B' | 'A'; px: number; sz: number; time: number };
export type AssetMeta = { coin: string; index: number; szDecimals: number; maxLeverage: number };

const INFO = process.env.HL_INFO_URL ?? 'https://api.hyperliquid.xyz/info';

/** POST /info {"type":"meta"} → perp universe; asset index = position in `universe`. */
export async function fetchMeta(): Promise<Map<string, AssetMeta>> {
  const r = await fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'meta' }), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HL meta HTTP ${r.status}`);
  const j: any = await r.json();
  const out = new Map<string, AssetMeta>();
  (j.universe ?? []).forEach((u: any, i: number) => out.set(u.name, { coin: u.name, index: i, szDecimals: Number(u.szDecimals), maxLeverage: Number(u.maxLeverage) }));
  return out;
}

/**
 * Hyperliquid public market data: wss://api.hyperliquid.xyz/ws
 * l2Book → { coin, levels: [bids[], asks[]] (WsLevel px/sz/n), time }; trades → WsTrade[] { coin, side, px, sz, time, ... }.
 */
export class HyperliquidFeed {
  books = new Map<string, HlBook>();
  private ws: ReconnectingWS;
  onTrade: (t: HlTrade) => void = () => {};
  onBook: (b: HlBook) => void = () => {};

  /** Hyperliquid-only mode: forward each HL trade to the Tick pipeline (venue 'hl', side 'B' = buy aggressor). */
  onTradeAsTick: (t: HlTrade) => void = () => {};

  constructor(private coins: string[]) {
    this.ws = new ReconnectingWS('hyperliquid', () => process.env.HL_WS_URL ?? 'wss://api.hyperliquid.xyz/ws', {
      heartbeat: { everyMs: 20_000, payload: JSON.stringify({ method: 'ping' }) },
      silenceMs: 45_000,
      onOpen: () => {
        for (const coin of this.coins) {
          this.ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin } }));
          this.ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
        }
      },
      onMessage: (raw) => this.handle(raw),
    });
  }

  start() { this.ws.start(); return this; }
  get connected() { return this.ws.connected; }

  private handle(raw: string) {
    bus.bytes += raw.length;
    const msg = JSON.parse(raw);
    switch (msg.channel) {
      case 'l2Book': {
        const d = msg.data;
        const lv = (a: any[]): Level[] => (a ?? []).map(l => ({ price: Number(l.px), size: Number(l.sz) }));
        const b: HlBook = { coin: d.coin, bids: lv(d.levels?.[0]), asks: lv(d.levels?.[1]), time: Number(d.time), recvAt: Date.now() };
        this.books.set(d.coin, b);
        bus.counts['hl-book'] = (bus.counts['hl-book'] ?? 0) + 1;
        this.onBook(b);
        break;
      }
      case 'trades':
        for (const t of msg.data ?? []) {
          const tr: HlTrade = { coin: t.coin, side: t.side, px: Number(t.px), sz: Number(t.sz), time: Number(t.time) };
          bus.counts['hl-trades'] = (bus.counts['hl-trades'] ?? 0) + 1;
          this.onTrade(tr);
          this.onTradeAsTick(tr);
        }
        break;
      case 'subscriptionResponse':
        bus.wireEvent('hyperliquid', 'sub', `${msg.data?.subscription?.type} ${msg.data?.subscription?.coin ?? ''}`, 0, false);
        break;
      case 'pong':
        break;
      case 'error':
        bus.wireEvent('hyperliquid', 'error', String(msg.data), 0, false);
        break;
    }
  }
}

export const mid = (b?: HlBook) => (b && b.bids[0] && b.asks[0] ? (b.bids[0].price + b.asks[0].price) / 2 : NaN);
