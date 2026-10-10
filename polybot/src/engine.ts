import { CFG, TF_SECONDS, TWAP_WINDOW_SEC, type Timeframe } from './config.js';
import { bus, log } from './bus.js';
import { AssetStats } from './model/stats.js';
import { fairUp, feePerShare } from './model/fair.js';
import { decide, avg, type Inventory, type Intent, type Side } from './strategy/decide.js';
import { fetchMarket, windowStart, type MarketInfo } from './markets/discovery.js';
import { ClobFeed, type Resolution } from './feeds/clob.js';
import { ChainlinkFeed } from './feeds/chainlink.js';
import type { Executor, Fill } from './exec/executor.js';
import { LiveExecutor } from './exec/executor.js';
import { appendFill, appendSettlement, loadFills, loadSettlements, type Settlement } from './store.js';
import type { Tick } from './feeds/binance.js';

type Hist = { t: number; p: number; au: number; ad: number; bu: number; bd: number; S: number };

export type MarketState = {
  info: MarketInfo;
  refSource: 'gamma' | 'chainlink-twap' | null;
  inv: Inventory;
  fills: Fill[];
  pending: boolean;
  lastOrderAt: number;
  lastInfoAt: number;
  fair: { pUp: number; z: number; mean: number; sd: number; S: number } | null;
  hist: Hist[];
  settled: Settlement | null;
  resolvedWinner: Side | null;
  block: string;  // why not trading right now
};

const emptyInv = (): Inventory => ({ up: { shares: 0, cost: 0 }, down: { shares: 0, cost: 0 } });

export class Engine {
  stats = new Map<string, AssetStats>();
  markets = new Map<string, MarketState>();
  fills: Fill[];
  settlements: Settlement[];
  killed: string | null = null;
  startedAt = Date.now();
  private lastDiscoveryWarn = 0;

  constructor(public exec: Executor, public clob: ClobFeed, public cl: ChainlinkFeed) {
    for (const a of CFG.assets) this.stats.set(a, new AssetStats(a));
    this.fills = loadFills(exec.mode);
    this.settlements = loadSettlements(exec.mode);
    clob.onResolved = (r) => this.onResolved(r);
  }

  /** Rebuild inventory for windows with fills but no settlement (restart safety). */
  async restoreOpen() {
    const settled = new Set(this.settlements.map(s => s.slug));
    const open = new Map<string, Fill[]>();
    for (const f of this.fills) if (!settled.has(f.slug) && Date.now() - f.ts < 86_400_000) open.set(f.slug, [...(open.get(f.slug) ?? []), f]);
    for (const [slug, fs] of open) {
      const [asset, , tf, st] = slug.split('-');
      try {
        const info = await fetchMarket(asset, tf as Timeframe, Number(st));
        if (!info) continue;
        const inv = emptyInv();
        for (const f of fs) { inv[f.side].shares += f.shares; inv[f.side].cost += f.notional + f.fee; }
        this.markets.set(slug, { info, refSource: info.priceToBeat ? 'gamma' : null, inv, fills: fs, pending: false, lastOrderAt: 0, lastInfoAt: 0, fair: null, hist: [], settled: null, resolvedWinner: null, block: 'restored' });
        this.clob.subscribe([info.upId, info.downId]);
        log('info', 'restore', `${slug} up ${inv.up.shares.toFixed(1)} / down ${inv.down.shares.toFixed(1)}`);
      } catch (e: any) { log('warn', 'restore', `${slug}: ${e?.message}`); }
    }
  }

  onTick(t: Tick) { this.stats.get(t.asset)?.onTick(t); }

  start() {
    this.restoreOpen().catch(e => log('warn', 'restore', e.message));
    setInterval(() => this.everySecond(), 1000);
    setInterval(() => this.discover().catch(e => log('warn', 'discovery', e.message)), 3000);
    setInterval(() => this.evaluateAll(), 200);
    setInterval(() => this.settleLoop().catch(e => log('warn', 'settle', e.message)), 5000);
    this.discover().catch(e => log('warn', 'discovery', e.message));
  }

  // ---------------------------------------------------------------- feeds
  private everySecond() {
    const now = Date.now();
    for (const s of this.stats.values()) {
      s.sample(now);
      const cl = this.cl.latest('spot', s.asset);
      if (cl && now - cl.ts < 5000) s.updateBasis(cl.value);
    }
    for (const m of this.markets.values()) {
      if (now < m.info.start || now > m.info.end + 1000) continue;
      const bu = this.clob.book(m.info.upId), bd = this.clob.book(m.info.downId);
      m.hist.push({ t: now, p: m.fair?.pUp ?? NaN, au: bu.bestAsk()?.price ?? NaN, ad: bd.bestAsk()?.price ?? NaN, bu: bu.bestBid()?.price ?? NaN, bd: bd.bestBid()?.price ?? NaN, S: m.fair?.S ?? NaN });
      if (m.hist.length > 900) m.hist.shift();
    }
    this.checkKill();
  }

  /** Chainlink-equivalent spot = Binance leader × exp(basis). */
  private clEquivalent(asset: string, now: number): number | null {
    const s = this.stats.get(asset);
    const r = s?.ref(now);
    if (!s || !r || now - r.ts > CFG.staleSpotMs) return null;
    return r.px * Math.exp(s.basis);
  }

  // ---------------------------------------------------------------- discovery
  private async discover() {
    const now = Date.now();
    const jobs: Promise<void>[] = [];
    for (const asset of CFG.assets) for (const tf of CFG.timeframes as Timeframe[]) {
      const cur = windowStart(now, tf);
      for (const st of [cur, cur + TF_SECONDS[tf]]) jobs.push(this.ensureMarket(asset, tf, st, now));
    }
    const res = await Promise.allSettled(jobs);
    const bad = res.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    if (bad.length && now - this.lastDiscoveryWarn > 30_000) {
      this.lastDiscoveryWarn = now;
      log('warn', 'gamma', `${bad.length}/${res.length} lookups failed: ${bad[0].reason?.message ?? bad[0].reason}`);
    }
    // drop finished, flat, settled-or-empty markets after a grace period
    for (const [slug, m] of this.markets) {
      const flat = m.inv.up.shares === 0 && m.inv.down.shares === 0;
      if (now > m.info.end + 120_000 && (flat || m.settled)) {
        this.clob.unsubscribe([m.info.upId, m.info.downId]);
        this.markets.delete(slug);
      }
    }
  }

  private async ensureMarket(asset: string, tf: Timeframe, startSec: number, now: number) {
    const slug = `${asset}-updown-${tf}-${startSec}`;
    let m = this.markets.get(slug);
    const refreshEvery = m && now >= m.info.start - 5000 ? 4000 : 30_000;
    const needRefresh = !m || ((!m.info.priceToBeat || !m.info.acceptingOrders) && now - m.lastInfoAt > refreshEvery);
    if (m && !needRefresh) return this.resolveRef(m);
    const info = await fetchMarket(asset, tf, startSec);
    if (!info) return;
    if (!m) {
      m = { info, refSource: null, inv: emptyInv(), fills: [], pending: false, lastOrderAt: 0, lastInfoAt: now, fair: null, hist: [], settled: null, resolvedWinner: null, block: 'init' };
      this.markets.set(slug, m);
      this.clob.subscribe([info.upId, info.downId]);
      bus.wireEvent('gamma', 'market', `${slug} ${info.version} tick=${info.tick} fee=${info.fees?.rate ?? 0}`);
    } else {
      const keep = m.info.priceToBeat;
      m.info = info;
      if (!info.priceToBeat && keep) m.info.priceToBeat = keep;
      m.lastInfoAt = now;
    }
    if (info.priceToBeat && m.refSource !== 'gamma') m.refSource = 'gamma';
    this.resolveRef(m);
  }

  /** Fallback price-to-beat: Chainlink 60s TWAP printed at the window start (same series Polymarket settles on). */
  private resolveRef(m: MarketState) {
    if (m.info.priceToBeat) return;
    const p = this.cl.at('twap', m.info.asset, m.info.start, 2500);
    if (p) { m.info.priceToBeat = p.value; m.refSource = 'chainlink-twap'; bus.wireEvent('chainlink', 'ptb', `${m.info.slug} K=${p.value.toFixed(4)}`); }
  }

  // ---------------------------------------------------------------- trading
  private evaluateAll() {
    const now = Date.now();
    for (const m of this.markets.values()) {
      if (now < m.info.start || now >= m.info.end) continue;
      this.evaluate(m, now);
    }
  }

  private evaluate(m: MarketState, now: number) {
    const i = m.info;
    const S = this.clEquivalent(i.asset, now);
    const st = this.stats.get(i.asset)!;
    if (!i.priceToBeat) { m.block = 'no price-to-beat'; m.fair = null; return; }
    if (!S) { m.block = 'spot stale'; m.fair = null; return; }
    const tau = (i.end - now) / 1000;
    let observedMean: number | undefined;
    if (tau < TWAP_WINDOW_SEC) {
      const from = i.end - TWAP_WINDOW_SEC * 1000;
      const cl = this.cl.mean(i.asset, from, now);
      if (cl.n >= 3) observedMean = cl.mean;
      else {
        const pts = st.series.filter(p => p.ts >= from);
        if (pts.length) observedMean = pts.reduce((a, p) => a + p.px, 0) / pts.length * Math.exp(st.basis);
      }
    }
    const d = st.drift();
    const f = fairUp({
      S, K: i.priceToBeat, tauSec: tau, sigma: st.sigma(), mu: d.mu, muHorizonSec: CFG.momHorizonSec,
      ofi: st.ofi(10, now), ofiWeight: CFG.ofiWeight, twapSec: TWAP_WINDOW_SEC, observedMean,
    });
    m.fair = { ...f, S };

    const bu = this.clob.book(i.upId), bd = this.clob.book(i.downId);
    if (this.killed) { m.block = `killed: ${this.killed}`; return; }
    if (st.basisN < 10 && !CFG.allowNoChainlink) { m.block = 'no chainlink basis'; return; }
    if (!i.acceptingOrders || i.closed) { m.block = 'not accepting'; return; }
    if (now - bu.ts > CFG.staleBookMs || now - bd.ts > CFG.staleBookMs) { m.block = 'book stale'; return; }
    if (m.pending) { m.block = 'order in flight'; return; }
    if (now - m.lastOrderAt < CFG.cooldownMs) { m.block = 'cooldown'; return; }

    const intent = decide({
      pUp: f.pUp, asks: { up: bu.askLevels(), down: bd.askLevels() }, inv: m.inv, fees: i.fees,
      minShares: i.minSize, tauSec: tau, sinceOpenSec: (now - i.start) / 1000,
    }, CFG);
    m.block = intent ? '' : 'no edge';
    if (intent) this.fire(m, intent);
  }

  private async fire(m: MarketState, it: Intent) {
    m.pending = true;
    m.lastOrderAt = Date.now();
    const book = this.clob.book(it.side === 'up' ? m.info.upId : m.info.downId);
    try {
      const f = await this.exec.buy(m.info, book, it);
      if (!f) { bus.wireEvent('exec', 'nofill', `${m.info.slug} ${it.side} ${it.reason} $${it.usd}`); return; }
      const leg = m.inv[f.side];
      leg.shares += f.shares; leg.cost += f.notional + f.fee;
      m.fills.push(f); this.fills.push(f); appendFill(f);
      bus.wireEvent('exec', f.reason, `${m.info.slug} BUY ${f.side.toUpperCase()} ${f.shares.toFixed(1)}@${f.price.toFixed(3)} edge ${(f.edge * 100).toFixed(1)}¢`);
    } catch (e: any) {
      log('error', 'exec', `${m.info.slug}: ${e?.message ?? e}`);
    } finally {
      m.pending = false;
    }
  }

  // ---------------------------------------------------------------- settlement
  private onResolved(r: Resolution) {
    for (const m of this.markets.values()) if (m.info.conditionId === r.conditionId) {
      m.resolvedWinner = r.winningAssetId === m.info.upId ? 'up' : r.winningAssetId === m.info.downId ? 'down' : null;
    }
  }

  private async settleLoop() {
    const now = Date.now();
    for (const m of this.markets.values()) {
      if (m.settled || now < m.info.end + 3000) continue;
      if (m.inv.up.shares === 0 && m.inv.down.shares === 0) continue;
      let winner = m.resolvedWinner, source = 'clob-ws';
      if (!winner && now - m.lastInfoAt > 15_000) {
        const fresh = await fetchMarket(m.info.asset, m.info.tf, m.info.start / 1000);
        m.lastInfoAt = now;
        if (fresh) {
          m.info = { ...fresh, priceToBeat: fresh.priceToBeat ?? m.info.priceToBeat };
          const op = fresh.outcomePrices;
          if (fresh.closed && op && (op[0] === 1 || op[1] === 1)) { winner = op[0] === 1 ? 'up' : 'down'; source = 'gamma'; }
        }
      }
      if (!winner) continue;
      const payout = m.inv[winner].shares;
      const cost = m.inv.up.cost + m.inv.down.cost;
      const pairs = Math.min(m.inv.up.shares, m.inv.down.shares);
      const s: Settlement = {
        ts: now, mode: this.exec.mode, slug: m.info.slug, asset: m.info.asset, tf: m.info.tf, winner,
        upShares: m.inv.up.shares, downShares: m.inv.down.shares, cost, payout, pnl: payout - cost,
        pairs, pairCost: pairs > 0 ? avg(m.inv.up) + avg(m.inv.down) : null,
        priceToBeat: m.info.priceToBeat, finalPrice: m.info.finalPrice, source,
      };
      m.settled = s; this.settlements.push(s); appendSettlement(s);
      bus.wireEvent('settle', winner, `${s.slug} → ${winner.toUpperCase()} pnl ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`);
      if (this.exec instanceof LiveExecutor) {
        this.exec.redeem(m.info.conditionId)
          .then(tx => log('info', 'settle', `redeemed ${m.info.slug} tx ${tx}`))
          .catch(e => log('warn', 'settle', `redeem ${m.info.slug} failed (retry manually / auto-redeem): ${e?.message}`));
      }
    }
  }

  private checkKill() {
    const day = new Date().toISOString().slice(0, 10);
    const today = this.settlements.filter(s => new Date(s.ts).toISOString().slice(0, 10) === day).reduce((a, s) => a + s.pnl, 0);
    if (!this.killed && today < -CFG.dailyLossLimit) {
      this.killed = `daily loss ${today.toFixed(2)} < -${CFG.dailyLossLimit}`;
      log('error', 'risk', `KILL SWITCH: ${this.killed}`);
    }
  }

  // ---------------------------------------------------------------- dashboard snapshot
  snapshot() {
    const now = Date.now();
    const fills = this.fills, sets = this.settlements;
    const winners = new Map(sets.map(s => [s.slug, s.winner] as const));
    const judged = fills.filter(f => winners.has(f.slug));
    const wins = judged.filter(f => winners.get(f.slug) === f.side).length;
    const sizes = fills.map(f => f.notional).sort((a, b) => a - b);
    const realized = sets.reduce((a, s) => a + s.pnl, 0);
    let unreal = 0, openCost = 0;
    for (const m of this.markets.values()) if (!m.settled && m.fair) {
      unreal += m.inv.up.shares * m.fair.pUp + m.inv.down.shares * (1 - m.fair.pUp) - m.inv.up.cost - m.inv.down.cost;
      openCost += m.inv.up.cost + m.inv.down.cost;
    }
    const day = 86_400_000;
    const pairSets = sets.filter(s => s.pairs > 0);
    const holdMs = sets.map(s => { const fs = fills.filter(f => f.slug === s.slug); return fs.length ? s.ts - Math.min(...fs.map(f => f.ts)) : 0; });
    const hrs = Math.max(1 / 60, (now - Math.min(this.startedAt, fills[0]?.ts ?? now)) / 3.6e6);

    return {
      now, mode: this.exec.mode, killed: this.killed,
      feeds: {
        binanceSpot: this.stats.size ? Math.min(...[...this.stats.values()].map(s => now - (s.last.spotTs || 0))) : null,
        binancePerp: this.stats.size ? Math.min(...[...this.stats.values()].map(s => now - (s.last.perpTs || 0))) : null,
        clob: this.clob.connected, chainlink: this.cl.status, counts: bus.counts, bytes: bus.bytes,
      },
      assets: [...this.stats.values()].map(s => {
        const r = s.ref(now), cl = this.cl.latest('spot', s.asset), tw = this.cl.latest('twap', s.asset), d = s.drift();
        return {
          asset: s.asset, px: r?.px ?? null, venue: r?.venue ?? null, spot: s.last.spot, perp: s.last.perp,
          cl: cl?.value ?? null, twap: tw?.value ?? null, basisBps: s.basis * 1e4, sigmaBps: s.sigma() * 1e4,
          momBps: d.mom * 1e4 * 15, accelBps: d.accel * 1e4 * 15, ofi: s.ofi(10, now),
          series: s.series.slice(-300).map(p => [p.ts, p.px]),
        };
      }),
      markets: [...this.markets.values()].sort((a, b) => a.info.end - b.info.end).map(m => {
        const bu = this.clob.book(m.info.upId), bd = this.clob.book(m.info.downId);
        const au = bu.bestAsk()?.price ?? null, ad = bd.bestAsk()?.price ?? null;
        const p = m.fair?.pUp ?? null;
        return {
          slug: m.info.slug, asset: m.info.asset, tf: m.info.tf, start: m.info.start, end: m.info.end,
          live: now >= m.info.start && now < m.info.end, K: m.info.priceToBeat, refSource: m.refSource,
          fair: m.fair, block: m.block, accepting: m.info.acceptingOrders, fees: m.info.fees,
          askUp: au, askDown: ad, bidUp: bu.bestBid()?.price ?? null, bidDown: bd.bestBid()?.price ?? null,
          edgeUp: p !== null && au !== null ? p - au - feePerShare(au, m.info.fees) : null,
          edgeDown: p !== null && ad !== null ? 1 - p - ad - feePerShare(ad, m.info.fees) : null,
          setCost: au !== null && ad !== null ? au + ad : null,
          inv: m.inv, avgUp: avg(m.inv.up), avgDown: avg(m.inv.down),
          pairs: Math.min(m.inv.up.shares, m.inv.down.shares), settled: m.settled,
          booksUp: { asks: bu.askLevels().slice(0, 8), bids: bu.bidLevels().slice(0, 8) },
          booksDown: { asks: bd.askLevels().slice(0, 8), bids: bd.bidLevels().slice(0, 8) },
          hist: m.hist.slice(-300),
        };
      }),
      tape: fills.slice(-80).reverse(),
      settlements: sets.slice(-40).reverse(),
      wire: bus.wire.slice(-80).reverse(),
      stats: {
        realized, unrealized: unreal, openCost,
        trades24h: fills.filter(f => now - f.ts < day).length, trades: fills.length,
        winRate: judged.length ? wins / judged.length : null,
        marketWinRate: sets.length ? sets.filter(s => s.pnl > 0).length / sets.length : null,
        avgTrade: sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : null,
        medTrade: sizes.length ? sizes[Math.floor(sizes.length / 2)] : null,
        avgHoldSec: holdMs.length ? holdMs.reduce((a, b) => a + b, 0) / holdMs.length / 1000 : null,
        fillsPerHr: fills.length / hrs,
        avgEdge: fills.length ? fills.reduce((a, f) => a + f.edge, 0) / fills.length : null,
        pairsUnder1: pairSets.length ? pairSets.filter(s => (s.pairCost ?? 2) < 1).length / pairSets.length : null,
        avgPairCost: pairSets.length ? pairSets.reduce((a, s) => a + (s.pairCost ?? 0), 0) / pairSets.length : null,
        hedgedShare: (() => { const t = sets.reduce((a, s) => a + s.upShares + s.downShares, 0); return t ? sets.reduce((a, s) => a + 2 * s.pairs, 0) / t : null; })(),
        equity: sets.reduce<[number, number][]>((acc, s) => { acc.push([s.ts, (acc.length ? acc[acc.length - 1][1] : 0) + s.pnl]); return acc; }, []),
        byReason: ['entry', 'hedge', 'pair'].map(r => ({ r, n: fills.filter(f => f.reason === r).length })),
      },
    };
  }
}
