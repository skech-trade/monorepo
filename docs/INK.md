# Ink: draw ahead of the price

The main app (`/app/<bitcoin>`) is one game: draw with a pen ahead of the
Bitcoin price, and the ink the price runs through pays. It is practice money
for now: $1,000 in the browser, no sign-in needed.

The engine is `packages/core/src/ink.ts` (strokes, cost, payouts) on top of
`packages/core/src/dots.ts` (the market readings, the library of real price
paths, the chances). The screen is `ui/app/src/components/app/ink/`. The
Lighter trading code is untouched and unused by it.

## The rules

- **The ink is the bet, exactly as drawn.** Pick a pen (fine, medium, thick)
  and what ink costs (10¢, 25¢, 50¢ or $1 a unit; a unit is one price step
  of ink for one second).
- **It costs its area.** Longer or thicker ink costs more.
- **Only the ink the price touches pays.** Each second, the prices Bitcoin
  trades across in that second are checked against your ink in that second;
  the ink inside that range pays, the rest does not. A tall stroke crossed at
  one point pays for that point.
- **What it pays depends on where it is.** Ink near the price is likely to
  be hit and pays a little (from 1.01×); ink far from it, in price or time,
  pays a lot (up to 100×). The map on screen shows it: a soft glow where the
  price will likely go, fading outward, with the multiples written on it.
- **Timing.** A drawing opens on the next whole second and is priced there.
  The second after that is never part of it, so nobody can react faster than
  the bet. It reaches 30 seconds ahead. Ink that is too soon or too far out
  to measure stays faint and costs nothing.

## How a chance is measured

Underneath, ink is measured on cells one second wide and half a price step
tall (a step is about 1.2 of the market's typical one-second moves). Each
cell's chance is the share of 16,000 real 30-second stretches of Binance
BTCUSDT (1–16 September 2026) that passed through it, taken from moments
like this one:

- as busy (volatility read on five-second moves, not one-second ones: the
  second-to-second rattle between buyers and sellers made quiet markets look
  busy, and a cell on the price was hit four times as often as priced);
- moving the same way (the last three seconds' move);
- with each path's in-second swings scaled to how far the price is swinging
  inside a second now.

A cell pays `rtp / chance`, with `rtp` 0.94, less on the side the price has
just moved toward (0.11 less per unit of momentum, at most 0.22). The chance
gets a small correction for how many paths it rests on, because paying 1/p
on a noisy p overpays on average.

## What the week it never saw says

Checked with `packages/core/scripts/check-ink.ts` on 17–23 September, with
the engine the page runs, strokes of every kind and bots:

| Stroke | Paid back per $1 |
| --- | --- |
| wander from near the price | 0.94 |
| a flick, anywhere | 0.95 |
| thin level line | 0.91 |
| thick blob near the price | 0.92 |
| wander, far out | 0.98 |
| bot, drawing the way the last 3 s moved | 0.99 |
| bot, chasing a jump | 0.91 |
| bot, drawing against the last 3 s | 0.89 |

By day it ran 0.80 to 1.14: the market changes from day to day, and one day
of seven paid players more than it took. Fine for practice money. Before real
money: retrain on recent days every day, watch live hit rates against priced
ones, pause when they drift, and get legal advice (this is a fixed-odds bet
on a price).

Four things the checks caught, all fixed: a cell on the line between two
rows was counted in both; one-second volatility mispriced quiet markets;
widening the path match after jumps also blurred momentum (a jump-chasing bot
got 1.23); and one bet per second paid a whole tall stroke when the price
touched any part of it.

## Rebuilding and checking

```bash
# the library, from Binance 1s klines (data.binance.vision)
bun packages/core/scripts/build-dots-lib.ts <csv folder> packages/core/src/dots-lib.bin 2026-09-01 … 2026-09-16
cp packages/core/src/dots-lib.bin ui/app/public/dots-lib.bin   # a test checks the two match
# the check, on days the library did not see
bun packages/core/scripts/check-ink.ts packages/core/src/dots-lib.bin <csv folder> 2026-09-17 … 2026-09-23
```
