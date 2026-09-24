/**
 * Boost's arithmetic, in whole micro-USDC.
 *
 * Floating point is fine for a chart and wrong for a ledger: a round that
 * settles at $59.999999 has to hand out exactly what the lane held, to the
 * millionth, or the books and the venue drift apart one round at a time.
 */

export const MICRO = 1_000_000n;

/** Dollars to micro-USDC, rounded down: a figure from the venue is never rounded up into money nobody has. */
export const micro = (usd: number) => BigInt(Math.floor(usd * 1e6 + 1e-6));
export const usd = (m: bigint) => Number(m) / 1e6;

/** A share of an amount, rounded down: `share(x, 0.3)`. Basis points underneath, so 0.3 is exactly 3000/10000. */
export const share = (amount: bigint, fraction: number) => (amount * BigInt(Math.round(fraction * 10_000))) / 10_000n;

export type Settlement = {
  /** What the lane held once flat. */
  equity: bigint;
  /** Back to the user's Boost balance. */
  user: bigint;
  /** Back to skech: its boost, less any shortfall past the user's stake, plus the fee or the cut. */
  skech: bigint;
  /** The 30% of a win. */
  cut: bigint;
  /** The 1% of a loss. */
  fee: bigint;
  /** What skech paid past the user's stake. */
  gap: bigint;
  /** The round's result before anybody's share: equity less stake and boost. */
  pnl: bigint;
};

/**
 * Who gets what once a lane is flat.
 *
 * A win: the user keeps their stake and 70% of the profit, skech its boost
 * and the other 30%. A loss comes out of the user's stake first; skech takes
 * 1% of the stake from whatever is left; anything past the stake is skech's
 * to carry. The two always add up to exactly what the lane held.
 */
export function settle(stake: bigint, boost: bigint, equity: bigint, cutShare: number, lossFeeShare: number): Settlement {
  if (equity < 0n) equity = 0n;
  const pnl = equity - (stake + boost);
  if (pnl >= 0n) {
    const cut = share(pnl, cutShare);
    return { equity, user: stake + pnl - cut, skech: boost + cut, cut, fee: 0n, gap: 0n, pnl };
  }
  const loss = -pnl;
  const userLoss = loss < stake ? loss : stake;
  const left = stake - userLoss;
  const wanted = share(stake, lossFeeShare);
  const fee = wanted < left ? wanted : left;
  const gap = loss > stake ? loss - stake : 0n;
  return { equity, user: left - fee, skech: boost - gap + fee, cut: 0n, fee, gap, pnl };
}

/**
 * Settle on a result other than the venue's: the user's share is worked out
 * as if the round had made `reference`, and skech keeps whatever the lane
 * really holds past that. Testnet's book is a thin, stale quote, so its fills
 * lose a few dollars a turn to the spread that the chart the user traded on
 * never showed; there the user is paid on the chart, and skech carries the
 * difference. The two still add up to exactly what the lane held.
 */
export function settleAt(stake: bigint, boost: bigint, equity: bigint, reference: bigint, cutShare: number, lossFeeShare: number): Settlement {
  if (equity < 0n) equity = 0n;
  const onChart = settle(stake, boost, stake + boost + reference, cutShare, lossFeeShare);
  return { ...onChart, equity, skech: equity - onChart.user, pnl: equity - (stake + boost) };
}
