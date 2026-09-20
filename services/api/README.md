# api

Who someone is, and what they are worth. Small on purpose: the feed holds a
socket and the trader holds a key, so this holds the database and nothing
else, and can restart without anyone noticing.

```
DATABASE_URL=postgres://… bun run --filter @skech/api dev
curl localhost:3230/health
curl 'localhost:3230/me?address=0x…'
curl 'localhost:3230/balance?address=0x…'
```

| Route | What it does |
|---|---|
| `/health` | whether the database answers |
| `/me?address=` | the user for a wallet, made on first sight |
| `POST /me/name` | what they want to be called |
| `/balance?address=` | what the wallet holds on Lighter |
| `/deposit/address?address=` | the one address that credits their account, mainnet only |
| `/deposit/chains` | where money can come from |
| `/deposit/quote?…` | what a bridge would cost and what would land |
| `POST /faucet` | 10,000 test USDC, testnet only |

## The database

Postgres, through Bun's own driver, so there is no dependency to keep current
and no pool to configure. Postgres because every host has a managed one: on
AWS that is **RDS** or **Aurora Serverless v2**, and nothing here uses an
extension or a type that ties it to either. A `DATABASE_URL` is the whole
configuration.

Tables are created on boot with `CREATE TABLE IF NOT EXISTS` rather than a
migration tool. One service and four tables does not need one, and the moment
a column has to change under live data is the moment to add one.

`users` is keyed by wallet address, lowercased, because the same address
arrives checksummed from one place and flat from another. `lighter_accounts`
holds the per-user account index and its encrypted key, and that column never
holds a key in the clear whatever is convenient at the time. `rounds` and
`orders` are what the trader will write.

With no `DATABASE_URL` the service still starts and answers, with no name on
anybody. The app treats a missing name the same as one that has not been set.

## Balances

Straight from Lighter, never from our own tables. Two places claiming to know
what an account holds is one too many. `collateral` is what can be traded
with, `unrealised` is what anything open has made, and `equity` is the sum,
which is what a reader means by "my balance". A wallet that has never
deposited has no account at all, and that answers as `accountIndex: null`
rather than as a zero that looks like a loss.

## The faucet

Testnet only, and it exists because the wallet people get here is an embedded
one. It has no browser extension and speaks no WalletConnect, so the usual
advice, open Lighter and connect your wallet, is a wall rather than a step.

Lighter's faucet takes an address and nothing else, so the service asks on the
reader's behalf and the app is one button. It makes the Lighter account if
there is not one, and the account shows up about eight seconds later. It
refuses above $100 of portfolio value, which is the rate limit and means
anybody who has lost it all can come back.

On mainnet the route answers 409. There is no faucet, and the deposit address
is the way in.

## Which chains, and why that many

Two lists, and they are different sizes for different reasons.

The **deposit address** takes plain USDC on Base, Arbitrum and Avalanche.
That is Lighter's CCTP list, not ours, and there is no widening it. It costs
little, because the address is open to anyone: an exchange withdrawal, a
friend, a wallet we have never heard of.

The **bridge from the skech wallet** covers Base, Arbitrum, Optimism, Polygon,
Avalanche, Ethereum and World. That is not a selection, it is the whole set.
Relay bridges from sixty chains, so Relay was never the limit; the limit is
that a Coinbase embedded wallet can only sign a transaction on those seven,
which the SDK spells out in `SendEvmTransactionWithEndUserAccountBodyNetwork`.
Adding an eighth means either a different wallet or a chain Coinbase adds.

Every USDC address in `CHAINS` was read off its own chain with a `symbol()`
call rather than copied from a list. A bridged lookalike on the wrong chain
does not arrive and cannot be recovered.
