import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feePerShare, normCdf, fairUp } from '../src/model/fair.js';
import { walkAsks, Book } from '../src/feeds/book.js';
import { decide, type DecideParams } from '../src/strategy/decide.js';
import { slugFor, windowStart, parseGammaMarket } from '../src/markets/discovery.js';

const CRYPTO = { rate: 0.07, exponent: 1, takerOnly: true };

test('taker fee matches Polymarket crypto fee table (100 shares)', () => {
  // docs.polymarket.com/trading/fees — Crypto tab
  const table: [number, number][] = [[0.01, 0.07], [0.10, 0.63], [0.30, 1.47], [0.50, 1.75], [0.70, 1.47], [0.90, 0.63], [0.99, 0.07]];
  for (const [p, fee] of table) assert.ok(Math.abs(feePerShare(p, CRYPTO) * 100 - fee) < 0.006, `p=${p}`);
  assert.equal(feePerShare(0.5, null), 0);
});

test('normal CDF', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.9750021) < 1e-6);
  assert.ok(Math.abs(normCdf(-1) - 0.1586553) < 1e-6);
});

const base = { S: 100_000, K: 100_000, sigma: 1e-4, mu: 0, muHorizonSec: 30, ofi: 0, ofiWeight: 0, twapSec: 60 };

test('fair value: ATM is 50%, monotone in S, continuous at the TWAP boundary', () => {
  assert.ok(Math.abs(fairUp({ ...base, tauSec: 600 }).pUp - 0.5) < 1e-9);
  assert.ok(fairUp({ ...base, S: 100_050, tauSec: 600 }).pUp > 0.5);
  assert.ok(fairUp({ ...base, S: 99_950, tauSec: 600 }).pUp < 0.5);
  const a = fairUp({ ...base, S: 100_020, tauSec: 60.0001 }), b = fairUp({ ...base, S: 100_020, tauSec: 59.9999 });
  assert.ok(Math.abs(a.sd - b.sd) < 0.01 && Math.abs(a.pUp - b.pUp) < 1e-3);
});

test('fair value: inside the TWAP window the observed average dominates', () => {
  // 50s of the 60s average already printed 30 above K; spot just fell 10 below K, 10s left
  const f = fairUp({ ...base, S: 99_990, tauSec: 10, observedMean: 100_030 });
  // expected mean = (50*100030 + 10*99990)/60 = 100023.33 → strongly Up
  assert.ok(Math.abs(f.mean - 100_023.333) < 0.01);
  assert.ok(f.pUp > 0.99);
});

test('fair value: positive drift raises P(up)', () => {
  assert.ok(fairUp({ ...base, tauSec: 300, mu: 2e-5 }).pUp > 0.5);
});

test('walkAsks respects maxPrice and budget', () => {
  const lv = [{ price: 0.50, size: 10 }, { price: 0.52, size: 10 }, { price: 0.60, size: 100 }];
  const w = walkAsks(lv, 100, 0.52);
  assert.equal(w.worst, 0.52);
  assert.ok(Math.abs(w.shares - 20) < 1e-9 && Math.abs(w.spent - 10.2) < 1e-9);
  const w2 = walkAsks(lv, 3, 1);
  assert.ok(Math.abs(w2.shares - 6) < 1e-9);
});

test('Book applies snapshot + deltas', () => {
  const b = new Book();
  b.snapshot([{ price: '0.48', size: '100' }], [{ price: '0.52', size: '50' }, { price: '0.51', size: '5' }]);
  assert.equal(b.bestAsk()!.price, 0.51);
  b.set('SELL', 0.51, 0);
  assert.equal(b.bestAsk()!.price, 0.52);
  b.set('BUY', 0.49, 20);
  assert.equal(b.bestBid()!.price, 0.49);
});

const P: DecideParams = { minEdge: 0.025, hedgeEdge: 0, pairTarget: 0.985, maxSlip: 0.02, clipUsd: 25, maxClipMult: 3, maxMarketUsd: 300, maxNetShares: 400, noNewRiskLastSec: 15, noTradeLastSec: 3, minSecFromOpen: 2 };
const flat = () => ({ up: { shares: 0, cost: 0 }, down: { shares: 0, cost: 0 } });
const deep = (px: number) => [{ price: px, size: 1000 }];

test('decide: enters when model edge after fee clears threshold', () => {
  // p_model(Up)=0.67, Up ask 0.60 → edge 0.07 − fee 0.0168 = 0.053
  const it = decide({ pUp: 0.67, asks: { up: deep(0.60), down: deep(0.41) }, inv: flat(), fees: CRYPTO, minShares: 5, tauSec: 400, sinceOpenSec: 100 }, P)!;
  assert.equal(it.side, 'up'); assert.equal(it.reason, 'entry');
  assert.ok(Math.abs(it.edge - (0.07 - 0.07 * 0.6 * 0.4)) < 1e-9);
  assert.ok(it.usd > 25 && it.usd <= 75);
});

test('decide: no trade when fee eats the edge', () => {
  assert.equal(decide({ pUp: 0.52, asks: { up: deep(0.50), down: deep(0.51) }, inv: flat(), fees: CRYPTO, minShares: 5, tauSec: 400, sinceOpenSec: 100 }, P), null);
});

test('decide: completes sub-$1 sets ahead of new directional risk', () => {
  const inv = { up: { shares: 100, cost: 52 }, down: { shares: 0, cost: 0 } }; // avg 0.52 all-in
  // model still likes Up a lot, but Down at 0.42 makes 0.52+0.42+fee ≈ 0.957 < 0.985
  const it = decide({ pUp: 0.70, asks: { up: deep(0.55), down: deep(0.42) }, inv, fees: CRYPTO, minShares: 5, tauSec: 400, sinceOpenSec: 100 }, P)!;
  assert.equal(it.side, 'down'); assert.equal(it.reason, 'pair');
  assert.ok(it.estShares <= 100 + 1e-9);
});

test('decide: hedges on reversal even without a cheap set', () => {
  const inv = { up: { shares: 100, cost: 65 }, down: { shares: 0, cost: 0 } };
  // fair flipped to Down 0.75, Down ask 0.62 → edge ≈ 0.11; pair cost 0.65+0.62 > 1
  const it = decide({ pUp: 0.25, asks: { up: deep(0.37), down: deep(0.62) }, inv, fees: CRYPTO, minShares: 5, tauSec: 400, sinceOpenSec: 100 }, P)!;
  assert.equal(it.side, 'down'); assert.equal(it.reason, 'hedge');
});

test('decide: no new risk in the final seconds, but hedges still allowed', () => {
  assert.equal(decide({ pUp: 0.9, asks: { up: deep(0.6), down: deep(0.4) }, inv: flat(), fees: CRYPTO, minShares: 5, tauSec: 10, sinceOpenSec: 800 }, P), null);
  const inv = { up: { shares: 50, cost: 25 }, down: { shares: 0, cost: 0 } };
  const it = decide({ pUp: 0.3, asks: { up: deep(0.3), down: deep(0.45) }, inv, fees: CRYPTO, minShares: 5, tauSec: 10, sinceOpenSec: 800 }, P);
  assert.equal(it?.side, 'down');
  assert.equal(decide({ pUp: 0.3, asks: { up: deep(0.3), down: deep(0.45) }, inv, fees: CRYPTO, minShares: 5, tauSec: 2, sinceOpenSec: 800 }, P), null);
});

test('decide: respects net-share and spend caps', () => {
  const inv = { up: { shares: 398, cost: 200 }, down: { shares: 0, cost: 0 } };
  assert.equal(decide({ pUp: 0.9, asks: { up: deep(0.6), down: deep(0.5) }, inv, fees: CRYPTO, minShares: 5, tauSec: 400, sinceOpenSec: 100 }, P), null);
});

test('slug + window math', () => {
  assert.equal(windowStart(1791582300_000 + 899_999, '15m'), 1791582300);
  assert.equal(slugFor('btc', '15m', 1791582300), 'btc-updown-15m-1791582300');
  assert.equal(windowStart(1791582300_000 + 300_000, '5m'), 1791582600);
});

test('parseGammaMarket on the field layout of a live btc-updown-15m market', () => {
  // field names/values as returned by gamma-api /markets/slug/btc-updown-15m-1791582300 (fetched 2026-10-09)
  const m = parseGammaMarket({
    slug: 'btc-updown-15m-1791582300', version: 'v1', outcomes: '["Up", "Down"]', outcomePrices: '["0", "1"]',
    clobTokenIds: '["47047655103465383929067684782291231694187643622431756855686339630860111783620", "114154719118709586032871631852229444853237834758532934032237096418063436808788"]',
    conditionId: '0xb1da740d34c1a0acb07756b099a215b2e38776d731d72820b6925e188ef122a7', closed: true, acceptingOrders: false,
    feesEnabled: true, feeSchedule: { exponent: 1, rate: 0.07, takerOnly: true, rebateRate: 0.2 }, orderPriceMinTickSize: 0.001, orderMinSize: 5,
    events: [{ eventMetadata: { finalPrice: 82464.9879919323, priceToBeat: 82472.50251805791 } }],
  }, 'btc', '15m', 1791582300)!;
  assert.equal(m.upId.slice(0, 8), '47047655');
  assert.equal(m.priceToBeat, 82472.50251805791);
  assert.deepEqual(m.outcomePrices, [0, 1]);
  assert.equal(m.tick, 0.001);
  assert.equal(m.fees!.rate, 0.07);
  assert.equal(m.end - m.start, 900_000);
});
