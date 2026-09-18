# What the app does

The list the rebuild is checked against. Interface only: no wallet, no feed.
Every figure comes from `src/lib/market.ts`, seeded from the token address.

## Shell

- `/` and `/app` redirect to the one listed market. Any other address is a 404.
- App bar: wordmark, market search (inert, one market, says so), cash chip
  with "Deposit", Draw / Desk switch, account menu (deposit, withdraw,
  transfers, profile, blur balances, settings, rewards, support, disconnect).
- Blur balances hides every figure on the screen.
- Light theme. Dark tokens defined, not switched on.

## Market

- Header: token mark, name, live price, today's move. In Desk also 24h high,
  low and traded. Pressing the header opens the market picker.
- Picker: search (inert), list of markets with price and change, copy address,
  open.

## Draw (default)

- Chart you draw on. History on the left, an empty half on the right, a "now"
  divider, a faint hint of the gesture, one line of instruction.
- Live simulated feed, one candle a second, forming candle updates within it.
- Tools: Pen (drag), Line (drag a straight line to where it ends), Points
  (click each turn; the curve joins them). Undo, Clear. Shapes menu with three
  common calls (dip then run, straight up, slow bleed) drawn at the chart's
  scale, to be dragged into shape.
- Once drawn, the head of the line is a handle: drag it and the tail follows
  with a cubic falloff while the start holds. Redrawing costs nothing.
- Drag to draw. Time only goes forward. First touch is anchored to the live
  price. Raw stroke while the finger is down, smoothed on release. A tap or a
  flat line is not a trade.
- Reading the line: direction from where it ends, "where you're aiming" is the
  furthest it gets on its side, "where you're out" is the furthest it strays
  the other way. No dip means no floor and the whole stake is at risk.
- Quote: "If it gets there +$X", "The most you can lose $Y", "Put in $S,
  trades like $N". Loss is capped at the stake.
- Size: wheel, $20 to $500 in $5 steps, click to type. Leverage: 1× to 15×
  meter with "$100 → 10× → $1,000" under it.
- "Draw it in for $S" places it. Toast confirms.
- Playing out: candles arrive against the line (pulled toward it by a factor
  rolled once per sketch), live P&L over the last candle and in the tray,
  "Take it off now".
- Settled on the same rule as the quote, on the wick, adverse level first:
  called it / out where you drew it / time's up / taken off / wiped out.
  Toast. Result card with the sketch as a picture, "Show your call" (share or
  copy), "Draw another".
- Your lines: every sketch as a thumbnail with side, stake at leverage, from
  and to prices, P&L and status. Inline beside the chart on a desk, in a sheet
  elsewhere. Two seeded lines from earlier.

## Desk

- Chart: lightweight-charts. Timeframes 1m 5m 15m 1h 4h 1D 1W. Candles, bars,
  line, area. EMA 7/25/99 and Bollinger overlays. Volume, RSI 14, MACD in
  panes, each with a fold chip that leaves a chip at the foot of the chart.
  Log scale. Fit. OHLC and EMA readout on hover. Stop and target draggable on
  the chart; liquidation, limit and trigger lines when they mean something.
- Account: equity, health (ratio plus healthy / steady / tight / at risk),
  balance, unrealised, margin used, free.
- Book: bids and asks with depth bars, spread row, click a row to set the
  limit price. Tape tab with recent prints.
- Ticket: Long / Short. Market / Limit, "Use mark". You pay (USDC) with
  25 / 50 / 75 / Max. You get (BTC). Leverage as the notched meter, 1× to 100×,
  with presets 2 5 10 25 50 100. Get out at and Take profit at, each a switch that
  drops a draggable level on the chart, clearable. Advanced: trigger price
  (turns market into stop, limit into stop-limit), margin cross / isolated,
  reduce only, post only (needs a limit). Summary: entry, wiped out at, margin
  used, fee (maker or taker). Submit, disabled without an amount, with an
  "Interface preview" caption.
- Positions: Open / Waiting / History. Open rows: side, size at leverage, in
  at, now, wiped out at, P&L in dollars and percent, Exits, Close. Waiting:
  type at price, filled, placed, Cancel. History: size at price, fee, time.
- Every panel folds: the header and account row together, the book and the
  ticket sideways into a rail, positions up into its tab strip. The grid
  gives folded width back to the chart.
