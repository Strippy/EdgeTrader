# HLBot — Binance → Hyperliquid lead-lag engine

Polybot's engine ported to Hyperliquid perps (BTC/ETH/SOL/XRP). Same core idea: a fast external feed sets fair value, the bot trades only when the venue's price is wrong by more than fees.

- **Fair value:** Binance perp (spot fallback) × slow basis to Hyperliquid, plus shrunk momentum drift over `HORIZON_SEC` and a Binance taker-flow tilt. Fast Binance moves that Hyperliquid hasn't caught up to show up as edge.
- **Edge after fees:** every threshold is net of entry and exit fees (default taker 4.5bp, maker 1.5bp, exit assumed taker).
- **Maker-first:** if only the maker edge clears, it posts an ALO at best bid/ask and requotes or cancels on TTL, edge loss or price move. It crosses the spread (IOC) only when the edge beats taker fees plus `TAKE_EDGE_BPS`.
- **Position management** (the hedge analogue): exits when remaining edge decays, on a stop, at max hold, or flips when the opposite signal clears the take threshold.
- **Lead-lag panel:** rolling correlation of Binance vs Hyperliquid returns at 0–3s lags. It tells you, from live data, whether Binance is currently leading and by how much. If the peak sits at 0ms, there's no latency edge and the bot should mostly sit idle.

## Run

Node 22.12+.

```bash
npm install
cp .env.example .env
npm start            # dashboard → http://127.0.0.1:8788
npm test
```

**shadow** (default): live Binance and Hyperliquid data, no orders. IOC fills walk the live L2 book after `SHADOW_LATENCY_MS`. Maker fills count only when a real print trades *through* the quote, or the book crosses it. It doesn't model queue position, so this errs conservative on maker fills. It still can't see adverse selection beyond that. Logs go to `data/shadow-*.jsonl`.

**live**: `LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY`, plus an API/agent wallet key (can trade, can't withdraw) and your account address. Sets cross leverage per coin, books maker fills from the `userFills` stream and IOC fills from order responses. Start with no open positions on those coins; the bot assumes it starts flat.

## Verified (2026-10-10)

| Item | Source |
|---|---|
| WS `wss://api.hyperliquid.xyz/ws`; `l2Book`/`trades` formats | HL docs: websocket + subscriptions |
| Price rules: ≤5 sig figs, ≤ 6−szDecimals decimals; size to szDecimals | HL docs: tick and lot size |
| Base fees: taker 0.045%, maker 0.015% | HL docs: fees |
| Limits: 1200 weight/min/IP; 1 action per $1 traded + 10k buffer | HL docs: rate limits |
| Order/cancel/leverage/userFills calls and response shapes | `@nktkas/hyperliquid` 0.33.3 types |
| Australia not on Hyperliquid's restricted list (US, Ontario, sanctioned) | Coinperps summary of HL terms |

## Not verified from the build environment

The build sandbox couldn't reach Binance or Hyperliquid, so the live feeds and order calls haven't run end-to-end. Logic, rounding, position accounting, fill simulation and lead-lag detection are unit-tested (10 tests), and the dashboard was smoke-tested. First run: watch the wire inspector for `hl-book`/`hl-trades`/`binance` counts and let the lead-lag panel fill (~3 min) before reading anything into results.

## Honest expectations

Hyperliquid is fast and heavily arbitraged against Binance. A round trip costs 6–9bp in fees, close to a typical minute of BTC movement. Expect long idle stretches. Run shadow for days, then judge by **net bp per trip** and **maker share**. Funding isn't counted in shadow P&L; holds are capped at 90s by default, so it's small but not zero.

Not financial advice. Offshore, unlicensed venue: no Australian investor protections apply.

## Experimental: Hyperliquid-only mode (`SIGNAL_SOURCE=hl`)

Binance (binance.com) is geo-blocked from some hosting environments, which blocks the
original cross-venue lead-lag strategy. `SIGNAL_SOURCE=hl` runs the engine on
Hyperliquid's own trade tape as the reference price, with momentum and taker-flow
imbalance computed from Hyperliquid trades.

**This is a different, unproven signal.** There is no external reference venue, so:

- The lead-lag panel is **not applicable** (it reads n/a on the dashboard).
- The fair value is an *experimental projected price*, not an independently
  observed cross-venue fair value.
- **Live execution is hard-disabled** for this mode. `assertConfig()` rejects
  `MODE=live` when `SIGNAL_SOURCE=hl`.

Do not judge the original Binance-lead-lag thesis from this mode's results.

### Run it

```bash
MODE=shadow SIGNAL_SOURCE=hl npx tsx src/index.ts
```

### Tested behavior

- `venue: 'hl'` ticks flow through `AssetStats` and drive `ref()`, `drift()`, `ofi()`.
- A stale HL trade tape yields a null reference and blocks new simulated entries.
- `assertConfig()` rejects live mode when `SIGNAL_SOURCE=hl`.
- The dashboard hides/disables the cross-venue lead-lag panel and the "BINANCE"
  feed chip when in HL-only mode.

Default `STALE_SPOT_MS` is 5000 in HL-only mode (HL trade cadence is lower than
Binance perp's); you can override via env.
