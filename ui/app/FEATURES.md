# What the app does

The list the rebuild is checked against. Interface only: no wallet, no feed.
Every figure comes from `src/lib/market.ts`, seeded from the token address.

## Shell

- `/` and `/app` redirect to the one listed market. Any other address is a 404.
- App bar: wordmark, market search (inert, one market, says so), cash chip
  with "Deposit", Draw / Desk switch, account menu (deposit, withdraw,
  transfers, profile, blur balances, settings, rewards, support, disconnect).
- Privacy blurs every figure on the screen, for reading it in company.
- Light and dark, from the toggle in the bar or the Settings sheet. An inline
  script applies the stored theme and palette before the first paint.

## Settings

- Everything the reader sets is remembered in this browser, under one key. The
  Desk used to forget its timeframe, overlays, studies, log scale and folded
  panes on every visit; it no longer does. So do the theme, the palette, the
  privacy blur and the three below.
- Colours: green and red, or blue and orange for readers who cannot separate
  the two. Set on the aliases the candles, the figures, the ribbon, the pills
  and the order book all read, so nothing green or red survives the switch.
  The Desk's canvas chart follows it too, because its palette is read out of
  computed styles and invalidated when `data-palette` changes.
- Candles: candles, bars (open left, close right) or one curve through the
  closes, which leaves the drawn line the only coloured line on the chart. The
  curve is Catmull-Rom: a second of Bitcoin moves six dollars, so joining the
  closes with straight runs drew a saw.
- Grid: lines, dots or off. The dot sits in the middle of its tile in the ink
  the axis uses; at the corner in the border colour it was invisible.
- On the drawing, each on or off: the ribbon (the band of profit and loss
  along your line), the buy and sell marks, the crosshair.
- Size and boost are remembered, so a round starts where the last one left off
  instead of resetting to $100 at 50x every time.
- Where: a gear at the end of the chart's own view controls holds all of the
  above, beside what they change. The Settings sheet, opened from the account
  menu, holds them plus the theme and the privacy blur. One store, so the two
  agree.
- Motion: the feed is not decoration, so reduced motion does not stop it. It
  used to return before the interval was made, which meant the market never
  moved and a round placed with that preference on never ran at all. What is
  decorative, the marching hint and the settled ribbon fading in, is CSS and
  stops under the preference.

## Market

- Header: token mark, name, live price, today's move. In Desk also 24h high,
  low and traded. Pressing the header opens the market picker.
- Picker: search (inert), list of markets with price and change, copy address,
  open.

## Draw (default)

- Chart you draw on. History on the left, an empty half on the right, a "now"
  divider, a faint hint of the gesture, one line of instruction.
- Live simulated feed, one candle a second, forming candle updates within it.
- Points is the default: one click places a point, the line joins them. A
  click on the empty chart with no line down starts one from the live price
  and lands the point where you clicked; no drag needed. Pen drags a stroke
  that settles into its few turning points on release. Undo, Clear. Shapes
  menu with eight calls drawn as diagrams at the chart's scale.
- Hovering a point offers a cross beside it that removes it, and the two
  neighbours join up. Double-click still does the same. Never on the last two,
  because a line is two points.
- Zoom follows the price. Bar positions scale with the zoom and the price
  scale did not, so at the far end eight candles sat in a band sized for
  ninety and collapsed to a line: the chart read as empty. Zoomed in past 1x
  the scale is taken from the bars, the line and the price actually on screen.
- Every point is a handle once the line is down: drag to move (both axes,
  held between its neighbours in time), double-click to remove, click the
  empty future to insert one there. While a round plays out the points ahead
  of now stay editable and the past is fixed. Redrawing costs nothing.
- The line is the landing's ballpoint blue.
- Drag to draw. Time only goes forward. First touch is anchored to the live
  price. Raw stroke while the finger is down, smoothed on release. A tap or a
  flat line is not a trade.
- Reading the line: direction from where it ends, "where you're aiming" is the
  furthest it gets on its side, "where you're out" is the furthest it strays
  the other way. No dip means no floor and the whole stake is at risk.
- Quote: "If it gets there +$X", "The most you can lose $Y", "Put in $S,
  trades like $N". Loss is capped at the stake, and at your stop if you set
  one: the bar used to say the whole stake with a $25 stop armed on the row
  above it.
- The ribbon: a band around the line, one and a half average candle ranges
  wide, sized from the last twenty candles. Candles that close inside it
  count. The money is decided by the levels; the ribbon is the score.
- Feedback while it plays: candle N of 24 in the bar, a progress strip under
  the future half, the live figure with "inside" or "outside" on the price
  head, ribbon segments coloured green (inside) or grey as each candle lands.
- The reveal: the line goes dashed, the segments fade in one by one, the
  verdict is bucketed by how much of the way the price stayed inside (Called
  it 80%+, Close 55%+, Off), with the money and the outcome under it, and a
  directional error ("you drew too high by $92 on average"). Recent rounds as
  a row of small bars. The round stays on screen until the next line starts.
- Share text is spoiler free: one glyph per candle, filled inside, hollow out.
- A faint ghost of your last line sits on the empty canvas at today's price.
- Until you have drawn anything: the hint path marches with "click to place
  your points" under it. Once a line exists, the ghost of your last line is
  the hint and the marching path stays away. Escape clears, Z or Backspace
  undoes. The Shapes menu opens beside the rail, never over the app bar.
- The note beside the Trade button ("Bitcoin long, trading like $5,000")
  opens on hover. It used to open by itself the moment a line was finished
  and the next click on the chart went to closing it instead of placing the
  second point.
- Hierarchy: one board with hairlines, no cards. The header is one 48px row.
  The one filled button on a view is the direction button in its colour.
  Candles sit one step quieter than the P&L figures. No vertical grid.
- Size: wheel, $20 to $500 in $5 steps, click to type. Boost: 1× to 50× on
  the same wheel, "Put in $100, trade like $1,000" above it. Stop loss and
  take profit as money, off by default, on the same wheel.
- "Trade for $S" places it. No toast: the header turns into "Close trade",
  the bar starts counting candles and the chart starts moving.
- Playing out: candles arrive against the line (pulled toward it by a factor
  rolled once per sketch), live P&L beside the last candle, "Close trade".
- Settled on the same rule as the quote, on the wick, adverse level first:
  called it / out where you drew it / time's up / taken off / wiped out.
  The Rounds sheet opens on the round just played. Its header is the
  word Rounds and nothing else. The card under it is the card: the same
  canvas the picture and the clip are painted from, so what you see is what
  gets posted. No text block above it, no eyebrow, no pill, no summary line.
  Replay runs the card's own animation in place. Today's tally sits where a
  tally goes, in the table's footer: "Bitcoin today, 2 of 3 came good" and
  the total on the right.
- The round is as long as the line. Placing a trade sets the clock to the
  line's last second (never under five) and rescales the points to span it,
  so a forty second line is a forty second call and the chart, the replay and
  the card all end where the drawing does. The bar says "Runs 40 seconds, as
  long as the line" before you place it. Drawing off the right edge while it
  runs still lengthens it.
- The card, 1280 by 720, painted from the theme as it is on screen (light or
  dark, the page's own fonts, the real mark): the chart is the whole card,
  the time axis fits what was drawn and what came, the line is a solid pen
  stroke in the brand blue, candles arrive against it. At the foot: the money
  as the one figure, then one sentence that runs long on purpose, in the
  third person ("vivek put $100 on Bitcoin going up at 10× and it stayed
  with the line 75% of the way, two in a row."), and "Draw yours at
  skech.trade" on the right. Nothing else. The post text is the same
  sentence in the first person, opened with "Called it." or "Wiped out."
  only when that is what happened. In a clip the line draws itself
  first, the candles arrive, the money lands, over five seconds.
- Replay and export, all client side: Replay animates the candles back in,
  Picture saves a PNG of the card (share sheet where the browser offers one,
  a download otherwise). Clip records the card off a canvas with the
  MediaRecorder API, MP4 where the browser can write it and WebM otherwise,
  the on-screen chart replaying alongside; the finished clip then plays in
  the card with Post on X, Save clip, Share and Back to the chart. The clip
  plays in the app's own player, not the browser's: play or pause by the
  button or by clicking the picture, a brand blue line to scrub, the time in
  figures, and a replay arrow when it ends. The share sheet only opens off a
  fresh click, which is why a clip is handed over in two steps. A browser
  that cannot record says so in one line.
- Post on X, with no app key: X takes no file from a page, so the compose
  window opens prefilled with the words (first person, spoiler free) and the
  picture goes on the clipboard in the same click, to paste in. With a clip
  held, the clip is saved instead and the note says to drag it in. The tab
  opens first, inside the click, or the browser blocks it. New trade clears
  the board.
- Rounds keeps every sketch under the card: thumbnail, stake at leverage, in
  and out prices, money and how much of the way was right. Click a row to put
  it in the card. Two seeded rounds from earlier. Replaces both the settle
  popup and the old Your lines sheet.
- Layout: one full-width chart card. Market and tools above the plot, the bar
  below it. Nothing sits over the plot. Draw keeps its own stake and leverage,
  separate from the Desk ticket.

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
