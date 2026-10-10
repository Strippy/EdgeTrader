import type { Tick } from '../feeds/binance.js';
import { CFG } from '../config.js';

const ewAlpha = (halfLifeSec: number) => 1 - Math.pow(0.5, 1 / halfLifeSec);

/**
 * Per-asset live state from Binance ticks. Sampled once per second for vol/momentum,
 * tick-level for last price + order-flow imbalance.
 */
export class AssetStats {
  last = { spot: 0, perp: 0, hl: 0, spotTs: 0, perpTs: 0, hlTs: 0 };
  /** 1s samples of the reference price (perp or hl per venue, else spot). */
  series: { ts: number; px: number }[] = [];
  private varFast = NaN;
  private varSlow = NaN;
  private flow: { ts: number; signed: number; abs: number }[] = [];
  /** EMA of log(chainlink / binanceSpot). */
  basis = 0;
  basisN = 0;

  constructor(public asset: string) {}

  onTick(t: Tick) {
    if (t.venue === 'spot') { this.last.spot = t.price; this.last.spotTs = t.ts; }
    else if (t.venue === 'perp') { this.last.perp = t.price; this.last.perpTs = t.ts; }
    else { this.last.hl = t.price; this.last.hlTs = t.ts; }
    const notional = t.price * t.qty;
    if (t.venue === 'perp' || t.venue === 'hl' || !this.last.perpTs) this.flow.push({ ts: t.ts, signed: t.buyAggressor ? notional : -notional, abs: notional });
  }

  /** Price that leads: hl (hyperliquid-only mode) or perp when fresh, else spot. */
  ref(now = Date.now()): { px: number; ts: number; venue: 'hl' | 'perp' | 'spot' } | null {
    if (CFG.signalSource === 'hl') {
      if (this.last.hl && now - this.last.hlTs < CFG.staleSpotMs) return { px: this.last.hl, ts: this.last.hlTs, venue: 'hl' };
      return null;
    }
    if (this.last.perp && now - this.last.perpTs < CFG.staleSpotMs) return { px: this.last.perp, ts: this.last.perpTs, venue: 'perp' };
    if (this.last.spot) return { px: this.last.spot, ts: this.last.spotTs, venue: 'spot' };
    return null;
  }

  /** Called every second. */
  sample(now = Date.now()) {
    const r = this.ref(now);
    if (!r) return;
    const prev = this.series[this.series.length - 1];
    this.series.push({ ts: now, px: r.px });
    if (this.series.length > 3600) this.series.shift();
    if (prev) {
      const dt = Math.max(0.2, (now - prev.ts) / 1000);
      const r2 = Math.log(r.px / prev.px) ** 2 / dt; // per-second variance estimate
      const af = ewAlpha(CFG.volHalfLifeFast), as = ewAlpha(CFG.volHalfLifeSlow);
      this.varFast = Number.isFinite(this.varFast) ? (1 - af) * this.varFast + af * r2 : r2;
      this.varSlow = Number.isFinite(this.varSlow) ? (1 - as) * this.varSlow + as * r2 : r2;
    }
    const cut = now - 30_000;
    while (this.flow.length && this.flow[0].ts < cut) this.flow.shift();
  }

  /** Basis between Chainlink and the *same* Binance reference the model uses (perp or spot). */
  updateBasis(chainlinkSpot: number) {
    const r = this.ref();
    if (!r || !(chainlinkSpot > 0)) return;
    const b = Math.log(chainlinkSpot / r.px);
    const a = ewAlpha(CFG.basisHalfLife);
    this.basis = this.basisN ? (1 - a) * this.basis + a * b : b;
    this.basisN++;
  }

  /** Per-second log-vol: max of fast/slow blend and floor. Fast vol weighted up when it exceeds slow (vol expansion). */
  sigma(): number {
    const floor = CFG.volFloorBps / 1e4;
    if (!Number.isFinite(this.varFast)) return floor * 2;
    const f = Math.sqrt(this.varFast), s = Number.isFinite(this.varSlow) ? Math.sqrt(this.varSlow) : f;
    return Math.max(floor, f > s ? 0.7 * f + 0.3 * s : 0.5 * f + 0.5 * s);
  }

  /** Log return over the last `sec` seconds from the 1s series. */
  ret(sec: number): number {
    const s = this.series; if (s.length < 2) return 0;
    const last = s[s.length - 1];
    for (let i = s.length - 2; i >= 0; i--) if (last.ts - s[i].ts >= sec * 1000) return Math.log(last.px / s[i].px);
    return Math.log(last.px / s[0].px);
  }

  /** Signed taker-flow imbalance over `sec` seconds, in [-1, 1]. */
  ofi(sec = 10, now = Date.now()): number {
    let sgn = 0, abs = 0;
    for (const f of this.flow) if (f.ts >= now - sec * 1000) { sgn += f.signed; abs += f.abs; }
    return abs > 0 ? sgn / abs : 0;
  }

  /** Momentum drift in log-return per second (shrunk), with an acceleration term. */
  drift(): { mu: number; mom: number; accel: number } {
    const r15 = this.ret(15), r60 = this.ret(60);
    const mom = r15 / 15;
    const accel = r15 / 15 - r60 / 60;
    const mu = CFG.momWeight * mom + CFG.accelWeight * accel;
    const cap = this.sigma() / Math.sqrt(CFG.momHorizonSec); // drift over the horizon ≤ 1σ of noise over it
    return { mu: Math.max(-cap, Math.min(cap, mu)), mom, accel };
  }
}
