# Skech request checklist — 22 September 2026

## Implemented locally

- **Accounting:** confirmed account-side fill P&L, partial-fill deduplication, realized plus open P&L during a round, venue total equity rather than collateral. The audited two rounds are restored as −$4.593190 and −$10.697232 (−$15.290422 combined). Deposits cannot inflate round results.
- **Execution state:** acknowledgement before running; no overlapping strategies; close waits for in-flight submissions, reduces the existing position and requires flat-position/fill confirmation. Unfinished rounds persist across restarts and require explicit recovery. Existing positions are visible with a close action.
- **Real data:** active app uses venue market data and execution results. No seeded rounds, simulated balances or locally settled profits. Legacy desk redirects to the live app. Missing historical drawings/replays remain unavailable.
- **Live chart:** WebSockets throughout the feed path, 500ms candles with immediate forming updates, frame-coalesced rendering, ping/pong, bounded trade deduplication and late-trade correction. Chart and trader use the same network/market. No guarantee of fastest possible venue latency.
- **Drawing:** stable live origin and drawing scale, upward/downward canvas expansion, confirmed B/S fill markers; removed duplicate labels and misleading colored prediction blocks.
- **UI:** restored blue primary actions; mobile market header aligned left; “Draw to Trade”; shorter prediction guidance without a fixed 60-second claim; removed warmup countdown and boost subheading; bordered secondary share buttons.
- **Completion:** results open after venue-confirmed completion, stay open until explicitly dismissed, and offer New trade as the primary action.
- **Onboarding:** optional username, person mascot holding a pencil, buddy colors and drawing introduction. Persistent signed username claims, points, levels and achievements; funding remains optional.
- **Sharing:** customizable card/clip appearance, money visibility, person mascot, replay and image/video downloads. Posting still requires an explicit user action.
- **Deposit:** responsive amount/address layouts, clear network information, QR/copy controls, loading, timeout and retry states; protection against stale wallet addresses.
- **Development:** stable ports, corrected local database endpoint, native signer built, auth configuration checked, container build contexts corrected.

## Verification

- All workspace TypeScript checks passed.
- Final targeted regression run: 73 tests passed, 347 assertions (chart math, candle feed, account equity, round closing/concurrency/recovery, fill accounting and social rules).
- Isolated social persistence integration test passed 17 assertions; temporary database removed.
- Browser checks passed for venue-driven live/results P&L, equity, pending close, sticky results and New trade history retention.
- Browser checks passed for stable midpoint, expansion at both drawing edges, onboarding at 320/390/1440px, and testnet/mainnet deposit layouts.
- Image and video export verified with customized person mascot and hidden monetary amounts.
- Targeted ESLint and git diff whitespace checks passed. Temporary QA routes removed.
- Read-only venue audit performed. No actual orders, position closes, faucet claims or external social posts were submitted by verification tools.

## Explicit limits and remaining launch work

This completes the local implementation and isolated verification, not a public mainnet release. Trading endpoint ownership authentication, key encryption and crash-window hardening remain release blockers; see [Lighter launch plan](LIGHTER-LAUNCH.md). A user-driven live testnet open/close acceptance pass and deployment have not been performed. Feed history remains in memory, gap recovery and measured p95/p99 latency are future operational work. Previously lost drawings cannot be reconstructed from fill records. API outages cannot be fixed by simulated fallback data.

See [social experience](SOCIAL-EXPERIENCE.md) for the implemented points model and optional future growth ideas.
