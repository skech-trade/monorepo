# @skech/relayer

Bun. The one process besides the engine that holds a signing key: the Solana game's oracle. It prices what
players draw, attests it, and puts it on chain for them; posts the price every second and settles on it; pays
off IOUs and moves the fees out. Players never send a transaction themselves or hold SOL.

```
app ──ws /ws──> relayer ──sendTransaction──> the skech program on Solana
                  │  ▲
                  │  └── engine ws (trades, signed prices)
                  └───── packages/core: the same pricing the app quotes with
```

- **One piece, one transaction.** Pieces are checked as they arrive (the session's Ed25519 signature over `pieceBytes`, the engine's price, the balance), then at 350 ms into their second each is priced on the map of that second (`field` from `@skech/core`, in a worker) and sent on its own. The Ed25519 precompile instruction points at the piece inside `place`; the relayer signs as fee payer and oracle (`src/solana/sequencer.ts`).
- **Sending.** A blockhash and a priority fee kept fresh in the background, every 12 s and every 45 s (never, with `SOLANA_PRIORITY_MICROLAMPORTS`): the fee is 75% of what recent blocks paid to write the pool, capped. The block height is reckoned from the blockhash, not asked for. v0 transactions go through the deployment's lookup table. Compute limits come from `packages/contracts/solana/snapshots/compute.json`. Each transaction is rebroadcast every 2 s until it is confirmed or its blockhash expires, and every one in flight is looked for in one `getSignatureStatuses` (up to 256 at once, every 400 ms while any is new, then every second): `src/solana/confirm.ts`.
- **Asking the RPC.** Every request waits on one budget, `SOLANA_RPC_RPS` a second (15 by default): sends first, then looking for transactions in flight, the blockhash and fee, players' reads, and the sweep last. A 429 stops them all for its `Retry-After`, or a doubling wait with jitter, and is logged at most every 30 s with a count; identical reads at once are one request (`src/solana/budget.ts`).
- **Settling.** A second's bar goes in with the first dozen bets that have ink in it, and the rest settle on it in parallel transactions. Bets are closed as they are decided and the rent comes back. Every five minutes, when nothing is due: IOUs, the house's IOUs, USDC swept in from wallets that approved it, and fees to the treasury, read in a few requests (the pool once, holders and wallets a hundred to a `getMultipleAccounts`). A wallet is swept at once when it approves the game, or when its app says USDC landed (`sweep`). What is still to settle survives a restart in `.relayer-state.solana-<cluster>.<game>.json`, written whole or not at all (`src/state.ts`). A state file that is there but cannot be read stops the relayer at start, rather than being saved over: restore it, or move it aside to start without it.
- **Wallet-signed transactions.** Sessions, deposits and withdrawals are `build` → wallet signs → `submit`; the relayer co-signs only a message it built.
- **Reading players.** A player's game account, the pool and their wallet's USDC are one `getMultipleAccounts`, made at most once a second for each player however many ask (the app, a settlement, a piece arriving; `src/solana/accounts.ts`). A piece's price signature is checked before anything is read for it, and an address with no game account is remembered as such for 30 s.
- **Transactions per player** are their `Player` account's signatures, counted incrementally; for an address nobody is watching, one page of them every 30 s at most.

```bash
bun run dev:relayer                          # from the repo root; reads .env.local there
bun packages/relayer/scripts/e2e-solana.ts   # a local validator, the relayer and a scripted player (below)
```

| Env | Default | |
|---|---|---|
| `SKECH_SOLANA_CLUSTER` | `devnet` | The cluster, and with it `packages/contracts/deployments/solana-<cluster>.json`. `devnet`, `mainnet-beta` or `localnet` |
| `SOLANA_RELAYER_KEYPAIR`, `SOLANA_RELAYER_SECRET_KEY` | `~/.config/solana/id.json` on localnet only | A keypair file, or its 64 bytes as JSON (the box). Pays every fee and rent, and must be the game's oracle |
| `SOLANA_DEVNET_RPC_URL`, `SOLANA_MAINNET_BETA_RPC_URL` | the public RPC | A private RPC per cluster; `SOLANA_<CLUSTER>_WS_URL` for its websocket if not the same URL over ws |
| `SOLANA_RPC_RPS` | `15` | Requests a second to the RPC, all told |
| `SOLANA_PRIORITY_MICROLAMPORTS`, `SOLANA_PRIORITY_MAX_MICROLAMPORTS` | followed; capped at 50,000 (2,000,000 on mainnet) | A fixed priority fee, or the cap on the followed one |
| `NEXT_PUBLIC_ENGINE_URL` | `ws://localhost:3102/ws` | Where the engine is |
| `RELAYER_SOLANA_PORT` | `3104` | |
| `RELAYER_HOST` | `127.0.0.1` | Where to listen. Caddy fronts it on the box; `0.0.0.0` for a phone on the LAN |
| `RELAYER_ENGINE_SIGNER` | none | The engine's signing address. Set, an engine that signs as anyone else is not listened to |
| `RELAYER_STATE_DIR` | `packages/relayer` | Where the state file goes; `/var/lib/skech-relayer` on the box |

`GET /health` returns `ok`; `GET /status` says what it is doing: the engine, the chain's sends and priority
fee, the RPC budget, pieces and settling. Keep SOL in the relayer's wallet: it logs a warning, and tells Sentry,
under 0.5 SOL.

## End to end

`scripts/e2e-solana.ts` plays the game on a local validator: a player with local USDC and no SOL signs a
session with a standing approval, deposits, draws a piece at the engine's price, sees it placed and settled,
counts its transactions and withdraws.

```bash
solana-test-validator --reset --gossip-port 8110 --dynamic-port-range 8111-8140   # elsewhere
SKECH_SOLANA_CLUSTER=localnet bun run deploy:solana
bun packages/relayer/scripts/e2e-solana.ts      # E2E_ENGINE_URL=ws://localhost:3102/ws for a local engine
```

## Protocol

JSON over one WebSocket; the chain's numbers are decimal strings. On connect: `hello` with the cluster, the
program and game, the oracle, the engine's signer, the game's domain, the difficulty, the grid units and the
terms. Then:

```jsonc
// app -> relayer
{ "type": "watch", "player": "<wallet>" }                  // follow a player: answered with "account", and every event after
{ "type": "piece", "piece": {…}, "sessionSig": "…", "priceSig": "0x…", "stroke": "…" }   // -> "ack" now; "placed" or "refused" once on chain
{ "type": "build", "kind": "session" | "deposit" | "withdraw" | "revoke", "player", … }  // -> "built": a transaction for the wallet to sign
{ "type": "submit", "id", "tx" }                           // the built transaction, signed -> "submitted"
{ "type": "sweep" }                                        // USDC just landed in the wallet: move it in now
{ "type": "activity", "player": "<wallet>" }               // -> "activity": the player's transactions
// relayer -> app
{ "type": "placed", "betId", "staked", "fee", "refunded", "sections": [{ "second", "lo", "hi", "stake", "rung" }], "tx" }
{ "type": "refused", "betId", "why" }
{ "type": "settled", "betId", "hitMask", "missMask", "paid", "owed", "closed", "tx" }
{ "type": "account", "player", "balance", "session": {…}, "owed", "wallet" }
{ "type": "beat" }                                          // every 15 s, so a phone's socket is never quiet; ignore it
```

A socket that sends nothing for 30 s, not even a pong to the server's pings, is closed. Apps pass over a
message type they do not know.

Every message is checked before it is read (`src/wire.ts`) and, if it is wrong, answered with why in the reply
its sender waits for. What the relayer pays for is held to players with money in: a session only with a balance
or USDC in the wallet, a deposit or withdrawal of at least 1 USDC (or the whole balance), a few an hour for one
wallet or one address. A piece none of whose bands earns a rung is refused before it is sent. Each connection is
rate limited by type of message (`src/limits.ts`).
