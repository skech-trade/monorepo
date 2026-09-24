# Ink: draw ahead of the price

The game at `/fun` is: draw with a pen ahead of the
Bitcoin price, and the ink the price runs through pays. It is practice money
for now: $1,000 in the browser, no sign-in needed.

The engine is `packages/core/src/ink.ts` (strokes, cost, payouts) on top of
`packages/core/src/dots.ts` (the market readings, the library of real price
paths, the chances). The screen is `ui/app/src/components/app/ink/`. The
Lighter trading code is untouched and unused by it.

## The rules

- **The ink is the bet, exactly as drawn.** Two settings, the two buttons
  under the chart on a phone: the **pen** (fine, medium, wide) and what a
  **point** of ink costs (10¢, 25¢, 50¢ or $1; a point is one price step of
  ink for one second). Deposit sits in the app bar, left of sign-in.
- **The pen changes the multiples; the amount does not.** Each pen's ink is
  judged in cells as tall as the pen is wide (half a step, one step, a step
  and a half), so wider ink catches the price more often and pays less for
  it, and the map redraws its multiples for the pen in hand. The amount only
  scales the dollars: a hit pays the ink's cost times its multiple.
- **It costs its area.** Longer or thicker ink costs more.
- **Only the ink the price touches pays.** Each second, the prices Bitcoin
  trades across in that second are checked against your ink in that second;
  the ink inside that range pays, the rest does not. A tall stroke crossed at
  one point pays for that point.
- **What it pays depends on where it is.** Ink near the price is likely to
  be hit and pays a little (from 1.01×); ink far from it, in price or time,
  pays a lot (up to 50×). The map on screen shows it: a soft glow where the
  price will likely go, fading outward, with the multiples written on it.
- **Timing.** A drawing opens on the next whole second and is priced there.
  The second after that is never part of it, so nobody can react faster than
  the bet. It reaches 30 seconds ahead. Ink that is too soon or too far out
  to measure stays faint and costs nothing.

## How a chance is measured

Underneath, ink is measured on cells one second wide and as tall as the pen
is wide: 0.4, 0.7 or 1 price step (a step is about 1.2 of the market's
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

A cell pays `rtp / chance`, with `rtp` 0.85, less on the side the price has
just moved toward (0.11 less per unit of momentum, at most 0.22). The chance
gets a small correction for how many paths it rests on, because paying 1/p
on a noisy p overpays on average.

## What the week it never saw says

Checked with `packages/core/scripts/check-ink.ts` on 17–23 September, with
the engine the page runs, each pen drawn as the page draws it, strokes of
every kind and bots. What they got back per $1 of ink:

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
