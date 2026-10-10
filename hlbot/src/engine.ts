import { CFG } from './config.js';
import { bus, log } from './bus.js';
import { AssetStats } from './model/stats.js';
import { Ema, LeadLag, fairPrice } from './model/signal.js';
import { decide, edges, roundPx, type Action, type Edges, type Position, type Working } from './strategy/decide.js';
import { applyFill } from './strategy/position.js';
import { HyperliquidFeed, mid, type AssetMeta } from './feeds/hyperliquid.js';
import type { Executor, Fill } from './exec/executor.js';
import { append, load, type RoundTrip } from './store.js';
import type { Tick } from './feeds/binance.js';

type Trip = { openedAt: number; dir: 'long' | 'short'; maxSz: number; entryPx: number; realized: number; fees: number; maker: boolean; exitReason: string };

type CoinState = {
  coin: string; meta: AssetMeta; stats: AssetStats;
  basis: Ema; leadlag: LeadLag;
  pos: Position; working: Working; busy: boolean; lastActionAt: number;
  fair: number | null; edges: Edges | null; block: string;
  trip: Trip | null;
  hist: { t: number; mid: number; fair: number; binEq: number; bid: number; ask: number }[];
};

export class Engine {
  coins = new Map<string, CoinState>();
  fills: Fill[];
  trips: RoundTrip[];
  killed: string | null = null;
  startedAt = Date.now();

  constructor(public exec: Executor, public hl: HyperliquidFeed, meta: Map<string, AssetMeta>) {
    const hlOnly = CFG.signalSource === 'hl';
    if (hlOnly) log('info', 'engine', 'signal=hyperliquid-only: no external reference price — experimental, live disabled');
    for (const c of CFG.coins) {
      const m = meta.get(c);
      if (!m) { log('warn', 'engine', `${c} not in Hyperliquid perp universe — skipped`); continue; }
      this.coins.set(c, {
        coin: c, meta: m, stats: new AssetStats(c.toLowerCase()), basis: new Ema(CFG.basisHalfLife), leadlag: new LeadLag(200, 15, 3000),
        pos: { sz: 0, avgPx: 0, openedAt: 0 }, working: null, busy: false, lastActionAt: 0, fair: null, edges: null, block: 'warming up', trip: null, hist: [],
      });
    }
    if (process.env.DATA_FRESH === '1' && exec.mode === 'shadow') {
      // In-memory only. Does NOT touch disk. Files still grow — use DATA_DIR to isolate sessions.
      this.fills = []; this.trips = [];
      log('info', 'engine', 'DATA_FRESH=1 (shadow only): skipping load of prior runs. Disk files unchanged.');
    } else if (process.env.DATA_FRESH === '1') {
      log('warn', 'engine', 'DATA_FRESH=1 ignored in live mode (restarts must preserve loss accounting).');
      this.fills = load<Fill>('fills', exec.mode);
      this.trips = load<RoundTrip>('trips', exec.mode);
    } else {
      this.fills = load<Fill>('fills', exec.mode);
      this.trips = load<RoundTrip>('trips', exec.mode);
      if (this.trips.length || this.fills.length)
        log('info', 'engine', `resumed ${this.trips.length} trips / ${this.fills.length} fills from prior runs (DATA_FRESH=1 to reset)`);
    }
    exec.onMakerFill = (f) => this.onFill(f, true);
    if (exec.mode === 'live') log('warn', 'engine', 'live: positions start flat in memory — close any existing positions on these coins before starting');
  }

  onTick(t: Tick) { this.coins.get(t.asset.toUpperCase())?.stats.onTick(t); }

  start() {
    setInterval(() => this.sample(), 200);
    setInterval(() => this.everySecond(), 1000);
    setInterval(() => { for (const s of this.coins.values()) this.evaluate(s); }, 100);
  }

  private sample() {
    const now = Date.now();
    if (CFG.signalSource === 'hl') return; // no cross-venue basis or lead-lag in HL-only mode
    for (const s of this.coins.values()) {
      const r = s.stats.ref(now), m = mid(this.hl.books.get(s.coin));
      if (!r || !(m > 0) || now - r.ts > CFG.staleSpotMs) continue;
      s.basis.update(Math.log(m / r.px), now);
      s.leadlag.push(r.px, m);
    }
  }

  private everySecond() {
    const now = Date.now();
    for (const s of this.coins.values()) {
      s.stats.sample(now);
      const b = this.hl.books.get(s.coin), r = s.stats.ref(now);
      if (b && r) s.hist.push({ t: now, mid: mid(b), fair: s.fair ?? NaN, binEq: r.px * Math.exp(s.basis.v || 0), bid: b.bids[0]?.price ?? NaN, ask: b.asks[0]?.price ?? NaN });
      if (s.hist.length > 600) s.hist.shift();
    }
    const day = new Date().toISOString().slice(0, 10);
    const today = this.trips.filter(t => new Date(t.closedAt).toISOString().slice(0, 10) === day).reduce((a, t) => a + t.net, 0);
    if (!this.killed && today < -CFG.dailyLossLimit) { this.killed = `daily net ${today.toFixed(2)} < -${CFG.dailyLossLimit}`; log('error', 'risk', `KILL SWITCH: ${this.killed}`); }
  }

  private evaluate(s: CoinState) {
    const now = Date.now();
    const b = this.hl.books.get(s.coin);
    const r = s.stats.ref(now);
    const staleBook = !b || now - b.recvAt > CFG.staleBookMs;
    const staleSignal = !r || now - r.ts > CFG.staleSpotMs;
    if (staleBook) s.block = 'HL book stale';

    // ---- Risk / cancellation handling runs on EVERY tick, not gated by signal or book freshness ----
    // A stale signal or stale book must never leave a real working order on the exchange.
    if (s.busy) { s.block = 'order in flight'; return; }
    // Working-order TTL cancels depend on nothing but our own clock — fire even if the book is stale.
    if (s.working && now - s.working.placedAt > CFG.makerTtlMs) {
      this.act(s, { kind: 'cancel', reason: 'ttl' });
      return;
    }
    if (this.killed) {
      // cancel first if quoting; otherwise flatten using live HL prices
      if (s.working) { this.act(s, { kind: 'cancel', reason: 'kill' }); return; }
      if (s.pos.sz !== 0 && !staleBook && b) {
        const bid = b.bids[0]?.price, ask = b.asks[0]?.price;
        if (bid > 0 && ask > 0) {
          this.act(s, { kind: 'exit', side: s.pos.sz > 0 ? 'sell' : 'buy', sz: Math.abs(s.pos.sz), limitPx: s.pos.sz > 0 ? roundPx(bid * 0.999, s.meta.szDecimals, 'down') : roundPx(ask * 1.001, s.meta.szDecimals, 'up'), reason: 'stop' });
          return;
        }
      }
      s.block = `killed: ${this.killed}`;
      return;
    }

    // ---- Signal-gated normal path ----
    if (staleBook) return;
    const bid = b.bids[0]?.price, ask = b.asks[0]?.price;
    if (!(bid > 0 && ask > bid)) { s.block = 'no book'; return; }

    // Book-based risk exits (stop, max-hold) depend only on HL prices —
    // run them even when the reference signal is stale, so a signal outage can't trap a position.
    // Priority (matches decide()): cancel any working order first, then manage the position.
    if (s.working && s.pos.sz !== 0) { this.act(s, { kind: 'cancel', reason: 'position open' }); return; }
    if (s.working && !staleSignal) {
      const best = s.working.side === 'buy' ? bid : ask;
      if (Math.abs(s.working.px - best) > 1e-12) { this.act(s, { kind: 'cancel', reason: 'requote' }); return; }
    }
    if (s.pos.sz !== 0) {
      const long = s.pos.sz > 0;
      const pnlBps = ((long ? bid - s.pos.avgPx : s.pos.avgPx - ask) / s.pos.avgPx) * 1e4;
      if (pnlBps < -CFG.stopBps) {
        if (!s.busy) this.act(s, { kind: 'exit', side: long ? 'sell' : 'buy', sz: Math.abs(s.pos.sz), limitPx: long ? roundPx(bid * (1 - 5e-4), s.meta.szDecimals, 'down') : roundPx(ask * (1 + 5e-4), s.meta.szDecimals, 'up'), reason: 'stop' });
        return;
      }
      if ((now - s.pos.openedAt) / 1000 > CFG.maxHoldSec) {
        if (!s.busy) this.act(s, { kind: 'exit', side: long ? 'sell' : 'buy', sz: Math.abs(s.pos.sz), limitPx: long ? roundPx(bid * (1 - 5e-4), s.meta.szDecimals, 'down') : roundPx(ask * (1 + 5e-4), s.meta.szDecimals, 'up'), reason: 'time' });
        return;
      }
    }

    if (staleSignal) { s.block = 'HL book stale (no signal)'; return; }
    if (CFG.signalSource === 'binance' && s.basis.n < 50) { s.block = `calibrating basis ${s.basis.n}/50`; return; }
    if (CFG.signalSource === 'binance' && s.stats.series.length < 30) { s.block = 'warming momentum'; return; }

    const d = s.stats.drift();
    const fairBasis = CFG.signalSource === 'hl' ? 0 : s.basis.v;
    s.fair = fairPrice({ binanceRef: r.px, basisLog: fairBasis, mu: d.mu, horizonSec: CFG.horizonSec, ofi: s.stats.ofi(10, now), ofiWeightBps: CFG.ofiWeightBps });
    s.edges = edges({ fair: s.fair, bid, ask, pos: s.pos }, CFG);

    let a: Action | null;
    {
      const gross = [...this.coins.values()].reduce((acc, c) => acc + Math.abs(c.pos.sz) * (mid(this.hl.books.get(c.coin)) || 0), 0);
      a = decide({ fair: s.fair, bid, ask, pos: s.pos, working: s.working, now, grossUsd: gross, szDecimals: s.meta.szDecimals }, CFG);
      s.block = a ? '' : s.working ? 'quoting' : 'no edge';
    }
    if (!a) return;
    if (a.kind !== 'cancel' && a.kind !== 'exit' && now - s.lastActionAt < CFG.cooldownMs) { s.block = 'cooldown'; return; }
    this.act(s, a);
  }

  private async act(s: CoinState, a: Action) {
    s.busy = true; s.lastActionAt = Date.now();
    try {
      if (a.kind === 'cancel') {
        if (s.working?.oid !== undefined) await this.exec.cancel(s.coin, s.working.oid);
        bus.wireEvent('exec', 'cancel', `${s.coin} ${s.working?.side} @${s.working?.px} (${a.reason})`);
        s.working = null;
      } else if (a.kind === 'make') {
        const oid = await this.exec.make(s.coin, a.side, a.sz, a.px, a.edgeBps);
        if (oid !== null) { s.working = { side: a.side, px: a.px, sz: a.sz, placedAt: Date.now(), oid }; bus.wireEvent('exec', 'quote', `${s.coin} ALO ${a.side} ${a.sz}@${a.px} edge ${a.edgeBps.toFixed(1)}bp`); }
      } else {
        const reason = a.kind === 'exit' ? a.reason : 'entry';
        const f = await this.exec.take(s.coin, a.side, a.sz, a.limitPx, a.kind === 'exit', reason, a.kind === 'take' ? a.edgeBps : (s.edges?.hold ?? 0));
        if (f) this.onFill(f, false); else bus.wireEvent('exec', 'nofill', `${s.coin} IOC ${a.side} ${a.sz}@${a.limitPx}`);
      }
    } catch (e: any) { log('error', 'exec', `${s.coin}: ${e?.message ?? e}`); }
    finally { s.busy = false; }
  }

  private onFill(f: Fill, maker: boolean) {
    const s = this.coins.get(f.coin); if (!s) return;
    const wasFlat = s.pos.sz === 0;
    const r = applyFill(s.pos, f.side, f.sz, f.px, f.ts);
    if (wasFlat) s.trip = { openedAt: f.ts, dir: f.side === 'buy' ? 'long' : 'short', maxSz: 0, entryPx: f.px, realized: 0, fees: 0, maker, exitReason: '' };
    if (s.trip) { s.trip.realized += r.realized; s.trip.fees += f.fee; s.trip.exitReason = f.reason; }
    s.pos = r.pos;
    if (s.trip) { s.trip.maxSz = Math.max(s.trip.maxSz, Math.abs(s.pos.sz)); if (s.pos.sz !== 0 && r.closedSz === 0) s.trip.entryPx = s.pos.avgPx; }
    if (maker && s.working) { s.working.sz -= f.sz; if (s.working.sz <= 1e-12) s.working = null; }
    this.fills.push(f); append('fills', this.exec.mode, f);
    bus.wireEvent('fill', f.liquidity, `${f.coin} ${f.side.toUpperCase()} ${f.sz}@${f.px} ${f.reason} fee $${f.fee.toFixed(3)}`);
    // trip closed (flat) or flipped
    if (s.trip && (s.pos.sz === 0 || (r.closedSz > 0 && Math.sign(s.pos.sz) !== (s.trip.dir === 'long' ? 1 : -1)))) {
      const t = s.trip;
      const rt: RoundTrip = { mode: this.exec.mode, coin: s.coin, dir: t.dir, openedAt: t.openedAt, closedAt: f.ts, sz: t.maxSz || r.closedSz, entryPx: t.entryPx, exitPx: f.px, pnl: t.realized, fees: t.fees, net: t.realized - t.fees, exitReason: t.exitReason, makerEntry: t.maker };
      this.trips.push(rt); append('trips', this.exec.mode, rt);
      bus.wireEvent('trip', rt.net >= 0 ? 'win' : 'loss', `${s.coin} ${rt.dir} ${rt.exitReason} net ${rt.net >= 0 ? '+' : ''}$${rt.net.toFixed(2)}`);
      s.trip = s.pos.sz !== 0 ? { openedAt: f.ts, dir: s.pos.sz > 0 ? 'long' : 'short', maxSz: Math.abs(s.pos.sz), entryPx: f.px, realized: 0, fees: 0, maker: false, exitReason: '' } : null;
    }
  }

  snapshot() {
    const now = Date.now();
    const trips = this.trips, fills = this.fills;
    const net = trips.reduce((a, t) => a + t.net, 0);
    let unreal = 0;
    const coins = [...this.coins.values()].map(s => {
      const b = this.hl.books.get(s.coin), m = mid(b), r = s.stats.ref(now), d = s.stats.drift();
      const u = s.pos.sz !== 0 && m > 0 ? s.pos.sz * (m - s.pos.avgPx) : 0; unreal += u;
      const ll = s.leadlag.corr();
      let peak = 0; ll.forEach((c, k) => { if (Number.isFinite(c) && c > (ll[peak] ?? -1)) peak = k; });
      return {
        coin: s.coin, mid: m, bid: b?.bids[0]?.price ?? null, ask: b?.asks[0]?.price ?? null,
        bookAgeMs: b ? now - b.recvAt : null, binance: r?.px ?? null, venue: r?.venue ?? null, signalSource: CFG.signalSource,
        basisBps: (s.basis.v || 0) * 1e4, fair: s.fair, fairBps: s.fair && m ? (s.fair / m - 1) * 1e4 : null, edges: s.edges,
        sigmaBps: s.stats.sigma() * 1e4, momBps: d.mom * 15 * 1e4, ofi: s.stats.ofi(10, now),
        pos: s.pos, unreal: u, working: s.working, block: s.block,
        leadlag: CFG.signalSource === 'hl' ? [] : ll, leadMs: CFG.signalSource === 'hl' ? null : peak * 200, llSamples: s.leadlag.samples,
        books: { bids: b?.bids.slice(0, 8) ?? [], asks: b?.asks.slice(0, 8) ?? [] },
        hist: s.hist.slice(-300),
      };
    });
    const day = 86_400_000;
    const wins = trips.filter(t => t.net > 0).length;
    const sizes = fills.map(f => f.sz * f.px).sort((a, b) => a - b);
    const hrs = Math.max(1 / 60, (now - Math.min(this.startedAt, fills[0]?.ts ?? now)) / 3.6e6);
    return {
      now, mode: this.exec.mode, killed: this.killed,
      feeds: { hl: this.hl.connected, counts: bus.counts, bytes: bus.bytes },
      coins,
      tape: fills.slice(-80).reverse(),
      trips: trips.slice(-60).reverse(),
      wire: bus.wire.slice(-80).reverse(),
      stats: {
        net, unreal, gross: trips.reduce((a, t) => a + t.pnl, 0), fees: trips.reduce((a, t) => a + t.fees, 0),
        trips: trips.length, trips24h: trips.filter(t => now - t.closedAt < day).length, fills: fills.length,
        winRate: trips.length ? wins / trips.length : null,
        avgNet: trips.length ? net / trips.length : null,
        avgHoldSec: trips.length ? trips.reduce((a, t) => a + (t.closedAt - t.openedAt), 0) / trips.length / 1000 : null,
        makerShare: fills.length ? fills.filter(f => f.liquidity === 'maker').length / fills.length : null,
        avgFill: sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : null,
        medFill: sizes.length ? sizes[Math.floor(sizes.length / 2)] : null,
        fillsPerHr: fills.length / hrs,
        netBpsPerTrip: trips.length ? trips.reduce((a, t) => a + t.net / (t.sz * t.entryPx || 1) * 1e4, 0) / trips.length : null,
        byExit: ['signal', 'time', 'stop', 'flip'].map(r => ({ r, n: trips.filter(t => t.exitReason === r).length, net: trips.filter(t => t.exitReason === r).reduce((a, t) => a + t.net, 0) })),
        equity: trips.reduce<[number, number][]>((acc, t) => { acc.push([t.closedAt, (acc.length ? acc[acc.length - 1][1] : 0) + t.net]); return acc; }, []),
      },
    };
  }
}
