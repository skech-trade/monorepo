# Solana contracts

The game on Solana: one Anchor program, `skech`, the same game as [`../evm`](../evm) (the same ladder, fees, pool and IOUs) built for how Solana works.

## How it differs from the EVM game, and why

| | EVM (Monad) | Solana |
| --- | --- | --- |
| Placing | one `place` per second, every player's pieces in it | **one piece per transaction**: transactions that write different accounts run in parallel, and a placement writes only the player's account, their new bet and the pool |
| The stroke | in an event, up to 24 KB | **only its hash** is signed; the relayer keeps the points (a transaction is 1232 bytes, and nothing reads strokes from chain) |
| Session keys | P-256, the browser's WebCrypto key, via Monad's precompile | **Ed25519**, checked by the Ed25519 precompile over the piece *as it sits in the `place` instruction*, so its bytes are in the transaction once |
| Quotes and bars | EIP-712, signed by the oracle and checked on chain | the oracle **signs the transaction**: the quote and the bar are instruction data it vouches for, with no second signature to check |
| The price | every second's bar kept forever | a **ring of the last 240 seconds** per market (9.6 KB, rent once); settling looks back 30 at most |
| Bets | stored forever | **an account per bet, closed when decided**; the rent goes back to the relayer, so the float is only what is live |
| Replays | a stored bet id | the bet account exists while live; once closed, every band's second is posted, so a replay has nothing to offer and is refused |
| IOUs | an ERC-20 with a growing index | the same shares and index, **on the holder's `Player` account**: redeemable by anyone, not transferable (a token would need Token-2022 transfer hooks for a feature nothing uses) |
| Deposits | EIP-3009 authorization | `deposit` signed by the wallet, or `sweep` on a standing SPL approval, so USDC that lands in the wallet moves in by itself |
| Gas | players never hold MON | players never hold SOL: the relayer is fee payer and pays every rent |
| Initializing | the deployer | **only the program's upgrade authority**, so nobody can take a fresh deployment first |

Accounts: `Game` (terms, oracle, vault; read-only to players), `Pool` (the pool, the fees, the IOU index), `Market` and `Bars` per market, `Player` per wallet, `Bet` per piece. All are PDAs of the program.

## Numbers (LiteSVM, `snapshots/compute.json`)

| | compute units |
| --- | --- |
| place, 1 band | 24,000 |
| place, 32 bands | 66,000 |
| a bar alone | 12,600 |
| a bar and 4 bets settled | 76,000 |

The widest piece, 32 bands, is **1,152 bytes** in a v0 transaction with the lookup table the deploy creates (the limit is 1,232). The relayer sets every compute limit from `snapshots/compute.json`, as it sets Monad's gas from `evm/snapshots/GasModel.json`. The program is built for speed, not size (`opt-level = 3`): `z` would save 110 KB of rent (~0.8 SOL, once) and double every instruction's compute units.

## Tools

- Anchor **0.32.1**, pinned in `Anchor.toml`: `avm install 0.32.1` once; `anchor` uses it here without changing your default.
- The Solana CLI 2.x or newer, and Rust `1.89.0` (`rust-toolchain.toml`).

## Build, test, generate

```bash
# from packages/contracts
bun run solana:build      # target/deploy/skech.so and target/idl/skech.json
bun run solana:test       # the suite in LiteSVM: the program as compiled, no validator
bun run solana:snapshot   # rewrite snapshots/compute.json
bun run solana:client     # regenerate the TypeScript client (client/) from the IDL, with Codama
bun test solana/sdk.test.ts
```

`tests/vectors/ladder.json` is the ladder as `@skech/core` computes it (`bun tests/vectors/ladder.ts`); the Rust tests check the program against all 12,852 rows. `tests/vectors/piece.json` is a piece's bytes as the program reads them; `sdk.test.ts` checks the TypeScript encodes the same (`SNAPSHOT=1 cargo test -p tests` rewrites it).

`sdk.ts` is the TypeScript side: networks, PDAs, the bytes a session key signs (`pieceBytes`) and the Ed25519 instruction that goes before `place`. It re-exports the generated client.

## Deploy

```bash
bun run deploy:solana                              # SKECH_SOLANA_CLUSTER, devnet when unset
SKECH_SOLANA_CLUSTER=localnet bun run deploy:solana # a local validator, with a local USDC
bun run deploy:solana --mainnet                    # mainnet-beta: required, it spends real SOL
```

It deploys the program, initializes the game (the deployer is admin, and must be the upgrade authority), opens BTC-USD, creates the lookup table and writes `../deployments/solana-<cluster>.json`. The keys are in the script's header. The program keypair, `target/deploy/skech-keypair.json`, is not in git: whoever deploys needs the one whose address is `declare_id!` in `lib.rs` (on a fresh checkout, `anchor keys sync` makes a new program id, for a new deployment).

## Before mainnet

- Build verifiably (`anchor build --verifiable`) and verify the deployed program against this source (`solana-verify`).
- Hand the upgrade authority and the admin to a multisig (Squads): `solana program set-upgrade-authority`, then `propose_admin` / `accept_admin`.
- Give the oracle its own key, apart from the admin's.
- Use a staked RPC (SWQoS) and priority fees for the relayer: placements must land within 3 seconds.
- An audit.
