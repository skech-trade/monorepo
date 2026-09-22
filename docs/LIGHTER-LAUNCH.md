# Live charts and launching Skech on Lighter

Reviewed 2026-09-22. This is an implementation and deployment plan, not a mainnet-readiness certification.

## Market data

Keep the existing architecture for the first release:

```text
Lighter mainnet trade WebSocket (read-only reference chart)
  → persistent Bun feed service (one subscription per market)
  → aggregate 500ms bars; publish forming-bar changes immediately
  → WebSocket to browsers
  → replace the current timestamp; append only a new timestamp
```

The chart now uses public mainnet BTC trade observations for both account modes, labeled as a reference chart. Testnet mark updates proved too infrequent for subsecond candles. Execution and P&L still use the selected account network; chart prices must not substitute for actual fills or account marks. Mainnet data is read-only and does not enable mainnet trading. Predictions retain their chart anchor separately from execution entry, so a price difference cannot flip the intended opening direction.

500ms candles do not mean only two price updates per second. The interval defines the time bucket, while trades can update its high, low, close and volume many times. The feed publishes each incoming trade batch immediately; the browser coalesces updates per animation frame. This does not guarantee a particular end-to-end venue latency.

The browser now connects to `/ws` on the configured `NEXT_PUBLIC_FEED_URL`, converting HTTP/HTTPS to WS/WSS automatically. Reconnects back off with jitter and reseed history; application heartbeats detect silent connections. The server bounds slow-client buffers to 256KB and checks configured origins. The existing SSE endpoint remains for older clients. Keep the feed on a persistent service whose proxy supports WebSocket upgrades. Signed order submission remains HTTP.

No paid account upgrade is needed for public trade data. No separate faster public-data endpoint was identified in Lighter's documentation. Deploy near the venue and measure real latency before making speed claims.

The current custom SVG is bounded to a few hundred candles. Measure frame time and pointer latency before replacing it. For a multi-market terminal or thousands of visible candles, use the existing Lightweight Charts dependency, update its series incrementally, and place the prediction overlay on the same coordinate transform. Do not rebuild a chart or call setData for every tick.

Implemented in this change:

- Immediate forming-bar publication, including the final previous bar, with browser rendering coalesced per frame.
- Outbound WebSocket keepalive every 30 seconds.
- Short browser histories grow, reconnect snapshots replace history, and same-second updates replace existing candles without advancing the round.
- No generated market data or simulated results in the active app. Unconfigured/offline data shows a waiting state; signed-out or disconnected trading is disabled. The legacy simulated desk route redirects to the live drawing screen.
- Visible-candle scaling, a stable scale during pointer drawing, price ticks, a clear drawing prompt, and keyboard editing of prediction handles.

Remaining work before relying on this feed for production:

- Persist 500ms bars so a feed process restart has genuine history immediately. In-memory history currently warms up after startup; the UI explicitly reports this.
- Trade IDs are now deduplicated across reconnects within a bounded in-memory window, upstream pings receive pongs, and the candle clock stops while disconnected. Still recover missing trade ranges and measure stale-but-connected upstreams; browser transport connectivity alone does not establish upstream health.
- WebSocket backpressure limits are implemented; extend equivalent limits to legacy SSE if retained in production. Measure source timestamp → receive timestamp → publication → browser paint latency, including p95/p99.
- For ordinary minute/hour charts, bootstrap historical data with the official candles endpoint. Do not manufacture second-level history from minute OHLC.

Sources: [WebSocket protocol and keepalive](https://apidocs.lighter.xyz/docs/websocket-reference), [historical candles](https://apidocs.lighter.xyz/reference/candles), [rate limits](https://apidocs.lighter.xyz/docs/rate-limits).

## Hosting cost

WebSocket is a transport protocol, not a subscription to purchase. Hosting, bandwidth, durable state and monitoring determine the bill. No paid data vendor is proposed here.

For one developer and a small beta, allow roughly **$40–100/month** for the UI plus persistent feed/trader/API services and a small database. This is a planning estimate, not a measured quote; it excludes trading fees, gas, domains, paid auth overages and development/security-review work.

- [Vercel Pro](https://vercel.com/docs/plans/pro-plan): $20/month platform fee including one deploying seat, plus usage beyond allocations/credits.
- [Railway pricing](https://docs.railway.com/pricing): Hobby $5 minimum; Pro $20 minimum for production teams. Usage counts toward the minimum rather than being fully additive. Listed resource rates: RAM $10/GB/month, CPU $20/vCPU/month, egress $0.05/GB, volumes $0.15/GB/month.

Illustrative payload-only bandwidth: 250 bytes/update × 10 updates/sec × 100 average concurrent viewers × 30 days ≈ 648GB/month. At $0.05/GB this is $32.40 of egress usage before protocol overhead, extra stats events or compression. Ten average viewers is one tenth that. Publish only changed candles and reduce publication frequency if measurements justify it.

Lighter documents free, application-reviewed Builder accounts for higher read-only REST limits. They do not increase trading transaction limits. Apply through official Discord support if needed; a Builder account is not a prerequisite for this small public-data stream. [Source](https://apidocs.lighter.xyz/docs/rate-limits).

## Shipping a Lighter Core frontend

Host Skech as an ordinary web application that talks to Lighter's API/sequencer and signs supported transactions. This does not require deploying the React UI or a new exchange contract into Lighter Core. Core provides the exchange execution/proof/settlement infrastructure. [Architecture](https://docs.lighter.xyz/about-lighter/technical-architecture-coming-soon).

The repository already has market data, wallet onboarding, per-wallet API-key registration, a native signer, round-to-order execution, and position/P&L reads. Keep the server runner for timed exits that must survive a closed browser tab.

Before mainnet, address these concrete gaps found in the current code:

1. **Authenticate trading requests and authorize ownership.** `services/trader/src/index.ts` accepts an address in POST /rounds and looks up its stored signer without verifying the caller. Round reads and closes also lack ownership checks. Use an authenticated wallet session, CSRF protection where applicable, and per-round authorization. CORS is not authentication.
2. **Protect keys and explain their real permissions.** `services/trader/src/keys.ts` stores the API private key directly in a text column. Use envelope encryption with a separately managed key, restrict signer access, and support revocation/rotation. Existing comments saying API keys cannot withdraw are inaccurate: Lighter documents secure withdrawals to the owning L1 address; arbitrary-address withdrawals/transfers require additional L1 authorization. [API-key permissions](https://apidocs.lighter.xyz/docs/api-keys).
3. **Extend crash recovery.** Round state and completed results now persist in Postgres. Restored unfinished rounds stop opening orders and require explicit closure; unknown existing positions are visible with a close action. Continue testing failures between transaction submission and durable order acknowledgement. Do not claim fully automatic crash recovery.
4. **Use venue acknowledgements and fills for trade state.** Draw now waits for the runner acknowledgement and uses confirmed fills for markers and realized P&L, adding venue unrealized P&L while open. Closing remains pending until the venue is flat and fills reconcile. Continue live testnet acceptance coverage for partial fills, entry-price presentation and stop/target behavior; protection is server-managed.
5. **Keep network selection consistent.** Execution follows SKECH_NETWORK; chart data is explicitly labeled mainnet reference data. Preserve that separation in fills, P&L and history. Verify account and endpoint overrides before deployment.
6. **Run a testnet acceptance pass, then a constrained mainnet release.** Cover wallet/key registration, deposits, a small open/close, rejected orders, disconnects, server restarts, withdrawal/revocation and concurrent requests. No live orders or deployment were performed in this task.

Host the Next.js UI on Vercel and the always-on Bun/native-signer services plus durable database on Railway or an equivalent container host. Configure HTTPS, exact UI origins, secrets and network selection, then verify the above flows before public mainnet availability.

Fast charts do not remove venue execution delays. Current [account-type documentation](https://apidocs.lighter.xyz/docs/account-types) lists 300ms Standard taker latency and 140ms Premium taker latency at the base premium tier, with different fee schedules. These are venue parameters, not an end-to-end execution guarantee. Do not change account tier merely to improve chart rendering.
