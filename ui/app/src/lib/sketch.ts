import type { Candle } from "./market";

export type Pt = { t: number; price: number };

export type Leg = { from: number; to: number; dir: 1 | -1 };

/** Samples of the drawn shape, evenly spaced across the window. */
export const SAMPLES = 32;

/** A move smaller than this fraction of entry is not a level worth marking. */
const TOL = 0.0002;
/**
 * A reversal smaller than this share of the drawing's own height is a wobble.
 *
 * Of the drawing's height, not of the price. As a fraction of the price it came
 * to $141 on a $64,000 Bitcoin — fine while a candle moved a hundred dollars,
 * and fatal the moment one moves six: every reversal a hand could draw would be
 * under the threshold, so every line would collapse to a single leg and the
 * whole product with it. A drawing's own height is the only scale that is
 * always the right one, whatever the market is doing.
 */
const REVERSAL = 0.08;
/**
 * Two vertices closer than this share of the round are one turn.
 *
 * The same idea as `TOL` along the other axis: there it is a move too small to
 * be a reversal, here it is a gap too short to be a leg. A stretch three
 * hundredths of the round long is under a minute on a half-hour sketch — not
 * something anyone drew on purpose, and nothing a position can be opened in.
 */
const TURN_GAP = 0.03;
/** Under this total travel the drawing says nothing worth trading. */
const FLAT = 0.0002;

/**
 * What a venue charges, per side, as a fraction of the position's value.
 *
 * Read off the two we would plausibly route to, base tier, no staking and no
 * referral, in September 2026:
 *
 *   Hyperliquid  perps tier 0: 0.045% taker, 0.015% maker. Seven volume tiers
 *                down to 0.024% / 0.000% above $7B of 14-day volume, plus a
 *                5-40% staking discount and a referral discount on the first
 *                $25M.  hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
 *   Lighter      standard accounts: zero maker, zero taker, all markets. Only
 *                its Premium tier for HFT pays anything, and that is 0.0040% /
 *                0.0280%.  docs.lighter.xyz/trading/trading-fees
 *
 * A drawn line has to be in the market at a particular minute, so it crosses
 * the spread: the taker rate is the one that applies, and it is charged on the
 * way in and again on the way out of every leg.
 *
 * Hyperliquid's taker is the default because it is the expensive answer of the
 * two, and a simulation that flatters the reader about costs is the one kind
 * of lie this screen cannot afford. On Lighter standard this is simply zero,
 * and every fee argument on this screen goes away with it.
 */
export const VENUES = {
  hyperliquid: { taker: 0.00045, maker: 0.00015 },
  lighter: { taker: 0, maker: 0 },
  lighterPremium: { taker: 0.00028, maker: 0.00004 },
} as const;

/**
 * The venue the figures on screen are quoted at.
 *
 * Lighter, whose standard accounts pay nothing either side. Which is the whole
 * argument for routing there: at 50x a Hyperliquid round trip is 4.5% of a
 * $100 stake and a leg has to travel $57.60 to break even, on a market that
 * moves $6.40 a candle. Every turn was a losing trade before it was drawn.
 */
export const VENUE: keyof typeof VENUES = "lighter";

/** Taker fee per side. Charged twice a leg: once in, once out. */
export const FEE = VENUES[VENUE].taker;
/** The venue closes a leg when equity falls to this fraction of notional. */
const MAINT = 0.0125;

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
 * Rising stretches are longs, falling stretches are shorts, a turn is a close
 * and an open. `TOL` keeps a shaky hand from buying and selling twenty times.
 */
/**
 * How far price must come back for a turn to be a turn.
 *
 * Two thresholds, and a turn has to clear both.
 *
 * The first is a share of the drawing's own height, so a wobble stays a wobble
 * whatever the market is worth.
 *
 * The second is what the turn costs. Taking one means closing here and opening
 * the other way, and that round trip is `2 × FEE` of the position's value — so
 * the counter-move has to travel `2 × FEE × price` just to get back to level.
 * At $64,000 that is $57.60, and it is the same figure at every leverage,
 * because the fee and the profit scale together.
 *
 * Under it, a dip is not a trade. It is something you sit through, and a model
 * that trades it anyway hands back a loss on a drawing that called the move:
 * the same $200 climb makes $11.13 taken as one leg and loses $10.85 taken as
 * six, and a typical four-candle leg moves $26 against a $57.60 bar. Every one
 * of those turns was a guaranteed loser at the moment it was drawn.
 */
function turnTol(values: number[], ref: number, costs = false): number {
  let lo = values[0];
  let hi = values[0];
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  /*
    The cost floor belongs to the legs and nowhere else.

    Applied to the drawing as well it deleted the drawing. `simplify` drops a
    point that has not moved far enough from the last one it kept, and with the
    floor in place "far enough" was $57.60 — more than most lines are tall on a
    market that moves $6.40 a candle. Every point failed the test, the line
    came back as a single point, `shapeOf` refused it, and the screen lost its
    line, its ticket and its whole bottom bar.

    What you drew and what gets traded are two different questions. The shape
    on screen is yours; which of its turns are worth a round trip is the
    compiler's, and only that second question has a price attached.
  */
  const floor = costs ? ref * FEE * 2 : ref * 1e-5;
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

export type Quote = {
  /** What you make if price reaches where you're aiming. */
  ifWorks: number;
  /** The most you can lose. Capped at the stake: nothing here goes negative. */
  mostLose: number;
  /** Where the venue would close the first leg on its own. */
  wipedAt: number;
  notional: number;
};

/**
 * The two dollar figures, and the price behind the second.
 *
 * Every number is in dollars at the stake the reader chose, never a multiple
 * or a percentage. `mostLose` is the stake, because the stake is what isolated
 * margin puts at risk — it used to be the loss at the low point of the drawing,
 * which was only ever true if the venue closed you there, and it does not.
 *
 * `ifWorks` is net of both fees. At fifty times a hundred dollars they come to
 * four fifty, which is most of what a short round makes; quoting the gross
 * would be quoting a number nobody receives.
 */
export function quote(
  shape: Shape,
  entry: number,
  stake: number,
  leverage: number,
): Quote {
  /*
    What the plan pays if the market traces it exactly — every leg of it.

    It used to be the move to the single furthest point, which ignored every
    turn in between and so priced a zigzag the same as a straight line to the
    same height. Walking the legs prices what is actually traded, fees and all,
    and that is the number that makes a zigzag look like what it is: eight
    turns is eight round trips out of the same stake.
  */
  let equity = stake;
  for (const leg of shape.legs) {
    const open = shape.prices[leg.from];
    const close = shape.prices[leg.to];
    const notional = equity * leverage;
    equity += leg.dir * (notional / open) * (close - open) - FEE * notional * 2;
    if (equity <= 0) return { ifWorks: -stake, mostLose: stake, wipedAt: liquidationPrice(entry, stake, leverage, shape.long ? 1 : -1), notional: stake * leverage };
  }
  return {
    ifWorks: equity - stake,
    mostLose: stake,
    wipedAt: liquidationPrice(entry, stake, leverage, shape.long ? 1 : -1),
    notional: stake * leverage,
  };
}

/**
 * How a position ended. Two ways, and neither is a level you did not set.
 *
 * It used to close at `target` — the high point of your own drawing — and at
 * `floor`, its low. Nobody placed those orders. A drawn line is a forecast, not
 * a bracket, and taking someone out at the top of their own sketch books a
 * profit they never asked to take and calls it their exit. The only things that
 * end a position here are the clock and the margin.
 */
export type Outcome = "time" | "liquidated";

export type Book = {
  /** Realised or marked P&L, net of fees. Never below minus the stake. */
  net: number;
  /** Null while the sketch is still playing out. */
  done: Outcome | null;
  /** The price it closed at, or the mark if it has not. */
  exit: number;
};

/**
 * Run the line against the candles that actually arrived.
 *
 * One position, facing the way the line ends up, from entry to whichever the
 * price touches first: where you're aiming, or where you're out. That is the
 * rule the sheet quotes and the rule the landing's FAQ states, so the number
 * you were shown is the number you get. Tested on the wick, not the close: a
 * level you traded through is a level you were closed at. The adverse level
 * is checked first, which is the honest tie-break.
 *
 * Recomputed from scratch on every tick so there is one place money is
 * decided. Fees come off both fills.
 */
/**
 * Where isolated margin gives out, as a venue works it out.
 *
 * Equity is the stake, less the fee taken on the way in, plus what the position
 * has made; the venue closes you when that falls to the maintenance margin it
 * holds against the position's value at the mark. Solving the two for price:
 *
 *   long   P = (q·entry − stake + fee) / (q · (1 − mmr))
 *   short  P = (q·entry + stake − fee) / (q · (1 + mmr))
 *
 * The old line was `entry * (1 − dir * (1/leverage − MAINT))`, which lands
 * within a few dollars at fifty times and drifts at low leverage, because it
 * treats maintenance as a flat haircut on entry rather than a claim against
 * the mark. Close enough to look right, which is the worst kind of wrong in a
 * number that decides whether someone loses everything.
 */
export function liquidationPrice(entry: number, stake: number, leverage: number, dir: 1 | -1): number {
  const q = (stake * leverage) / entry;
  const room = stake - FEE * stake * leverage;
  return dir > 0 ? (q * entry - room) / (q * (1 - MAINT)) : (q * entry + room) / (q * (1 + MAINT));
}

/**
 * The line, traded leg by leg.
 *
 * Every turn you drew is a close and an open — that is what the chart has been
 * claiming all along, with a Buy at each trough and a Sell at each peak. The
 * money did not do it. It read the last point, decided the whole round was one
 * long or one short, and held that from the first candle to the last, so a
 * drawing that went up hard and then down hard was booked as a single bet in
 * whichever direction happened to end higher. Every turn in between was
 * decoration.
 *
 * Now each leg is its own position: in at the market price where the leg
 * starts, out at the market price where it ends, sized off the equity standing
 * at the time, and charged a round trip of its own. Which means a zigzag costs
 * what a zigzag costs — eight turns is eight round trips, and at fifty times
 * that is real money — and the chart and the ledger finally describe the same
 * trade.
 *
 * Liquidation is checked inside each leg against that leg's own entry. Equity
 * is carried across them and the whole thing stops at zero, because isolated
 * margin cannot go below the stake.
 */
export function settle(
  bars: Candle[],
  shape: Shape,
  entry: number,
  stake: number,
  leverage: number,
  runBars: number,
): Book {
  const last = bars.length;
  if (last === 0) return { net: 0, done: null, exit: entry };
  /** The market price when this many candles of the round had arrived. */
  const priceAt = (i: number) => (i <= 0 ? entry : (bars[Math.min(last, i) - 1]?.c ?? entry));
  /** A sample index on the drawing, to a candle of the round. */
  const barOf = (sample: number) => Math.round((sample / (SAMPLES - 1)) * runBars);

  let equity = stake;
  let exit = priceAt(last);

  for (const leg of shape.legs) {
    const from = barOf(leg.from);
    if (from >= last) break;
    const to = barOf(leg.to);
    const open = priceAt(from);
    const notional = equity * leverage;
    const q = notional / open;
    const liq = liquidationPrice(open, equity, leverage, leg.dir);

    for (let i = from; i < Math.min(to, last); i++) {
      const bar = bars[i];
      const worst = leg.dir > 0 ? bar.l : bar.h;
      if (leg.dir * (worst - liq) <= 0) return { net: -stake, done: "liquidated", exit: liq };
    }

    const close = priceAt(Math.min(to, last));
    equity += leg.dir * q * (close - open) - FEE * notional * 2;
    exit = close;
    if (equity <= 0) return { net: -stake, done: "liquidated", exit: close };
    // Still inside this leg: it is marked, not closed, and nothing follows yet.
    if (to >= last) break;
  }

  return { net: Math.max(-stake, equity - stake), done: null, exit };
}

/**
 * A hand-drawn stroke reduced to the few points that shape it, so a pen line
 * becomes a point line and can be edited the same way. Ramer-Douglas-Peucker
 * with time scaled into price units; the tolerance grows until the line fits
 * the budget.
 */
export function simplify(
  pts: Pt[],
  priceSpan: number,
  /** The entry price, to judge a move against the same bar the legs use. */
  tolerance: number,
  /**
   * No cap, by default.
   *
   * There was one at eight, and it did not thin the line — it destroyed it. The
   * tolerance is raised until the result fits, so a zigzag of four peaks, which
   * needs nine points, had its tolerance inflated by half again and again until
   * only one peak was left. You drew four and got one. The base tolerance alone
   * takes the tremor out of a hand; how many turns are left after that is the
   * drawing's business, not a budget's.
   */
  maxPoints = Number.POSITIVE_INFINITY,
): Pt[] {
  if (pts.length <= 2) return pts;
  const scale = priceSpan; // one unit of t is worth the whole visible price range
  const dist = (p: Pt, a: Pt, b: Pt) => {
    const ax = a.t * scale;
    const bx = b.t * scale;
    const px = p.t * scale;
    const dx = bx - ax;
    const dy = b.price - a.price;
    const len = Math.hypot(dx, dy) || 1;
    return Math.abs(dy * px - dx * p.price + bx * a.price - b.price * ax) / len;
  };
  const rdp = (list: Pt[], eps: number): Pt[] => {
    if (list.length <= 2) return list;
    let worst = 0;
    let at = 0;
    for (let i = 1; i < list.length - 1; i++) {
      const d = dist(list[i], list[0], list[list.length - 1]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst <= eps) return [list[0], list[list.length - 1]];
    return [...rdp(list.slice(0, at + 1), eps).slice(0, -1), ...rdp(list.slice(at), eps)];
  };
  let eps = priceSpan * 0.01;
  let out = rdp(pts, eps);
  while (out.length > maxPoints && eps < priceSpan) {
    eps *= 1.5;
    out = rdp(pts, eps);
  }

  /*
    One turn, not two.

    Simplification can keep both samples that straddle the top of a peak — they
    are each a long way off the chord, so each looks worth keeping — and the
    result is a pair of handles a few pixels apart at the apex. That is not a
    detail, it is a leg of no length: the stretch between them rises or falls by
    nothing, so it opens no position and buys the reader nothing but a second
    handle to catch with the mouse.

    Where a pair is too close to be two turns, the apex is kept: whichever of
    the two carries the move further in the direction it was already going. The
    first point is the entry and the last is where the line was left, so neither
    is ever traded away for a peak.
  */
  const thinned: Pt[] = [];
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    const last = thinned.at(-1);
    if (!last || p.t - last.t >= TURN_GAP) {
      thinned.push(p);
      continue;
    }
    if (thinned.length === 1) continue;
    if (i === out.length - 1) {
      thinned[thinned.length - 1] = p;
      continue;
    }
    const prev = thinned.at(-2) as Pt;
    const rising = last.price >= prev.price;
    const apex = rising ? p.price > last.price : p.price < last.price;
    if (apex) thinned[thinned.length - 1] = p;
  }

  /*
    No flat segments.

    A stretch that ends at the price it started is not a position. It cannot be
    a long and it cannot be a short, so drawing one puts a piece of line on the
    chart that stands for nothing — and the place it shows up worst is the cap
    on a peak: two handles level with each other, a little plateau where the
    picture should come to a point and the trade turns around.

    So a pair closer in price than a leg needs is one point. Which of the two
    survives is whichever carries the move further the way it was already
    going — the apex, the actual turn. The first point is the entry and the last
    is where the line was left, so neither is traded away for one.

    Sized to the drawing, not to what a trade costs. The legs answer a second
    question — which of these turns is worth a round trip — and that one has a
    price attached; this one does not.
  */
  const grip = turnTol(pts.map((p) => p.price), tolerance);
  const kept: Pt[] = [];
  for (let i = 0; i < thinned.length; i++) {
    const p = thinned[i];
    const last = kept.at(-1);
    if (!last || Math.abs(p.price - last.price) >= grip) {
      kept.push(p);
      continue;
    }
    // The entry is where you get in. It does not move for a flat.
    if (kept.length === 1) continue;
    // The end is where you stopped drawing, so it wins the pair.
    if (i === thinned.length - 1) {
      kept[kept.length - 1] = p;
      continue;
    }
    // Otherwise keep whichever of the two carries the move further the way it
    // was already going: the pair is one turn and this is its apex.
    const prev = kept.at(-2) as Pt;
    const rising = last.price >= prev.price;
    if (rising ? p.price > last.price : p.price < last.price) {
      kept[kept.length - 1] = p;
    }
  }

  /*
    Only the turns.

    Two rising segments in a row are one long. The handle between them is not a
    close and not an open — it is a bend in the middle of a leg, and the line
    trades exactly the same without it. Leaving it there says there are two
    positions where there is one, which is the thing this whole screen is for
    getting right.

    So a point survives only if the line arrives going one way and leaves going
    the other. What is left is a zigzag, alternating, one leg per segment: the
    picture and the trade are finally the same object.
  */
  const turns: Pt[] = [kept[0]];
  for (let i = 1; i < kept.length - 1; i++) {
    const before = Math.sign(kept[i].price - (turns.at(-1) as Pt).price);
    const after = Math.sign(kept[i + 1].price - kept[i].price);
    if (before !== 0 && after !== 0 && before !== after) turns.push(kept[i]);
  }
  if (kept.length > 1) turns.push(kept[kept.length - 1]);
  /*
    A line is at least two points.

    Every pass here removes points, and a threshold set too high can take all
    of them: one of these passes once reduced an entire drawing to a single
    point, which `shapeOf` rejects, which left the screen with no line, no
    ticket and no bottom bar and no way to tell why. Whatever the thresholds
    decide, the first point and the last one are what the hand did, and there
    is always a line between them.
  */
  if (turns.length < 2) return pts.length > 1 ? [pts[0], pts[pts.length - 1]] : pts;
  return turns;
}

/**
 * The ribbon: how far from your line the price may stray and still count as
 * "inside". Sized from the market's own recent candles, about one and a half
 * average ranges, so a quiet market gets a tight ribbon and a wild one gets
 * room. The money is decided by the levels; the ribbon is the score.
 */
export function ribbonFor(recent: Candle[]): number {
  const bars = recent.slice(-20);
  if (bars.length === 0) return 0;
  const avg = bars.reduce((sum, c) => sum + (c.h - c.l), 0) / bars.length;
  return avg * 1.5;
}

/** The line's price at a fraction of the window, read off the samples. */
export function lineAt(prices: number[], u: number): number {
  const x = Math.min(1, Math.max(0, u)) * (prices.length - 1);
  const i = Math.min(prices.length - 2, Math.floor(x));
  return prices[i] + (prices[i + 1] - prices[i]) * (x - i);
}

export type Accuracy = {
  /**
   * Share of the round's movement that went your way, 0 to 1. Above a half
   * exactly when the round made money — that is the point of weighting it.
   */
  right: number;
  /** One flag per candle, in order: did that minute pay. */
  flags: boolean[];
  /** Mean of line minus close: positive means you drew too high. */
  bias: number;
};

/**
 * How much of the round went your way — weighted by money, not by minutes.
 *
 * The direction the line is going at that moment is the position you are in,
 * the candle's own move is what the market did, and the two multiplied is what
 * that minute made. Sum what it made for you, sum what it took, and the share
 * is the first over the total. That is the same test the chart shades with, so
 * the figure in the copy and the colours under the line cannot disagree.
 *
 * Weighted, because a count of candles is a vote per minute and money is not
 * democratic: forty-six percent of minutes can pay while the round profits,
 * since the ones that paid were the big ones. True, and it reads as nonsense
 * printed beside a gain. Weighted by what each minute moved, the figure passes
 * a half exactly when the round makes money, so the two can never contradict.
 *
 * Its direction comes from the way the line is going at that moment, which is
 * the position `settle` actually holds there now that the line is traded leg by
 * leg. The chart's shading, the buy and sell marks, the money and this figure
 * all read the same trade at last; for a while the money held one position for
 * the whole round and this had to follow it to avoid printing a contradiction.
 *
 * It scored distance before this: the share of closes landing inside the
 * ribbon. A line can sit inside its ribbon the whole way and lose money the
 * whole way, and a round that made twenty-five percent scored twenty-four.
 */
export function accuracyOf(bars: Candle[], prices: number[], runBars: number): Accuracy {
  if (bars.length === 0) return { right: 0, flags: [], bias: 0 };
  let sum = 0;
  let forYou = 0;
  let against = 0;
  const flags = bars.map((bar, i) => {
    const was = lineAt(prices, i / runBars);
    const goes = lineAt(prices, (i + 1) / runBars);
    sum += goes - bar.c;
    const made = (goes >= was ? 1 : -1) * (bar.c - bar.o);
    if (made >= 0) forYou += made;
    else against -= made;
    return made >= 0;
  });
  const moved = forYou + against;
  return { right: moved > 0 ? forYou / moved : 0, flags, bias: sum / bars.length };
}

/** Three words, by how much of the move went your way. Half is break-even. */
export function verdictFor(right: number): "Called it" | "Close" | "Off" {
  if (right >= 0.7) return "Called it";
  if (right >= 0.5) return "Close";
  return "Off";
}

/**
 * The word for a round. Hitting where you aimed is a call whatever the path.
 * Otherwise how much of the move you called decides, and since that figure
 * only passes a half when the round made money, the word can no longer argue
 * with the figure printed beside it.
 */
export function verdictWord(outcome: Outcome | "closed", right: number, net: number): string {
  if (outcome === "liquidated") return "Wiped out";
  const word = verdictFor(right);
  return word === "Called it" && net < 0 ? "Close" : word;
}

/**
 * One candle of a random walk, pulled toward the drawn line by `follow`.
 *
 * `follow` is rolled once per sketch and held: near zero the market ignores
 * the drawing, high and it tracks it, negative and it walks off the other way.
 * Rolling it per candle averages out to indifference.
 */
export function nextCandle(
  open: number,
  vol: number,
  t: number,
  toward: number | null = null,
  follow = 0,
): Candle {
  /*
    The lean toward the line, bounded by what a bar can actually move.

    `follow` is rolled negative about a fifth of the time, and a negative
    proportional pull is not a market walking away — it is compound interest on
    the gap. Each bar multiplied the distance from the line by 1 + |follow|, so
    over twenty-four bars a twelve percent lean became sixteen times the gap and
    over ninety-six it became fifty thousand times: a market that leaves the
    solar system rather than one that disagrees with you.

    Capped at a couple of bars' worth of move, it is a drift either way. The cap
    almost never binds on a positive follow, where the gap closes and the pull
    shrinks with it; it binds constantly on a negative one, which is exactly
    where it is needed.
  */
  const lean = toward === null ? 0 : (toward - open) * follow;
  const most = open * vol * 2;
  const pull = Math.min(most, Math.max(-most, lean));
  const close = open + pull + open * vol * (Math.random() - 0.5) * 2;
  const wick = open * vol * (0.3 + Math.random() * 0.8);
  return {
    t,
    o: open,
    c: close,
    h: Math.max(open, close) + Math.random() * wick,
    l: Math.min(open, close) - Math.random() * wick,
    v: 0.5 + Math.random(),
  };
}

/** Extend the candle still forming, so the right edge is never static. */
export function extend(c: Candle, vol: number): Candle {
  const close = c.c * (1 + (Math.random() - 0.5) * vol * 0.55);
  return { ...c, c: close, h: Math.max(c.h, close), l: Math.min(c.l, close) };
}

/**
 * The plotted points, joined straight.
 *
 * It was a Catmull-Rom spline, which reads as a hand and lies about the trade.
 * A position is a straight run from where it opens to where it closes; there is
 * no curve to be in. Drawing one put the line somewhere other than where it
 * would be traded — bulging past a turn it never reaches, easing out of one it
 * leaves at once — and softened every corner, which is the one part of the
 * picture that decides anything: a corner is a close and an open.
 *
 * Straight segments also say what the handles are for. Two of them and the bit
 * between is a leg; that is the whole grammar.
 */
export function legPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  return pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
}
