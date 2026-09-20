# What the app does

The list the rebuild is checked against. Interface only: no wallet, no feed.
Every figure comes from `src/lib/market.ts`, seeded from the token address.

## Shell

- `/` and `/app` redirect to the one listed market. Any other address is a 404.
- App bar: wordmark, market search (inert, one market, says so), cash chip
  with "Deposit", Draw / Desk switch, account menu (deposit, withdraw,
  privacy, settings, support, sign out).
- Privacy blurs every figure on the screen, for reading it in company.
- The rail beside the chart is there in every phase. While a round runs it
  holds only the chart settings: there is nothing to undo, clearing would not
  close the position, and a shape would replace a line already being traded.
  It used to vanish whole and take the chart settings with it, so the one
  moment you might want to change how the chart is drawn was the one moment
  you could not.
- Light and dark, from the toggle in the bar or the Settings sheet. An inline
  script applies the stored theme and palette before the first paint.

- Nothing on the screen pretends to work. Withdraw, Support, the desk's
  submit and the positions row buttons all say "Not live yet" and what is
  missing. Rewards and Transfers were words with nothing behind them and no
  plan, so they are gone rather than apologising for themselves.

## On a phone

- One row of controls at the bottom, where a thumb is, and symmetric about
  the thing it is for: rounds and the tools drawer on the left, size and boost
  on the right, all four the same 52px circle, and the button between them,
  52px tall, taking whatever width is left. Everything else on the screen is chart.
- The row above it is drawn only when it has something to say. While a line is
  being drawn the chart already reads "click to place your points" where the
  points go, so repeating it under the chart cost a row and told nobody
  anything. It comes back for the figures on a finished line, the candle count
  while a round runs, and the result.
- Buttons are 44px on a phone and unchanged on a desk, and the footer's own
  are 52px, because that row is the one people actually press. A pointer is a pixel
  and a thumb is about a centimetre, which is why every phone platform asks
  for 44 and why the trading apps people already use look oversized on a
  laptop. Ours were 36, made for a mouse.
- The market sits in the app bar on a phone, where the search field is on a
  desk, and the row it used to have is gone. That row was a band of chrome
  above a chart that wants every pixel; the chart now runs from the bar to the
  footer. The name gives way to the price when it is tight, because the mark
  already says which market. The logo loses its word and light or dark moves
  into the tools drawer, so the bar holds four things and fits.
- One socket for the page. The bar and the chart show the same live price, so
  the stream is held once, by the screen above both of them.
- "Testnet" is "Test" on a phone and never absent. Being on testnet without
  knowing it is worse on the screen somebody carries than the one they sit at.
- Edge to edge: bar, content, footer, the shape a phone app has. The margin,
  border and rounded corners are how a panel sits on a desk among other
  panels; on a phone there is nothing to sit among, and the inset only took
  eight pixels off each side of the chart to put a hairline where the screen
  edge already is. The desk keeps its card.
- The app bar is 56px on a phone. Forty-four pixel buttons in a forty-eight
  pixel bar left two pixels top and bottom, and the toggle and Sign in were
  forty-four and forty, so nothing in it lined up.
- The stop loss and take profit open out in the drawer: a switch, and the
  wheel under it once it is on. As chips they hid the wheel in a popover, and
  a popover inside a drawer portals itself outside the drawer, so the first
  touch on the wheel read as a press outside and shut the whole thing.
- Panels come up from the bottom rather than in from the side. Rounds, the
  market picker, Settings and Add money all do it, because a side panel covers
  a phone anyway and puts its close button in the corner furthest from a
  thumb. Nothing about the desk changes.
- The chart is a line unless somebody picks otherwise. Ninety candles across a
  phone are slivers with no bodies worth reading. Whatever is picked is kept,
  on either screen.
- The shapes menu used to open to the right of a rail sitting at the left
  edge, so most of it was off the screen and the page scrolled sideways 119px
  to reach it.
- The market picker showed $64,180 under a header reading $81,133, because it
  listed the mock rather than the market on screen. It carries the live one
  now.

## Signing in

- Coinbase embedded wallets: email, phone or Google. No extension, no seed
  phrase. The wallet is an EOA rather than a smart account, because Lighter
  registers a trading key by asking the wallet to sign one plain message and a
  contract wallet cannot sign one off chain.
- Signed out, the corner holds one thing: Sign in. No avatar, no Deposit, no
  menu of things that would need an account.
- Signed in, the menu greets you by name and the address under it is a button
  that copies, turning into a tick. With no name it reads "Your wallet", which
  is honest and stops the address being printed twice.
- The balance line is four words: "$10,000.00 on Lighter", or "Nothing on
  Lighter yet". It used to be a sentence about what to do next, which is what
  the Deposit item directly under it is for.
- The name is asked once, the first time somebody arrives without one, and
  skipping is an answer that sticks. It used to greet you with your own wallet
  address, and ask again on every visit.
- That same prompt says signing in made you a wallet, and names it. Nobody
  agreed to a wallet and nobody was told, and the address in the corner should
  not be the first anyone hears of it. Settings says it too, above the key.
- Coinbase's button opens Coinbase's modal: an email field, then Continue
  with phone, Google or Apple. The one-time codes and the recovery are theirs
  to get right, and this is the screen where getting it wrong locks someone
  out of their money, so none of it is rebuilt here.
- With no project id the app runs signed out and everything else still works,
  which is what the tests and screenshots use.

## Adding money

- Whatever you are holding, wherever it is, ending as collateral on Lighter.
  Lighter hands out an address that credits your perp account and makes one if
  you have none; Relay turns what you hold into USDC on a chain Lighter
  watches and sends it there. Neither needs a key.
- Seven chains: Base, Arbitrum, Optimism, Polygon, Avalanche, Ethereum and
  World, each with its own mark, USDC or the chain's own coin. That is every
  chain there can be, not a selection: Relay bridges from sixty, so it was
  never the limit, and a Coinbase embedded wallet signs on exactly those seven
  and no others. Measured from World, the newest of them: 5 USDC becomes
  $4.971446 on Lighter in two seconds, for under three cents.
- The address is narrower than the bridge and always will be: Lighter watches
  Base, Arbitrum and Avalanche for plain transfers, and that is Lighter's list
  rather than ours. It costs nothing, because anyone can send to it from
  anywhere, so a wallet on a chain we cannot sign on is somebody else's
  problem to solve once rather than ours to work around.
- Measured: 0.01 ETH on Arbitrum becomes $25.71 on Lighter, one step, two
  seconds, nine cents. 25 USDC on Polygon becomes $24.97 in two. USDC already
  on Base is free and arrives at once.
- Chain and token marks are drawn in the app rather than fetched: an icon that
  arrives over the network is a request on every load and a blank square while
  it lands.
- The sheet prices the route before anything is signed, so what lands is a
  number you saw rather than one you find out afterwards. The button says the
  figure: "Add $25.71".
- Relay's own Lighter route was the alternative and is worse for the people
  this is for: its recipient is an account index, so a wallet that has never
  deposited has nothing to put there, and a made-up one still quotes, at
  $3.62 of relayer gas against $0.02.
- On testnet there is nothing to deposit into, so the sheet is one button that
  says "Get $10,000" and a copy of your address. Lighter's faucet takes an
  address and nothing else, so the app asks on your behalf rather than sending
  you off to connect a wallet that cannot connect to anything. The account
  appears about eight seconds later and the header picks it up.
- Measured: a random address with no account, one press, $10,000.00 in the
  header. The faucet refuses above $100 of portfolio value, and says so in its
  own words.

## Trading for real

- Press Trade and the round opens a real position on Lighter. The page sends
  the points it drew and nothing else: what the line means, which way the
  position faces at each moment and what size that is are all worked out by
  the trader, from `@skech/core`, the same code the page quotes with. A page
  that decided its own orders could claim it drew anything.
- The line is a target position over time, not one trade. Every turn is a
  reversal, and on Lighter a reversal is one order rather than a close and an
  open. Measured on testnet: a line drawn down, up and down sent four orders,
  short, long, short, flat, and booked the venue's own figure.
- While a round runs the money on screen is the venue's, not ours: its mark,
  its fills, its fees. The local settlement still draws the ribbon and decides
  when the round is over, but it does not name the number once real money is
  on it.
- The round outlives the tab. The trader answers as soon as the position is
  open rather than when the round ends, so a closed laptop does not leave one
  running with nobody watching.
- With no trader configured a round runs exactly as it always did, against
  real prices with no position behind it, and the tray says so while it runs.
  Silence there would be the worst of both.
- **Rounds trade your own Lighter account.** The first time you press Trade,
  the wallet is asked to sign one message: it registers a trading key against
  your account, and it is never asked again. That key can trade your account
  and nothing else. It cannot move money off the venue.
- Measured, from a wallet that did not exist a minute earlier: faucet, own
  account 391 with $10,000, key registered, a three-leg line traded as four
  orders on 391, and its own collateral down to $9,999.117519. The balance
  that moved is the one on the screen.
- The card and the Rounds sheet show what the venue booked, not what the
  simulation worked out. A round that cost $39 in slippage read $0.00,
  because the local settlement had nothing to settle after an early close.
  Two numbers for one round, and the wrong one on screen.
- The tray still compares the account a round landed on with the one behind
  your wallet, and says so in amber if they ever differ. They should not any
  more, so it is a check rather than a mode.
- A wallet with no Lighter account cannot register a key, because there is
  nothing to register against. On testnet the faucet makes one; on mainnet a
  deposit does.
- Three guards, each of which exists because something went wrong on testnet.
  No order may exceed twice the round's size, measured against the round and
  not against what is held, so a position read wrong cannot raise its own
  ceiling. A position past twice the target stops the round instead of trading
  further into it. And a top-up waits for the venue to book the last fill,
  while a reversal does not.

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
  the same wheel, "Put in $100, trade like $1,000. A move of 8.9% against you
  takes all of it" above it. That figure is a function of the boost alone and
  it is why the default is ten and not fifty: at fifty it reads 0.81%, which
  Bitcoin does several times on an ordinary day. Stop loss and
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
