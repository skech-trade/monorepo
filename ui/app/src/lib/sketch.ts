/**
 * What a round is worth.
 *
 * The shape half of this file, what a drawn line means, moved to
 * `@skech/core` so the trader reads the drawing the same way the page does.
 * What stays here is the money: the quote, the settlement, and the words for
 * how a round went.
 */

import type { Candle } from "./market";
import { FEE as VENUE_FEE, LATENCY_BARS, liquidationPrice, MARGIN, roundSize, tradeable } from "./venue";
import { type Leg, legsFrom, type Pt, priceAt, resample, SAMPLES, type Shape, shapeOf, TURN_GAP, turnTol } from "@skech/core/shape";

/** What a round trip costs, per side. Zero on Lighter Standard. See `venue.ts`. */
export const FEE = VENUE_FEE.taker;

export { LATENCY_BARS, liquidationPrice, legsFrom, priceAt, resample, SAMPLES, shapeOf };
export type { Leg, Pt, Shape };

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
 * Both figures in dollars at the chosen stake. `mostLose` is the stake, which is what isolated
 * margin risks. `ifWorks` walks every leg and is net of fees.
 */
export function quote(
  shape: Shape,
  entry: number,
  stake: number,
  leverage: number,
  exits: Exits = { lose: null, gain: null },
): Quote {
  /* Every leg, not just the furthest point: a zigzag is that many round trips out of the same stake. */
  let equity = stake;
  for (const leg of shape.legs) {
    const open = shape.prices[leg.from];
    const close = shape.prices[leg.to];
    const notional = equity * leverage;
    equity += leg.dir * (notional / open) * (close - open) - FEE * notional * 2;
    if (equity <= 0) break;
  }
  /*
    A stop you have set is the most you can lose, and that is the whole point
    of setting one. The bar said "the most you can lose $100" with a $25 stop
    armed on the row above it, which is the screen disagreeing with its own
    control about the only number that matters.
  */
  const gross = Math.max(-stake, equity - stake);
  return {
    ifWorks: exits.gain !== null ? Math.min(gross, exits.gain) : gross,
    mostLose: exits.lose !== null ? Math.min(stake, exits.lose) : stake,
    wipedAt: liquidationPrice(entry, stake, leverage, shape.long ? 1 : -1),
    notional: stake * leverage,
  };
}

/**
 * The clock, the margin, or a level you set yourself. The drawing's own high and low never close
 * anything.
 */
export type Outcome = "time" | "liquidated" | "stop" | "target";

/**
 * In dollars of the stake, not prices: a sentence a non-trader can check. Null means the clock and
 * the margin are the only ways out.
 */
export type Exits = { lose: number | null; gain: number | null };

export type Book = {
  /** Realised or marked P&L, net of fees. Never below minus the stake. */
  net: number;
  /** Null while the sketch is still playing out. */
  done: Outcome | null;
  /** The price it closed at, or the mark if it has not. */
  exit: number;
};

/**
 * The line traded leg by leg: each turn closes one position and opens the next, sized off the
 * equity at the time and charged its own round trip. Liquidation is checked inside each leg; equity
 * stops at zero.
 */
/** One net position: how much BTC is held, what it averaged, what has been booked. */
type Position = { size: number; avg: number; realised: number };

/**
 * Trade the position to `want`, at `price`.
 *
 * The part that reduces what is open books a profit or a loss; the part that
 * is left re-averages the entry. This is one order on the venue, of the size
 * of the difference, which is why a reversal costs one round trip and not two.
 */
function tradeTo(pos: Position, want: number, price: number): Position {
  const delta = want - pos.size;
  if (delta === 0) return pos;
  let { size, avg, realised } = pos;
  if (size !== 0 && Math.sign(delta) !== Math.sign(size)) {
    const closed = Math.min(Math.abs(delta), Math.abs(size));
    realised += Math.sign(size) * closed * (price - avg);
    size -= Math.sign(size) * closed;
  }
  const opened = want - size;
  if (opened !== 0) {
    avg = size === 0 ? price : (avg * size + price * opened) / (size + opened);
    size += opened;
  }
  if (size === 0) avg = price;
  realised -= FEE * Math.abs(delta) * price;
  return { size, avg, realised };
}

/**
 * The line, traded as one position.
 *
 * Every turn you drew closes what is open and opens the other way, which the
 * venue sees as a single order for the difference. It used to run each leg as
 * a position of its own, with its own liquidation price, sized off compounded
 * equity: a zigzag had four liquidation prices and the bar could only show the
 * first. There is one position, one average entry and one margin now, and the
 * liquidation test is the venue's own: equity has fallen to the maintenance it
 * must hold against the position at the mark.
 *
 * Sizes are rounded down to the venue's step, so the figure here is a figure
 * Lighter would accept. Under its minimum nothing opens at all.
 */
export function settle(
  bars: Candle[],
  shape: Shape,
  entry: number,
  stake: number,
  leverage: number,
  runBars: number,
  exits: Exits = { lose: null, gain: null },
): Book {
  const last = bars.length;
  if (last === 0) return { net: 0, done: null, exit: entry };
  /** The market price when this many candles of the round had arrived. */
  const priceAt = (i: number) => (i <= 0 ? entry : (bars[Math.min(last, i) - 1]?.c ?? entry));
  /**
   * Fills land a latency after the turn, read across the gap between two candles rather than
   * snapped to one.
   */
  const fillAt = (i: number) => {
    const at = i + LATENCY_BARS;
    const whole = Math.floor(at);
    const part = at - whole;
    return priceAt(whole) + (priceAt(whole + 1) - priceAt(whole)) * part;
  };
  /** A sample index on the drawing, to a candle of the round. */
  const barOf = (sample: number) => Math.round((sample / (SAMPLES - 1)) * runBars);

  let pos: Position = { size: 0, avg: entry, realised: 0 };
  let exit = priceAt(last);
  /** Isolated margin: the stake, plus whatever the round has booked so far. */
  const equityAt = (mark: number) => stake + pos.realised + pos.size * (mark - pos.avg);
  /** What the venue must still hold against what is open. */
  const heldAt = (mark: number) => MARGIN.maintenance * Math.abs(pos.size) * mark;

  for (const leg of shape.legs) {
    const from = barOf(leg.from);
    if (from >= last) break;
    const to = barOf(leg.to);
    const open = fillAt(from);
    const want = leg.dir * roundSize((stake * leverage) / open);
    // Under the venue's minimum there is no order to send, so the round sits flat.
    if (tradeable(Math.abs(want), open)) pos = tradeTo(pos, want, open);

    /* Bar by bar: the margin first, then your two levels, tested on the wick. */
    for (let i = from; i < Math.min(to, last); i++) {
      const bar = bars[i];
      const worst = pos.size >= 0 ? bar.l : bar.h;
      const best = pos.size >= 0 ? bar.h : bar.l;
      if (pos.size !== 0 && equityAt(worst) <= heldAt(worst)) return { net: -stake, done: "liquidated", exit: worst };
      if (exits.lose !== null && equityAt(worst) - stake <= -exits.lose) {
        return { net: -exits.lose, done: "stop", exit: priceForPnl(pos, -exits.lose) };
      }
      if (exits.gain !== null && equityAt(best) - stake >= exits.gain) {
        return { net: exits.gain, done: "target", exit: priceForPnl(pos, exits.gain) };
      }
    }

    const close = fillAt(Math.min(to, last));
    exit = close;
    if (equityAt(close) <= 0) return { net: -stake, done: "liquidated", exit: close };
    // Still inside this leg: it is marked, not closed, and nothing follows yet.
    if (to >= last) break;
    // No flattening between legs. The next one trades straight through to the
    // other side, which is the single order the venue would receive.
  }

  const mark = priceAt(last);
  return { net: Math.max(-stake, equityAt(mark) - stake), done: null, exit: pos.size === 0 ? exit : mark };
}

/** The price at which the round would be up or down exactly `pnl`. */
function priceForPnl(pos: Position, pnl: number): number {
  if (pos.size === 0) return pos.avg;
  return pos.avg + (pnl - pos.realised) / pos.size;
}

/**
 * A stroke reduced to the points that shape it: Ramer-Douglas-Peucker with time scaled into price
 * units, then the passes below.
 */
export function simplify(
  pts: Pt[],
  priceSpan: number,
  /** The entry price, to judge a move against the same bar the legs use. */
  tolerance: number,
  /** No cap by default: raising the tolerance to fit a budget turned four peaks into one. */
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
    A pair of handles closer than TURN_GAP is one turn; keep the apex. The first and last points are
    never traded away.
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
    A pair level in price is not a position; keep the one that carries the move further. Sized to
    the drawing, not to fees.
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

  /* Only the turns survive: a bend inside a rise is one long, not two. */
  const turns: Pt[] = [kept[0]];
  for (let i = 1; i < kept.length - 1; i++) {
    const before = Math.sign(kept[i].price - (turns.at(-1) as Pt).price);
    const after = Math.sign(kept[i + 1].price - kept[i].price);
    if (before !== 0 && after !== 0 && before !== after) turns.push(kept[i]);
  }
  if (kept.length > 1) turns.push(kept[kept.length - 1]);
  /* Never fewer than two points, whatever the thresholds did. */
  if (turns.length < 2) return pts.length > 1 ? [pts[0], pts[pts.length - 1]] : pts;
  return turns;
}

/**
 * How far price may stray and still count as inside: one and a half average ranges of the last
 * twenty candles.
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
   * Share of the round's movement that went your way, 0 to 1. Passes a half exactly when the round
   * made money.
   */
  right: number;
  /** One flag per candle, in order: did that minute pay. */
  flags: boolean[];
  /** Mean of line minus close: positive means you drew too high. */
  bias: number;
};

/**
 * Weighted by money, not by minutes: the line's direction at each candle is the position, the
 * candle's move is the market, their product is what that second made. The same test the chart
 * shades with.
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

/** The word for a round. Never "Called it" beside a loss. */
export function verdictWord(outcome: Outcome | "closed", right: number, net: number): string {
  if (outcome === "liquidated") return "Wiped out";
  const word = verdictFor(right);
  return word === "Called it" && net < 0 ? "Close" : word;
}

/**
 * One candle of a random walk pulled toward the line by `follow`, rolled once per sketch: near zero
 * ignores the drawing, negative walks away from it.
 */
export function nextCandle(
  open: number,
  vol: number,
  t: number,
  toward: number | null = null,
  follow = 0,
): Candle {
  /*
    The lean is capped at two bars' move: a negative pull compounds the gap otherwise and the market
    leaves the solar system.
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
 * Straight segments. A position is a straight run from open to close; a spline lied about the trade
 * and softened the corners that decide it.
 */
export function curvePath(pts: { x: number; y: number }[]): string {
  if (pts.length < 3) return legPath(pts);
  const at = (n: number) => n.toFixed(1);
  let d = `M ${at(pts[0].x)} ${at(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    d += ` C ${at(p1.x + (p2.x - p0.x) / 6)} ${at(p1.y + (p2.y - p0.y) / 6)}`;
    d += ` ${at(p2.x - (p3.x - p1.x) / 6)} ${at(p2.y - (p3.y - p1.y) / 6)}`;
    d += ` ${at(p2.x)} ${at(p2.y)}`;
  }
  return d;
}

export function legPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  return pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
}
