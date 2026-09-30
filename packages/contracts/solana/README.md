# Solana contracts

The game on Solana: one Anchor program, `skech`, the same game as [`../evm`](../evm) (the same ladder, fees, pool and IOUs) built for how Solana works.

## How it differs from the EVM game, and why

| | EVM (Monad) | Solana |
| --- | --- | --- |
| Placing | one `place` per second, every player's pieces in it | **one piece per transaction**: transactions that write different accounts run in parallel, and a placement writes only the player's account, their new bet and the pool |
| The stroke | in an event, up to 24 KB | **only its hash** is signed; the relayer keeps the points (a transaction is 1232 bytes, and nothing reads strokes from chain) |
| Session keys | P-256, the browser's WebCrypto key, via Monad's precompile | **Ed25519**, checked by the Ed25519 precompile over the piece *as it sits in the `place` instruction*, so its bytes are in the transaction once |
| Quotes and bars | EIP-712, signed by the oracle and checked on chain | the oracle **signs the transaction**: the quote and the bar are instruction data it vouches for, with no second signature to check |
| The price | every second's bar kept forever | a **ring of the last 240 seconds** per market (9.6 KB, rent once). A bar may be posted up to **200 s** after its second (`BAR_LATE`), so a posted second is never overwritten through its slot |
| A stalled oracle | bars can be posted any time later | once a band's second is past `BAR_LATE` unposted, **`expire`** (anyone may) gives its whole stake back, as on Monad, and closes the bet |
| Bets | stored forever | **an account per bet, closed when decided**; the rent goes back to the relayer, so the float is only what is live |
| Replays | a stored bet id | the bet account, at the one address a piece has (its canonical bump), lives until every band is decided **and** its piece's placing window is over; a replay before then is refused, after it is late. `place` must be a top-level instruction, so another program cannot pass on a piece the key never signed |
| IOUs | an ERC-20 with a growing index | the same shares and index, **on the holder's `Player` account**: redeemable by anyone, who is paid 10% of the growth into their own `Player` account as on Monad (none if they send none), not transferable (a token would need Token-2022 transfer hooks for a feature nothing uses) |
| Deposits | EIP-3009 authorization | `deposit` signed by the wallet, or `sweep` on a standing SPL approval, so USDC that lands in the wallet moves in by itself |
| Gas | players never hold MON | players never hold SOL: the relayer is fee payer and pays every rent |
| Initializing | the deployer | **only the program's upgrade authority**, so nobody can take a fresh deployment first; a vault someone created first is used, not a block; USDC must be an SPL Token mint (Token-2022's extensions could leave the vault short) |
| Terms | set by `initialize` | the same, `Config::DEFAULT` = `SkechGame.initialize`'s (a test on each side reads the Solidity) |

Accounts: `Game` (terms, oracle, vault; read-only to players), `Pool` (the pool, the fees, the IOU index), `Market` and `Bars` per market, `Player` per wallet, `Bet` per piece. All are PDAs of the program.

## Numbers (LiteSVM, `snapshots/compute.json`)

| | compute units |
| --- | --- |
| place, 1 band | 24,000 |
| place, 32 bands | 65,400 |
| each bump of the bet's address below 255 | 1,500 more |
| a bar alone | 13,400 |
| a bar and 4 bets settled | 77,300 |

`place` finds the bet's canonical bump itself (so a piece has one address), 1,500 units for each bump it tries below 255: the snapshot is taken at 255, and the relayer adds `place_per_bump` for the bump it already knows.

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

`tests/src/attacks.rs` is every way found to cheat the game, each shown refused. One of them builds `tests/cpi-probe`, a small program that calls `place` from inside itself (never deployed), with `cargo build-sbf` on first use.

`tests/vectors/ladder.json` is the ladder as `@skech/core` computes it (`bun tests/vectors/ladder.ts`, `--check` to see it is up to date); the Rust tests check the program against all 15,552 rows, and `evm/test/LadderVectors.t.sol` checks `SkechLadder` against the same file. `tests/vectors/piece.json` is a piece's bytes as the program reads them; `sdk.test.ts` checks the TypeScript encodes the same (`SNAPSHOT=1 cargo test -p tests` rewrites it).

`sdk.ts` is the TypeScript side: networks, PDAs, the bytes a session key signs (`pieceBytes`) and the Ed25519 instruction that goes before `place`. It re-exports the generated client.

## Deploy

```bash
bun run deploy:solana                              # SKECH_SOLANA_CLUSTER, devnet when unset
SKECH_SOLANA_CLUSTER=localnet bun run deploy:solana # a local validator, with a local USDC
bun run deploy:solana --mainnet                    # mainnet-beta: required, it spends real SOL
bun run deploy:solana --skip-program --set-config  # set a running game's terms to the defaults (SOLANA_CONFIG='{"feeBps":300}' to differ)
```

Run again on a game already set up, it leaves the game as it is and writes the deployment from the game account: its mint (on a local validator, the stand-in made the first time), vault, token program, treasury, oracle and admin.

It deploys the program, initializes the game (the deployer is admin, and must be the upgrade authority), opens BTC-USD, creates the lookup table and writes `../deployments/solana-<cluster>.json`. The keys are in the script's header. The program keypair, `target/deploy/skech-keypair.json`, is not in git: whoever deploys needs the one whose address is `declare_id!` in `lib.rs` (on a fresh checkout, `anchor keys sync` makes a new program id, for a new deployment).

## Upgrading a deployed program

The accounts keep their layout. Bets live seconds, so before upgrading, stop placing (stop the relayer's placements, or pause) and let the live bets settle, about 35 seconds; then `solana program deploy` over the same program id, regenerate the client, and restart the relayer with the new `snapshots/compute.json`. A game set up under the old defaults keeps its terms (a 2% fee, $10 a dot, $1,000 a piece): `deploy:solana --skip-program --set-config` moves it to Monad's.

## Before mainnet

- Build verifiably (`anchor build --verifiable`) and verify the deployed program against this source (`solana-verify`).
- Hand the upgrade authority and the admin to a multisig (Squads): `solana program set-upgrade-authority`, then `propose_admin` / `accept_admin`.
- Give the oracle its own key, apart from the admin's.
- Use a staked RPC (SWQoS) and priority fees for the relayer: placements must land within 3 seconds.
- An audit.
