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

## A key per wallet

```
POST /keys/prepare   {address}              -> {messageToSign, accountIndex}
POST /keys/register  {address, signature}   -> {ok, accountIndex}
GET  /keys/:address                         -> {registered, accountIndex}
```

Rounds trade the drawer's own Lighter account, signed with a key they
registered against it. Before this the service held one key for one account
and every round landed there, so somebody watched their own balance sit still
while their orders filled on somebody else's.

Two steps, because the middle one is not ours. `GenerateAPIKey` makes a
keypair and `SignChangePubKey` signs its registration, leaving an `L1Sig`
empty; the wallet that owns the account signs the message the signer hands
back, and that signature fills the gap. The new key signing its own
registration proves whoever asks holds it, and the wallet's signature proves
they own the account. Neither alone is enough, which is why the transaction
carries both.

The key can trade that account and nothing else. It cannot withdraw, and it
cannot move money off the venue.

Registering waits for the venue to accept the key before saying it is theirs.
It takes a few seconds, and answering "no trading key for this wallet" to
somebody who has just registered one is the least helpful possible reply.

Keys live in `trader_keys` in Postgres. With no database they are held in
memory and `/health` says `memory only, lost on restart`, because a trader
that refuses to start without a database is a trader nobody can try.

## Boost

skech's money beside a user's stake, for one round. A boosted round is an
ordinary round run on one of the treasury's lanes (sub-accounts of its master
account) instead of the user's own account, sized at the stake plus five times
it, with the loss exit at 80% of the stake resting on Lighter as a stop. When it
ends the lane is shared out (30% of a win, 1% of a loss to skech), swept back
to the master and booked in a double-entry ledger. See
[docs/BOOST-PLAN.md](../../docs/BOOST-PLAN.md).

```
bun run boost:setup                    # the treasury wallet, its account, four lanes; writes BOOST_* to .env.local
TRADER=http://localhost:3220 bun run boost:e2e   # add money, one boosted round, send it all home, check the books
```

| Route | What it does |
|---|---|
| `GET /boost/status?address=&market=` | Boost balance, rules, the round running if any, lanes free |
| `POST /boost/deposit/prepare` `{address, amount}` | the transfer to sign, and Lighter's fee |
| `POST /boost/deposit/confirm` `{address, id, signature}` | sent, and credited once the treasury shows it |
| `POST /boost/withdraw` `{address, amount}` or `{address, all: true}` | back to the wallet's own Lighter account, less Lighter's fee. The trader also does this by itself for wallets idle `BOOST_RETURN_AFTER_S` |
| `POST /boost/rounds` `{address, market, pts, stake, seconds}` | a boosted round; answers with the round, as `POST /rounds` does |
| `GET /boost/admin` | the books against the venue; `Authorization: Bearer $BOOST_ADMIN_TOKEN` |
| `POST /boost/admin/kill` `{killed, reason}` | stop new boosted rounds, or let them start again |

Any round can also carry `venueStop: true`, which puts its loss exit on the
venue as a resting reduce-only stop and moves it with every trade. Boosted
rounds always do.
