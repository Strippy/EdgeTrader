import { CFG, assertConfig } from './config.js';
import { log } from './bus.js';
import { startBinance } from './feeds/binance.js';
import { HyperliquidFeed, fetchMeta } from './feeds/hyperliquid.js';
import { Engine } from './engine.js';
import { LiveExecutor, ShadowExecutor, type Executor } from './exec/executor.js';
import { startServer } from './server.js';

async function main() {
  assertConfig();
  let meta: Awaited<ReturnType<typeof fetchMeta>> | null = null;
  for (let i = 0; !meta; i++) {
    try { meta = await fetchMeta(); }
    catch (e: any) { const wait = Math.min(30_000, 2000 * 2 ** i); log('warn', 'main', `Hyperliquid meta unreachable (${e?.cause?.code ?? e?.message}); retry in ${wait / 1000}s`); await new Promise(r => setTimeout(r, wait)); }
  }
  const hl = new HyperliquidFeed(CFG.coins.filter(c => meta.has(c)));
  const exec: Executor = CFG.mode === 'live' ? new LiveExecutor() : new ShadowExecutor(hl.books);
  await exec.ready(meta);
  hl.onTrade = t => exec.onTrade?.(t);
  hl.onBook = b => exec.onBook?.(b);
  hl.start();
  const engine = new Engine(exec, hl, meta);
  if (CFG.signalSource === 'hl') {
    hl.onTradeAsTick = t => engine.onTick({ asset: t.coin.toLowerCase(), venue: 'hl', price: t.px, qty: t.sz, ts: t.time, buyAggressor: t.side === 'B' });
    log('info', 'main', 'SIGNAL_SOURCE=hl: no Binance feeds started — Hyperliquid trade tape is the only reference');
  } else {
    startBinance([...engine.coins.keys()].map(c => c.toLowerCase()), t => engine.onTick(t));
  }
  engine.start();
  startServer(engine as any);
  log('info', 'main', `mode=${CFG.mode.toUpperCase()} coins=${[...engine.coins.keys()].join(',')} clip=$${CFG.clipUsd} take≥${CFG.takeEdgeBps}bp make≥${CFG.makeEdgeBps}bp`);
  const bye = () => { log('info', 'main', 'shutdown'); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

main().catch(e => { log('error', 'main', e?.stack ?? String(e)); process.exit(1); });
