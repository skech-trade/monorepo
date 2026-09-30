# Setup

What has to be set up by hand to run what is on `main`: keys, consoles, the box, the contracts. Code ships
itself (Vercel on merge, `infra/deploy.sh` for the box); this is everything that doesn't.

Do it in order: each part assumes the ones above it. [`DEPLOYING.md`](DEPLOYING.md) is how to ship once it
is set up; [`infra/README.md`](../infra/README.md) is the box.

## 1. Keys on your machine

`.env.local` at the repo root holds every server key. `infra/deploy.sh --env` sends the box only the ones
the servers read. [`.env.example`](../.env.example) documents each.

| Variable | What | Status |
|---|---|---|
| `SKECH_NETWORK` | `testnet` | set |
| `ENGINE_PRIVATE_KEY` | signs prices and bars; the contracts' admin today | set |
| `MONAD_TESTNET_RPC_URL` | Monad RPC for the servers | set |
| `RELAYER_PRIVATE_KEY` | pays gas. Blank: the engine's key | optional |
| `RELAYER_ENGINE_SIGNER` | the engine key's address. The relayers ignore prices signed by anyone else | **new: add** |
| `ENGINE_SENTRY_DSN`, `RELAYER_SENTRY_DSN` | errors from the box | set |
| `ENGINE_BAND_BPS` | how far Coinbase may be from Binance or Kraken, in bp. Blank: 15 | leave blank |
| `SKECH_SOLANA_CLUSTER` | `devnet` | **new: add** (part 5) |
| `SOLANA_RELAYER_SECRET_KEY` | the Solana relayer's keypair, the 64 bytes as JSON. It is also the Solana game's oracle | **new: add** (part 5) |
| `SOLANA_DEVNET_RPC_URL` | a devnet RPC (the public one rate-limits) | **new: add** (part 5) |

`RELAYER_ENGINE_SIGNER` for today's key is `0xc6377415Ee98A7b71161Ee963603eE52fF7750FC`
(`cast wallet address --private-key $ENGINE_PRIVATE_KEY` prints it).

Unused, safe to delete: `DATABASE_URL`, `LIGHTER_*`, `BOOST_*`, `FEED_URL`, `API_URL`, `TRADER_URL`,
`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`. Rotate the Lighter and Boost keys first if those accounts hold anything.

## 2. Consoles

**Coinbase (CDP Portal, portal.cdp.coinbase.com), Embedded Wallets → Domains:**
- [ ] `https://app.skech.trade` (the web app)
- [ ] `skech://callback`, exactly (the phone app's Google and Apple sign-in; without it: "Redirect URL does
  not match project's configured CORS origins")
- [ ] `http://localhost:3101` for local development

**Vercel, the app's project, Production and Preview.** These are read when the app is built: redeploy after
changing any.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_ENGINE_URL` | `wss://api.skech.trade/engine/ws` |
| `NEXT_PUBLIC_RELAYER_URL` | `wss://api.skech.trade/relayer/ws` |
| `NEXT_PUBLIC_CDP_PROJECT_ID` | the CDP project id |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_REGION` | PostHog → Settings → Project; `us` or `eu` |
| `NEXT_PUBLIC_SENTRY_DSN` | the Sentry project `next-app` |
| `SENTRY_AUTH_TOKEN` | Sentry → Settings → Auth Tokens. Secret. Without it errors show minified code |

Check it took: the live page's JavaScript must not contain `localhost:3102`.

**AWS (Mumbai):**
- [ ] The box has an Elastic IP, and `api.skech.trade` points at it
- [ ] Security group: inbound 80 and 443 from anywhere; 22 from your own IP only
- [ ] The instance's CPU credits are not "Unlimited"
- [ ] A monthly budget alert (about $15)

**Sentry:** alert rules for new issues, and for the relayer's `low-mon`, `not-oracle` and `engine-signer`
reports (players can't play while any of them fires).

**PostHog:** filter internal and test users, with your own wallet in the filter.

## 3. The box

After merging, from a clean checkout of `main` (both scripts refuse uncommitted changes):

```bash
infra/setup.sh            # the service users, bun, Caddy 2.11.4 (checksum checked), units, the backup timer
infra/deploy.sh --env     # right after: until it runs, the new units point at files that don't exist yet
```

Setup changes how the box runs: each service as its own user, code owned by root, `/etc/skech/env` split
per service, the relayers' state moved to `/var/lib/skech-relayer`, backed up every 15 minutes. Do part 4
first if the contracts are being upgraded in the same sitting: it says where these two go.

Then check:
- [ ] `curl https://api.skech.trade/engine/health` and `/relayer/health` answer `ok`
- [ ] `ssh skech curl -s localhost:3103/status` shows the difficulty and no errors (`/status` is box-only now)
- [ ] `ssh skech chronyc tracking`: the clock is synced. Trades more than 2 s off local time are not signed
- [ ] `ssh skech systemctl status skech-engine skech-relayer`: memory under the units' `MemoryMax`
  (300M and 400M, estimates)
- [ ] The relayer wallet holds 12 MON or more (Monad keeps 10 in reserve)

## 4. The Monad contracts

The live game (`0xd7cE3AADC704caF2D16319D1D25d01024cC5fdF0`) and IOU (`0x1F90adAd727FBcaf800cf3532ce75976EAA3e820`)
sit behind UUPS proxies. The audit's contract fixes take effect only once they are upgraded, and the new
relayer reads the new `Settled` event, so the upgrade and the box deploy go together, with the game paused:

1. **Check** from `packages/contracts`: `bun run test:check` passes, including the storage layout check.
2. **Work out `OWED`**: the IOU basis outstanding, `SkechIOU.basisOf` summed over every address that ever
   received IOU (the `to` of every IOU `Transfer` since block 66,645,399). It was 0 on 2026-09-29. Too low
   and `redeem` reverts; too high and only the count is off.
3. **Pause**: `cast send $GAME 'pause()' --private-key $ENGINE_PRIVATE_KEY --rpc-url $MONAD_TESTNET_RPC_URL`.
4. **Upgrade the game**, then the IOU, from `packages/contracts/evm`:
   ```bash
   PROXY=0xd7cE3AADC704caF2D16319D1D25d01024cC5fdF0 WHICH=game OWED=<sum> forge script script/Deploy.s.sol:Upgrade --broadcast --rpc-url $MONAD_TESTNET_RPC_URL --private-key $ENGINE_PRIVATE_KEY
   PROXY=0x1F90adAd727FBcaf800cf3532ce75976EAA3e820 WHICH=iou forge script script/Deploy.s.sol:Upgrade --broadcast --rpc-url $MONAD_TESTNET_RPC_URL --private-key $ENGINE_PRIVATE_KEY
   ```
5. **Ship the box**: part 3.
6. **Unpause**: `cast send $GAME 'unpause()' …`, then place one piece from the app and watch it settle.

The live difficulty is 51 (set 2026-09-30). The upgraded contracts refuse anything under 50.

## 5. Solana devnet

Solana has never been deployed to devnet (only `deployments/solana-localnet.json` exists). Once:

1. **Keys**: a deployer keypair with about 5 SOL (`solana airdrop`, or faucet.solana.com), and the relayer's
   keypair with 1 SOL or more. The relayer is the game's oracle, and pays every fee and rent.
2. **Deploy** from the repo root: `bun run deploy:solana`. It writes `packages/contracts/deployments/solana-devnet.json`;
   commit and merge it. The market starts at difficulty 51 and Monad's terms (4% of a stake, 10% of a
   win's profit, $100 a dot, $10,000 a piece).
3. **Ship**: the part 1 Solana keys in `.env.local`, then `infra/deploy.sh --env`. With them, the Solana
   relayer starts beside the Monad one, at `wss://api.skech.trade/solana/ws`.
4. **Check**: `ssh skech curl -s localhost:3104/status`.

## 6. The phone app

`packages/solana-mobile`, its own npm project (not in the bun workspace).

1. `packages/solana-mobile/.env` from its `.env.example`: `EXPO_PUBLIC_CDP_PROJECT_ID` (the web's) and the
   two URLs, which default to the box.
2. `npm install` (its `.npmrc` allows Coinbase's optional peer against Expo 55), then `npx expo run:ios` or
   `npx expo run:android`. Needs Xcode, or Android Studio and JDK 17.
3. `skech://callback` in the CDP Portal: part 2.

Not yet tried on a device: a real sign-in, a real deposit on devnet, and a Solana wallet through the Mobile
Wallet Adapter (Android only).

## 7. Before mainnet

- **Split the keys.** One key is today the contracts' admin, upgrader, pauser, treasurer, oracle and relayer,
  and it sits on the box: whoever takes the box can upgrade the contracts. Give admin and upgrade to a wallet
  that never touches the box (a multisig), and set `DEPLOYER_PRIVATE_KEY` for mainnet deploys, which refuse
  the engine's and relayer's keys.
- **Shorten the web session.** A browser-held session key is allowed $100,000 for 7 days; about a day, and
  an allowance near the balance, is enough.
- **Enforce the CSP.** It runs report-only; switch it to enforced once Sentry shows no reports.
- **Coinbase's first-party cookie** (`auth.skech.trade`), so iPhones don't sign players out after 7 days
  without a visit: an access request to Coinbase and three DNS records.
