# EdgeTrader

AI buy/sell tool bag of sorts. Each folder is a standalone Node/TypeScript bot with its own live terminal dashboard. All of them run on live market data only, and run in shadow mode (no orders) by default.

| Bot | Venue | Strategy | Status |
|---|---|---|---|
| [`hlbot/`](hlbot) | Hyperliquid perps | Binance → Hyperliquid lead-lag; maker-first entries, fee-aware edge, live lead-lag panel | Primary. Usable from Australia |
| [`polybot/`](polybot) | Polymarket crypto Up/Down (5m/15m) | TWAP-aware fair value from Binance + Chainlink; edge entries, opposite-side hedging into sub-$1 sets | Reference build. Polymarket blocks order placement from AU; live mode refuses when geoblocked |

## Quick start

```bash
cd hlbot            # or polybot
npm install
cp .env.example .env
npm start           # dashboard on 127.0.0.1 (hlbot :8788, polybot :8787)
npm test
```

See each folder's README for the model, risk controls, verified API facts and what hasn't been exercised end-to-end yet.

Not financial advice.
