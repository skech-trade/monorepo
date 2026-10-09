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
| `SOLANA_RELAYER_SECRET_KEY` | the Solana relayer's keypair, the 64 bytes as JSON: `~/.config/solana/skech-devnet-relayer.json` on the owner's machine (`3hNNKV…Ge9s`). It is also the devnet game's oracle | **new: add** (part 5) |
| `SOLANA_DEVNET_RPC_URL` | a devnet RPC (the public one rate-limits) | **new: add** (part 5) |
| `SOLANA_RPC_RPS` | requests a second the Solana relayer asks of that RPC, all told. Blank: 15. Set it under the plan's limit | optional (part 5) |

`RELAYER_ENGINE_SIGNER` for today's key is `0xc6377415Ee98A7b71161Ee963603eE52fF7750FC`
(`cast wallet address --private-key $ENGINE_PRIVATE_KEY` prints it).

Unused, safe to delete: `DATABASE_URL`, `LIGHTER_*`, `BOOST_*`, `FEED_URL`, `API_URL`, `TRADER_URL`, and the
web app's old Coinbase keys. Rotate the Lighter and Boost keys first if those accounts hold anything.

## 2. Consoles

**Privy (dashboard.privy.io), the app `cmuzqwmig01200dl8gf8j8tf2`** ([`PRIVY-SETUP.md`](PRIVY-SETUP.md)):
- [ ] Login methods: email, SMS, Google, Apple
- [ ] Embedded wallets: Solana on
- [ ] Allowed origins: `https://app.skech.trade` and `http://localhost:3101`

**Vercel, the app's project, Production and Preview.** These are read when the app is built: redeploy after
changing any.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_ENGINE_URL` | `wss://api.skech.trade/engine/ws` |
| `NEXT_PUBLIC_RELAYER_URL` | `wss://api.skech.trade/solana/ws` (the default, so it may be left unset) |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` (the default; `mainnet-beta` once the game is there) |
| `NEXT_PUBLIC_PRIVY_APP_ID` | `cmuzqwmig01200dl8gf8j8tf2`. Not the app secret, which the web app never needs |
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
   received IOU (the `to` of every IOU `Transfer` since block 66,645,399). It was 0 on 2026-09-29, and the relayer counted one IOU holder on 2026-10-01, so read it again. Too low
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

The game is on devnet (2026-10-01). Every address is in `packages/contracts/deployments/solana-devnet.json`:

| | |
|---|---|
| Program | `2k9WY5YR357AGVVoBW6ouFHijEypTj8953fzSdD7HfRV` (upgrade authority: the deployer, `7Qfww9…Njng`) |
| Game | `EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyxF`, BTC-USD at difficulty 51, Monad's terms |
| USDC | Circle's devnet mint, `4zMMC9…DncDU` |
| Oracle and relayer | `3hNNKVAfS95A1Rqqss7xoRS8PZceQbKCS4HCfhDsGe9s`, 0.3 SOL |

What is left is running its relayer on the box (`https://api.skech.trade/solana/health` answers 502 until then):

1. **Keys**: `SKECH_SOLANA_CLUSTER=devnet`, `SOLANA_RELAYER_SECRET_KEY` (the relayer keypair file's contents) and
   `SOLANA_DEVNET_RPC_URL` in the env file `infra/deploy.sh` reads (`.env.local`, or `SKECH_ENV_FILE`). If the
   RPC's plan allows fewer than 15 requests a second, set `SOLANA_RPC_RPS` below it: the relayer holds itself to
   that and backs off on a 429 (`/status` → `rpc` counts both).
2. **Ship**: `infra/deploy.sh --env`. With both Solana keys, the Solana relayer starts beside the Monad one, at
   `wss://api.skech.trade/solana/ws`.
3. **Check**: `curl https://api.skech.trade/solana/health` answers `ok`; `ssh skech curl -s localhost:3104/status`
   shows devnet, difficulty 51 and the engine connected.
4. **SOL**: the relayer pays every fee and every bet's rent (the rent comes back when the bet settles). Keep it
   over 1 SOL from faucet.solana.com; `solana airdrop` is rate-limited.

Upgrading the program: `deploy:solana` uploads through the RPC (`--use-rpc`), and the public devnet RPC rate-limits
it to a crawl (4% in 30 minutes). Upload straight to the validators instead, then set up or reconfigure the game:
`solana program deploy target/deploy/skech.so --program-id target/deploy/skech-keypair.json --url devnet` from
`packages/contracts/solana`, then `bun run deploy:solana --skip-program`.

## 6. The phone app

`packages/solana-mobile`, its own npm project (not in the bun workspace). It signs in by email, SMS or, on
Android, a Solana wallet on the phone (Phantom, Solflare, the Seeker's Seed Vault). The email and SMS sign-in
and the embedded Solana wallet are Privy's, the same Privy app as the web. Google and Apple are off on the phone.

**Privy (dashboard.privy.io), app `cmuzqwmig01200dl8gf8j8tf2`:**
- Login methods: email and SMS on.
- Embedded wallets: Solana on. The app creates one for anyone who signs in without one.
- App settings → Clients → Add app client: allowed app identifiers `trade.skech.app` (the Android package and
  the iOS bundle id), URL scheme `skech`. Its client id is `EXPO_PUBLIC_PRIVY_CLIENT_ID`.
- The app secret stays on servers: nothing in `packages/solana-mobile` may hold it.

1. `packages/solana-mobile/.env` from its `.env.example`: `EXPO_PUBLIC_PRIVY_APP_ID`, `EXPO_PUBLIC_PRIVY_CLIENT_ID`
   (without both the app signs in only with a wallet on the phone) and the two URLs, which default to the box.
   Until the Solana relayer runs there (part 5), point `EXPO_PUBLIC_RELAYER_URL` at a relayer on your machine by
   its network address, e.g. `ws://192.168.x.x:3104/ws` (a phone's `localhost` is the phone), with
   `RELAYER_HOST=0.0.0.0` on the relayer.
2. `npm install` (its `.npmrc` lets Privy's pinned viem peer through), then `npx expo run:ios` or
   `npx expo run:android`. Needs Xcode, or Android Studio and JDK 17. A development build loads its code from
   Metro on your machine: the phone has to be on the same network.
3. To play: sign in, copy the Solana address from Deposit, get devnet USDC at faucet.circle.com (Solana Devnet)
   and send it there. It is swept into the balance by itself.

Done on a Galaxy A07: Privy sign-in, a deposit, pieces placed and settled, a Solana wallet (Phantom, Solflare)
through the Mobile Wallet Adapter.

### Releasing: store builds and over-the-air updates

`android/` and `ios/` are generated (`npx expo prebuild`) and not in git. Everything native lives in `app.json`
and `plugins/`: the release signing (`with-release-signing`, reading `~/.config/skech/android-signing.properties`,
which is the Play upload key: back up `~/.config/skech/`), Gradle's memory (`with-gradle-memory`), and the
permissions (only camera, vibrate, internet, notifications; microphone, overlay, storage and background audio
are blocked).

Two kinds of release:
- **Over the air (most releases).** Changes to the app's own code and images: `npx eas-cli update --channel
  production --message "…"` from `packages/solana-mobile`. Installed apps download it in the background and run
  it on their next launch. `EXPO_PUBLIC_*` values are baked into the update, so switching the relayer or the
  Solana cluster (e.g. to mainnet) ships this way too.
- **Through the store.** Anything native: a new package with native code, a new permission, the icon, the
  Expo SDK. Raise `android.versionCode` in `app.json`, `npx expo prebuild --platform android`, then
  `./gradlew bundleRelease` in `android/` (JDK 17) and upload `app/build/outputs/bundle/release/app-release.aab`
  in Play Console.

`runtimeVersion` is the native fingerprint, so an update only reaches builds whose native code it matches: an
update that needs a new native build simply waits for it, rather than crashing an old one. `eas-cli fingerprint:compare`
tells which kind a change is.

Once: `npx eas-cli login`, then `npx eas-cli init` and `npx eas-cli update:configure` in `packages/solana-mobile`,
which write the project id and the updates URL into `app.json`. Play's own app-signing SHA-256 (Play Console → App
integrity) goes into skech.trade's `assetlinks.json` next to the upload key's, or wallets stop trusting the
store's copy.

## 7. Before mainnet

- **iOS builds.** Android ships through Play (part 6); iOS still needs an Apple distribution certificate and
  TestFlight.
- **Real-money gambling on Play.** Closed, open and production tracks need Google's real-money gambling
  approval (licences per country, age and region gating). Internal testing does not.

- **Split the keys.** One key is today the contracts' admin, upgrader, pauser, treasurer, oracle and relayer,
  and it sits on the box: whoever takes the box can upgrade the contracts. Give admin and upgrade to a wallet
  that never touches the box (a multisig), and set `DEPLOYER_PRIVATE_KEY` for mainnet deploys, which refuse
  the engine's and relayer's keys.
- **Shorten the web session.** A browser-held session key is allowed $100,000 for 7 days; about a day, and
  an allowance near the balance, is enough.
- **Enforce the CSP.** It runs report-only; switch it to enforced once Sentry shows no reports.
- **Privy's HttpOnly cookies** on our own domain (dashboard → Configuration → App settings → Domains, then the
  DNS records it shows), so the session is a first-party cookie rather than browser storage. Add the
  `privy.skech.trade` host it gives to the CSP's `connect-src` and `frame-src` (`ui/app/src/proxy.ts`).
