/**
 * What a drawn line means.
 *
 * Points in, legs out: where the line turns is where the position flips, and
 * everything downstream, the quote on the page and the orders on the venue,
 * is read off the same legs. Shared rather than copied, because two versions
 * of "what did they draw" is how a client comes to be trusted about it.
 */

import { FEE as VENUE_FEE } from "./venue";

/** What a round trip costs, per side. Zero on Lighter Standard. See `venue.ts`. */
const FEE = VENUE_FEE.taker;

export type Pt = { t: number; price: number };

export type Leg = { from: number; to: number; dir: 1 | -1 };

/** Samples of the drawn shape, evenly spaced across the window. */
export const SAMPLES = 32;

/** A move smaller than this fraction of entry is not a level worth marking. */
const TOL = 0.0002;
/**
 * A reversal under this share of the drawing's own height is a wobble. Of the height, not the
 * price: as a share of price it came to $141 on Bitcoin and every hand-drawn turn fell under it.
 */
const REVERSAL = 0.08;
/**
 * Two vertices closer than this share of the round are one turn: under a second on a minute round,
 * nothing a position can open in.
 */
export const TURN_GAP = 0.03;
/** Under this total travel the drawing says nothing worth trading. */
const FLAT = 0.0002;


/** Price of the drawn line at a moment, flat past either end. */
export function priceAt(pts: Pt[], t: number, entry: number): number {
  if (pts.length === 0) return entry;
  if (t <= pts[0].t) return pts[0].price;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (t <= b.t) {
      const k = (t - a.t) / (b.t - a.t || 1);
      return a.price + (b.price - a.price) * k;
    }
  }
  return pts[pts.length - 1].price;
}

/** The line as SAMPLES prices, first one pinned to the entry. */
export function resample(pts: Pt[], entry: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    out.push(priceAt(pts, i / (SAMPLES - 1), entry));
  }
  out[0] = entry;
  return out;
}

/**
 * How far price must come back for a turn to count: REVERSAL of the drawing's height, or with
 * `costs` the fee round trip (2 × FEE × price, $57.60 at $64k), whichever is more. Under the cost
 * floor a dip is a guaranteed loser.
 */
export function turnTol(values: number[], ref: number, costs = false): number {
  let lo = values[0];
  let hi = values[0];
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  /*
    Only the legs pay the cost floor. Applied to the drawing itself it deleted every point on a
    quiet market.

    The floor can never be zero. It used to be the fee round trip, and Lighter
    charges nothing, so it was: every sample of a flat line cleared a tolerance
    of zero and became a turn, and a flat line came back as thirty-one legs. On
    screen that was hidden, because a flat shape is rejected before its legs are
    read. On the venue it is thirty-one reversals of a real position, so a
    nearly-flat line drawn by a shaky hand would have traded itself to death.

    It was two basis points, sixteen dollars on Bitcoin, which is more than
    Bitcoin usually moves in the minute a round lasts. Every turn somebody drew
    on a quiet chart fell under it, so a line drawn long–short–long–short
    traded as one long: the page showed the zigzag and the venue got one
    order. The wobble filter is the share of the drawing's own height above,
    which scales with however the line was drawn, and a hand-drawn stroke is
    already simplified to its intended corners on release. What is left here
    is a floor against a numerically flat line: a tenth of a basis point.
  */
  const floor = Math.max(costs ? ref * FEE * 2 : 0, ref * 1e-5);
  return Math.max((hi - lo) * REVERSAL, floor);
}

export function legsFrom(prices: number[]): Leg[] {
  const tol = turnTol(prices, prices[0], true);
  const legs: Leg[] = [];
  let start = 0;
  let extIdx = 0;
  let dir: 0 | 1 | -1 = 0;

  for (let i = 1; i < prices.length; i++) {
    const p = prices[i];
    if (dir === 0) {
      if (Math.abs(p - prices[start]) >= tol) {
        dir = p > prices[start] ? 1 : -1;
        extIdx = i;
      }
      continue;
    }
    if ((p - prices[extIdx]) * dir > 0) {
      extIdx = i;
      continue;
    }
    if (Math.abs(p - prices[extIdx]) >= tol) {
      legs.push({ from: start, to: extIdx, dir });
      start = extIdx;
      dir = p > prices[extIdx] ? 1 : -1;
      extIdx = i;
    }
  }
  if (dir !== 0 && extIdx > start) {
    legs.push({ from: start, to: prices.length - 1, dir });
  }
  return legs;
}

export type Shape = {
  prices: number[];
  legs: Leg[];
  /** Total distance the drawing asks price to cover, as a fraction of entry. */
  travel: number;
  flat: boolean;
  /** Which way the trade faces: where the line ends up, not its biggest swing. */
  long: boolean;
  /** Where you're aiming: the furthest the line gets on its own side. */
  target: number;
  /** Where you're out: the furthest it strays the other way. Null if never. */
  floor: number | null;
};

export function shapeOf(pts: Pt[], entry: number): Shape | null {
  if (pts.length < 2) return null;
  const prices = resample(pts, entry);
  const legs = legsFrom(prices);
  let travel = 0;
  for (const l of legs) travel += Math.abs(prices[l.to] - prices[l.from]);

  let hi = entry;
  let lo = entry;
  for (const p of prices.slice(1)) {
    if (p > hi) hi = p;
    if (p < lo) lo = p;
  }
  const long = prices[prices.length - 1] >= entry;
  const target = long ? hi : lo;
  const other = long ? lo : hi;
  // A line that never dips sets no floor, so the whole stake is on the table.
  const floor = Math.abs(other - entry) < entry * TOL ? null : other;

  return {
    prices,
    legs,
    travel: travel / entry,
    flat: legs.length === 0 || travel / entry < FLAT,
    long,
    target,
    floor,
  };
}

/** Scheduled position at a candle, using the same rounded boundaries as settlement. */
export function directionAt(legs: Leg[], candle: number, runBars: number): 1 | -1 | 0 {
  let direction: 1 | -1 | 0 = 0;
  for (const leg of legs) {
    if (Math.round((leg.from / (SAMPLES - 1)) * runBars) > candle) break;
    direction = leg.dir;
  }
  return direction;
}
