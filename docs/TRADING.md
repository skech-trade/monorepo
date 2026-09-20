# How a drawn line becomes a real position

Written for whoever picks this up next, human or otherwise. It covers the
path from a line drawn in the browser to an order filled on Lighter: which
file does what, what was proved and how, and which pieces of code exist only
because something went wrong. Skip to **Guards that must not be removed** if
you are about to change `services/trader`.

Everything below is live on testnet and has been run end to end. Nothing here
has been run against real money.

## The shape of it

```
browser                     services/trader                 Lighter
────────                    ───────────────                 ───────
draw a line
press Trade
  │
  ├─ GET  /keys/:address ──────────▶ does this wallet have a trading key?
  │
  ├─ POST /keys/prepare ───────────▶ generate a keypair, sign its
  │                                  registration, return messageToSign
  │  wallet signs the message
  ├─ POST /keys/register ──────────▶ fill L1Sig, send tx type 8 ──────▶ venue
  │                                  wait for the venue to accept it
  │
  └─ POST /rounds ─────────────────▶ open the round, answer at once
        {address, pts, stake,        then, every second, take the
         leverage, seconds, exits}   position the line asks for ────▶ orders
     GET /rounds/:id (every 2s)      until the clock runs out, then flatten
```

Two rules shape all of it.

**The page sends the points it drew and nothing else.** It does not say which
way to trade, how big, or where the turns are. If it did, it could claim it
drew anything. The server works that out from the same code the page quotes
with, which is why `packages/core` exists.

**A round outlives the tab that drew it.** `POST /rounds` answers as soon as
the position is open, not when the round ends. A closed laptop must not leave
a position running with nobody watching it, which is the reason the trader is
a server and not the browser.

## Files

### `packages/core` — what both sides must agree about

| File | What it holds |
|---|---|
| `src/shape.ts` | points in, legs out. `shapeOf`, `legsFrom`, `resample`, `priceAt` |
| `src/venue.ts` | Lighter as it is: size floors, margin levels, `liquidationPrice` |
| `src/shape.test.ts` | what a line means, which is the thing that must not drift |

No React, no DOM, no network. That is the condition for living in the browser
and the server at once. `ui/app/src/lib/venue.ts` re-exports it so every
`@/lib/venue` import in the app still works, and `ui/app/src/lib/sketch.ts`
imports the shape half and keeps the money half (quote, settlement, wording).

### `services/trader` — the only thing that signs

| File | What it does |
|---|---|
| `src/signer.ts` | Bun FFI over the C shim. Orders, leverage, `generateApiKey`, `changePubKey` |
| `src/keys.ts` | a trading key per wallet: prepare, register, store |
| `src/round.ts` | `Trader.goTo` takes the position to a target; `flatten` closes it |
| `src/rounds.ts` | a drawn round: follow the line, watch the exits, close |
| `src/lighter.ts` | the venue's REST surface, and the `TX` type numbers |
| `src/network.ts` | one switch picks venue, chain, market and which key signs |
| `native/shim.c` | flat C wrappers over Lighter's Go signer |

### `ui/app` — the browser

| File | What it does |
|---|---|
| `src/lib/round.ts` | the trader client: `keyFor`, `prepareKey`, `registerKey`, `openRound`, `closeRound`, `useVenueRound` |
| `src/components/app/draw/draw-screen.tsx` | `trade()` at line ~480 is where a press becomes a round |
| `src/components/app/auth.tsx` | publishes `signMessage` through context, so a screen can ask for a signature without knowing whether Coinbase's provider is mounted |

## The signer

Lighter's signer is Go compiled to a C shared library, shipped only inside
their Python wheel. `native/fetch-signer.sh` extracts it; `native/build.sh`
compiles `shim.c` against it.

The shim exists because **Bun's FFI cannot take a struct back by value**, and
every Go signing call returns a forty-byte struct. Each call is wrapped into
plain arguments in, an error string back, and the answer written into pointers
the caller owns. Nothing is reimplemented: every signature is still produced
by Lighter's own binary.

On macOS the build also runs `install_name_tool -change`, because the signer
records itself by bare name and rpath never applies to it.

Two calls were added for per-wallet keys: `shim_generate_api_key` and
`shim_sign_change_pub_key`. If you add more, the exported Go symbols are in
`native/vendor/signer.h`, and `nm -gU` on the dylib lists what is available.

## A trading key per wallet

Before this, the trader held one key for one account and every round landed
there. Somebody watched their own balance sit still while their orders filled
on somebody else's. That was never a mode; it was the wrong thing.

Lighter accounts carry several API keys, each at an index. `KEY_INDEX` in
`keys.ts` is the slot skech takes, which is 2 by default.

Registration needs two proofs and the transaction carries both:

1. `GenerateAPIKey()` makes the keypair.
2. `SignChangePubKey(pubKey, …)` signs the registration **with the new key
   itself**, which proves whoever asks holds it. This is the one place
   `Signer.open({check: false})` is correct: the key is not registered yet, so
   its own check would fail.
3. The signer leaves `"L1Sig": ""` in the transaction and hands back a plain
   text `messageToSign`. The wallet that owns the account signs it with
   `personal_sign`, which proves ownership.
4. That signature fills `L1Sig` and the transaction goes out as type 8.

The key can trade that account and nothing else. It cannot withdraw and it
cannot move money off the venue.

A wallet with no Lighter account cannot register a key, because there is
nothing to register against. On testnet the faucet makes one, on mainnet a
deposit does.

Keys live in `trader_keys` in Postgres. With no database they are held in
memory and `/health` says `memory only, lost on restart`, because a trader
that refuses to start without a database is a trader nobody can try.

## How a round follows a line

`Rounds.run` in `rounds.ts`. Every second:

1. `u` is how far through the round we are.
2. `dirAt(shape, u)` finds the leg covering that sample and returns its
   direction.
3. `want = dir × full`, where `full = stake × leverage / entry`.
4. `goTo(market, want, {cap: full})` reads what is actually held and sends one
   order for the difference. A reversal is one order on Lighter, not a close
   and an open.
5. The venue's own position and unrealised are read back, and the exits are
   checked against them.

At the end, or on an exit, `finish` flattens and reads the account's
collateral before and after. **`realised` is that difference**, not our
arithmetic over fills: the venue's figure includes every fee and every bit of
slippage, and it is the number the money is.

Because `goTo` reads the position before it sends anything, a missed tick, a
rejected order or a partial fill all correct themselves on the next tick
rather than compounding.

## Guards that must not be removed

Each of these exists because something went wrong on testnet. They look
defensive. They are load-bearing.

**No order larger than twice the round's size.** `goTo` takes a `cap` and the
ceiling is `2 × cap + minBase`. The cap comes from the round, never from what
is held, so a position read wrong cannot raise its own ceiling.

> Lighter reports a short as a **positive** `position` with a separate
> `sign: -1`. Reading only the first made every short look like a long, so the
> runner computed a delta twice the position and sent it every second. A flat
> testnet account became 3.565 BTC short in twelve seconds. See
> `lighter.ts`, where `size` is multiplied by the sign.

**A position past twice the target stops the round.** Whatever the reason, it
is not the round doing what it was asked, so it closes rather than trading
further into it.

**A top-up waits `SETTLE_MS` (3s); a reversal does not.** The venue books a
fill a second or two after the order. Asking every second meant re-sending the
same order before the first landed, and one target of 0.012 BTC became 0.17
held: every order passed the cap on its own and the pile did not. A reversal
still goes out at once, because that is the drawing changing its mind and
waiting means trading the wrong way for another second.

**The turn tolerance has a floor that cannot be zero.** `turnTol` in
`shape.ts` floored at the fee round trip, and **Lighter charges nothing**, so
the floor was zero: every sample of a flat line cleared it and became a turn,
and a flat line came back as thirty-one legs. Invisible on screen, because a
flat shape is rejected before its legs are read; thirty-one reversals of a
real position on the venue. The floor is two basis points now.

**`finish` re-reads the position until the venue agrees it is gone**, up to
five seconds. Reading it straight back showed the round still holding what it
had just closed.

**Registration waits for the venue to accept the key.** It takes a few
seconds, and answering "no trading key for this wallet" to somebody who has
just registered one is the least helpful possible reply. It was what happened,
because the failure to build their signer was being swallowed.

## Numbers the venue cares about

- `updateLeverage` is transaction type **20**, not 23. Type 23 answers
  "unsupported tx type"; 20 rejects an empty body with "invalid initial margin
  fraction", which is how you know it parsed. `TX` in `lighter.ts`.
- IOC orders need `OrderExpiry` **0**, not the 28-day `-1`. `EXPIRY` in
  `signer.ts`.
- `chainId` is 300 on testnet and 304 on mainnet. The signer bakes it into
  every signature, so a wrong one produces signatures the venue rejects
  without saying why.
- BTC is market **1** on mainnet and **4096** on testnet, with different size
  floors. All of this comes from `SKECH_NETWORK`; do not add a second switch.

## Configuration

One switch, read by every service and the browser:

```
SKECH_NETWORK=testnet
NEXT_PUBLIC_SKECH_NETWORK=testnet
```

They must match. The first picks the venue, the chain, the market and which
Lighter key signs; the second picks the market the browser quotes. Two names
for one switch is how the app once quoted market 4096 while the badge said
mainnet.

Services read the repo-root `.env.local` through `--env-file` in their dev
scripts. The browser gets it through `ui/app/next.config.ts`, which pulls
`NEXT_PUBLIC_` names out of the same file, because Next only looks in its own
directory.

```
NEXT_PUBLIC_TRADER_URL=http://localhost:3220
```

Leave it unset and rounds still run, against real prices, with no position
behind them, and the tray says so while one is running. A round that quietly
did not trade would be the worst of both.

Postgres: `docker compose --env-file .env.local up -d db`. The `--env-file` is
required, because compose reads `.env` and this repo keeps one file at the
root.

## What has been proved, and how

All on testnet, against the live venue.

| | |
|---|---|
| A fresh wallet | faucet, own account 391 with $10,000 |
| Key registration | index 2, authorised by the wallet's signature |
| A three-leg line | four orders on 391: short, long, short, flat |
| Its own collateral | $10,000 → $9,999.117519 |
| From the browser | a line drawn in headless Chrome, four orders, −$4.19 |
| Prices | app within $26 of Kraken over four reads |

The signing prompt inside the app has not been driven by a script, because it
needs a real Coinbase wallet rather than a generated key. The server side of
it has.

## Not built

- **Exits are watched in a loop, not placed as trigger orders.** A trigger
  survives this process dying and a loop does not.
- **Rounds are held in memory.** The `rounds` and `orders` tables exist and
  nothing writes to them, so a restart forgets what is running.
- **Keys are stored in the clear** in `trader_keys`. The column in
  `lighter_accounts` was specified as encrypted; match that before mainnet.
- **The Desk screen is still simulated.** Its price is frozen and thousands of
  dollars from the real one. Only Draw is wired to the feed and the trader.
- **No withdrawals.** Deposits work on mainnet through a CCTP intent address;
  getting money out is not built.

## How to check it is working

```bash
curl localhost:3220/health
# {"ok":true,"signer":"ready","network":"testnet","keys":"postgres",…}

curl "https://testnet.zklighter.elliot.ai/api/v1/faucet?l1_address=0x…"
# {"code":200,"message":"ok"}   10,000 test USDC, account made if there is none

curl "https://testnet.zklighter.elliot.ai/api/v1/account?by=index&value=391"
# the venue's own view: collateral, positions, sign
```

The faucet is an open GET and needs no signature, which is what makes testing
this cheap. It refuses above $100 of portfolio value.

When a round misbehaves, the venue's account endpoint is the ground truth, not
our `/rounds/:id`. Two of the bugs above were found by reading them side by
side and noticing they disagreed.
