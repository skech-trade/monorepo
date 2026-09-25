# Drawing contracts and verification

The practice app uses `rounded-v3` for new freehand drawings. Saved `rounded-v1`, `rounded-v2`, `area-v1`
and historical row contracts retain their original pricing and settlement terms.
This document supersedes earlier area-v1 replay figures for the active UI.

## Product and presentation

- Skech’s warm neutrals, Bitcoin mark, typography and blue ink; no betting tiles.
- The canvas fills the viewport. Future space uses 72% of desktop width and 76%
  on phones. Controls respect safe-area insets; phone controls have 44px height.
- No LIVE badge, payout heading/explanatory legend, or floating pointer tooltip.
- Dimmed map labels show one maximum section return at each sampled nib position,
  not a range. A dash means no offer. These maxima do not promise the entire
  drawing will pay that multiple. The footer shows actual cost and max total return
  during a drawing. Help explains the distinction.
- Pen sizes are 8/14/20 CSS pixels. They change nib coverage and payout, never zoom.
- There is no five-piece or five-drawing limit. Release commits; cancellation
  costs nothing. Overlapping ink within one drawing is charged once.
- Rounded caps and joins use the same linear capsule geometry that is priced.
  Accepted ink is solid after placement. An inactive dashed trace preserves the
  original gesture through unavailable or refunded regions without promising payout.
  Opening refunds also show a brief dollar notice.

## Geometry, pricing and settlement

Time is horizontal; price is vertical. One complete nib-sized dot has area
`A = pi * rt * rp`. The swept round nib is intersected with fine price cells,
then integrated with 24 quadrature samples per second. A full isolated tap is
normalized to exactly one dot unit; clipped taps are not renormalized.

Connected price cells within a second are partitioned into adjacent sections
of roughly two dot units or less (whole accounting rows are indivisible). This
avoids rejecting an entire steep stroke second because its total area exceeds
the payout cap. Partitioning preserves covered area and introduces no price gaps. If the market reaches any part of the
section, the whole section pays once. New sections include two CSS pixels of
paid price-edge tolerance; probability estimation includes that same tolerance.

The historical input has one-second OHLC ranges, so a hit means overlap with
that second’s price band, including both padded edges. It does not establish
pixel-exact subsecond intersection. The previous close is included consistently
in both historical pricing and live judging.

For section area `a` in dot units, estimated touch probability `p`, adjusted
pricing target `r`, and per-dot amount `d`:

    raw = a * r / p
    tail = raw <= 10 ? raw : 1.1 + sqrt((raw - 1.1) * 8.9)
    displayed_section_return = floor_tenth(min(tail, 25))
    internal_multiple = displayed_section_return / a
    cost = ceil_cent(d * sum(accepted_section_areas))
    payout = floor_cent(d * sum(hit_section_returns))

An offer requires a displayed section return of at least **1.1x** and an
internal multiple at least the existing minimum. Unknown probabilities and
under-minimum offers are unavailable, not artificially rounded up. The cap is
per section, not per drawing. The drawing’s total possible payout can exceed it.

The default difficulty is **70**, base pricing target **0.716**, section cap
**25x**. Returns through 10x follow the raw formula; larger returns use the
square-root tail above. The old global 10x cap still applies to historical
engines; `MAX_INK_MULTIPLE` explicitly sets the current drawing cap.
`rounded-v1` retains its old hard cap, `rounded-v2` its logarithmic soft cap,
and already-opened contracts retain their saved values. Momentum adjustment, payout caps and rounding reduce effective return.
In particular, capping rare sections can reduce expected return far below 71.6%.
The user explicitly chose to retain this tougher model after reviewing that
tradeoff; it must not be described as a uniform 71.6% RTP game.

A longer stroke costs its area in dot units. A hit therefore need not cover the
whole drawing’s cost. Changed opening odds may reject a section; its unused
stake is refunded. Refunds subtract the rounded retained cost from the initial
debit. Cumulative payouts round after summing fractions, and credits are the
difference between successive totals, avoiding repeated credits or per-cell
rounding losses. Explicit saved difficulty settings remain in effect.

## Worker correctness and rendering

The quote field stores weighted cumulative distributions for path lows and
highs. A continuous band’s probability is computed as
`P(low <= upper) - P(high < lower)`, with the same calibration as direct path
pricing. It is not the sum of correlated cell probabilities. Out-of-field
opening requests fall back to exact historical-path pricing.

Worker requests carry explicit difficulty, scale, edge allowance, time and
monotonic request ID. Stale replies cannot replace newer fields. Closed-bar
quote fields refresh once per second. Settlement uses fresh market bars.

The live line follows the latest trade without an added price interpolation
lag. Its numeric tag and header use the same published price snapshot (up to
10Hz); the canvas redraws with requestAnimationFrame. Camera easing is time-based
and freezes during drawing. This is not a claim of fastest exchange-to-screen
latency: network and source-feed latency remain.

Accepted clipping bands are cached by section-array identity and drawing groups
are cached between state updates. Masks use merged rectangles followed by the
original round stroke, avoiding seams from individually rounded accounting cells.
Reduced-motion mode suppresses decorative effects; coin tones have a mute control.

Live P&L is paid cash minus the allocated cost of settled ink for the current batch.
Pending stakes leave available balance on placement but do not count as losses.
Hits settle on touch; misses settle after their one-second window closes.
Retained stake is allocated by resolved area, with fractional cents carried
until completion so the final result exactly reconciles to payout minus cost.
Completed drawings stay in that total while others remain pending; the final
result remains as Last P&L until a new batch starts. It is not a cash-out value.

## Retrospective replay — 25 September 2026

`packages/core/scripts/check-ink-area.ts` uses the exact shared viewport geometry,
preview filtering, opening repricing, refunds and settlement. Run with `STEP=300
STAKE=1 OUT=report.json`, followed by library path, CSV folder and day arguments.
CSV hashes, rules and detailed breakdowns are recorded in the JSON output.

September 17–23: 2,009 outcome windows x three viewport sizes x three pens x
four predefined strategies = 72,324 attempts, 71,916 non-void openings.
At $1 per dot, realized return was **0.424580 per dollar**, against model estimate
**0.435497**. The hour-block bootstrap interval was **0.397–0.454**.
Fine/Medium/Wide returned **0.368 / 0.462 / 0.509**. Offered area was **99.6%**.
All **3,819,711 invariant checks** passed, including cent accounting, refunds,
minimum/cap bounds, expected-value bounds and settlement. Daily returns ranged
from **0.274 to 0.544**. These results supersede earlier v1/v2 replay figures.

These dates are outside the library’s documented September 1–16 building window,
but were evaluated by previous versions. This is retrospective validation,
not an untouched holdout. Replays omit intrasecond execution latency; predefined
strategies are not an exhaustive exploit search. Model agreement does not make
the product fair or guarantee future returns. Real-money services are not wired
to these browser-local practice contracts.

## Checks

Core: 52 tests / 104,512 assertions across ink-area, ink, odds and dots pass.
The area suite also passes alone at the default difficulty, avoiding test-order
configuration dependence. UI lint, typecheck and production build are required
for this change. Desktop and 320px/390px mobile layouts are inspected in-browser.


## Follow-up: two-times zoom-out and visible balance

The current vertical camera spans six market steps instead of three, with the
same pen diameters and time scale. Balance appears before P&L; phone account
figures occupy a separate row. Settled misses stay in the render mask through
the normal fade instead of being removed immediately. Opening rejections are
still refunded and excluded.

## Presentation motion

Quote columns have fixed future offsets instead of a one-second scroll/reset.
Label rows ease toward their new price positions; only changed glyphs roll within a clipped slot
for 140ms. Unchanged digits remain solid. Quotes are discrete priced values,
never a count-up through artificial intermediate multipliers. Guides remain
sampled maximum section returns, not locked quotes for a whole gesture.

Header prices, balance and P&L use tabular characters with a 90ms, 1.5px entrance
only for changed characters. They stay fully opaque and show the current value
immediately. P&L reserves width, controls use short press/color transitions, and
reduced-motion mode disables decorative motion. The resize observer does not
clear the canvas when its physical dimensions are unchanged.

Retracing within one gesture is unioned and charged once. Separately released
drawings are separate paid contracts; overlapping them adds correlated exposure,
not a free payout or independent chance of winning.
