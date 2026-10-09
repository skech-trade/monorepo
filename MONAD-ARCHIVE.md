# Monad archive

This branch keeps skech as it was on Monad, working end to end, before the game moved to Solana alone. It is a
snapshot for reference and for picking Monad back up: nothing here is deployed from, and `main` does not merge it.

- **Taken at:** `9afa2cd` (main, 9 October 2026), the last commit before #108 moved the web app to Solana and #109
  took the Monad relayer out.
- **Not kept up to date.** Everything merged to `main` after that (the web on Solana, the gas keeper, the smaller
  Solana program, the phone's size work) is not here.

## What is here that main no longer has

| Path | What it is |
|---|---|
| `packages/contracts/evm/` | The Solidity game: `SkechGame` (UUPS proxy), `SkechIOU`, `SkechRevenue`, `SkechLadder`, tests and the deploy and upgrade scripts. `main` keeps these too, unused. |
| `packages/contracts/deployments/10143.json` | Where the game lives on Monad testnet (chain 10143): game `0xd7cE3AADC704caF2D16319D1D25d01024cC5fdF0`. |
| `packages/relayer/src/` (top level) | The Monad relayer: `server.ts` (the players' WebSocket), `sequencer.ts` (batches pieces into `place`), `settler.ts` (posts bars and settles), `chain.ts`, `gas.ts`, `nonce.ts`, `predict.ts`, `activity.ts`. The Solana relayer sits beside it in `src/solana/`. |
| `packages/relayer/scripts/e2e.ts`, `player.ts` | The Monad end-to-end test on anvil, and a scripted player. |
| `scripts/deploy-contracts.ts` | Deploys the EVM contracts (`bun run deploy:contracts`). |
| `packages/core/src/network.ts` | The `SKECH_NETWORK` switch: picks Monad testnet or mainnet, its RPC, USDC and faucet. |
| `ui/app/` | The web app on Monad: a Privy Ethereum wallet, P-256 session keys signed with EIP-712, viem. |
| `infra/systemd/skech-relayer.service`, the `/relayer/*` route in `infra/Caddyfile` | The Monad relayer on the box, on port 3103. |

## Running it

```bash
git switch monad-archive
bun install
SKECH_NETWORK=testnet bun run dev          # engine, Monad relayer (3103), app (3101), landing (3100)
bun packages/relayer/scripts/e2e.ts        # the whole loop on a local anvil chain
bun run deploy:contracts                   # a fresh deploy; reads the keys in .env.local
```

The env keys it needs are listed in `.env.example` on this branch: `SKECH_NETWORK`, `ENGINE_PRIVATE_KEY`,
`RELAYER_PRIVATE_KEY`, `MONAD_TESTNET_RPC_URL` (or `MONAD_MAINNET_RPC_URL`), and `NEXT_PUBLIC_PRIVY_APP_ID` for the app.

## Known state of the live Monad testnet game

- **Never upgraded.** The contract on chain predates the audit fixes in `packages/contracts/evm` (#93): it has no
  `owed()`, and it emits the old `Settled` event. The relayer on this branch expects the new event, so against the
  live contract it settles bets on chain but never tells players their results. Upgrade the proxies first
  (`docs/SETUP.md`, the Monad upgrade section on this branch), or deploy fresh.
- **One key runs everything:** admin, upgrader, oracle and relayer. Split them before any real money.
- **Players' balances** stay in the contract and can still be withdrawn on chain.

## Bringing Monad back

Branch from here, then bring over what you want from `main` one piece at a time. The engine still signs prices under
the Monad domain (chain 10143, the game's address) on `main` too, so its price feed works for both chains unchanged.
