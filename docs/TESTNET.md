# Testing on testnet

`SKECH_NETWORK=testnet` in `.env.local`, which is the default, and everything
that can follow it does. Orders are signed and settled for real, with money
that is not.

```bash
bun run dev:feed        # prices, always mainnet, see below
bun run dev:api         # balances and deposits
cd ui/app && bun run dev
```

The app shows a **Testnet** badge in the header. On mainnet there is no badge,
and the absence is the message.

## What is real on testnet

| | |
|---|---|
| Signing | Lighter's own signer, the real key, the real algorithm |
| Orders | really placed, really matched, really filled |
| Positions and P&L | the venue's own numbers |
| Balances | account 378, about 10,000 test USDC |
| Liquidation | the venue does it, at its own maintenance margin |

A round through the trader has been run end to end: opened 0.0002 BTC at
$80,532, read the fill back off the account, closed it reduce-only, flat
again. Nothing about that is simulated.

## What cannot follow it there, and why

**Prices come from mainnet.** Testnet reports a mark and a day's volume but
does not trade: ten seconds of its stream returns no trades at all. A chart
built from that is a flat line, which teaches nobody anything and hides every
bug the real tape would find. Reading mainnet prices risks nothing, so the
feed always does.

That means a testnet round is judged against mainnet prices while it fills at
testnet prices. The two track each other closely, but they are not the same
number, so do not read a testnet P&L as a prediction of a real one.

**Deposits do not exist.** `createIntentAddress` answers "internal server
error" on testnet, because testnet money comes from Lighter's faucet rather
than from Circle. The deposit sheet says so instead of showing an address that
cannot work, and `/deposit/quote` refuses.

**Signing in is the same either way.** Coinbase wallets are not per-network;
the wallet is the wallet and the chain decides what it holds.

## Going to mainnet

Set `SKECH_NETWORK=mainnet`. That switches the venue, the market (1 rather
than 4096), the minimum size (0.00007 BTC rather than 0.0002), the balances
and the deposit path all at once, which is the point of it being one
variable. The mainnet account is 748619 and holds about $9.58.

Do it after a full round has been through testnet, not before.
