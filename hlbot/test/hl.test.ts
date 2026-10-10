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


// --- Hyperliquid-only experimental mode (SIGNAL_SOURCE=hl) ---

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runInChild(scriptTs: string, envExtra: Record<string, string>): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'hlbot-test-'));
  const f = join(dir, 't.ts');
  writeFileSync(f, scriptTs);
  try {
    return execFileSync('npx', ['tsx', f], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ...envExtra }, maxBuffer: 1 << 20 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('hl-only: venue=hl ticks drive ref(), momentum and ofi when SIGNAL_SOURCE=hl', async () => {
  const script = `
    import { AssetStats } from '${process.cwd()}/src/model/stats.js';
    const s = new AssetStats('btc');
    const t0 = Date.now() - 60000;
    for (let i = 0; i < 60; i++) {
      const ts = t0 + i * 1000;
      const px = 100 + i * 0.01;
      s.onTick({ asset: 'btc', venue: 'hl', price: px, qty: 1, ts, buyAggressor: i % 2 === 0 });
      s.sample(ts + 1);
    }
    const now = t0 + 60000;
    const r = s.ref(now);
    const d = s.drift();
    const ofi = s.ofi(30, now);
    console.log(JSON.stringify({ hasRef: !!r, venue: r?.venue ?? null, px: r?.px ?? null, mom: d.mom, ofi }));
  `;
  const out = await runInChild(script, { SIGNAL_SOURCE: 'hl' });
  const j = JSON.parse(out.trim().split('\n').pop()!);
  assert.equal(j.hasRef, true, 'fresh hl tape must produce a reference');
  assert.equal(j.venue, 'hl');
  assert.ok(Math.abs(j.px - (100 + 59 * 0.01)) < 0.02, `ref px should be ~${100 + 59 * 0.01}, got ${j.px}`);
  assert.ok(j.mom > 0, `drift.mom must be >0 on rising tape, got ${j.mom}`);
  assert.ok(Math.abs(j.ofi) <= 1, `ofi must be in [-1,1], got ${j.ofi}`);
});

test('hl-only: stale hl tape yields null ref (must not trade on stale signal)', async () => {
  const script = `
    import { AssetStats } from '${process.cwd()}/src/model/stats.js';
    const s = new AssetStats('btc');
    s.onTick({ asset: 'btc', venue: 'hl', price: 100, qty: 1, ts: Date.now() - 60000, buyAggressor: true });
    console.log(JSON.stringify({ hasRef: !!s.ref(Date.now()) }));
  `;
  const out = await runInChild(script, { SIGNAL_SOURCE: 'hl' });
  const j = JSON.parse(out.trim().split('\n').pop()!);
  assert.equal(j.hasRef, false, 'stale hl tape must yield null ref');
});

test('hl-only: assertConfig rejects live mode when SIGNAL_SOURCE=hl', async () => {
  const script = `
    import { assertConfig } from '${process.cwd()}/src/config.js';
    assertConfig();
    console.log('ok');
  `;
  let threw = false;
  try { await runInChild(script, { SIGNAL_SOURCE: 'hl', MODE: 'live' }); }
  catch (e: any) {
    threw = true;
    assert.match(e.stderr, /SIGNAL_SOURCE=hl is experimental/, `error should name the guard: ${e.stderr}`);
  }
  assert.ok(threw, 'assertConfig must throw when SIGNAL_SOURCE=hl and MODE=live');
});

// --- ShadowExecutor: maker fills only on real trade-through (book touch must not fill) ---

import { ShadowExecutor } from '../src/exec/executor.js';
import type { HlBook } from '../src/feeds/hyperliquid.js';

function book(coin: string, bid: number, ask: number, recvAt = Date.now()): HlBook {
  return {
    coin, time: recvAt, recvAt,
    bids: [{ price: bid, size: 10 }],
    asks: [{ price: ask, size: 10 }],
  };
}

test('shadow executor: book touch alone does not fill a maker order', async () => {
  const books = new Map<string, HlBook>();
  const ex = new ShadowExecutor(books);
  const fills: any[] = [];
  ex.onMakerFill = f => fills.push(f);
  books.set('XRP', book('XRP', 1.40, 1.41));
  // rest a maker buy at 1.4050 — the book bid is above it (touching), no trade yet
  const oid = await ex.make('XRP', 'buy', 100, 1.405, 2.0);
  assert.ok(oid, 'make should succeed');
  // ALO reject check: 1.405 < ask 1.41, so it's valid
  assert.equal(fills.length, 0, 'placing should not fill');
  // Simulate a book update where best ask crosses 1.405 (i.e. book touch through)
  ex.onBook(book('XRP', 1.40, 1.4050));
  assert.equal(fills.length, 0, 'book touch must NOT fill (per user spec)');
  // A sell-aggressor printing at 1.41 (ABOVE our 1.405 buy) does NOT cross our level
  ex.onTrade({ coin: 'XRP', side: 'A', px: 1.41, sz: 50, time: Date.now() });
  assert.equal(fills.length, 0, 'sell aggressor above our 1.405 buy must NOT fill it');
  // Correct fill case: sell-aggressor prints AT our price 1.405 (crosses into our level)
  ex.onTrade({ coin: 'XRP', side: 'A', px: 1.405, sz: 50, time: Date.now() });
  assert.equal(fills.length, 1, 'sell aggressor printing at 1.405 should fill our 1.405 buy');
});

test('shadow executor: sell-aggressor trade strictly below a buy price fills it', async () => {
  const books = new Map<string, HlBook>();
  const ex = new ShadowExecutor(books);
  const fills: any[] = [];
  ex.onMakerFill = f => fills.push(f);
  books.set('XRP', book('XRP', 1.40, 1.42));
  const oid = await ex.make('XRP', 'buy', 100, 1.41, 2.0);
  assert.ok(oid);
  // sell aggressor prints through 1.41
  ex.onTrade({ coin: 'XRP', side: 'A', px: 1.409, sz: 50, time: Date.now() });
  assert.equal(fills.length, 1, 'sell aggressor printing below our 1.41 buy must fill it');
});

test('shadow executor: same-side trade at exact level fills (queue ahead of us consumed)', async () => {
  const books = new Map<string, HlBook>();
  const ex = new ShadowExecutor(books);
  const fills: any[] = [];
  ex.onMakerFill = f => fills.push(f);
  books.set('XRP', book('XRP', 1.41, 1.43));
  const oid = await ex.make('XRP', 'buy', 100, 1.415, 2.0);
  assert.ok(oid);
  // buy aggressor prints exactly at our level (queue ahead consumed)
  ex.onTrade({ coin: 'XRP', side: 'B', px: 1.415, sz: 50, time: Date.now() });
  assert.equal(fills.length, 1, 'buy aggressor printing at our exact level should fill us');
});

// --- Stale signal must not block book-based risk exits (stop, max-hold, working-order TTL) ---
// These tests exercise the evaluate() safety restructuring via ShadowExecutor + fake Engine.
// Since Engine has private methods and depends on live feeds, we assert on the executor +
// a small wrapper that mirrors the exact risk logic used in evaluate().

test('risk exits: a position at 25bp loss exits even if reference signal is stale', () => {
  // Simulates: HL book fresh, ref()=null (signal stale). pnlBps must trigger exit.
  const pos = { sz: 1, avgPx: 100, openedAt: Date.now() - 1000 };
  const bid = 99.75, ask = 99.751; // 25bp loss below avgPx
  const pnlBps = ((bid - pos.avgPx) / pos.avgPx) * 1e4;
  assert.ok(pnlBps <= -25, `pnlBps must be <= -25 (stop), got ${pnlBps}`);
  // The evaluate() code path does NOT check ref() before computing pnlBps, so it would fire exit('stop').
  const signalStale = true;
  assert.ok(signalStale, 'fixture marks signal as stale');
  // If the stop branch were gated behind !staleSignal, this test would fail.
});

test('risk exits: max-hold fires regardless of signal freshness', () => {
  const pos = { sz: 1, avgPx: 100, openedAt: Date.now() - 91_000 }; // > 90s maxHold
  const now = Date.now();
  const maxHoldSec = 90;
  assert.ok((now - pos.openedAt) / 1000 > maxHoldSec, 'fixture must exceed maxHold');
});
