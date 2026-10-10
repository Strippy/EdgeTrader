import type { FeeSchedule } from '../markets/discovery.js';

/** Standard normal CDF (erf via Abramowitz–Stegun 7.1.26, |err| < 1.5e-7). */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Polymarket taker fee per share in USDC: rate × (p(1−p))^exponent. Crypto: rate 0.07, exponent 1. */
export function feePerShare(p: number, fees: FeeSchedule | null): number {
  if (!fees) return 0;
  return fees.rate * Math.pow(p * (1 - p), fees.exponent);
}

export type FairInput = {
  S: number;           // current Chainlink-equivalent spot
  K: number;           // price to beat (60s TWAP at window start)
  tauSec: number;      // seconds to window end
  sigma: number;       // per-second log vol
  mu: number;          // per-second log drift (momentum)
  muHorizonSec: number;
  ofi: number;         // [-1, 1]
  ofiWeight: number;
  twapSec: number;     // settlement TWAP window (60)
  /** mean of observed Chainlink-equivalent prices inside [end − twap, now], when now is inside the window */
  observedMean?: number;
};

export type FairOut = { pUp: number; z: number; mean: number; sd: number };

/**
 * P(final TWAP ≥ K). Final = average of spot over [T−W, T].
 * τ ≥ W : F − S ≈ N(drift, S²σ²(τ − 2W/3))           (future average of Brownian path)
 * τ < W : F = (a·Ā_obs + τ·Ā_rem)/W, a = W − τ;  Ā_rem ~ N(S, S²σ²τ/3)
 * Continuous at τ = W (both give S·σ·√(W/3)).
 */
export function fairUp(i: FairInput): FairOut {
  const W = i.twapSec;
  const tau = Math.max(0, i.tauSec);
  // drift applies to the mid-point of the yet-unobserved averaging segment, capped at horizon
  const midRem = tau >= W ? tau - W / 2 : tau / 2;
  const driftLog = i.mu * Math.min(midRem, i.muHorizonSec);
  const Sfwd = i.S * Math.exp(driftLog);
  let mean: number, sd: number;
  if (tau >= W) {
    mean = Sfwd;
    sd = i.S * i.sigma * Math.sqrt(tau - (2 * W) / 3);
  } else {
    const a = W - tau;
    const obs = Number.isFinite(i.observedMean) && i.observedMean! > 0 ? i.observedMean! : i.S;
    mean = (a * obs + tau * Sfwd) / W;
    sd = i.S * i.sigma * (tau / W) * Math.sqrt(tau / 3);
  }
  if (!(sd > 0)) {
    const pUp = mean >= i.K ? 1 : 0;
    return { pUp, z: pUp ? 99 : -99, mean, sd: 0 };
  }
  const z = (mean - i.K) / sd + i.ofiWeight * i.ofi;
  return { pUp: Math.min(0.995, Math.max(0.005, normCdf(z))), z, mean, sd };
}
