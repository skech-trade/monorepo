# How skech works

You draw ink ahead of Bitcoin's live price. Ink the price runs through pays.
It is practice money for now: $1,000 in the browser, no sign-in needed.

| Part | Where |
| --- | --- |
| The screen | `ui/app/src/components/app/ink/` |
| The live price | `packages/engine` (Rust), read by `ui/app/src/lib/engine.ts` |
| The game on chain | `packages/contracts/solana/programs/skech/src/` (Anchor, on Solana) |
| Pricing and sending pieces to the chain | `packages/relayer` (Bun) |
| What the app signs, and the ladder in integers | `packages/core/src/chain.ts` |
| The browser's drawing key, the relayer, real money on screen | `ui/app/src/lib/session.ts`, `lib/relayer.ts`, `components/app/ink/chain-context.tsx` |
| Practice balance and settings | `ui/app/src/lib/practice.ts` |
| Market readings, price paths, chances | `packages/core/src/dots.ts` |
| Drawings: cost, opening, settlement | `packages/core/src/ink.ts`, `ink-area.ts` |
| Quotes while drawing | `packages/core/src/odds.ts` |
| Price history | `packages/core/scripts/fetch-coinbase.ts` |
| Replay check | `packages/core/scripts/check-ink-area.ts` |

The page, the replay and the tests run the same functions from `packages/core`.
Nothing is priced twice.

## 1. The price

- Coinbase BTC-USD, trade by trade, over its public WebSocket (`matches`), through the engine (`packages/engine`).
  The browser talks only to the engine.
- The engine keeps the last ten minutes of trades, backfilled from Coinbase's REST API when it starts,
  and sends them to the app on connect to seed the chart.
- Each live trade comes signed by the engine's wallet as EIP-712 typed data, under one fixed domain, so the
  relayer can check the price a piece was drawn at before it places it (`packages/engine/src/quote.rs`).
- The engine passes on Coinbase's heartbeat every second. Five seconds with no message at all and the socket is reopened.
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
figure (`stepFor`). On every screen the chart shows 6.75 market steps top to
bottom (`VIEW_STEPS`: nine, zoomed in by 10/7.5) and 16.5 seconds ahead of now (`drawingLayout`, `VIEW_SECONDS` = 15). Ink can be
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
rung   = the highest rung ≤ fair, or 128× past it; under the floor, fair itself,
         rounded down to the hundredth, and never under 1×
hit pays d × stake × rung                  (one section pays at most 256 dots)
```

- **Difficulty** is one number, 50 to 100 (`DIFFICULTY` in `dots.ts`, 55 by default;
  a slider in the help sheet in development, or with `?house`). It sets `ladderBest`,
  what ink exactly on a rung returns: 1.20 − 0.40 × d/100, so 98¢ at 55. Under 50 that
  is more than a dollar, so both chains refuse a lower setting (`MIN_DIFFICULTY`), and
  price one set lower before there was a least as 50. It also sets the floor, the least
  a rung pays: 1.1× up to 70, easing to 1× at 100. Harder lowers every rung a spot earns;
  nothing ever pays under 1×.
- A section's chance `p` sets its rung. Ink placed exactly on a rung returns
  `ladderBest` per dollar. Everywhere between rungs rounds down, by at most a third, and 15% on average.
  Rungs double, with one between each pair, so the loss stays small.
- Only ink the price actually crosses pays.
- A band is never priced as likelier than one nearer the price. Far out, a band's chance
  rests on a few library paths, and a handful that ended together once made 12×, 8×, 12×
  alternate a few pixels apart. Each second, chances are held to fall away from the
  likeliest price (`fallingChances` in `dots.ts`), which only ever lowers a payout.
- On the side the price has just moved toward, fair is lowered by 0.11 × momentum,
  at most two units.
- Ink too likely for the floor pays its fair multiple, rounded down to the hundredth, and
  never under 1×: 99% likely at 55 pays 1× (99¢ back), 90% pays 1.08×. So no stroke is
  cut, and at every chance and difficulty a band returns at most a dollar per dollar before
  fees (chance × rung ≤ 1, tested exhaustively in `chain.test.ts` and fuzzed on chain).
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

On the price line the rung rises with time: about 1× a few seconds out, 4× at 30
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

The chart shows 6.75 market steps top to bottom (it showed nine until September 28). Zooming in moves the edge closer to
the price (lower edge multiples) but makes the same pen cover less price (higher
multiples everywhere else), so the map gets flatter rather than just shorter. On a
laptop, a tap's quote by zoom (columns: 5, 17 and 29 seconds ahead):

| Market steps in view | On the price | Halfway to the edge | At the edge |
| --- | --- | --- | --- |
| 3 | 1.5× / 3.3× / 5.4× | 12.7× / 13.9× / 16.1× | 24.7× / 18.4× / 20.3× |
| 6 | 1.4× / 2.8× / 4.3× | 14.8× / 10.9× / 12.1× | 72.8× / 30.5× / 22.0× |
| 9 (until September 28) | 1.3× / 2.4× / 3.6× | 24.1× / 12.2× / 10.4× | 92.9× / 57.5× / 35.8× |

## 7. Timing

- Each piece of ink opens on the next whole second and is priced there, on everything
  known by then.
- The second after opening is never in play, so nobody can react faster than the bet.
  So ink starts counting one to two seconds ahead. The wait line holds still at two
  seconds: everything right of it always counts, and the zone left of it is greyed out
  and cannot be drawn in.
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

These figures predate the rule that near-certain ink pays its fair multiple, not the floor:
`on-price`, and a little of every other row, will come in lower when the replay is run again.

Coinbase BTC-USD, September 17–24, library from September 1–16, at difficulty 70
(ladder best 92¢): 172,777 drawings opened, 8,047,900 invariant checks passed. At the
default 55 (best 98¢), with chances held to fall away from the price, the same replay returns 0.779 overall (95%: 0.729–0.832), 0.777–0.783 by screen and 0.779–0.780 by pen; drawing with the momentum returns 0.876 (95%: 0.789–0.975). Before that rule it was 0.798 at 55; at 60 0.781, at 75 0.730. At 66
(best 93.6¢), 172,800 drawings, 11,338,664 invariant checks passed: 0.744 overall
(95%: 0.695–0.795), 0.741–0.748 by screen, 0.744 for every pen; level line 0.695,
against momentum 0.710, with momentum 0.839, `on-price` 0.859.
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

### The paper run

Signed out, "Try it free" plays thirty seconds on $10 of paper money (`paper.ts`):
the live price, the real screen, nothing sent to the relayer, no fees, a cent a dot,
and a "Practice" pill the whole time. It plays the real game's odds: the live game's
difficulty when the relayer has said it, else the game's own. A practice run that paid
more than the real game would sell one that isn't there.

`check-paper.ts` replays six strokes drawn near the price (a level line within a
market step, with and against the move, along the price, from the price drifting
off, a zigzag across it) on three screens and three pens at 10¢ a dot. Coinbase
BTC-USD, October 7–9, 46,494 drawings per level:

| Difficulty | Best ink | Touched | Came out ahead | Per $1 |
| --- | --- | --- | --- | --- |
| **55 (real, and paper)** | **0.98** | **59.7%** | **28.6%** | **0.783** |
| 50 | 1.00 | 59.7% | 29.1% | 0.799 |
| 25 | 1.10 | 59.7% | 31.2% | 0.880 |
| 0 | 1.20 | 59.7% | 33.0% | 0.961 |
| −50 | 1.40 | 59.7% | 36.0% | 1.122 |
| −100 | 1.60 | 59.7% | 38.4% | 1.286 |

Whether the price touches a stroke does not depend on the difficulty: 74–79% of
strokes along, from or across the price are touched, 51% of level lines, 38–40% of
diagonal ones. The difficulty only moves what a touch pays, so it cannot raise the
hit rate, and even a giveaway does not make most rounds come out ahead.

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

## 11. On chain

Signed in, with a game deployed on the cluster `SKECH_SOLANA_CLUSTER` names (devnet for now), the same
drawing is played for USDC on Solana. On devnet the USDC is free from Circle's faucet, and the app says
so where it asks for a deposit. Nothing about the pricing changes; what changes is who vouches for what.

### The grid

Ink is priced and judged on a grid of the market step: one unit is the step over 50 (20¢ on a $10
step), bands sit on it, and every band is judged one unit wider each way (`gridStep`, `unitFor` in
`chain.ts`). The screen sets only the pen's size. So a phone and a 1440p screen price the same ink
the same, and the chain judges exactly what was priced. The replay (`check-ink-area.ts`) runs on the
same grid.

### The program

One Anchor program, `skech` (`packages/contracts/solana`; its README has the details). Its accounts are
all addresses of the program:

- **`Game`** holds the terms, the oracle and the USDC vault. The house never holds the players' money.
- **`Pool`**: every stake goes into one pool, and every hit is paid from it. The house's take is counted
  here too: 4% of every stake as it is placed, and 10% of the profit on every hit, both the admin's to
  set (`set_config`). `collect_fees` moves it to the treasury. Nothing else.
- **`Market`** and **`Bars`**: each market's difficulty, and a ring of its last 240 seconds of price. The
  ladder is computed in the program (`ladder.rs`, the same integers as `chain.ts`, checked row for row
  against `@skech/core`), so the oracle cannot pay a band more than its chance earns at the difficulty on
  chain.
- **`Player`**, one per wallet: its USDC balance, its session key, and the IOUs it holds. An IOU is what the
  game owes when the pool cannot pay a hit at once: shares worth one USDC when they started and rising at a
  fixed rate, carrying their basis, what was owed when they were issued. Anyone may hand a holder's shares
  back once the pool can pay (`redeem`), and is paid 10% of the growth for it; a holder redeeming their own
  pays nothing. The house is never owed: its 10% of a profit is taken after the player is paid, from what
  the pool has left, and goes without the rest.
- **`Bet`**, one per piece: its bands until each is decided. It is then closed, its rent back to the relayer.

The EVM contracts the game was first written as (`packages/contracts/evm`) are kept in the repo, not
deployed or used; the conformance cases (`packages/contracts/conformance`) still play both, so the two agree
on every payout, fee, refund and refusal.

### What goes on chain, and who signs it

| Thing | Signed by | Says |
| --- | --- | --- |
| A **piece** of a drawing | the player's session key (Ed25519, checked by the Ed25519 precompile over the piece as it sits in `place`) | the bands (second, price from, width, on the grid), what each stakes, what a dot costs, the second it opens on, the price on the screen and when, the difficulty shown, the stroke's hash |
| A **quote** | the oracle (the relayer's key), by signing the `place` transaction | when the piece was received, the market's price and momentum then, and each band's chance in billionths |
| A **price** | the engine, as EIP-712 typed data | the price the player saw, as the engine already signs every trade; the relayer checks it before it places the piece |
| A **bar** | the oracle, by signing the transaction | one second of the price: the close before it, its high, low and close |

The chance is measured off chain, on the paths, as before; it cannot be measured on chain. The
rung is computed on chain from the chance, the difficulty and the momentum. Each piece is its own
`place` transaction: transactions that write different accounts run in parallel, and a placement writes
only the player's account, their new bet and the pool. A piece that cannot go in fails with its reason.
`post_bar_and_settle` records a second's bar with the first dozen bets that have ink in it, and the rest
settle on it in parallel: a band is hit if the second's range, from the close before to its high and low,
reaches it, one unit wider each way, the rule of section 5.

### Timing, and why it cannot be gamed

- A piece must reach the relayer before its opening second, give or take 200 ms (`late_ms`, on
  chain); the oracle vouches for when it received it, and the program refuses anything later. The app
  computes the opening second from `now + 200 ms`, so a piece drawn at the end of a second opens on
  the one after and is never late.
- The `place` transaction must land within 3 s of the opening second (`place_grace_ms`); a band
  whose second is already posted is refused and its stake not taken.
- The price a player saw must be no older than 15 s and no newer than the receipt.
- A bar may be posted up to 200 s after its second. A band whose second was never posted by then is given
  back in full by `expire`, which anyone may send.
- A piece is named by its player, drawing and index, and its bet lives at the one address that names: sent
  twice, it is refused as a replay.
- A piece is signed under the game's domain (SHA-256 of `skech/v1`, the program id and the cluster), so
  nothing signed for one deployment or cluster verifies on another.

### Sessions

A session key signs pieces; nothing else. It is an Ed25519 key the app keeps on the device. Registering it,
an expiry and an allowance of stake, is one transaction the wallet signs and the relayer pays for (the relayer
builds it, the wallet signs, the relayer sends exactly what it built); drawing then takes no prompts at all.
A session cannot withdraw: withdrawals need the wallet. Deposits are a `deposit` the wallet signs, or a `sweep`
on a standing approval, so USDC that lands in the player's wallet is moved in by itself and a player sees one
address and one balance. Players never hold SOL: the relayer pays every fee and every rent.

### The relayer

`packages/relayer`: checks each piece as it arrives (the session's signature, the engine's price, the
balance), prices it with `@skech/core` on the map of the opening second, 350 ms into it, and sends it in its
own `place`, signed as fee payer and oracle. When a second ends it posts the bar and settles the bets with
ink in it. Every five minutes, when nothing is due, it redeems IOUs the pool can pay, sweeps in USDC from
wallets that approved it, and collects the fees. Compute limits come from
`packages/contracts/solana/snapshots/compute.json`, measured in LiteSVM; the priority fee follows what recent
blocks paid to write the pool, capped; every request to the RPC waits on one budget, sends first. Its README
has the rest.

### Fees and the pool, by the numbers

A half-dot at 10¢ with a 50% chance at difficulty 40, with the 4% stake fee: fair 2.080×, rung 2×.
Placed: 5¢ leaves the balance, 0.2¢ (4%) is the house's, 4.8¢ joins the pool. Hit: 10¢ gross, 5¢
profit, 0.5¢ (10%) the house's, 9.5¢ to the balance, paid from the pool. Missed: the 4.8¢ stays in the
pool for the next hit. With the pool empty, the 9.5¢ is owed as IOU and paid off as others lose.

### Running it

```bash
bun run deploy:solana                    # the program on devnet, from .env.local; writes deployments/solana-devnet.json
bun run dev                              # engine, relayer, app, landing
bun packages/relayer/scripts/e2e-solana.ts   # the whole game on a local validator, with a scripted player
bun run solana:test                      # in packages/contracts: the program in LiteSVM, every attack refused among it
```

## Before mainnet

- Retrain the library on recent days, and watch live hit rates against priced ones.
- Give the admin and the program's upgrade authority to a multisig, apart from the oracle's key on the box.
- Watch the pool: IOUs are the plan for a shortfall, not for a run.
- Get legal advice: this is a fixed-odds bet on a price.
