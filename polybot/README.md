# Polybot — Polymarket crypto Up/Down engine

Directional + dynamic-hedge bot for Polymarket's short-term crypto Up/Down markets (BTC/ETH/SOL/XRP, 5m + 15m), modelled on the `antsaslyku` playbook:

1. **Fair value from fast feeds.** Binance perp/spot aggTrades lead; Chainlink (via Polymarket PolyBolt) anchors the settlement basis. The model prices `P(final TWAP ≥ price-to-beat)` from distance to the reference, momentum, acceleration, EWMA volatility, time left and taker-flow imbalance.
2. **Edge after fees.** `edge = p_model − ask − takerFee(ask)`. Buys while edge ≥ `MIN_EDGE`, walking the book only through levels that still clear it.
3. **Opposite-side hedging.** When fair value swings to the other side, it buys the opposite outcome to cut net exposure; whenever `avgCost(held) + allInCost(other) ≤ PAIR_TARGET` it completes sets below $1. Matched pairs are hedged, the remainder stays directional. Risk-reducing buys always take priority over new entries.

Everything on the dashboard streams from real feeds. There is no simulated market data anywhere.

## Facts this is built on (checked 2026-10-10)

| Fact | Source |
|---|---|
| Up/Down resolve on Chainlink **60s TWAP**: price-to-beat = TWAP at window start, final = TWAP at window end; tie → Up | Polymarket changelog (Aug 7 & Aug 14 2026), live market description |
| `priceToBeat` / `finalPrice` live in `events[0].eventMetadata`; tick 0.001, min size 5 | Live Gamma response for `btc-updown-15m-1791582300` |
| Crypto taker fee = `0.07 × p(1−p)` per share (1.75¢ at 50¢), makers free | docs.polymarket.com/trading/fees, live `feeSchedule` |
| Crypto taker delay 150ms (since Sep 4 2026) | Polymarket changelog |
| Order placement via `@polymarket/client` 0.13 `placeMarketOrder` (FAK, `maxPrice`, `maxSpend`) | SDK type definitions |
| **Australia (AU) is blocked from placing orders** | docs.polymarket.com/api-reference/geoblock; ACMA block Aug 2025 |

Because settlement is a 60s average, the model is TWAP-aware: with τ ≥ 60s the final value's st.dev is `Sσ√(τ − 40)`; inside the last minute the already-printed part of the average is locked in and only `τ/60` of the result is still random. Snapshot-price models misprice the final minute badly.

## Run

Requires Node 24+ (SDK requirement).

```bash
npm install
cp .env.example .env      # add a throwaway SIGNER_PRIVATE_KEY for the Chainlink stream
npm start                 # dashboard → http://127.0.0.1:8787
npm test                  # model, fee, book and decision tests
```

### Modes

- **shadow** (default): live Binance, CLOB books and Chainlink; no orders. After `SHADOW_LATENCY_MS` (network + taker delay) each intended FAK order is walked against the *current* live book, and liquidity it takes is marked used until that level changes. It can't see queue competition from other bots, so shadow P&L is an upper bound. Logs go to `data/shadow-*.jsonl`.
- **live**: needs `LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY`, signer key, wallet address and relayer key. On boot it calls Polymarket's geoblock endpoint and **refuses to start if the connection is blocked**, runs `setupTradingApprovals()`, then trades with FAK market buys capped by `maxPrice` + `maxSpend`, and redeems on resolution.

Without a Chainlink stream the bot still computes and displays fair value but **won't trade** (`ALLOW_NO_CHAINLINK=1` overrides): Binance quotes USDT while settlement is USD, and that basis is the same size as a minute of BTC noise.

## Risk controls

Per-window spend cap, net-share cap, edge-scaled clip size, no new risk in the last 15s, no trading in the last 3s, stale-feed guards (spot 1.5s, book 5s), per-market cooldown, one order in flight per market, daily realized-loss kill switch, restart-safe inventory rebuild from the fill log.

## Layout

```
src/feeds/      binance.ts (spot+perp aggTrade) · clob.ts (L2 books, trades, resolutions) · chainlink.ts (PolyBolt spot + 60s TWAP)
src/markets/    discovery.ts — slug math, Gamma parsing, price-to-beat
src/model/      stats.ts (vol, momentum, flow, basis) · fair.ts (TWAP fair value, fee curve)
src/strategy/   decide.ts — entry / hedge / pair-completion logic (pure, unit-tested)
src/exec/       executor.ts — Shadow + Live executors
src/engine.ts   orchestration, settlement, stats, dashboard snapshot
public/         index.html — terminal dashboard (WS, 4 Hz)
```

## Not verified from the build environment

The build sandbox had no route to Binance or Polymarket, so the live WebSocket feeds, PolyBolt auth with a throwaway key, and live order flow have not been exercised end-to-end. The Gamma parser and fee curve are checked against real responses and docs. First run: start in shadow, watch the wire inspector for `clob:book`, `binance` and `chainlink` traffic, and confirm `price to beat` populates with source `gamma`.

Not financial advice. Short-horizon taker strategies on these markets are crowded; fees and the taker delay were introduced specifically to tax them.
