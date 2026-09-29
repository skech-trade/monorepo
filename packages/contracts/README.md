# @skech/contracts

Foundry. `SkechPrice` checks a price signed by the engine (`packages/engine`).

```solidity
uint256 price = oracle.verify(market, price, time, signature); // reverts NotEngine or Stale
```

- **EIP-712:** `Price(string market,uint256 price,uint64 time)` under the domain
  `{name "skech", version "1", chainId, verifyingContract}`. The domain is readable
  on chain through EIP-5267's `eip712Domain()`.
- **Freshness:** a price older than `maxAge` seconds is refused. Without this, a
  user could keep an old price that suits them.
- Dependencies (OpenZeppelin, forge-std) are installed by bun into the root
  `node_modules`, not as git submodules. Run `bun install` first.

```bash
bun install
forge test          # or: bun run --filter @skech/contracts test
```

`test/SkechPrice.t.sol` recovers the signature that
`packages/engine/src/quote.rs` pins in its own test, so the Rust signer and the
Solidity checker can't drift apart silently.

## Deploy

```bash
ENGINE_ADDRESS=<hello.signer> MAX_AGE=5 \
  forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <deployer>
```

Then set `ENGINE_CHAIN_ID` and `ENGINE_VERIFYING_CONTRACT` in `.env.local`, so
the engine signs for that chain and that contract.
