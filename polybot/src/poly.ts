import { createSecureClient, relayerApiKey } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { CFG } from './config.js';
import { log } from './bus.js';

export type Secure = Awaited<ReturnType<typeof createSecureClient>>;
let cached: Promise<Secure> | null = null;

/**
 * Authenticated SDK client. Needed for (a) live trading and (b) PolyBolt Chainlink reference
 * prices, which require CLOB credentials. Returns null when no signer key is configured.
 */
export function secureClient(): Promise<Secure> | null {
  if (!CFG.signerKey) return null;
  if (!cached) {
    const signer = privateKey(CFG.signerKey);
    cached = (async () => {
      const wallet = CFG.wallet ?? (await signer.getAddress());
      const apiKey = CFG.relayerKey && CFG.relayerKeyAddress
        ? relayerApiKey({ key: CFG.relayerKey, address: CFG.relayerKeyAddress })
        : undefined;
      const c = await createSecureClient({ signer, wallet, ...(apiKey ? { apiKey } : {}) } as any);
      log('info', 'poly', `secure client ready wallet=${wallet}`);
      return c;
    })();
    cached.catch(e => { log('error', 'poly', `secure client failed: ${e?.message ?? e}`); cached = null; });
  }
  return cached;
}

/** Polymarket's own geoblock check (https://polymarket.com/api/geoblock). */
export async function geoblock(): Promise<{ blocked: boolean; country?: string; region?: string; ip?: string }> {
  const r = await fetch('https://polymarket.com/api/geoblock', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`geoblock HTTP ${r.status}`);
  return r.json() as any;
}
