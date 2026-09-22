# Scheduled order execution

Updated 22 September 2026.

The backend compiles each drawing into a durable queue before starting its runner. Each intent records its due time, expiry (the next turn), target position, status and resulting transaction hash. These are local scheduled intents, not resting orders accepted by Lighter.

The runner submits a due intent once, observes settlement before a reversal, and wakes at the next turn or round end rather than sleeping a full polling interval across that boundary. Position and market-price reads run concurrently. Closing cancels queued intents, waits for any submission already in flight, and flattens reduce-only. A missed intent expires instead of triggering a rapid backlog of late trades. Restarted rounds do not automatically resume submitting intents; they require recovery.

Orders are signed only when dispatched; nonces and actual position deltas must not be frozen in advance. Placing all market orders at round start would execute the strategy early. Resting limit/conditional orders would change its time-based semantics and do not guarantee fills.

Round timing records now include request, ready, close-request and confirmed-close times. Each order records preparation-request and acknowledgement times. These use the backend clock; venue fill timestamps may be on a different clock and must not be used alone to infer network latency.

UI delivery: round snapshots, queue changes and reconciliation results are pushed over a per-round event stream with heartbeat, reconnect and REST fallback. Scheduled/submitting/submitted states are visible before fills; confirmed fill markers remain separate.

Remaining performance work: measure these stages on user-initiated trades and move account/fill confirmation from REST polling to authenticated account streams with REST recovery. The current implementation still uses REST confirmation; no end-to-end latency guarantee is claimed.

Verification: 12 focused trader tests passed, including exact turn boundaries, queue deadlines, cancellation, lagging position reads, concurrent opens, close during submission and partial-fill P&L. Trader typecheck and whitespace checks passed. No real orders were placed or positions closed by verification tools.
