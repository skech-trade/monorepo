# What is proven against Lighter, and how

Everything here was run against the live venue on 2026-09-20, not read from a
spec. Re-run anything you doubt; the commands are next to each claim.

## Reads need no credential at all

A socket with nothing attached streams trades, the order book and account
state. This is why there is no Builder account in the build and no Discord
ticket blocking anything. A Builder account only raises a REST read limit that
the WebSocket architecture never touches.

```
wss://mainnet.zklighter.elliot.ai/stream
  subscribe trade/1, order_book/1, market_stats/1, account_all/<index>
```

About 19 trades a second on BTC, which is plenty for one-second bars.

## The market's real constants

`GET /api/v1/orderBookDetails`. These differ between networks, which is the
sort of thing found the hard way: an order sized for mainnet is rejected on
testnet and the error says nothing useful.

| | mainnet | testnet |
|---|---|---|
| market id | 1 | 4096 |
| size decimals | 5 | 5 |
| price decimals | 1 | 1 |
| minimum size | 0.00007 BTC | 0.00020 BTC |
| minimum notional | $10 | $10 |
| maker / taker fee | 0 / 0 | 0 / 0 |
| maintenance margin | 1.2% | 1.2% |
| close-out margin | 0.8% | 0.8% |

Both floors bind, and the size one is applied after rounding down, so $10 of
Bitcoin becomes $9.60 of Bitcoin and is refused. Anything sized off the
venue's own minimum has to ask for a little more than it.

## A round runs end to end on testnet

The official Python SDK ships a prebuilt signer for darwin-arm64 and for
linux, so no Go toolchain is needed. Account 378, key index 4:

```
signer ok
mark 80317.4  order 0.0002 BTC (= 20 units, $16.06)
open : sent 2286f22509e892223b7d08fe
filled: 0.00020 BTC @ 80532.4  value $16.096500  unrealised -0.009980
close: sent 729f3eac37388f9ee9188e3f
flat again
```

So: the key signs, the order is accepted, the fill appears on the account, and
a reduce-only close flattens it. That is the whole of what the trader has to
do, proven before any of it is written.

## What this decides

**The trader is Python, not Bun.** The TypeScript SDK has no signer. The Go
one is the reference but needs a toolchain and a WASM build; the Python one
ships working binaries for the machines this will run on. The feed stays in
Bun, because reads are just a socket and it shares types with the app.

**No Discord ticket blocks the build.** A bridge key would buy twelve deposit
chains and a card route, which is worth having, but the public CCTP intent
address and the Ethereum contract both work without one.

## Still to verify

- Whether an isolated position's loss can exceed its allocated margin under
  any deleveraging path. The landing page's "the most you can lose is what you
  put in" stands on this.
- Whether Relay can deposit to an account index that does not exist yet. If it
  cannot, a new user's first deposit has to go another way.
- Whether Coinbase CDP's `signMessage` verifies against Lighter's key
  registration.

## The deposit address, and which network it is on

`createIntentAddress` with `is_external_deposit=true` gives **one address per
wallet**. Confirmed by asking for it several ways:

- the same address on Base, Arbitrum and Avalanche
- the same address for $10, $25 and $100
- the same address with and without the external flag

So it is a function of the wallet alone. USDC arriving on it is credited to
that wallet's Lighter account and makes the account if there is none, which is
what removes the need to fund anything first.

Without `is_external_deposit` the call refuses an amount of zero: "amount
should be greater than 0 for user wallet deposit". With it, zero is right,
because the amount is whatever turns up.

**The two networks hand out addresses that look identical.** A testnet
address shown as "send USDC here" loses real money for good. So the API reads
`LIGHTER_API_URL`, deliberately not the `LIGHTER_BASE_URL` that points the
trader at testnet, it returns the network with every address, and the app
refuses to dress a testnet address up as somewhere to send anything.

## The USDC contracts, checked on chain

Each answered `symbol()` as USDC on its own live node, so these are Circle's
native issues and not bridged lookalikes.

| Chain | Contract |
|---|---|
| Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Arbitrum | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Optimism | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |
| Polygon | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| Avalanche | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |
| Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
