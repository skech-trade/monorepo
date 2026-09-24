# Ink: draw ahead of the price

The game at `/fun` is: draw with a pen ahead of the
Bitcoin price, and the ink the price runs through pays. It is practice money
for now: $1,000 in the browser, no sign-in needed.

The engine is `packages/core/src/ink.ts` (strokes, cost, payouts) on top of
`packages/core/src/dots.ts` (the market readings, the library of real price
paths, the chances). The screen is `ui/app/src/components/app/ink/`. The
Lighter trading code is untouched and unused by it.

## The rules

- **A line is points.** Every second your line passes through a row of
  prices is one point. Each point costs what you set under **Per point**
  (5¢ to $5, on the trading screen's wheel), so a longer line, or one that climbs through more
  rows, costs more. Deposit sits in the app bar, left of sign-in.
- **Points are placed as you draw them.** The moment the pen covers a new
  point it is bet and comes off the balance; lifting the pen places nothing
  more. The ticket while drawing says how many points so far and what they
  cost.
- **A hit pays the point times its multiple.** A point the price trades in
  during its second pays what you set times the multiple there: 25¢ at 10×
  is $2.50. The pen shows both ("10× · $2.50"), and the hit shows the same
  figure. A line's result says how many of its points were hit.
- **The pen changes the multiples; the amount does not.** Rows are as tall
  as the pen is wide (0.4, 0.7 or 1 price step), so a wider pen's points are
  hit more often and pay less, and the map redraws for the pen in hand.
- **What it pays depends on where it is.** Ink near the price is likely to
  be hit and pays a little (from 1.01×); ink far from it, in price or time,
  pays a lot (up to the top payout the difficulty sets: 28× at 60). The map on screen shows it: a soft glow where the
  price will likely go, fading outward, with the multiples written on it.
- **Timing.** A drawing opens on the next whole second and is priced there.
  The second after that is never part of it, so nobody can react faster than
  the bet. It reaches 30 seconds ahead. Ink that is too soon or too far out
  to measure stays faint and costs nothing.

## How hard it is: one number, 0 to 100

`difficulty(d)` in `packages/core/src/dots.ts` sets every lever the house
has, together:

| Lever | At d | Why it matters |
| --- | --- | --- |
| return per point (`rtp`) | 0.95 − 0.40 × d/100 | the house keeps the rest, on average |
| top payout (`maxMultiple`) | 100 × 0.12^(d/100) | a lucky big hit is what turns a losing session around |
| lowest multiple offered | 1.01 + 0.19 × d/100 | nearly sure points stop being offered |
| margin on the side it just moved to | 0.11 + 0.09 × d/100 | momentum carries on more than the paths say |

The game plays at 60. On the house's side, the slider is in How it works
in development, or with `?house` in the address (it is practice money, kept
per browser). `DIFFICULTY=` on `check-ink.ts` backtests any level. On
17–23 September, the medium pen:

| Difficulty | Keeps | Top payout | 50 drawings ended ahead | 200 ended ahead | Got back per $1, by day |
| --- | --- | --- | --- | --- | --- |
| 0 | 5% | 100× | 33% | 29% | 0.73–0.99 |
| 30 | 17% | 53× | 16% | 9% | 0.60–0.85 |
| **60** | **29%** | **28×** | **7%** | **2%** | **0.48–0.71** |
| 80 | 37% | 18× | 3% | 0% | 0.42–0.61 |
| 100 | 45% | 12× | 1% | 0% | 0.37–0.52 |

"Ended ahead" is the share of sessions of that many drawings, of one kind of
line, that finished with more than they started; averaged over the kinds.
At 60 the fine and wide pens come out the same (7% after 50 drawings). 30 is
about where the game was, at 0.85 and 50×: at 60 coming out ahead is two and
a half times rarer.

## One place for the odds

`packages/core/src/odds.ts` is the one place the game's numbers come from.
`terms(map, now, step, pen, perPoint)` answers everything for a drawing
placed now:

| | |
| --- | --- |
| a row | `step × PEN_CELLS[pen]` dollars tall: a wider pen, taller rows |
| a point | each second a line passes through a row, once (`cellsOf`) |
| cost | `perPoint × points in play` (`costOf`) |
| chance | how often the price trades in that row in that second, measured on real paths (below) |
| multiple | `rtp ÷ chance`, rounded down, between the lowest and top multiple the difficulty sets, else not offered |
| a hit pays | `perPoint × multiple`, rounded down to the cent (`payoutOf`) |
| the house | keeps `1 − rtp` of every point on average |

The chart's labels (what a hit pays there, in dollars), the pen's
"10× · $2.50", the ticket while drawing, the cost taken, and the payout on a
hit all read from it; `judge` pays with the same `payoutOf`. So the pen
changes the multiples, and what a point costs changes the dollars on the
chart, never the multiple: if it did, a bigger bet would be a worse one.
Tests hold the chart, the pen, the charge and the payout to the same figures.

## A formula for the odds, and why it is not used

The chance could be a formula instead of a measurement, and one was fitted
(`packages/core/scripts/odds-formula.ts`, fitted by `fit-odds.ts`): the price as a random walk, touching
a row within a second by the reflection principle, with a share of jumps,
drift from momentum, and a chance the price has not moved off its tick yet,
which fades over the seconds and faster in a busy market. Nine constants,
fitted to 19,000 measured points; on average it was within a few percent in
every band of multiples.

On the week it never saw it lost on both ends:

| | Got back per $1 |
| --- | --- |
| ordinary lines | 0.45–0.75 |
| a bot that knows the measured odds and draws only where the formula is at least 10% generous | 1.00–1.21 |
| a bot chasing jumps | 0.91–1.08 |

Unfair to players, and beatable by anyone who notices where. Bitcoin a
second at a time sits on its tick, jumps, and carries on after a jump, and a
smooth formula gets each of those wrong somewhere a player can find. The
measured chance has no such gap: it is what happened.

## How a chance is measured

Underneath, a point is a cell one second wide and as tall as the pen is
wide: 0.4, 0.7 or 1 price step (a step is about 1.2 of the market's
typical one-second moves). Each
cell's chance is the share of 16,000 real 30-second stretches of Binance
BTCUSDT (1–16 September 2026) that passed through it, taken from moments
like this one:

- as busy (volatility read on five-second moves, not one-second ones: the
  second-to-second rattle between buyers and sellers made quiet markets look
  busy, and a cell on the price was hit four times as often as priced);
- moving the same way (the last three seconds' move);
- with each path's in-second swings scaled to how far the price is swinging
  inside a second now.

A cell pays `rtp / chance`, with `rtp` set by the difficulty (0.71 at 60), less on the side the price has
just moved toward (the momentum margin per unit of momentum, 0.164 at 60, for at most two units). The chance
gets a small correction for how many paths it rests on, because paying 1/p
on a noisy p overpays on average.

## What the week it never saw says

Checked with `packages/core/scripts/check-ink.ts` on 17–23 September, with
the engine the page runs, each pen drawn as the page draws it, strokes of
every kind and bots. What they got back per $1 (these are the numbers for
ink priced by area, just before points; with points every day and every
stroke came out within a cent or two of them: no day over 0.89, no stroke
over 0.86):

| Stroke | Fine | Medium | Wide |
| --- | --- | --- | --- |
| wander from near the price | 0.76 | 0.77 | 0.78 |
| a flick, anywhere | 0.75 | 0.75 | 0.79 |
| thin level line | 0.76 | 0.77 | 0.78 |
| thick blob near the price | 0.69 | 0.74 | 0.77 |
| wander, far out | 0.73 | 0.74 | 0.76 |
| bot, drawing the way the last 3 s moved | 0.84 | 0.84 | 0.84 |
| bot, chasing a jump | 0.74 | 0.75 | 0.77 |
| bot, drawing against the last 3 s | 0.75 | 0.75 | 0.75 |
| **by day, worst for the house** | **0.87** | **0.87** | **0.88** |
| by day, best for the house | 0.62 | 0.62 | 0.63 |

So the house keeps about 23% on an ordinary day and at least 12% on its
worst: the margin to pay out of when a crash pays players more than it takes.
A player can still come out ahead, which keeps it a game: over 50 drawings,
16–31% of sessions did; over 200, 0–24%, depending on how they draw (the
check prints it by stroke).

Why the old margin lost money: `rtp` was 0.94, and live play judged a trade
exactly on the line between two cells as hitting both. Bitcoin trades on
round numbers and the lines are round numbers, so ink near the price was
hit more often than the paths (which never land exactly on a line) had
priced it, worth about 8% of what was paid. A price on a line is now in the
cell above only, in the pricing, the map and the judging alike.

Before real money: retrain on recent days every day, watch live hit rates
against priced ones, pause when they drift, and get legal advice (this is a
fixed-odds bet on a price).

Other things the checks caught, all fixed: one-second volatility mispriced
quiet markets; widening the path match after jumps also blurred momentum (a
jump-chasing bot got 1.23); and one bet per second paid a whole tall stroke
when the price touched any part of it.

## Keeping it smooth

Measuring the map on 16,000 paths takes 50–150 ms. It runs in a worker
(`field.worker.ts`), once a second, for the second that has just ended; a
drawing opening on that second is priced straight off it (`openOn`, the same
multiples as pricing it on the paths, which a test holds it to), and the
stroke being drawn is quoted off it too (`quoteOn`). The page re-renders ten
times a second, not every frame; the chart reads the trades directly.

## Rebuilding and checking

```bash
# the library, from Binance 1s klines (data.binance.vision)
bun packages/core/scripts/build-dots-lib.ts <csv folder> packages/core/src/dots-lib.bin 2026-09-01 … 2026-09-16
cp packages/core/src/dots-lib.bin ui/app/public/dots-lib.bin   # a test checks the two match
# the check, on days the library did not see
bun packages/core/scripts/check-ink.ts packages/core/src/dots-lib.bin <csv folder> 2026-09-17 … 2026-09-23
```

Before points, ink was priced by area: each sliver of ink a bet of its own,
at a share of a unit. It was fair, but a hit paid for the sliver the price
touched, and nothing on the screen said how big that was: the map read 10×
and the hit paid 17¢.
