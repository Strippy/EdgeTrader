import type { Position, Side } from './decide.js';

/** Apply a fill to a signed position. Returns new position and realized PnL (pre-fee) from any reduction. */
export function applyFill(pos: Position, side: Side, sz: number, px: number, now: number): { pos: Position; realized: number; closedSz: number } {
  const signed = side === 'buy' ? sz : -sz;
  if (pos.sz === 0 || Math.sign(pos.sz) === Math.sign(signed)) {
    const nsz = pos.sz + signed;
    const avg = (Math.abs(pos.sz) * pos.avgPx + sz * px) / Math.abs(nsz);
    return { pos: { sz: nsz, avgPx: avg, openedAt: pos.sz === 0 ? now : pos.openedAt }, realized: 0, closedSz: 0 };
  }
  const closing = Math.min(Math.abs(pos.sz), sz);
  const realized = closing * (px - pos.avgPx) * Math.sign(pos.sz);
  const rest = pos.sz + signed;
  if (Math.abs(rest) < 1e-12) return { pos: { sz: 0, avgPx: 0, openedAt: 0 }, realized, closedSz: closing };
  if (Math.sign(rest) === Math.sign(pos.sz)) return { pos: { ...pos, sz: rest }, realized, closedSz: closing };
  return { pos: { sz: rest, avgPx: px, openedAt: now }, realized, closedSz: closing }; // flipped through zero
}
