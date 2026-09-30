# @skech/relayer

Bun. The one process besides the engine that holds the oracle's key. It prices what players draw,
signs it, and puts it on chain for them; posts the price every second and settles on it; pays off
IOUs and moves the fees out. Players never send a transaction or hold MON.

```
app ──ws /ws──> relayer ──eth_sendRawTransactionSync──> SkechGame on Monad
                  │  ▲
                  │  └── engine ws (trades, signed prices)
                  └───── packages/core: the same pricing the app quotes with
```

- `src/sequencer.ts`: pieces arrive signed by a session key; each is checked (shape, signatures, session,
  balance, not late) and answered at once. All the pieces opening on one second are priced 350 ms into it,
  on the map of that second (`field` from `@skech/core`, in a worker), the quote is signed, and one
  `place` transaction carries them all.
- `src/settler.ts`: 600 ms after a second ends, its bar is signed and posted with the bets that have ink
  in it, in one `postBarAndSettle`. Every fifteen seconds it redeems IOUs the pool can pay and collects
  the fees. What is still to settle survives a restart in `.relayer-state.<chainId>.<game>.json`.
- `src/chain.ts`: viem with a local nonce and Monad's synchronous send, which returns the receipt from the
  proposed block. Nothing is asked of the node between deciding to send and sending: the gas limit comes
  from `src/gas.ts` and the base fee is followed in the background. Nonces are taken and transactions signed
  one at a time; a send that times out is waited on by its hash, its bytes sent again, never sent again under
  a new nonce (both could land). A nonce that went unused is filled once every other is accounted for.
- `src/rpc.ts`: Monad's public RPC allows 15 requests a second and turns the rest away with error -32011,
  which viem does not retry. This waits it out (five tries, under 2.5 s), so a throttled send goes again
  with the same bytes instead of failing and losing its nonce. Set `MONAD_TESTNET_RPC_URL` (or `MONAD_MAINNET_RPC_URL`) to a private RPC for
  real traffic: two scripted players were enough to be throttled.
- `src/predict.ts`: what settling will do, worked out with the contract's arithmetic before sending. The
  relayer posts the very bar it settles against and knows every band from the chain's Placed events, so
  it knows which bets hit and which the pool cannot pay, and the gas is for exactly that.
- `src/gas.ts`: gas limits worked out, not estimated. Monad charges a transaction its gas limit and its
  receipts report the limit as used, so the limit has to be right beforehand and every unit over it is
  money. EVM gas is deterministic, so the limit follows from the call's shape: pieces, bands and bytes of
  stroke; bars, bets, live bands, hits and IOUs (from `src/predict.ts`). The coefficients are measured by
  `packages/contracts/evm/test/GasModel.t.sol` in the worst state each can meet, at Monad's prices, and read
  from `snapshots/GasModel.json`; the limit is the model, the transaction's 21,000 and its calldata, 5%
  over, plus room for a bet's words straddling two of Monad's 128-slot storage pages. Only the calls
  that reach Circle's USDC (deposit, withdraw, collecting fees) are still estimated. Every fifth send
  is also estimated alongside, never waited for, and `GET /status` reports how close the model runs;
  a limit that proves short is sent again wider and widens that kind of call for the rest of the run.

```bash
bun run dev:relayer          # from the repo root; reads .env.local there
bun packages/relayer/scripts/e2e.ts   # anvil + contracts + engine + relayer + a scripted player
```

| Env | Default | |
|---|---|---|
| `RELAYER_PRIVATE_KEY` | `ENGINE_PRIVATE_KEY` | Signs quotes and bars, pays gas. Must be the game's oracle. |
| `SKECH_NETWORK` | `testnet` | Picks the chain: 10143, or 143 for `mainnet`. |
| `ENGINE_CHAIN_ID` | from `SKECH_NETWORK` | Override for anvil; may not name the other network. |
| `SKECH_GAME` | `packages/contracts/deployments/<chainId>.json` | The game proxy. |
| `MONAD_TESTNET_RPC_URL`, `MONAD_MAINNET_RPC_URL` | Monad's public RPC | The private RPC for each network. `MONAD_RPC_URL` overrides both. |
| `NEXT_PUBLIC_ENGINE_URL` | `ws://localhost:3102/ws` | Where the engine is. |
| `RELAYER_PORT` | `3103` | |
| `RELAYER_SHADOW_EVERY` | `5` | Estimate one shaped send in this many alongside, to check the gas model; `1` checks all. |

`GET /health` returns `ok`; `GET /status` says what it is doing, `chain.gas` among it: sends, shadow
estimates, the worst estimate-to-limit ratio seen, and any slack added. Keep the relayer's wallet above
12 MON: Monad holds 10 in reserve, and every transaction is charged its gas limit.

## On Solana

`src/solana/` is the same job for the Solana program, as its own process (`bun run dev:relayer:solana`, port 3104), sharing the engine client, the pricer and the price check:

- **One piece, one transaction.** Pieces are checked as they arrive (the session's Ed25519 signature over `pieceBytes`, the engine's price, the balance), then at 350 ms into their second each is priced and sent on its own. The Ed25519 precompile instruction points at the piece inside `place`; the relayer signs as fee payer and oracle.
- **Sending.** A blockhash and a priority fee kept fresh in the background: the fee is 75% of what recent blocks paid to write the pool, capped. v0 transactions go through the deployment's lookup table. Compute limits come from `packages/contracts/solana/snapshots/compute.json`. Each transaction is rebroadcast every 800 ms until it is confirmed or its blockhash expires.
- **Settling.** A second's bar goes in with the first dozen bets that have ink in it, and the rest settle on it in parallel transactions. Bets are closed as they are decided and the rent comes back. Every fifteen seconds, when nothing is due: IOUs, the house's IOUs, USDC swept in from wallets that approved it, and fees to the treasury.
- **Wallet-signed transactions.** Sessions, deposits and withdrawals are `build` → wallet signs → `submit`; the relayer co-signs only a message it built. Players never hold SOL.
- **Transactions per player** are their `Player` account's signatures, counted incrementally.

`scripts/e2e-solana.ts` plays it end to end on a local validator against the live engine.

## Protocol

JSON over one WebSocket; the chain's numbers are decimal strings. On connect: `hello` with the chain,
the game, the oracle, the difficulty and the terms. Then:

```jsonc
// app -> relayer
{ "type": "watch", "player": "0x…" }                       // follow a player: answered with "account", and every event after
{ "type": "piece", "piece": {…}, "sessionSig": "0x…", "priceSig": "0x…", "stroke": "0x…" }   // -> "ack" now; "placed" or "refused" once on chain
{ "type": "session", "player", "kind", "key", "x", "y", "validUntil", "allowance", "deadline", "sig" }   // -> "session-set"
{ "type": "deposit", "owner", "amount", "validAfter", "validBefore", "nonce", "sig" }   // an EIP-3009 authorization -> "deposited"
{ "type": "deposit", "owner", "amount", "deadline", "v", "r", "s" }        // or a permit, for tokens without EIP-3009
{ "type": "withdraw", "player", "amount", "to", "deadline", "sig" }       // -> "withdrawn"
// relayer -> app
{ "type": "placed", "betId", "staked", "fee", "refunded", "sections": [{ "second", "lo", "hi", "stake", "rung" }], "tx" }
{ "type": "refused", "betId", "why" }
{ "type": "settled", "betId", "hitMask", "missMask", "paid", "owed", "tx" }
{ "type": "account", "player", "balance", "session": {…}, "owed" }
```

Every message is checked before it is read (`src/wire.ts`) and, if it is wrong, answered with why in the reply
its sender waits for. What the relayer pays for is held to players with money in: a session only with a balance
(on Solana, or USDC in the wallet), a deposit or withdrawal of at least 1 USDC (or the whole balance), a few an
hour for one wallet or one address. A piece none of whose bands earns a rung is refused before it is sent, with
the chain's own `NotOffered`. Each connection is rate limited by type of message (`src/limits.ts`).
