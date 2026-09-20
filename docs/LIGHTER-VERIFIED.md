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
