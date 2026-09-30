# Solana contracts

The game on Solana, as an [Anchor](https://www.anchor-lang.com) workspace. For now it is Anchor's starter: one program, `skech`, with a single `initialize` and its test. The live game is on Monad, in [`../evm`](../evm).

## Tools

- Anchor **0.32.1**, pinned in `Anchor.toml`: `avm install 0.32.1` once, and `anchor` picks it up here without changing your default.
- The Solana CLI (for `solana-test-validator`) and Rust `1.89.0`, pinned in `rust-toolchain.toml`.

## Build and test

```bash
bun run solana:build   # target/deploy/skech.so and target/idl/skech.json
bun run solana:test    # starts a local validator, runs tests/ (Rust), stops it
```

Run them from `packages/contracts`. They're called `solana:*` so the root `bun run build` and `bun run test` (the EVM contracts') don't need Anchor or a validator.

`solana:test` starts its own validator on ports 8110–8140, because Anchor's default (8000) is taken by Docker on this machine.

## The program id

`declare_id!` in `programs/skech/src/lib.rs` and `Anchor.toml` hold the id of a keypair in `target/deploy/`, which is gitignored. On a fresh checkout, run `anchor keys sync` once after the first build to make them match your keypair. Keep the keypair that finally deploys somewhere safe: it is the only way to upgrade the program.
