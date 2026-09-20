# trader

Holds the key, turns a drawn round into orders, and is the only thing that
books money. A round has to close itself when the clock runs out even if the
tab is gone, which is why this is a server and not the browser.

```
bun run --filter @skech/trader build:native   # once: fetch the signer, compile the shim
bun run --filter @skech/trader dev
curl localhost:3220/health
curl -XPOST localhost:3220/rounds -d '{"stake":20,"leverage":10,"seconds":6}'
```

## The signer

Lighter's signer is Go compiled to a C shared library. The TypeScript SDK has
no signer at all, the Go one needs a toolchain, and the official Python one
ships working binaries. So `native/fetch-signer.sh` takes the binary and its
header out of Lighter's published wheel, which is a zip, and `native/build.sh`
compiles `native/shim.c` against it.

The shim exists because every signing call returns a forty byte struct by
value and Bun's FFI cannot take one back. It passes arguments through and
writes the answer into pointers the caller owns. No signature is
reimplemented; they all come out of Lighter's own binary.

`native/vendor/` is gitignored. It is eight megabytes of binary that the build
fetches, not something to diff.

## Things the venue is fussy about, found the hard way

- **Testnet is a different market.** BTC is 4096 there and 1 on mainnet, and
  the size floor is 0.0002 rather than 0.00007.
- **Both floors bind, after rounding down.** $10 of Bitcoin rounds to $9.60 of
  Bitcoin and is refused, so anything sized off the minimum must ask for more.
- **An IOC order expires at zero**, not at the venue's twenty-eight day
  default of minus one. Sending minus one returns "OrderExpiry is invalid".
- **The chain id is baked into every signature.** 300 on testnet. A wrong one
  produces signatures the venue rejects without explaining why.

| Variable | Default |
|---|---|
| `PORT` | `3220` |
| `SKECH_NETWORK` | `testnet`, which also picks the venue, chain and market |
| `LIGHTER_ACCOUNT_INDEX`, `LIGHTER_API_KEY_INDEX`, `LIGHTER_PRIVATE_KEY` | required, used on testnet |
| `LIGHTER_MAINNET_*` | the same three, used when the switch says mainnet |

The network picks the credential as well as the venue. A mainnet order signed
with a testnet account index is not a small mistake, and the trader used to
read its own URL, so `SKECH_NETWORK=mainnet` moved the app and left the thing
that signs on testnet.

## Not built yet

`/rounds` opens, holds and flattens. Compiling the drawn shape into legs comes
next, from the same code the browser uses so the client cannot lie about what
it drew, and with it the stop and target as reduce-only trigger orders.

## A round, end to end

```
POST /rounds      {pts, stake, leverage, seconds, exits}  -> the round, already open
GET  /rounds/:id                                          -> how it is going
POST /rounds/:id/close                                    -> out now, at the market
```

The page sends the points it drew and nothing else. `@skech/core` turns those
into legs here, the same way the page turns them into a quote, so a client
cannot claim it drew something it did not. Every tick the runner asks where
the line is going at this moment and takes the position there; `goTo` reads
what is actually held before it sends anything, so a missed tick, a rejected
order or a partial fill all correct themselves rather than compounding.

It answers as soon as the position is open, not when the round ends. A round
outlives the tab that drew it, and holding the request open for the length of
one means a closed laptop leaves a position running with nobody watching it.

### What it refuses to do

Three guards, each of them written after something went wrong on testnet.

**No order larger than twice the round.** The cap comes from the round's own
size, not from the position, so a position read wrong cannot raise its own
ceiling. Lighter reports a short as a positive size with `sign: -1`; reading
only the first made every short look like a long, and the runner sold the
difference again every second until a flat account was 3.565 BTC short.

**A position past twice the target stops the round.** Whatever the reason, it
is not the round doing what it was asked, so it closes instead of trading
further into it.

**A top-up waits for the fill.** The venue takes a second or two to show an
order as a position, and asking every second meant sending the same order
again before the first one landed. A reversal still goes out at once: that is
the drawing changing its mind, and waiting means trading the wrong way for
another second.

## One key, one account

The trader signs everything with a single Lighter key, so every round lands
on that account whoever drew it. A reader's own balance, which the app reads
from their own wallet's Lighter account, does not move when they trade. The
app says so in the tray while a round runs rather than leaving somebody to
work it out from a number that never changes.

The way out is a trading key per wallet. Lighter's own signer exports both
halves: `GenerateAPIKey` makes the keypair and `SignChangePubKey` registers
its public half against an account, authorised by the wallet that owns it.
Neither is in the C shim yet. The `lighter_accounts` table is already there
for the result, with a column that never holds a key in the clear.
