# Skech social experience

## Product direction

Make a prediction worth identifying with and easy to share. The loop is:
choose a name and a Sketch buddy → draw → watch the market → make a card or
clip → invite a friend to draw their own version.

Use a person in a Skech-colored hoodie holding a pencil as the mascot.
The UI and media exports share the same vector artwork; users can choose
blue, mint or coral. Show neutral or thoughtful
expressions after losses; celebration must not imply the next trade wins.

## First release

- Personalize shared media with the user's saved display name, not the current
  hardcoded `vivek`. Never fall back to an email address or a wallet address
  on public exports.
- Let people choose a mascot color and a card appearance in a live preview.
- Keep the exported image and clip faithful to the preview and actual result.
- Animate prediction, market movement, then result. Include a recording state,
  preview and explicit save/share actions.
- Label practice, testnet and verified live results accurately. A local
  simulation must never receive a verified-trade badge.
- Keep New trade separate from the sharing flow.

## Implemented identity and onboarding

After sign-in, one optional onboarding flow introduces username claims, the
person mascot and the drawing experience. It replaces the legacy display-name
prompt. Funding is optional. The account menu reopens profile setup; the
results sidebar contains compact progress, with detailed rules behind a disclosure.

Claims use a five-minute wallet-signature challenge, a replay-resistant consumed
nonce and a seven-day hashed session token. Names use 3–20 lowercase letters,
digits and underscores, begin with a letter, and are unique in Postgres. System
names are reserved. Existing players can sign again to reconnect. Buddy color
persists on the account; session tokens and onboarding dismissal are local to
the browser. Public profile pages and referral links are not implemented.

## Implemented points and achievements

An append-only Postgres ledger uses unique event keys for idempotent awards:
50 for the initial claim, 20 for completing a registered prediction and 10 extra
for at least 70% direction accuracy. Three registrations per UTC day, one pending
prediction at a time. Levels start at 0, 100, 250, 500, 1,000 and 2,000 points.
Achievements: founding skecher, first prediction, five predictions, sharp eye.

The API registers the original line before its future window, then scores
against server market candles. Editing or closing the UI trade does not change
that registered prediction. Missing history expires the prediction rather than
inventing a score. Set SOCIAL_FEED_URL when the feed runs on another host.
These are prediction-practice points, not proof of a real trade, and they have
no cash value. There are no points for deposits, stake or leverage.

## Sharing and funding behavior

Trade completion opens the results sidebar. Outside clicks do not dismiss it;
Close, Escape and New trade remain explicit exits. Personalization supports
night/paper appearances, a shared person mascot and hiding money amounts for
both PNG cards and replay clips. Results remain labeled unverified.

Funding uses the API network response: a testnet faucet panel, or the mainnet
USDC address with local QR code, supported networks and minimum deposit.
Loading and retry states do not expose a send form or a previous wallet's
address. The wallet bridge is available only for mainnet deposit responses.

## Acquisition experiments

1. Shareable prediction replay: compare card export rate and recipient visits.
2. Draw your version: open a free prediction challenge before asking for funds.
3. Friend challenges: same market and time window; compare prediction accuracy.
4. Weekly recap: personal best predictions, learning progress and a share card.
5. Creator showcase: opt-in, verified examples with both wins and losses.

These are product hypotheses, not forecasts. Track preview → export → shared
link visit → first drawing, plus week-one return rate. Do not count a click on
an external compose window as a confirmed published post.

## References

- Strava's activity sharing: https://support.strava.com/en-us/articles/15401840-sharing-your-strava-activities
- Duolingo's friend streak design: https://blog.duolingo.com/product-lessons-friend-streak/

Borrow the identity and shared-activity patterns, not pressure to trade daily.
