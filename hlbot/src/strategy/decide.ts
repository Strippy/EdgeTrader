export type Side = 'buy' | 'sell';
export type Position = { sz: number; avgPx: number; openedAt: number }; // sz signed: + long, − short
export type Working = { side: Side; px: number; sz: number; placedAt: number; oid?: number | string } | null;

export type Params = {
  takerFeeBps: number; makerFeeBps: number; exitFeeBps: number;
  takeEdgeBps: number; makeEdgeBps: number; exitEdgeBps: number;
  clipUsd: number; maxPosUsd: number; maxGrossUsd: number; minOrderUsd: number;
  maxHoldSec: number; stopBps: number; makerTtlMs: number;
};

export type Action =
  | { kind: 'exit'; side: Side; sz: number; limitPx: number; reason: 'signal' | 'time' | 'stop' | 'flip' }
  | { kind: 'take'; side: Side; sz: number; limitPx: number; edgeBps: number }
  | { kind: 'make'; side: Side; sz: number; px: number; edgeBps: number }
  | { kind: 'cancel'; reason: string };

export type Edges = { longTake: number; shortTake: number; longMake: number; shortMake: number; hold: number | null };

export type DecideInput = {
  fair: number; bid: number; ask: number;
  pos: Position; working: Working; now: number;
  grossUsd: number;      // |notional| across all coins
  szDecimals: number;
};

export function edges(i: Pick<DecideInput, 'fair' | 'bid' | 'ask' | 'pos'>, p: Params): Edges {
  const mid = (i.bid + i.ask) / 2;
  const bp = (x: number) => (x / mid) * 1e4;
  return {
    longTake: bp(i.fair - i.ask) - p.takerFeeBps - p.exitFeeBps,
    shortTake: bp(i.bid - i.fair) - p.takerFeeBps - p.exitFeeBps,
    longMake: bp(i.fair - i.bid) - p.makerFeeBps - p.exitFeeBps,
    shortMake: bp(i.ask - i.fair) - p.makerFeeBps - p.exitFeeBps,
    hold: i.pos.sz > 0 ? bp(i.fair - i.bid) : i.pos.sz < 0 ? bp(i.ask - i.fair) : null,
  };
}

/** Hyperliquid perp price rules: ≤5 significant figures, ≤ (6 − szDecimals) decimals; integers always valid. */
export function roundPx(px: number, szDecimals: number, dir: 'up' | 'down'): number {
  const maxDec = Math.max(0, 6 - szDecimals);
  const mag = Math.floor(Math.log10(Math.abs(px)));
  const sigDec = Math.max(0, 4 - mag);              // decimals allowed by 5 sig figs
  const dec = Math.min(maxDec, sigDec);
  const f = 10 ** dec;
  const v = dir === 'up' ? Math.ceil(px * f - 1e-9) / f : Math.floor(px * f + 1e-9) / f;
  return Number(v.toFixed(dec));
}
export const roundSz = (sz: number, szDecimals: number) => Math.floor(sz * 10 ** szDecimals + 1e-9) / 10 ** szDecimals;

export function decide(i: DecideInput, p: Params): Action | null {
  const { bid, ask, pos } = i;
  if (!(bid > 0 && ask > bid)) return null;
  const mid = (bid + ask) / 2;
  const e = edges(i, p);
  const posUsd = Math.abs(pos.sz) * mid;

  // 1) manage an open position first
  if (pos.sz !== 0) {
    const long = pos.sz > 0;
    const exitSide: Side = long ? 'sell' : 'buy';
    const exitPx = long ? roundPx(bid * (1 - 5e-4), i.szDecimals, 'down') : roundPx(ask * (1 + 5e-4), i.szDecimals, 'up');
    const pnlBps = ((long ? bid - pos.avgPx : pos.avgPx - ask) / pos.avgPx) * 1e4;
    const exit = (reason: 'signal' | 'time' | 'stop' | 'flip'): Action => ({ kind: 'exit', side: exitSide, sz: Math.abs(pos.sz), limitPx: exitPx, reason });
    if (i.working) return { kind: 'cancel', reason: 'position open' };
    if (pnlBps < -p.stopBps) return exit('stop');
    if ((i.now - pos.openedAt) / 1000 > p.maxHoldSec) return exit('time');
    if ((long ? e.shortTake : e.longTake) >= p.takeEdgeBps) return exit('flip');
    if ((e.hold ?? 0) < p.exitEdgeBps) return exit('signal');
  }

  // 2) working maker order: keep, requote or cancel
  if (i.working) {
    const w = i.working;
    const stillEdge = w.side === 'buy' ? e.longMake >= p.makeEdgeBps : e.shortMake >= p.makeEdgeBps;
    const best = w.side === 'buy' ? bid : ask;
    if (i.now - w.placedAt > p.makerTtlMs) return { kind: 'cancel', reason: 'ttl' };
    if (!stillEdge) return { kind: 'cancel', reason: 'edge gone' };
    if (Math.abs(w.px - best) > 1e-12) return { kind: 'cancel', reason: 'requote' };
    return null;
  }

  // 3) new risk (or adding to an existing same-side position)
  const room = (side: Side) => {
    const sameDir = (side === 'buy' && pos.sz >= 0) || (side === 'sell' && pos.sz <= 0);
    if (!sameDir) return 0;
    return Math.max(0, Math.min(p.maxPosUsd - posUsd, p.maxGrossUsd - i.grossUsd));
  };
  const sizeFor = (side: Side, edgeBps: number, thr: number, px: number) => {
    const usd = Math.min(p.clipUsd * Math.min(3, Math.max(1, edgeBps / Math.max(thr, 0.5))), room(side));
    const sz = roundSz(usd / px, i.szDecimals);
    return sz * px >= p.minOrderUsd ? sz : 0;
  };

  type C = { a: Action; score: number };
  const cands: C[] = [];
  if (e.longTake >= p.takeEdgeBps) { const sz = sizeFor('buy', e.longTake, p.takeEdgeBps, ask); if (sz) cands.push({ a: { kind: 'take', side: 'buy', sz, limitPx: roundPx(ask * (1 + 2e-4), i.szDecimals, 'up'), edgeBps: e.longTake }, score: e.longTake }); }
  if (e.shortTake >= p.takeEdgeBps) { const sz = sizeFor('sell', e.shortTake, p.takeEdgeBps, bid); if (sz) cands.push({ a: { kind: 'take', side: 'sell', sz, limitPx: roundPx(bid * (1 - 2e-4), i.szDecimals, 'down'), edgeBps: e.shortTake }, score: e.shortTake }); }
  if (!cands.length) {
    if (e.longMake >= p.makeEdgeBps) { const sz = sizeFor('buy', e.longMake, p.makeEdgeBps, bid); if (sz) cands.push({ a: { kind: 'make', side: 'buy', sz, px: bid, edgeBps: e.longMake }, score: e.longMake }); }
    if (e.shortMake >= p.makeEdgeBps) { const sz = sizeFor('sell', e.shortMake, p.makeEdgeBps, ask); if (sz) cands.push({ a: { kind: 'make', side: 'sell', sz, px: ask, edgeBps: e.shortMake }, score: e.shortMake }); }
  }
  cands.sort((a, b) => b.score - a.score);
  return cands[0]?.a ?? null;
}
