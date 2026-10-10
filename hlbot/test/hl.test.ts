import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, edges, roundPx, roundSz, type Params } from '../src/strategy/decide.js';
import { applyFill } from '../src/strategy/position.js';
import { Ema, LeadLag, fairPrice, pearson } from '../src/model/signal.js';

const P: Params = {
  takerFeeBps: 4.5, makerFeeBps: 1.5, exitFeeBps: 4.5, takeEdgeBps: 3, makeEdgeBps: 1.5, exitEdgeBps: 0,
  clipUsd: 200, maxPosUsd: 1000, maxGrossUsd: 3000, minOrderUsd: 10, maxHoldSec: 90, stopBps: 25, makerTtlMs: 4000,
};
const flat = { sz: 0, avgPx: 0, openedAt: 0 };
const base = { pos: flat, working: null, now: 1_000_000, grossUsd: 0, szDecimals: 5 };

test('price rounding follows Hyperliquid rules (5 sig figs, ≤ 6−szDecimals decimals)', () => {
  assert.equal(roundPx(100123.456, 5, 'down'), 100123);   // integer always valid
  assert.equal(roundPx(1234.56, 2, 'down'), 1234.5);
  assert.equal(roundPx(1234.56, 2, 'up'), 1234.6);
  assert.equal(roundPx(0.0123456, 1, 'down'), 0.01234);   // 5 sig figs
  assert.equal(roundPx(2.345678, 0, 'up'), 2.3457);
  assert.equal(roundSz(0.123456, 3), 0.123);
});

test('edges subtract entry + exit fees', () => {
  const e = edges({ fair: 100.2, bid: 99.99, ask: 100.01, pos: flat }, P);
  assert.ok(Math.abs(e.longTake - (19 - 9)) < 0.05);       // (100.2−100.01)/100 = 19bp − 9bp fees
  assert.ok(Math.abs(e.longMake - (21 - 6)) < 0.05);
  assert.ok(e.shortTake < 0);
});

test('takes when Binance-implied fair clears taker fees + threshold', () => {
  const a = decide({ ...base, fair: 100.2, bid: 99.99, ask: 100.01 }, P)!;
  assert.equal(a.kind, 'take');
  if (a.kind === 'take') { assert.equal(a.side, 'buy'); assert.ok(a.sz * 100 >= 200 && a.sz * 100 <= 600 + 1); }
});

test('quotes maker when only the maker edge clears', () => {
  // fair 9bp above mid: take = 8bp−9 <3, make = 10bp−6 = 4 ≥ 1.5
  const a = decide({ ...base, fair: 100.09, bid: 99.99, ask: 100.01 }, P)!;
  assert.equal(a.kind, 'make');
  if (a.kind === 'make') { assert.equal(a.side, 'buy'); assert.equal(a.px, 99.99); }
});

test('no trade inside the fee band', () => {
  assert.equal(decide({ ...base, fair: 100.03, bid: 99.99, ask: 100.01 }, P), null);
});

test('working order: cancel on ttl, on edge loss, on requote; keep otherwise', () => {
  const w = { side: 'buy' as const, px: 99.99, sz: 2, placedAt: base.now - 1000, oid: 's1' };
  assert.equal(decide({ ...base, working: w, fair: 100.09, bid: 99.99, ask: 100.01 }, P), null);
  assert.equal(decide({ ...base, working: { ...w, placedAt: base.now - 5000 }, fair: 100.09, bid: 99.99, ask: 100.01 }, P)?.kind, 'cancel');
  assert.equal(decide({ ...base, working: w, fair: 100.0, bid: 99.99, ask: 100.01 }, P)?.kind, 'cancel');
  assert.equal(decide({ ...base, working: w, fair: 100.1, bid: 100.0, ask: 100.02 }, P)?.kind, 'cancel');
});

test('position: exits on stop, time, flip, signal decay', () => {
  const long = { sz: 2, avgPx: 100, openedAt: base.now - 5000 };
  const ex = (o: any) => decide({ ...base, pos: long, ...o }, P);
  assert.deepEqual([ex({ fair: 99.8, bid: 99.7, ask: 99.72 })?.kind, (ex({ fair: 99.8, bid: 99.7, ask: 99.72 }) as any).reason], ['exit', 'stop']);
  assert.equal((decide({ ...base, pos: { ...long, openedAt: base.now - 100_000 }, fair: 100.2, bid: 100.05, ask: 100.07 }, P) as any).reason, 'time');
  assert.equal((ex({ fair: 99.8, bid: 99.95, ask: 99.97 }) as any).reason, 'flip');
  assert.equal((ex({ fair: 99.99, bid: 100.0, ask: 100.02 }) as any).reason, 'signal');
  assert.notEqual(ex({ fair: 100.2, bid: 100.0, ask: 100.02 })?.kind, 'exit'); // still has edge: hold (may add)
});

test('respects per-coin and gross caps', () => {
  assert.equal(decide({ ...base, grossUsd: 2995, fair: 100.2, bid: 99.99, ask: 100.01 }, P), null);
});

test('applyFill: open, add, reduce, flip, close', () => {
  let r = applyFill(flat, 'buy', 2, 100, 1);
  assert.deepEqual(r.pos, { sz: 2, avgPx: 100, openedAt: 1 });
  r = applyFill(r.pos, 'buy', 2, 102, 2); assert.equal(r.pos.avgPx, 101);
  r = applyFill(r.pos, 'sell', 1, 103, 3); assert.equal(r.realized, 2); assert.equal(r.pos.sz, 3);
  r = applyFill(r.pos, 'sell', 5, 100, 4); assert.equal(r.realized, -3); assert.deepEqual(r.pos, { sz: -2, avgPx: 100, openedAt: 4 });
  r = applyFill(r.pos, 'buy', 2, 99, 5); assert.equal(r.realized, 2); assert.equal(r.pos.sz, 0);
});

test('fair price and lead-lag detection', () => {
  assert.ok(Math.abs(fairPrice({ binanceRef: 100, basisLog: Math.log(1.001), mu: 0, horizonSec: 10, ofi: 0, ofiWeightBps: 1 }) - 100.1) < 1e-9);
  const e = new Ema(1); e.update(0, 0); e.update(1, 1000); assert.ok(Math.abs(e.v - 0.5) < 1e-9);
  // deterministic driver: HL copies Binance's step 3 samples (600ms) later
  const ll = new LeadLag(200, 10, 2000);
  let b = 100; const bs: number[] = [];
  for (let i = 0; i < 1500; i++) { b *= Math.exp(Math.sin(i * 12.9898) * 1e-4); bs.push(b); }
  for (let i = 3; i < bs.length; i++) ll.push(bs[i], bs[i - 3]);
  const c = ll.corr(); const peak = c.indexOf(Math.max(...c.filter(Number.isFinite)));
  assert.equal(peak, 3);
  assert.ok(Number.isNaN(pearson([1, 2], [1, 2])));
});
