# How skech works

You draw ink ahead of Bitcoin's live price. Ink the price runs through pays.
It is practice money for now: $1,000 in the browser, no sign-in needed.

| Part | Where |
| --- | --- |
| The screen | `ui/app/src/components/app/ink/` |
| The live price | `ui/app/src/lib/coinbase.ts` |
| Practice balance and settings | `ui/app/src/lib/practice.ts` |
| Market readings, price paths, chances | `packages/core/src/dots.ts` |
| Drawings: cost, opening, settlement | `packages/core/src/ink.ts`, `ink-area.ts` |
| Quotes while drawing | `packages/core/src/odds.ts` |
| Price history | `packages/core/scripts/fetch-coinbase.ts` |
| Replay check | `packages/core/scripts/check-ink-area.ts` |

The page, the replay and the tests run the same functions from `packages/core`.
Nothing is priced twice.

## 1. The price

- Coinbase BTC-USD, trade by trade, over its public WebSocket (`matches`), straight from the browser.
- On connect, the last ten minutes of public trades seed the chart.
- Coinbase sends a heartbeat every second. Five seconds with no message at all and the socket is reopened.
- Each trade is folded into the bar of its second: high, low, close.
- A second with no trade is closed at the last price once it is 600 ms old.
- The chart line is drawn from the trades themselves, with no smoothing delay.

## 2. Reading the market

At each whole second the game reads four things from the bars before it (`features`):

| Reading | What it is |
| --- | --- |
| `price` | the last close |
| `sigma` | how busy the market is: five-second moves over the last five minutes |
| `momentum` | the last three seconds' move, in units of `sigma` |
| `wick` | how far the price swings inside a second, beyond close-to-close |

The **market step** is 2.5 typical one-second moves, rounded to a round dollar
figure (`stepFor`). On every screen the chart shows nine market steps top to
bottom and 16.5 seconds ahead of now (`drawingLayout`, `VIEW_SECONDS` = 15). Ink can be
bet up to 30 seconds ahead; the view shows the nearer half, stretched, so it moves fast. The pen stops at the chart's
top and bottom edges.

## 3. What you draw

- A pen is a round nib: 8, 14 or 20 CSS pixels (Fine, Medium, Wide).
- A stroke is the nib swept along your path: round caps, round joins.
- Its **area** is measured in dots. One dot is one full nib tap: `A = π · rt · rp`,
  where `rt` and `rp` are the nib's radius in time and price.
- Area is integrated in 2-pixel price slices, 24 samples per second.
- Going back over your own ink in one drawing costs nothing extra.
- A tap entirely in play is exactly one dot, however it lines up.

**Cost** = your per-dot amount × area, rounded up to the cent once per drawing.

Ink is bet **as it is drawn**, not when the pen lifts. About every 150 ms while the
pen is down, the ink added since the last piece (`newInk`) opens on the next second,
priced on what is known then (`placeInk`). A slow stroke is not priced on where the
market has gone by the time it ends. The pieces add up to exactly the whole stroke's
area, and the drawing's stake rounds up to the cent once over all of them: each piece
takes the growth of that rounded total. Payouts round once per drawing the same way.

## 4. Sections

Each second of a drawing is cut into **sections** of about two dots or less,
each a continuous band of price. A section pays once if the price reaches any
part of it.

- Two CSS pixels of tolerance are added above and below every section.
- Its chance is priced with the same tolerance.

## 5. The chance

The chance is measured, not modelled.

- The library: 16,000 real 30-second stretches of Coinbase BTC-USD, 1–16 September 2026,
  folded into one-second bars the same way the live feed folds them.
- Each stretch is weighted by how like now it started: as busy, moving the same way.
  The match widens until at least 1,500 effective paths count.
- Each path's in-second swings are scaled to how much the price swings inside a second now.
- A section's chance is the weighted share of paths whose second reached its band:
  `P(low ≤ top) − P(high < bottom)`.

A section in second `t` is reached if that second's range, counted from the
previous close to its own high and low, overlaps the padded band. Live
judging uses the same rule on live bars.

### Why the chance is measured

A formula was fitted (`scripts/odds-formula.ts`) and tested on a week it never saw.
Ordinary players got back 45–75¢ a dollar. A bot that drew only where the formula
was generous got back up to $1.21. Bitcoin sits on its tick, jumps, and keeps going
after a jump; a smooth formula gets each of those wrong somewhere a player can find.

## 6. What a section pays (`ladder-v1`)

Every piece of ink pays a rung of one ladder, per dollar of ink:

```
LADDER = 1.1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128 (×)
fair   = (ladderBest − momentum margin) / p
rung   = the highest rung ≤ fair, or the floor if fair is under it, or 128× past it
hit pays d × stake × rung                  (one section pays at most 256 dots)
```

- **Difficulty** is one number, 0 to 100 (`DIFFICULTY` in `dots.ts`, 60 by default;
  a slider in the help sheet in development, or with `?house`). It sets `ladderBest`,
  what ink exactly on a rung returns: 1.20 − 0.40 × d/100, so 96¢ at 60. It also sets
  the floor, what near-certain ink pays: 1.1× up to 70, easing to 1× at 100. Harder
  lowers every rung a spot earns; nothing ever pays under 1×.
- A section's chance `p` sets its rung. Ink placed exactly on a rung returns
  `ladderBest` per dollar. Everywhere between rungs rounds down, by at most a third, and 15% on average.
  Rungs double, with one between each pair, so the loss stays small.
- Only ink the price actually crosses pays.
- On the side the price has just moved toward, fair is lowered by 0.11 × momentum,
  at most two units.
- Ink too likely for the floor still pays the floor, so no stroke is cut. Where it is over 91%
  likely, that ink returns more than a dollar; see the replay's `on-price` row.
- Ink worth more than 128× pays 128×, so the farthest ink returns less than the rest.

The map shows three columns of numbers, each doubling rung (2×, 4× … 128×) once per
side in the middle of its band, plus what the price's own band pays. Under them a soft
glow, sampled from the same quotes, is dark on the price and brightens, blue toward
white, as the rung climbs. Numbers and glow re-price each second and cross-fade rather than snap.

### Why every screen and pen returns the same

A rung depends only on a section's chance, and a chance depends only on where the
ink is in price and time. The pen and the screen change how much ink goes where,
never the rung a given chance earns.

### Time

On the price line the rung rises with time: 1.1× a few seconds out, 4× at 30
seconds, because the price has longer to wander off. At the edge it falls with
time: a far level is out of reach in 5 seconds but not in 30.

### Why far rungs come close to the price

A dot is small and pays only in its own second. Even one row off the price, a
dot's exact second touches it only about 1 time in 30. Bitcoin second to second
mostly sits still and then jumps, so far rows are touched more often than a smooth
curve would say, and the multiples climb slowly rather than exponentially.

The chances themselves were checked against what happened, before the ladder rounded
them: 123,000 single taps over a laptop-sized map, Binance September 17–24, Medium pen,
grouped by the continuous multiple they were quoted:

| Quoted | Actually hit | Priced at | Paid back per $1 |
| --- | --- | --- | --- |
| under 2× | 13.0% | 14.6% | 0.64 |
| 2–5× | 7.9% | 8.5% | 0.67 |
| 5–10× | 6.4% | 6.5% | 0.70 |
| 10–20× | 4.2% | 4.3% | 0.70 |
| 20–30× | 2.8% | 2.6% | 0.77 |
| 30–50× | 1.7% | 1.7% | 0.73 |
| 50–100× | 0.9% | 0.8% | 0.75 |

### Zoom

The chart shows nine market steps top to bottom. Zooming in moves the edge closer to
the price (lower edge multiples) but makes the same pen cover less price (higher
multiples everywhere else), so the map gets flatter rather than just shorter. On a
laptop, a tap's quote by zoom (columns: 5, 17 and 29 seconds ahead):

| Market steps in view | On the price | Halfway to the edge | At the edge |
| --- | --- | --- | --- |
| 3 | 1.5× / 3.3× / 5.4× | 12.7× / 13.9× / 16.1× | 24.7× / 18.4× / 20.3× |
| 6 | 1.4× / 2.8× / 4.3× | 14.8× / 10.9× / 12.1× | 72.8× / 30.5× / 22.0× |
| 9 (today) | 1.3× / 2.4× / 3.6× | 24.1× / 12.2× / 10.4× | 92.9× / 57.5× / 35.8× |

## 7. Timing

- Each piece of ink opens on the next whole second and is priced there, on everything
  known by then.
- The second after opening is never in play, so nobody can react faster than the bet.
  So ink starts counting one to two seconds ahead; the dashed wait line holds still at
  two seconds, and everything right of it always counts.
- Ink reaches 30 seconds ahead of the opening second.
- The preview uses the last closed second's map; the opening uses its own second's.
  If a section is no longer offered at opening, its stake is refunded.
- A hit pays the moment the price reaches it and glows green. A miss settles once its
  second closes and turns red as the price passes.

## 8. Live P&L

- Placing a drawing takes its cost from the balance at once.
- Live P&L is payouts received minus the cost of ink that has settled. Pending ink
  is not counted as a loss.
- When a batch of drawings finishes, its result stays as Last P&L.

## 9. The replay

`check-ink-area.ts` replays days the library never saw. It uses the page's own
layout, preview, opening, refunds and settlement, at ten screen sizes, three pens
and five drawing styles: a random tap, a level line, with momentum, against it,
and `on-price`, ink only on the live price in the first seconds.

```bash
STEP=600 OUT=report.json bun packages/core/scripts/check-ink-area.ts \
  packages/core/src/dots-lib.bin <csv folder> 2026-09-17 2026-09-18 …
```

Coinbase BTC-USD, September 17–24, library from September 1–16, at difficulty 70
(ladder best 92¢): 172,777 drawings opened, 8,047,900 invariant checks passed. At the
default 60 (best 96¢) the same replay returns 0.781 overall (95%: 0.730–0.834), 0.771–0.788 by screen and 0.778–0.784 by pen; at 75 (best 90¢) it was 0.730.
The replay places each drawing whole; pieces bet as they are drawn price each piece
the same way.

| | Got back per $1 | Model |
| --- | --- | --- |
| Every screen, phone to 1440p | 0.738–0.754 | 0.756–0.759 |
| Every pen, Fine / Medium / Wide | 0.750 / 0.743 / 0.740 | 0.756–0.758 |
| Level line / against momentum | 0.703 / 0.709 | 0.755 / 0.769 |
| With momentum | 0.830 | 0.741 |
| `on-price` | 0.876 | 0.792 |
| **All** | **0.746** (95%: 0.698–0.796) | **0.757** |

Drawing with the last three seconds' move returns more than the model expects on
Coinbase (0.83 against 0.74): the momentum margin, tuned on Binance, is too small here.

By rung, single taps spread over a laptop map, with the best at 90¢ (73¢ overall):

| Rung | 1.1× | 1.5× | 2× | 3× | 4× | 6× | 8× | 12× | 16× | 24× | 32× | 48× | 64× | 96× | 128× |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hit rate | 68% | 49% | 34% | 24% | 17% | 12% | 9% | 6.6% | 4.8% | 3.1% | 2.4% | 1.7% | 1.1% | 0.8% | 0.4% |
| Per $1 | 0.74 | 0.73 | 0.69 | 0.72 | 0.69 | 0.75 | 0.71 | 0.78 | 0.79 | 0.77 | 0.79 | 0.78 | 0.72 | 0.80 | 0.55 |

Ten single taps in a row: median 30¢ back, 39% lose everything, the luckiest 10%
get $1.85 or more. How much a session swings depends on the rung drawn on, not the
formula: ten $1 taps land between 50¢ and $1.25 only on the lowest rungs.

Five fixed drawing styles are not a search for every exploit. The replay has no
network latency. Model agreement does not guarantee future returns.

## 10. Rebuilding

```bash
# Coinbase trades, folded into one-second bars, one CSV per UTC day (about a minute a day)
bun packages/core/scripts/fetch-coinbase.ts <csv folder> 2026-09-01 … 2026-09-24

# the path library
bun packages/core/scripts/build-dots-lib.ts <csv folder> packages/core/src/dots-lib.bin 2026-09-01 … 2026-09-16
cp packages/core/src/dots-lib.bin ui/app/public/dots-lib.bin   # a test checks the two match

# tests
cd packages/core && bun test
```

## Saved drawings

Drawings saved in a browser under earlier terms (`area-v1`, `rounded-v1` to `rounded-v3`, `fair-v1`,
and the original per-row points) keep the terms they opened on. `ink.ts` never
reprices a saved drawing.

## Before real money

- Retrain the library on recent days, and watch live hit rates against priced ones.
- Route the price through a service, and settle on the same bars the server saw.
- Settle on a server running this same code, not in the browser.
- Get legal advice: this is a fixed-odds bet on a price.
