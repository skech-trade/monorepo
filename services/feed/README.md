# feed

Real Bitcoin and Ethereum, a bar every half second.

Lighter's smallest candle is a minute and a round in Draw is sixty seconds, so
this holds one socket to the venue per market, builds the bars itself from
the trade stream, and hands them to browsers over WebSockets (server-sent
events still work). Every route takes `?market=BTC` or `?market=ETH`, and
Bitcoin when it says neither. The chart is always mainnet's.

```
bun run dev:feed          # from the repo root, port 3210
curl localhost:3210/health
curl 'localhost:3210/bars?n=90&market=ETH'
curl -N 'localhost:3210/stream?market=ETH'
```

| Route | What it gives |
|---|---|
| `/health` | whether bars are arriving, how many, the mark, how many are watching, and each market's connection |
| `/bars?n=90` | the last `n` bars, oldest first, plus the day's figures |
| `/ws` | WebSocket: `seed` once, then `bar`, `quote` and `stats` as they happen; send `ping` for `pong` |
| `/stream` | the same as server-sent events |

Reads need no credential of any kind. The socket carries trades, the book and
account state to anyone who asks, which is why this exists rather than a
Builder account, whose only gift is a higher REST read limit nothing here
would reach.

| Variable | Default |
|---|---|
| `PORT` | `3210` |
| `ALLOW_ORIGIN` | `*` |

To point the app at it, set `NEXT_PUBLIC_FEED_URL=http://localhost:3210`.
Unset, Draw waits for real data rather than inventing any.

Half-seconds with no trades still get a bar, flat at the last close, because a gap
would draw as a jump and the chart counts bars to place your line against
them. A market that has not printed is a market that has not moved.
