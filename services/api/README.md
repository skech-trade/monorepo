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
