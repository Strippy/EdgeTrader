import { ReconnectingWS } from './ws.js';
import { bus } from '../bus.js';

export type Venue = 'spot' | 'perp';
export type Tick = { asset: string; venue: Venue; price: number; qty: number; ts: number; buyAggressor: boolean };

/**
 * Live Binance aggTrade streams for spot and USDⓈ-M perps.
 * aggTrade fields: s symbol, p price, q qty, T trade time, m = buyer is maker (so !m = buy aggressor).
 */
export function startBinance(assets: string[], onTick: (t: Tick) => void) {
  const streams = assets.map(a => `${a}usdt@aggTrade`).join('/');
  const handler = (venue: Venue) => (raw: string) => {
    const msg = JSON.parse(raw);
    const d = msg.data ?? msg;
    if (d.e !== 'aggTrade') return;
    const asset = String(d.s).toLowerCase().replace(/usdt$/, '');
    const t: Tick = { asset, venue, price: Number(d.p), qty: Number(d.q), ts: Number(d.T), buyAggressor: !d.m };
    if (!(t.price > 0)) return;
    bus.counts[`binance-${venue}`] = (bus.counts[`binance-${venue}`] ?? 0) + 1;
    bus.bytes += raw.length;
    onTick(t);
  };
  const spotHost = process.env.BINANCE_SPOT_WS ?? 'wss://stream.binance.com:9443';
  const perpHost = process.env.BINANCE_PERP_WS ?? 'wss://fstream.binance.com';
  const spot = new ReconnectingWS('binance-spot', () => `${spotHost}/stream?streams=${streams}`, { onMessage: handler('spot'), silenceMs: 20000 }).start();
  const perp = new ReconnectingWS('binance-perp', () => `${perpHost}/stream?streams=${streams}`, { onMessage: handler('perp'), silenceMs: 20000 }).start();
  return { spot, perp };
}
