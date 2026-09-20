# trader

Holds the key, turns a drawn round into orders, and is the only thing that
books money. A round has to close itself when the clock runs out even if the
tab is gone, which is why this is a server and not the browser.

```
bun run --filter @skech/trader build:native   # once: fetch the signer, compile the shim
bun run --filter @skech/trader dev
curl localhost:3220/health
curl -XPOST localhost:3220/rounds -d '{"stake":20,"leverage":10,"seconds":6}'
```

## The signer

Lighter's signer is Go compiled to a C shared library. The TypeScript SDK has
no signer at all, the Go one needs a toolchain, and the official Python one
ships working binaries. So `native/fetch-signer.sh` takes the binary and its
header out of Lighter's published wheel, which is a zip, and `native/build.sh`
compiles `native/shim.c` against it.

The shim exists because every signing call returns a forty byte struct by
value and Bun's FFI cannot take one back. It passes arguments through and
writes the answer into pointers the caller owns. No signature is
reimplemented; they all come out of Lighter's own binary.

`native/vendor/` is gitignored. It is eight megabytes of binary that the build
fetches, not something to diff.

## Things the venue is fussy about, found the hard way

- **Testnet is a different market.** BTC is 4096 there and 1 on mainnet, and
  the size floor is 0.0002 rather than 0.00007.
- **Both floors bind, after rounding down.** $10 of Bitcoin rounds to $9.60 of
  Bitcoin and is refused, so anything sized off the minimum must ask for more.
- **An IOC order expires at zero**, not at the venue's twenty-eight day
  default of minus one. Sending minus one returns "OrderExpiry is invalid".
- **The chain id is baked into every signature.** 300 on testnet. A wrong one
  produces signatures the venue rejects without explaining why.

| Variable | Default |
|---|---|
| `PORT` | `3220` |
| `SKECH_NETWORK` | `testnet`, which also picks the venue, chain and market |
| `LIGHTER_ACCOUNT_INDEX`, `LIGHTER_API_KEY_INDEX`, `LIGHTER_PRIVATE_KEY` | required, used on testnet |
| `LIGHTER_MAINNET_*` | the same three, used when the switch says mainnet |

The network picks the credential as well as the venue. A mainnet order signed
with a testnet account index is not a small mistake, and the trader used to
read its own URL, so `SKECH_NETWORK=mainnet` moved the app and left the thing
that signs on testnet.

## Not built yet

`/rounds` opens, holds and flattens. Compiling the drawn shape into legs comes
next, from the same code the browser uses so the client cannot lie about what
it drew, and with it the stop and target as reduce-only trigger orders.
