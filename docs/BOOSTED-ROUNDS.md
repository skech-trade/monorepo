# Boosted rounds: skech's money behind the user's

## Current model (v2, 2026-09-23)

This section replaces everything below it. The live version, with every setting
adjustable, is https://claude.ai/artifact/MdZJHDV7n5qF3fFRfvQead

**The structure**
- The user puts in $10–$100.
- skech keeps a fee at open (2–20%). The rest is the user's trade money.
- skech adds 5x the stake as a boost, and takes a cut of any winning round.
- The round closes when the user's trade money is gone.

**Where the numbers come from**
- 30 days of one-second prices (Binance, 2.59M seconds per coin, no gaps), with
  about 1M rounds per coin per setting.
- One-second replays of the 23 worst-minute windows of the past year.
- Every slip past the line is stretched by Lighter's own measured wick size
  relative to Binance's.
- Lighter's rules come from its own docs.

**BTC, $10, 5% fee, 20% cut, closes filling within 5 s**

| | Measured |
|---|---|
| User ends above their stake | 26% of rounds |
| User's average per round | −$0.60 |
| skech net per round | +$0.59 |
| Slip past the line, per round | $0.0065 |
| Lighter liquidations (skech loses its whole boost) | 4.7 in 100,000 rounds |
| Oct 10, 2025 crash, per open round on the wrong side | ≈ −$47 of the $50 boost |

**The conclusion**
- skech makes money on ordinary days.
- A crash can cost nearly the whole boost of every round open on the wrong side.
  In a whipsaw, a book split evenly between longs and shorts still lost $42 a
  round.
- What bounds it is a rule: open boost ≤ a reserve skech can afford to lose. The
  most it can lose at any moment is the boost in open rounds.

**Lighter facts that change the design**
- Stops trigger on the mark price, and are cancelled if they would slip past their
  price cap.
- Isolated positions can pull from the cross balance.
- Standard accounts get 4 sub-accounts (Premium 64), and each account holds one
  position per coin.

---

The original proposal (superseded above):

- the user puts in $10;
- skech adds $50;
- both are traded at 50x, or at the coin's maximum where that is lower;
- the round is closed as soon as the user's $10 is down to $8.

It is a rough model built from real prices, not a promise. [How it was
measured](#how-this-was-measured) is at the end, with what the model cannot see.

Nothing here is built. It is a proposal for testnet first.

## What it is, in one line

**The user controls $3,000 of Bitcoin while risking $2, and skech's $50 is what
guarantees the $2.**

On BTC, that is 300x on the user's $10, or 1,500x on the $2 actually at risk.

## The two lines on every round

Every boosted round has two exits. The first is ours. The second is the venue's,
and it only fires when ours fails.

- **Our stop** closes the round when the user is down $2. That is a move of
  `$2 ÷ position size`.
- **The venue's liquidation** is where Lighter closes the combined $60 isolated
  position:
  - Lighter liquidates when equity falls to maintenance margin (`mmf`) times the
    position's value;
  - on every market measured, `mmf` is 0.6 ÷ the market's maximum leverage;
  - so at maximum leverage the venue always steps in after the $60 has lost 40%,
    which is **$24, on every coin**.
- If our stop fails, **skech's worst loss on one round is $22**: the venue's $24
  less the user's $2. With isolated margin, the absolute ceiling is skech's whole
  $50. Liquidation fee: *verify* whether Lighter charges one on top.

| Coin | Leverage | Position | Our stop (−$2) is a move of | Venue liquidates at a move of | Spread now |
|---|---|---|---|---|---|
| BTC | 50x | $3,000 | 0.067% | 0.80% | 0.01 bp |
| ETH | 50x | $3,000 | 0.067% | 0.80% | 0.29 bp |
| SOL | 25x | $1,500 | 0.133% | 1.60% | 0.09 bp |
| XRP | 20x | $1,200 | 0.167% | 2.00% | 2.27 bp |
| HYPE | 20x | $1,200 | 0.167% | 2.00% | 0.94 bp |
| ZEC | 20x | $1,200 | 0.167% | 2.00% | 1.45 bp |
| NEAR | 15x | $901 | 0.222% | 2.67% | 1.49 bp |
| UNI | 15x | $901 | 0.222% | 2.67% | 7.79 bp |
| DOGE | 15x | $901 | 0.222% | 2.67% | 11.89 bp |
| 1000PEPE | 10x | $600 | 0.333% | 4.00% | 4.25 bp |

Most coins cannot be traded at 50x, so a $60 position on them is smaller. That
cancels most of the extra movement they have.

## How exciting each coin is

One-minute rounds, a $10 stake, a −$2 stop. Every figure is in dollars on the
user's $10.

| Coin | Stopped by noise | Typical round | 1 round in 20 | 1 in 100 | Best in 3 days | Spread cost per round |
|---|---|---|---|---|---|---|
| **BTC** | 16% | ±$0.92 | +$2.44 | +$4.44 | +$26.36 | $0.00 |
| **ETH** | 27% | ±$1.43 | +$3.23 | +$5.96 | +$23.69 | $0.09 |
| **SOL** | 10% | ±$0.79 | +$2.17 | +$3.72 | +$8.55 | $0.01 |
| XRP | 11% | ±$0.72 | +$2.11 | +$3.75 | +$11.00 | $0.27 |
| HYPE | 6% | ±$0.63 | +$1.61 | +$2.64 | +$6.54 | $0.11 |
| ZEC | 18% | ±$1.06 | +$2.79 | +$4.88 | +$38.18 | $0.17 |
| NEAR | 29% | ±$1.69 | +$3.84 | +$6.38 | +$17.02 | $0.13 |
| UNI | 16% | ±$1.09 | +$2.28 | +$4.60 | +$31.71 | **$0.70** |
| DOGE | 7% | ±$1.07 | +$0.92 | +$2.73 | +$14.07 | **$1.07** |
| 1000PEPE | 6% | ±$0.26 | +$1.54 | +$3.93 | +$21.68 | $0.26 |

For comparison, today's $10 at 50x with no boost has a typical round of ±$0.14.

What the table says:

- **BTC and ETH are the only coins worth boosting.**
  - They are the only two at 50x.
  - They have the tightest spreads, and skech repositions every tick.
  - ETH is about 1.5x as lively as BTC.
- **SOL is a reasonable third.** It has a tight spread, but at 25x it is a little
  duller than BTC.
- **NEAR and ZEC move the most, but the low leverage cap takes it back**, and
  their spreads cost 1–2% of the stake every round.
- **UNI and DOGE lose 7–11% of the stake per round to the spread alone**,
  before the market moves at all. Not these.

## The −$2 stop is too tight

At $3,000, $2 is 0.067% of BTC: noise, not a view. One BTC round in six and one
ETH round in four would end at the stop, which reads as "I was right and got
stopped anyway".

Widening it helps the user and skech both. There are fewer stops, so there are
fewer chances for a stop to fill badly.

Every row is one-minute rounds with a 20% profit share. Per round, "skech earns"
is what skech makes net of losses when stops fill late.

| | Move to stop | Stopped | User EV per round | Skech earns (stops fill ~1 bp late) | Skech earns (stop fails for the minute) |
|---|---|---|---|---|---|
| BTC −$2 | 0.067% | 16.4% | −$0.12 | +$0.06 | **−$0.08** |
| BTC −$3 | 0.100% | 6.6% | −$0.12 | +$0.10 | +$0.02 |
| **BTC −$4** | 0.133% | 2.9% | −$0.12 | +$0.11 | +$0.07 |
| BTC −$5 | 0.167% | 1.3% | −$0.12 | +$0.11 | +$0.09 |
| ETH −$2 | 0.067% | 27.0% | −$0.18 | +$0.05 | **−$0.27** |
| ETH −$4 | 0.133% | 6.8% | −$0.23 | +$0.13 | +$0.03 |
| **ETH −$5** | 0.167% | 3.8% | −$0.24 | +$0.14 | +$0.08 |
| **SOL −$3** | 0.200% | 3.5% | −$0.10 | +$0.09 | +$0.06 |

A stop of −$4 on BTC, −$5 on ETH and −$3 on SOL keeps noise stop-outs under 4%.
It also keeps skech in profit even if every stop fills at the worst price of its
minute. At −$2, skech loses money in that case.

## What the user gets

On BTC with a −$4 stop and 20% of profits to skech:

- **Typical round:** about ±$1 on $10 (±10%).
- **1 round in 100:** +$4.40.
- **Best round in 3 days:** +$26 (+260%).
- **Worst case:** −$4, and that is a guarantee, not an estimate. Skech pays
  anything past it.
- **The catch:** the expected value is −$0.12 a round, 1.2% of the stake. On
  average that is the $10 gone in about 80 rounds.

Without a profit share the expected value is about zero, which is a coin flip.
The 20% is the house edge, and it is what pays for the bad minutes.

## What skech is exposed to

- **Capital:** $50 locked in every open round. A thousand people playing at once
  is $50,000 on the venue.
- **One round:** at most $22 on the venue's liquidation, and at most $50 in
  theory. Our stop failing is what makes it happen:
  - the trader is down;
  - an order is rejected;
  - a candle jumps past the stop.
- **Every coin goes down together.** The worst minute in these 3 days was
  09-21 08:38 UTC.
  - Assume 50 users per coin on the wrong side (500 of 1,000) and stops that
    failed for that minute.
  - Skech would have lost **$4,300 in one minute**.
  - BTC and ETH both hit the $22 cap in that minute, and every other coin lost as
    well. Alts do not hedge BTC in a fall.
  - A real crash (several percent in a minute) puts every wrong-side boosted round
    at the $22 cap, which is $11,000 per thousand users.
- **Day to day:** with sane stops and a 20% share, skech makes about
  $0.07–0.14 per round. That is small and positive, and it only holds while the
  stops really live on the venue.

## What has to be true before it runs

1. **The stop is a venue order.** It has to be a reduce-only trigger order resting
   on Lighter, not the trader's once-a-second loop. 0.13% on BTC is a few seconds
   of ordinary movement, and Standard adds 300 ms to every taker order.
2. **Skech's $50 cannot sit in an account the user owns.** In PLAN.md, each Lighter
   account belongs to the user's wallet, so money skech deposits there can be
   withdrawn by the user. Boosted rounds need a skech-owned account or
   sub-account. That means skech holds the user's $10 too, which reverses the
   non-custodial design.
3. **Order limits.** Many users in one skech account share Standard's 60 orders a
   minute. That means sub-accounts, or a higher tier.
4. **Legal.** Lending skech's money to retail users for leveraged trading is
   margin lending, or looks like a CFD, and is regulated in most places. Get
   advice before mainnet. Testnet has no such problem.

## Recommendation

- Boost BTC, ETH and SOL only.
- Stops: −$4 on BTC, −$5 on ETH, −$3 on SOL, as resting venue orders.
- Skech takes 20% of profits.
- Skech's stake: $50 at the coin's maximum leverage. More margin than that only
  moves the venue's liquidation further out, which raises skech's worst case
  without making anything more exciting.
- A kill switch: a skech-wide cap on open boosted exposure, lowered when the feed
  shows the market moving fast.
- Testnet first. The one number this model cannot supply is how far past the stop
  real fills land, and that decides whether the 20% is enough.

## How this was measured

- **Data:** Lighter mainnet one-minute candles, 2026-09-20 08:25 to 2026-09-23
  11:24 UTC. That is 4,500 minutes per coin.
- **Venue numbers:** leverage limits and maintenance margin from
  `/api/v1/orderBookDetails`. Spreads are a single snapshot from
  `/api/v1/orderBookOrders`.
- **Rounds:** every minute is one 60-second round, taken both long and short, so
  9,000 rounds per coin.
  - A round is stopped if the minute's high or low reached the stop.
  - Otherwise the round's P&L is the move from open to close, less the full spread
    (half in, half out).
- **Skech's side, optimistic:** stops fill 1 bp plus half the spread past the stop.
- **Skech's side, pessimistic:** the stop fails, and the round takes the minute's
  worst price, capped at the venue's liquidation.

What the model does not see:

- **A fixed position.** A drawn line moves its position every tick and crosses the
  spread more than twice.
- **Random direction.** It assumes users have no skill.
- **The path inside a minute.** One-minute candles hide it.
- **Three quiet-ish days.** A news day moves 3–5 times as much.
