# skech → production on Lighter

Written 2026-09-20 from the Lighter API docs (apidocs.lighter.xyz, docs.lighter.xyz),
the official `lighter-python` and `lighter-go` source, the live mainnet API, the Relay
API, provider pricing pages, and a file-by-file read of `ui/app` and `ui/landing`.
Numbers are as of that date; re-check the ones marked *verify* before relying on them.

---

## 0. The shape of the thing

- **One Lighter account per user, owned by the user's own embedded wallet.** Lighter
  keys an account to an Ethereum address, and the account is created by the first
  deposit. That is the non-custodial model the landing page already promises ("we
  never hold your money"). Sub-accounts do not scale as a per-user model (Standard tier
  gets 4, Plus 16, Premium 64).
- **skech holds a *trading* key, the wallet holds *ownership*.** Lighter accounts carry
  up to 251 L2 API keys (indices 4–254; 0–3 are reserved for Lighter's own web and
  mobile clients). A key signs orders. It can also sign a withdrawal, but a withdrawal
  can only go to the account's own L1 address; moving funds to *another* account needs
  the owner's Ethereum signature. So a stolen skech key can trade badly but cannot
  exfiltrate. Users can rotate the key from Lighter's own UI at any time.
- **Rounds are server-authoritative.** A round has to close itself when the clock runs
  out even if the tab is gone, and the P&L the card shows has to be the P&L the venue
  booked. So the server places, reverses, closes and records every round; the browser
  draws and watches.
- **Standard tier for every user.** Zero maker and taker fees, at the price of a 300 ms
  speed bump on taker and cancel orders and 60 transactions a minute per account. Both
  are fine for a product that sends one to five orders per round.
- **BTC only, isolated margin, 1×–50×.** Lighter's BTC market: index 1, max 50×,
  maintenance margin 1.2 %, close-out 0.8 %, default initial margin 5 % (= 20×) so
  leverage above 20× needs an explicit `update_leverage` per account.

---

## 1. How Lighter works for an app like this

### 1.1 Accounts and keys

1. A user's wallet address deposits ≥ 1 USDC (Ethereum contract) or ≥ $5 (any other
   route). "Crediting on mainnet takes a few minutes, after which a master account
   index gets generated." Look it up with `GET /api/v1/accountsByL1Address`.
2. skech generates an L2 keypair (`create_api_key` in the SDK, or the same code
   compiled to WASM) and asks the wallet for **one `personal_sign`** of this exact
   text, produced by the signer:

   ```
   Register Lighter Account

   pubkey: 0x…
   nonce: …
   account index: …
   api key index: …
   Only sign this message for a trusted client!
   ```

   That signature goes in as `L1Sig` on a `ChangePubKey` transaction (`change_api_key`
   in the Python SDK, `signMessage` in the TS SDK). No typed data, no gas. Any embedded
   wallet that exposes `signMessage` works. A *smart-contract* wallet cannot sign this
   off-chain; it has to call `changePubKey()` on the L1 contract as a priority
   transaction and then loses transfers entirely. **Pick an auth provider that gives an
   EOA.**
3. Store `{account_index, api_key_index, encrypted_private_key}` per user. Use index 4
   for the server key; keep index 5 free for a browser key later if you ever want
   client-side signing.
4. Every key has its own nonce (`GET /api/v1/nextNonce`, +1 per tx, or `skip_nonce=1`
   to allow gaps). Taker orders consume a nonce even when the sequencer rejects them.

### 1.2 Orders

- Signed by the API key, sent with `sendTx` or `sendTxBatch` (≤ 15 per batch) over REST
  or the WebSocket (`jsonapi/sendtx`).
- `create_order` fields: `market_index` (1 = BTC), `client_order_index` (your uint48
  id), `base_amount` (BTC × 10⁵), `price` (USD × 10, the worst acceptable price for a
  taker), `is_ask`, `order_type` (LIMIT 0, MARKET 1, STOP_LOSS 2, STOP_LOSS_LIMIT 3,
  TAKE_PROFIT 4, TAKE_PROFIT_LIMIT 5, TWAP 6), `time_in_force` (IOC 0, GTT 1,
  POST_ONLY 2), `reduce_only`, `trigger_price`, `order_expiry` (5 min – 30 days).
- Minimums on BTC: 0.00007 BTC and 10 USDC notional; size step 0.00001 BTC; tick $0.1.
- `update_leverage(market_index, margin_mode, leverage)` with `ISOLATED_MARGIN_MODE = 1`
  puts BTC in isolated mode for that account; the position's collateral is then its
  `AllocatedMargin` and "won't be affected by the other positions". Liquidation is an
  IOC close sent by the exchange at MMR, with up to a 1 % liquidation fee to the LLP
  insurance fund, which also absorbs bad debt (then ADL). *Verify with Lighter*: that an
  isolated position's shortfall can never touch the account's cross balance. If yes,
  "the most you can lose is your stake" is literally true and CONTENT.md §9.1 closes.
- SL/TP are standalone reduce-only trigger orders on mark price, not attachments.
  Batch them with the entry order.
- Funding is hourly. Rounds are 5–300 s, so a round pays funding only when it straddles
  the hour; show it or absorb it, but do not ignore it.

### 1.3 Deposits and withdrawals

Three ways in, in order of usefulness:

| Route | Chains | Min | Time | Creates a new account? | Needs |
|---|---|---|---|---|---|
| **Relay** (chain id `3586256`, `vmType: lvm`) | any Relay chain, any asset → "USDC (Perp)" | Relay's own | quote said **~1 s**, spec says < 2 min | *verify* (see below) | nothing; public API |
| **Lighter UDA bridge** (Fun.xyz) `https://bridge.lighter.xyz/v1/uda` | Ethereum, Arbitrum, Base, Polygon, Optimism, BNB, HyperEVM, Monad, Solana, Tron, Bitcoin, card | $5 new / $3 existing | "a few minutes" | yes | `x-api-key` from Lighter's Discord |
| **L1 contract** `0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7` `deposit(_to, assetIndex, routeType=0, amount)` | Ethereum mainnet | 1 USDC | a few minutes | yes | mainnet ETH for gas |
| CCTP intent address (`POST /api/v1/createIntentAddress`) | Arbitrum, Base, Avalanche, Arc | 5 USDC | minutes | yes | nothing |

Relay specifics found by dry-running `POST https://api.relay.link/quote/v2`:
- `destinationChainId: 3586256`, `destinationCurrency: "0"` (USDC Perp; `"1"` is ETH
  spot), **`recipient` is the Lighter account index as a string**, not an 0x address.
  An 0x address is rejected with `INVALID_ADDRESS`.
- 25 USDC from Base → 24.978 USDC (Perp), fees ≈ $0.03, two steps (`approve`,
  `deposit`).
- The same quote for an index that does not exist came back with $3.60 of relayer gas
  instead of $0.02, which looks like a fallback to an L1 deposit. **Test with a fresh
  wallet before assuming Relay can create accounts.** If it cannot, the first deposit
  goes through the UDA bridge (which explicitly supports new accounts) and every later
  one through Relay.
- Relay lists a $2 fee for leaving Lighter through Relay, and that direction needs an
  API-key signer on the Lighter side.

Out:
- **Secure withdrawal**: signed by the API key, lands at the account's L1 address on
  Ethereum after the batch is proven and claimed. L2BEAT shows state updates roughly
  every 7 minutes and proofs every ~4 minutes; the L1 claim is done by Lighter "whenever
  the gas isn't too steep". Budget "under an hour, sometimes longer" in copy until you
  have measured it.
- **Fast withdrawal**: USDC only, 4 USDC minimum, minutes. Fee not published in the docs;
  a third-party source says staking 100 LIT waives withdrawal and transfer fees. *Verify.*
- Escape hatch: 14-day forced-exit window if the sequencer censors.

### 1.4 Latency: what to expect and what Lighter recommends

- **Colocate in AWS Tokyo, `ap-northeast-1a`.** That is the one explicit recommendation
  in the docs. Put the order service there.
- Use the WebSocket for both data and `sendTx`; authenticate every request so that
  per-account limits apply instead of per-IP.
- Tier latencies from the docs (added by the exchange on purpose):

  | Tier | Taker | Maker | Cancel/modify | Fees | sendTx / min |
  |---|---|---|---|---|---|
  | Standard | 300 ms | 0 ms | 300 ms | 0 / 0 | 60 |
  | Plus | 300 ms | 200 ms | 200 ms | 0.5 bps / 0.5 bps | 4,000 |
  | Premium | 140 ms | 0 ms | 0 ms | 0.4 / 2.8 bps (less with LIT) | 4,000–48,000 |

- End-to-end for a Standard user: browser → Tokyo (50–250 ms by geography) → Lighter
  (single-digit ms colocated) → 300 ms speed bump → fill → `account_all` push (order
  book pushes are batched every 50 ms). **Plan on 400–600 ms from click to confirmed
  fill.** The app's `LATENCY_BARS = 0.5` (half a one-second candle) is the right order
  of magnitude and should stay.
- Market data: `order_book/1` every 50 ms, `trade/1` in real time, `candle/1/1m` is the
  **smallest candle Lighter serves**. The product draws one-second candles, so the feed
  service builds 1 s bars from the trade stream (and marks P&L on mark price, which is
  what the venue liquidates on).

### 1.5 Rate limits that shape the architecture

- Standard: 60 weighted REST requests per rolling minute (per IP *or* per L1 address;
  authenticate to get the per-address bucket). `sendTx`/`nextNonce` weigh 6, most reads
  weigh 300, so **a Standard key gets effectively zero read budget**. Reads come from
  the WebSocket or from a **Builder account** (240,000 weighted reads/min, free,
  applied for in Lighter's Discord, covers reads only).
- WebSocket per IP: 255 connections, 500 subscriptions and 500 accounts per connection,
  200 client messages/min (sendTx excluded). One Tokyo box can therefore watch
  ~127,000 accounts.

### 1.6 Money

- Standard users pay Lighter nothing to trade. `sketch.ts` already models that.
- **You cannot charge a builder fee on Standard accounts.** Partner attribution
  (`IntegratorAccountIndex` + `IntegratorTakerFee`, capped at 10 bps for perps by
  `systemConfig`) only works when the *user* is on Plus or Premium. Plus costs the user
  0.5 bps. Decide: free product on Standard (revenue from elsewhere), or move users to
  Plus and take up to 10 bps. Referral codes exist but pay points, not cash.

### 1.7 SDKs

- Official: Python (`lighter-sdk`) and Go (`elliottech/lighter-go`, the reference
  signer). The Go repo has `wasm/` and `web-wasm/` targets.
- TypeScript: `elliottech/lighter-ts` is a store + WebSocket demo with **no signer**.
  `lighter-ts-sdk` (also published as `@reservoir0x/lighter-ts-sdk` and
  `@oraichain/lighter-ts-sdk`) is a community SDK that wraps the Go signer compiled to
  WASM; unofficial, alpha-tagged, last published April 2026.
- Recommendation: a small **Go order service** on the official SDK in Tokyo, or a
  TS/Bun service that loads the WASM built from `elliottech/lighter-go` itself. Do not
  put the community npm package in the money path without reading it.

---

## 2. Auth and embedded wallets

What skech actually needs from the provider: email/social login, an **EOA** that can
`personal_sign` once (key registration) and send a deposit transaction on the source
chain now and then. **Every order is signed by the Lighter key, not the wallet**, so
per-user monthly-active pricing is paying for nothing.

| Provider | Free | Then | Notes |
|---|---|---|---|
| Privy | 499 MAU | $299/mo to 2.5k, $499/mo to 10k, then $2,000 base + $0.05/MAU + $0.01/sig | Stripe-owned |
| Dynamic | 1,000 MAU | $249/mo to 5k, $0.05/MAU after | Fireblocks-owned |
| Para | 1,200 MAU | $200/mo 2.5k, $500/mo 10k, $1,000/mo 25k | |
| Web3Auth | 1,000 MAW | $69/mo 3k, $399/mo 10k, $0.04–0.05/MAW | MPC, MetaMask-owned |
| Magic | 1,000 MAW | $99/mo 2.5k, $0.04/MAW | |
| Reown AppKit | 500 MAU | $89/mo 7.5k, $350/mo 15k, $0.05 extra | embedded email/social wallet in free tier |
| thirdweb in-app wallets | 1,000 wallets | $0.015/MAU, no minimum; custom auth needs $99/mo Growth | |
| Openfort | 2,000 ops/mo | $0.01/op; $99/mo for 25k ops | per-operation, open source, logins not billed |
| Turnkey | 25 sigs/mo, 1,000 wallets | $0.10/sig PAYG, $99/mo + $0.05/sig Pro | signing infra with an embedded-wallet kit |
| **Coinbase CDP Embedded Wallets** | **5,000 wallet ops/mo** | **$0.005/op**, no minimum | EOA or smart account; email OTP, SMS, Google/Apple, custom JWT; `useSignEvmMessage`; wagmi connector; Onramp sits next to it |

**Recommendation: Coinbase CDP Embedded Wallets.** A user costs one op to create the
wallet and one op to sign the Lighter registration, plus two ops per deposit sent from
the wallet. 5,000 free ops is roughly 2,000 new users a month for free, then about a
cent per new user and nothing for returning ones. Privy would be $299/mo at the 500th
user. CDP also gives an EOA (set `createOnLogin: "eoa"`), which is the wallet type
Lighter's off-chain key registration needs. Runner-up: Openfort, same billing shape at
twice the per-op price, open source, self-hostable later. If you want a flat monthly
number instead, Reown AppKit at $89/mo for 7,500 MAU is the cheapest per-MAU plan.
*Check before committing*: CDP's developer terms for a leveraged-derivatives front end,
and that the CDP EOA `signMessage` output verifies against Lighter on testnet.

---

## 3. What the code is today

From the audit of `ui/app/src` and `ui/landing/src` (file:line references are current
as of `7d62c98`):

- **Nothing is wired.** No wallet library, no auth, no API route, no env var, no
  persistence beyond a theme string in `localStorage`. `HANDLE = "vivek"`
  (`lib/user.ts`), `BALANCE = 12_480.55` (`lib/market.ts:323`).
- **Settlement is client-side and random.** `settle()` in `lib/sketch.ts` runs on a
  `Math.random()` walk (`nextCandle`, `sketch.ts:726`) with a per-sketch bias
  `follow` (`draw-screen.tsx:480`). Fills are interpolated half a candle late.
- **The new exits do nothing.** `exits` (stop/target in dollars) never reaches
  `settle`; all three call sites in `draw-screen.tsx` (147, 163, 237) pass six
  arguments and the seventh defaults to `{lose: null, gain: null}`. The `stop` and
  `target` outcomes are unreachable.
- **Three liquidation formulas.** `sketch.ts:358` (flat 1.25 % maintenance),
  `ticket.tsx:68` and `market.ts:252` (`entry × (1 ∓ 0.9/leverage)`), and a hard-coded
  number in `landing/.../market-data.ts:22`. Lighter's are 1.2 % maintenance, 0.8 %
  close-out, initial = 1/leverage (floor 2 %).
- **The trade model assumes things the venue does not.** Each drawn leg is sized off
  compounded equity and gets its own liquidation price (`sketch.ts:417–424`); the venue
  holds one net position and liquidates the aggregate. Legs have to become reversal
  orders on a single position.
- **Rounds are 5–300 seconds** (`MIN_BARS = 5`, `RUN_BARS = 60`, `RUN_MAX = 300`),
  candles are one second. Lighter's smallest candle is one minute.
- **Fees**: `FEE = 0` via `VENUE = "lighter"` (`sketch.ts:72–75`), which also zeroes the
  "a turn has to be worth taking" cost floor; the tray still prints "after fees"
  (`sketch-tray.tsx:106`); the Desk ticket uses its own unsourced 0.05 % / 0.02 %
  (`ticket.tsx:37`); the landing canvas charges Hyperliquid's 0.045 %
  (`draw-canvas.tsx:92`).
- **Leverage**: Draw 1–50× is right for BTC; Desk goes to 100× and must cap at 50×.
- **Inert controls that look live**: Deposit (header and menu), Withdraw, Transfers,
  Settings, Rewards, Support, Disconnect (`app-bar.tsx`), the Desk submit button
  (`ticket.tsx:367`, no `onClick`, no "Interface preview" caption despite FEATURES.md),
  Positions Exits/Close/Cancel.
- **Infra**: `next.config.ts` empty; no `error.tsx`, `global-error.tsx`, `loading.tsx`
  or `not-found.tsx` in the app; no tests anywhere; no `.github/`; no analytics or
  error reporting; no `robots.txt`; the waitlist route has no rate limit; DiceBear
  avatar is a third-party call on every load; `tsconfig.tsbuildinfo` and `.DS_Store`
  are committed.
- **`prefers-reduced-motion` freezes the chart** (`draw-screen.tsx:219`): the interval
  never starts, so the round never runs.
- **Dead code**: `lib/trace.ts` (733 lines, imported nowhere, a different model),
  `market.ts:tickCandle`, `sketch-tray.tsx:VERDICT` and `shareText`; `replay.tsx`
  reimplements `resample` as `sampled()`.
- **FEATURES.md is stale**: "candle N of 24", "1× to 15×", "never under three minutes",
  a settle toast that was removed, an "Interface preview" caption that does not exist.

---

## 4. The plan

Each phase ends with something you can run. Order matters: the model has to match the
venue before the venue is attached, or every screen will disagree with the money.

### Phase 0 — Decide (a day)

1. Standard tier and no builder fee, or Plus tier and up to 10 bps. Everything in
   copy about "free" depends on this.
2. Server-held trading key (this plan) versus browser-held key. Server is required for
   time-boxed rounds; browser-held could be added later as a second key.
3. Auth provider (recommend CDP, §2).
4. Apply in Lighter's Discord for a **Builder account** and a **bridge `x-api-key`**.
   Both are free and both gate later phases.
5. Set the round clock in stone: seconds, 5–300, or something else. FEATURES.md,
   the landing FAQ ("about a minute") and the code currently say three different things.

### Phase 1 — Make the simulation tell the venue's truth (app only, ~1 week)

Goal: the mock still runs, but every number it prints is one Lighter would print.

1. One `venue.ts` with Lighter's BTC constants: market index 1, size decimals 5, price
   decimals 1, min 0.00007 BTC / 10 USDC, MMR 1.2 %, close-out 0.8 %, IMF = 1/leverage
   floored at 2 %, max 50×, funding hourly, taker/maker 0. Delete the other liquidation
   formulas; `ticket.tsx`, `market.ts`, `landing/market-data.ts` and
   `landing/draw-canvas.tsx` all read from here (or the landing copies the file).
2. **One net position per round.** Rework `settle()` so legs are reversals of a single
   position with one liquidation price on the aggregate, sized in venue steps
   (round `base_amount` down to 0.00001 BTC, reject notional under $10). Keep the
   `LATENCY_BARS` fill delay.
3. **Wire `exits` into `settle`** and convert dollar exits to trigger prices, since that
   is what the venue will receive.
4. Mark P&L on a mark price, not last trade, and make "the most you can lose" the
   allocated margin less up to 1 % liquidation fee, so the copy stays true.
5. Fix the reduced-motion freeze (step the chart without animation instead of not
   stepping it).
6. Cap Desk at 50×, put the "Interface preview" caption on its submit button, and give
   every inert control the landing's `SoonButton` behaviour so nothing looks live that
   is not.
7. Delete `trace.ts`, `tickCandle`, `VERDICT`, `shareText`; make `replay.tsx` import
   `resample`. Update FEATURES.md.
8. **Tests for `sketch.ts`** (vitest): shape reading, quote, settle, liquidation, exits,
   size rounding. This is the file that decides money and it has none.

### Phase 2 — Backend skeleton, auth, accounts (~1–2 weeks)

1. New workspace `services/api` (Bun + Hono or Next route handlers, your call) with
   Postgres (Neon/Supabase) and Redis. Tables: `users`, `wallets`, `lighter_accounts`
   (`account_index`, `api_key_index`, `encrypted_key`, `tier`), `rounds`, `orders`,
   `fills`, `deposits`, `withdrawals`, `events`.
2. Auth: CDP Embedded Wallets in the app (`@coinbase/cdp-hooks`, EOA), session cookie
   from the CDP JWT. Replace `HANDLE` with the user's chosen handle.
3. **Onboarding state machine** per user: `no_wallet → wallet → funding →
   account_pending → key_registered → ready`. Poll `accountsByL1Address` after the first
   deposit; when the index appears, generate the key server-side, ask the wallet for the
   one `personal_sign`, submit `ChangePubKey`, verify with `apikeys`, encrypt the key at
   rest (KMS or libsodium sealed box with the key in a secret manager).
4. Set BTC to isolated mode and the user's chosen leverage with `update_leverage`
   whenever the meter changes (it is a signed tx, so debounce it).
5. Testnet first (`https://testnet.zklighter.elliot.ai`, chain id 300). Get one account
   through the whole flow before touching mainnet.

### Phase 3 — Deposits (~1 week, you already know Relay)

1. Deposit sheet in the app: any chain, any asset, Relay quote → `approve` + `deposit`
   steps sent from the embedded wallet; recipient = the user's Lighter account index.
2. First-deposit path: if Relay cannot create the account (test it), route the first
   deposit through the UDA bridge (`POST /v1/uda`, then poll `GET /v1/uda/{wallet}` for
   `COMPLETED`) and every later one through Relay.
3. Server watches `account_all_assets/{index}` on the WebSocket and Relay's request
   status; the cash chip becomes real. Show the minimums ($5 new account, $10 per trade).
4. Card / Apple Pay: CDP Onramp or the UDA bridge's card route. Fits the fomo comparison
   in CONTENT.md.

### Phase 4 — Feed (~1 week)

1. `services/feed` in Tokyo: one WebSocket to Lighter subscribed to `trade/1`,
   `ticker/1`, `market_stats/1`, `mark_price_candle/1/1m`. Builds 1-second OHLC bars from
   trades, keeps the last few hours in Redis, and fans out to browsers over its own
   WebSocket or SSE.
2. `candlesFor` in `market.ts` becomes a client that seeds 90 bars from the feed and
   appends live ones; `nextCandle`/`follow` go away. Everything else in
   `draw-screen.tsx` stays, which is what the "swap the feed and the rest stays"
   comment promised.
3. Desk: order book and tape from `order_book/1` and `trade/1`. Or keep Desk unlinked
   until Draw is live.

### Phase 5 — Trading engine: rounds (~2–3 weeks, the core)

1. `services/trader` in `ap-northeast-1a`, one process per shard of accounts, each
   holding a WebSocket to Lighter with `account_all/{index}` for every account it owns,
   and the Go or WASM signer.
2. `POST /rounds` from the app carries the drawn shape (32 samples), stake, leverage,
   exits, duration. The server re-derives the legs with the same `sketch.ts` code (share
   the package) so the client cannot lie, then:
   - **t=0**: MARKET IOC entry sized `floor(stake × leverage / mark, 5 dp)`, `price` =
     mark ± slippage cap; batch a reduce-only STOP_LOSS and TAKE_PROFIT if exits are set.
   - **each drawn turn**: MARKET IOC for `current + next` on the other side (a reversal),
     or a close + open batch. Legs shorter than the speed bump collapse into their
     neighbour.
   - **time's up / "take it off"**: reduce-only MARKET IOC close, then cancel the
     trigger orders.
   - **liquidation**: the venue does it; the server sees the position go to zero on
     `account_all_positions` and books it as `liquidated`.
3. Book realised P&L from `account_all_trades` fills, not from the chart. The card is
   painted from the booked number. The client's `settle()` becomes a preview only.
4. Idempotency and recovery: `client_order_index` = round id + step; on restart,
   reconcile open positions from `account_all_positions` and either resume or close.
   Handle nonce gaps with `skip_nonce`. Handle Lighter's 429/405 and the 60-second
   firewall cooldown by backing off per account.
5. Limits the app must enforce before sending: notional ≥ $10, size step, leverage
   ≤ 50×, no more than ~50 orders a minute per account.
6. Rounds table becomes the "Rounds" sheet's source. Seeded fake rounds go.

### Phase 6 — Withdrawals, history, sharing (~1 week)

1. Withdraw: secure withdrawal (API key) to the user's wallet address on Ethereum, with
   honest timing copy; fast withdrawal for USDC ≥ 4. Optionally Relay out to another
   chain ($2 Relay fee, needs the key signer).
2. Deposit / withdrawal history from `deposit_history` and `withdraw_history`.
3. The share card and clip stay client-side; the sentence on the card reads the booked
   P&L. Posts carry the round id so a public round page (`/r/[id]`) can show it, which
   is CONTENT.md §5.5.

### Phase 7 — Hardening (~1 week, in parallel with 5–6)

1. `error.tsx`, `global-error.tsx`, `not-found.tsx`, `loading.tsx` in the app.
   `next.config.ts`: security headers, `poweredByHeader: false`, image remote patterns
   or drop DiceBear for a local avatar.
2. Sentry (or equivalent) on app and services; PostHog for "time to first drawn line"
   and the funnel CONTENT.md names.
3. CI: `bun run lint`, `typecheck`, vitest, and the banned-vocabulary grep from
   CONTENT.md §7 as a check. Remove `tsconfig.tsbuildinfo` and `.DS_Store` from git.
4. Rate-limit the waitlist route (Upstash or Vercel WAF) and the new API.
5. `robots.txt` for `app.skech.trade`; a `/legal` page: this is a leveraged product,
   geoblocking as required, "you can lose what you put in" on the deposit sheet.
6. Secrets: the trading keys are the crown jewels. KMS-encrypted at rest, decrypted only
   in the trader process, never in the Next app, rotation runbook, alert on any
   `withdraw` the server did not initiate.
7. Load test the trader against testnet with 500 simulated accounts, 5 orders a round.

### Phase 8 — Rollout

1. Full flow on Lighter testnet with real CDP wallets.
2. Mainnet with a $20–$100 stake cap and an allowlist, watching fills against the mark
   and the 300 ms assumption.
3. Lift the cap, open the waitlist, wire the §5.5 feed.

---

## 5. Things to verify before building on them

- Whether Relay can deposit to an account index that does not exist yet (the quote
  behaves differently; nobody has documented it).
- That an isolated position's loss on Lighter cannot exceed its allocated margin plus
  the liquidation fee under any ADL/LLP scenario. This is the sentence the landing
  page's "the most you can lose" stands on.
- Withdrawal timing and fee for both secure and fast paths, measured, not read.
- CDP EOA `signMessage` verifies against Lighter's `ChangePubKey` on testnet.
- CDP's terms for this use case.
- Lighter's own terms for third-party front ends and any geoblocking they expect you
  to mirror.
