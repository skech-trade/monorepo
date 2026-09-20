# feed

Real Bitcoin, one bar a second.

Lighter's smallest candle is a minute and a round in Draw is sixty seconds, so
this holds one socket to the venue, builds the bars itself from the trade
stream, and hands them to browsers over server-sent events.

```
bun run dev:feed          # from the repo root, port 3210
curl localhost:3210/health
curl 'localhost:3210/bars?n=90'
curl -N localhost:3210/stream
```

| Route | What it gives |
|---|---|
| `/health` | whether bars are arriving, how many, the mark, how many are watching |
| `/bars?n=90` | the last `n` bars, oldest first, plus the day's figures |
| `/stream` | `seed` once, then `bar` and `stats` as they happen |

Reads need no credential of any kind. The socket carries trades, the book and
account state to anyone who asks, which is why this exists rather than a
Builder account, whose only gift is a higher REST read limit nothing here
would reach.

| Variable | Default |
|---|---|
| `PORT` | `3210` |
| `LIGHTER_WS` | `wss://mainnet.zklighter.elliot.ai/stream` |
| `LIGHTER_MARKET_ID` | `1` (BTC) |
| `ALLOW_ORIGIN` | `*` |

To point the app at it, set `NEXT_PUBLIC_FEED_URL=http://localhost:3210`.
Unset, Draw runs on its simulation, which is what every test and screenshot
still uses.

Seconds with no trades still get a bar, flat at the last close, because a gap
would draw as a jump and the chart counts bars to place your line against
them. A market that has not printed is a market that has not moved.
