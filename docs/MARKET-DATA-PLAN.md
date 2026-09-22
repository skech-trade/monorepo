# Shared market data and chart history — implementation plan

Draft: 22 September 2026. Proposed work; this document does not implement it.

## Current state

`services/feed/src/lighter.ts` already holds a shared upstream Lighter WebSocket. `services/feed/src/index.ts` broadcasts its data to browser WebSockets; `ui/app/src/lib/feed.ts` connects to our backend. Market-data viewers do not each open a Lighter socket. Each independently started feed process does, so a scaled deployment still needs a single ingestion owner.

The cache is only 1,200 in-memory 500ms candles (10 minutes). New browsers receive 180 candles (90 seconds). Restarting the feed loses history. There is no provider-history bootstrap, durable replay cursor or complete reconnect-gap repair.

The recent flat chart was a data-source issue: testnet trades stopped while the mark price continued moving. The chart now uses labeled mainnet trade observations in both account modes; testnet mark observations were also too sparse for the requested chart. Account execution remains on its configured network. Both source types arrive over WebSocket. Changing transport does not increase a source's publication frequency.

## Proposed architecture

Lighter live stream → one ingestion worker per network → normalized observations and 500ms aggregation → memory cache + PostgreSQL → our snapshot/history API and WebSocket gateway → browsers.

Lighter historical REST endpoints → throttled history worker → the same database and history API.

Start with the existing Bun service and PostgreSQL. Separate ingestion from gateways logically now. Add Redis Streams and multiple gateways when load tests justify them, not a second source connection per gateway. Use a renewable leader lease with fencing to prevent simultaneous ingest owners during failover. Keep market ingestion independent of trading/signing.

## Price identity comes first

Key every observation, candle, cache entry and subscription by venue, network, market, price type and resolution. Resolve market IDs from venue metadata and validate them at startup.

- Mainnet execution chart: Lighter BTC perpetual trades, with mark price available separately for P&L.
- Testnet account: mainnet BTC reference chart, clearly labeled; testnet execution fills and P&L remain separate. Store chart anchor/source separately from execution entry.
- Testnet mark price may be shown as a separately labeled account metric; it must not be spliced into the mainnet candle series.

Use Lighter's own history initially to keep market/source consistency. Its SDK documents both `/candles` and `/markPriceCandles`. Verify supported resolutions and availability on the chosen network before implementing backfill. If an external provider is needed, verify instrument, quote currency, timestamps, coverage and redistribution terms first. Never silently splice spot history or mainnet prices into a testnet perpetual series.

## Implementation phases

### 1. Durable short-term data

- Normalize source timestamps to milliseconds; retain source time and receive time separately. Mark observations with no source timestamp use receive time explicitly.
- Deduplicate trades by stable venue ID; retain bounded late-arrival correction behavior.
- Keep the latest 15 minutes in a memory ring buffer. Persist 500ms bars for 24 hours initially (172,800 bars/day/series); retain raw events for a proposed 1-hour repair window and cap it by measured bytes/event throughput.
- Store closed bars with a unique source/market/resolution/bucket key and monotonic revision. Batch upserts off the broadcast path; persist the forming bar periodically. Record ingestion checkpoints and gaps.
- Restore recent bars and checkpoints before accepting subscriptions. Backfill a crash gap where the venue provides sufficient underlying observations; otherwise preserve and label the gap.
- Keep the exact candles used in completed rounds separately from rolling retention so replay history does not expire.

### 2. Historical API and backfill

- Add a bounded `GET /v1/markets/:market/candles` with explicit network, priceType, resolution, from, to and limit. Return source metadata and coverage/gaps.
- Serve recent half-second history from our cache/database. Load older provider candles only at resolutions the provider actually supports. Never turn a minute candle into 120 invented half-second candles.
- Cache closed historical ranges, coalesce identical requests, and queue cache misses behind a shared upstream rate limiter. No per-viewer provider fetches.
- Lighter's documented candle response caps at 500 candles per call: paginate by validated time coverage, deduplicate boundaries, and check returned coverage rather than trusting count alone.
- Treat missing zero-valued fields according to the provider schema. Keep mark volume distinct from traded volume.

### 3. Seamless history/live handoff

- Each stream has an epoch and monotonic sequence. Snapshot includes the matching cursor and bounded candle range.
- Buffer live deltas during history loading; apply only later sequence numbers after installing the snapshot. Use candle bucket + revision to upsert updates.
- On reconnect, replay from a bounded delta log when available. Otherwise send a fresh snapshot; an epoch change always forces resync.
- Fetch older pages only when panning left or changing timeframe. Main-thread chart updates remain batched per animation frame without waiting for a 500ms candle to close.

### 4. Health, limits and scale

- Track socket health, latest market observation age and latest trade age separately. Heartbeats alone do not prove fresh prices; sparse trading does not prove a broken connection.
- Label stale data and gaps. Do not create moving prices or continuously present disconnected carry-forward bars as fresh observations.
- Keepalive every 30 seconds, reconnect with jitter/backoff, bounded queues and slow-client resnapshot/disconnect.
- Apply one REST budget across history, repair and other venue reads; prioritize execution/account reconciliation over optional old-history requests. Respect rate-limit cooldowns instead of retry storms.
- Add Redis Streams when multiple gateways are required; Pub/Sub alone cannot replay missed updates. Gateways scale browser delivery while ingest connection count stays bounded.
- Measure source age, receive-to-publish delay, browser paint delay, cache hit rate, recovery time and p95/p99 latency. Do not promise faster prices than the upstream source supplies.

### 5. Acceptance checks

- 1,000 synthetic browser viewers do not increase the number of upstream ingest connections or identical history requests.
- A feed restart restores chart history without a 90-second warmup.
- Disconnect/reconnect yields repaired data or an explicit gap, with no duplicates.
- History-to-live transitions have no missing/double candles or backward cursor movement.
- Out-of-order trades, late corrections, sparse testnet prints and silent mark streams are covered.
- Different sources/networks never merge; open P&L always remains venue-derived.
- Load tests establish actual resource usage and latency before increasing replica count.

## Rate-limit implications

The current official docs list 255 WebSocket connections/IP, 500 subscriptions/connection and 200 client messages/minute. This design needs a bounded number of upstream connections independent of viewer count. Historical REST and other requests still consume venue limits; centralization does not eliminate those limits. Builder accounts offer application-reviewed, free higher read-only REST limits if history demand warrants them. Premium is not a prerequisite for this architecture.

## Recommended delivery order

First ship durable recent history and accurate feed-health metadata. Then add cached provider history and cursor-based handoff. Finally load-test and add Redis/multiple gateways if necessary. No trading-network change, account-tier purchase or public deployment is part of this planning step.

## Primary sources

- https://apidocs.lighter.xyz/docs/websocket-reference
- https://apidocs.lighter.xyz/docs/rate-limits
- https://github.com/elliottech/lighter-python/blob/main/docs/CandlestickApi.md
