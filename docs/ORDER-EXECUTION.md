# Order execution

Updated 22 September 2026.

## Where the time went

Measured from a laptop, every REST call to Lighter testnet takes ~330ms. Before this
change an order made three of them in series: a position read and a market read (in
parallel), a `nextNonce` call the Go signer made for itself inside the FFI call (nonce
`-1`, blocking the event loop), then `sendTx`. Opening added three more reads and a
separately awaited `updateLeverage` transaction. Recorded rounds show 1.0–1.5s per order
acknowledgement and ~1.2s before the first order was even sent.

## The path now

At the moment of trading, one network round trip remains: the send.

- **One venue WebSocket** (`services/trader/src/venue-socket.ts`) carries signed
  transactions (`jsonapi/sendtx`, `jsonapi/sendtxbatch`, answered with the id they were
  sent under) and pushed state: `account_all_positions/{account}` and
  `account_all_trades/{account}` (public, no auth), plus `ticker/{market}` and
  `market_stats/{market}` for the worst-fill bound. HTTP is the fallback when it is down.
- **Per-account executor** (`executor.ts`): nonce read once and counted locally; a
  `21104 invalid nonce` re-reads it and re-signs once (nothing executed). A send with no
  answer is never retried blindly: the nonce is re-read and the position push decides.
- **Prepare while drawing**: `POST /rounds/prepare` subscribes the account, reads the
  nonce and sets leverage when the page enters drawing, so none of it is on the clock.
  If it was skipped, leverage rides in the same batch as the opening order.
- Formats were verified on testnet with stale-nonce transactions the venue rejects before
  execution: single `tx_info` is an object; batch `tx_types`/`tx_infos` are JSON strings,
  the infos being the signer's own strings.

## Trades, segments and the scheduler

`plan.ts` turns the drawing into **segments** with ids. Consecutive segments facing the
same way are one **trade**: long after long continues the position. A turn is the old
trade's reduce-only close and the new trade's open, **sent as one batch** (one round
trip, two orders, two trade ids). A **skipped** segment holds the previous position, so
cutting the short out of long–short–long keeps one long open.

The scheduler (`rounds.ts`) does not replay a list. At each wake it asks what the plan
wants held at `now + lead`, compares it with what is held, and sends the difference,
then sleeps until the plan next changes. `lead` is half the measured ack round trip, so
orders land on the boundary rather than one round trip after it. The same question
covers on-time turns, late wakes, mid-round edits and cuts.

- `PUT /rounds/:id/plan` — a new line; everything before `now + lead + 150ms` is kept,
  the rest is re-planned. Segment ids survive where they mean the same thing, so the open
  trade keeps its id.
- `POST /rounds/:id/segments/:segmentId` `{ skipped }` — cut or restore a future segment.
- Close: cancels the schedule, waits for any order in flight, sends a reduce-only close
  unless one is already on its way, and waits for the position push to show flat and
  every accepted order to have its fill. REST fills are read only if a push was missed.
- A refused turn is retried after 400ms (three strikes fail the round and close it). An
  open that never filled is noticed from the position push once settled, and reopened.

## Measuring it

Every stage is logged as one JSON line (`grep '"evt":"timing"'` in the trader's output)
and summarised at `GET /metrics/timings` (p50/p95/max per metric):

| metric | from → to |
|---|---|
| `open.accept` | request in → validated, before any network |
| `open.ack` / `http.open` | request in → venue accepted the first order |
| `open.fill` | request in → first fill pushed |
| `order.ack` | order sent → accepted (one round trip) |
| `order.fill` | order sent → first fill pushed |
| `order.late` | order sent − when the plan wanted it sent (negative is early) |
| `close.ack`, `close.flat` | close requested → accepted / venue flat |

The browser logs `[skech timing]` lines for prepare, click → venue ack, plan edits and
close → flat, and the status line under the chart shows the open latency and each
order's acceptance time. Order marks on the chart are hollow while sending and solid at
the fill price once filled; hover for ack and fill times.

All times are the trader's clock. Testnet fill timestamps were seen ~10s adrift of it, so
they are stored (`venueAt`) but never used for placement or latency.

## What sub-500ms depends on

From a laptop the floor is one round trip, ~350ms, plus the venue's own taker delay for
the fill (300ms Standard). Deployed near the venue (Tokyo) the send is single-digit
milliseconds. The venue's matching delay is not ours to remove.

Not verified yet: the success-answer shape of `sendtx`/`sendtxbatch` (hashes are optional;
fills are matched on client order index), and batch semantics under partial failure.
