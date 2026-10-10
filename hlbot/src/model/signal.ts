/** Time-aware EMA (half-life in seconds). */
export class Ema {
  v = NaN; t = 0; n = 0;
  constructor(public halfLifeSec: number) {}
  update(x: number, now: number) {
    if (!Number.isFinite(x)) return this.v;
    if (!this.n) { this.v = x; this.t = now; this.n = 1; return x; }
    const dt = Math.max(0, (now - this.t) / 1000);
    const a = 1 - Math.pow(0.5, dt / this.halfLifeSec);
    this.v += a * (x - this.v); this.t = now; this.n++;
    return this.v;
  }
}

/**
 * Lead-lag tracker: samples Binance ref and Hyperliquid mid on a fixed grid and measures
 * corr(ΔlogBinance[t − k], ΔlogHL[t]) for k = 0..maxLag. A peak at k > 0 means Binance leads.
 */
export class LeadLag {
  private b: number[] = []; private h: number[] = [];
  constructor(public stepMs = 200, public maxLag = 15, public window = 3000) {}
  push(binance: number, hl: number) {
    if (!(binance > 0 && hl > 0)) return;
    this.b.push(Math.log(binance)); this.h.push(Math.log(hl));
    if (this.b.length > this.window + 1) { this.b.shift(); this.h.shift(); }
  }
  get samples() { return Math.max(0, this.b.length - 1); }
  corr(): number[] {
    const db = diff(this.b), dh = diff(this.h);
    const out: number[] = [];
    for (let k = 0; k <= this.maxLag; k++) {
      const x: number[] = [], y: number[] = [];
      for (let t = k; t < dh.length; t++) { x.push(db[t - k]); y.push(dh[t]); }
      out.push(pearson(x, y));
    }
    return out;
  }
}
const diff = (a: number[]) => a.slice(1).map((v, i) => v - a[i]);
export function pearson(x: number[], y: number[]) {
  const n = x.length; if (n < 20) return NaN;
  let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

export type FairInput = {
  binanceRef: number;   // leading price (Binance perp, else spot)
  basisLog: number;     // slow EMA of log(HL mid / Binance ref)
  mu: number;           // per-second log drift (momentum)
  horizonSec: number;
  ofi: number;          // [-1, 1] Binance perp taker imbalance
  ofiWeightBps: number;
};

/** Fair Hyperliquid price over the horizon: Binance-implied HL price + projected drift + flow tilt. */
export function fairPrice(i: FairInput): number {
  const log = Math.log(i.binanceRef) + i.basisLog + i.mu * i.horizonSec + (i.ofiWeightBps * i.ofi) / 1e4;
  return Math.exp(log);
}
