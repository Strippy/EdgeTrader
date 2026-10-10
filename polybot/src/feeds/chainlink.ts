import { secureClient } from '../poly.js';
import { bus, log } from '../bus.js';

export type RefPoint = { ts: number; value: number };

/**
 * Chainlink reference prices via PolyBolt (authenticated): `prices.crypto` (spot, Chainlink default)
 * and `prices.crypto.twap` (60s TWAP — the exact series up/down markets settle on).
 * Keeps ~30 min of history per symbol so price-to-beat can be recovered from the TWAP series.
 */
export class ChainlinkFeed {
  spot = new Map<string, RefPoint[]>();
  twap = new Map<string, RefPoint[]>();
  status: 'off' | 'connecting' | 'live' | 'error' = 'off';
  lastAt = 0;

  constructor(private assets: string[]) {}

  start() {
    const c = secureClient();
    if (!c) { log('warn', 'chainlink', 'no SIGNER_PRIVATE_KEY → Chainlink reference stream OFF (model uses Binance with zero basis)'); return this; }
    this.loop();
    return this;
  }

  latest(kind: 'spot' | 'twap', asset: string): RefPoint | undefined {
    const a = (kind === 'spot' ? this.spot : this.twap).get(asset);
    return a?.[a.length - 1];
  }

  /** First point with ts in [t - before, t + after] closest to t. */
  at(kind: 'spot' | 'twap', asset: string, t: number, toleranceMs = 2500): RefPoint | undefined {
    const a = (kind === 'spot' ? this.spot : this.twap).get(asset) ?? [];
    let best: RefPoint | undefined;
    for (const p of a) if (Math.abs(p.ts - t) <= toleranceMs && (!best || Math.abs(p.ts - t) < Math.abs(best.ts - t))) best = p;
    return best;
  }

  /** Mean of spot points with ts in [from, to]. */
  mean(asset: string, from: number, to: number): { mean: number; n: number } {
    const a = this.spot.get(asset) ?? [];
    let s = 0, n = 0;
    for (const p of a) if (p.ts >= from && p.ts <= to) { s += p.value; n++; }
    return { mean: n ? s / n : NaN, n };
  }

  private push(kind: 'spot' | 'twap', symbol: string, pts: RefPoint[]) {
    const asset = symbol.replace(/usd$/, '');
    const m = kind === 'spot' ? this.spot : this.twap;
    const arr = m.get(asset) ?? [];
    for (const p of pts) if (Number.isFinite(p.value) && (!arr.length || p.ts > arr[arr.length - 1].ts)) arr.push(p);
    const cutoff = Date.now() - 30 * 60_000;
    while (arr.length && arr[0].ts < cutoff) arr.shift();
    m.set(asset, arr);
    this.lastAt = Date.now();
    bus.counts[`chainlink-${kind}`] = (bus.counts[`chainlink-${kind}`] ?? 0) + pts.length;
  }

  private async loop() {
    const symbols = this.assets.map(a => `${a}usd`);
    for (let attempt = 0; ; attempt++) {
      try {
        this.status = 'connecting';
        const client = await secureClient()!;
        const stream: any = await (client as any).subscribe([
          { topic: 'prices.crypto', symbols },
          { topic: 'prices.crypto.twap', symbols },
        ]);
        this.status = 'live';
        log('info', 'chainlink', `PolyBolt subscribed ${symbols.join(',')}`);
        attempt = 0;
        for await (const ev of stream) {
          const kind: 'spot' | 'twap' = ev.topic === 'prices.crypto.twap' ? 'twap' : 'spot';
          if (ev.type === 'subscribe') {
            this.push(kind, ev.payload.symbol, (ev.payload.data ?? []).map((d: any) => ({ ts: Number(d.timestamp), value: Number(d.value) })));
          } else {
            this.push(kind, ev.payload.symbol, [{ ts: Number(ev.payload.timestamp), value: Number(ev.payload.value) }]);
          }
        }
        throw new Error('stream ended');
      } catch (e: any) {
        this.status = 'error';
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        log('warn', 'chainlink', `${e?.name ?? ''} ${e?.message ?? e}; retry in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
}
