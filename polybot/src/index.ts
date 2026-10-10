import { CFG, assertConfig } from './config.js';
import { log } from './bus.js';
import { startBinance } from './feeds/binance.js';
import { ClobFeed } from './feeds/clob.js';
import { ChainlinkFeed } from './feeds/chainlink.js';
import { Engine } from './engine.js';
import { LiveExecutor, ShadowExecutor, type Executor } from './exec/executor.js';
import { startServer } from './server.js';

async function main() {
  assertConfig();
  const exec: Executor = CFG.mode === 'live' ? new LiveExecutor() : new ShadowExecutor();
  await exec.ready(); // live: geoblock check + approvals; throws if blocked

  const clob = new ClobFeed().start();
  const cl = new ChainlinkFeed(CFG.assets).start();
  const engine = new Engine(exec, clob, cl);
  startBinance(CFG.assets, t => engine.onTick(t));
  engine.start();
  startServer(engine);
  log('info', 'main', `mode=${CFG.mode.toUpperCase()} assets=${CFG.assets.join(',')} tf=${CFG.timeframes.join(',')} clip=$${CFG.clipUsd} minEdge=${CFG.minEdge}`);

  const bye = () => { log('info', 'main', 'shutdown'); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

main().catch(e => { log('error', 'main', e?.stack ?? String(e)); process.exit(1); });
