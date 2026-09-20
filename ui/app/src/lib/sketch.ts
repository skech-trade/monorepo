import type { Candle } from "./market";
import { FEE as VENUE_FEE, LATENCY_BARS, liquidationPrice } from "./venue";

/** What a round trip costs, per side. Zero on Lighter Standard. See `venue.ts`. */
export const FEE = VENUE_FEE.taker;

export { LATENCY_BARS, liquidationPrice };

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
const TURN_GAP = 0.03;
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
function turnTol(values: number[], ref: number, costs = false): number {
  let lo = values[0];
  let hi = values[0];
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  /*
    Only the legs pay the cost floor. Applied to the drawing itself it deleted every point on a
    quiet market.
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

  let equity = stake;
  let exit = priceAt(last);

  for (const leg of shape.legs) {
    const from = barOf(leg.from);
    if (from >= last) break;
    const to = barOf(leg.to);
    const open = fillAt(from);
    const notional = equity * leverage;
    const q = notional / open;
    const liq = liquidationPrice(open, equity, leverage, leg.dir);

    /* Bar by bar: the margin first, then your two levels, tested on the wick. */
    const banked = equity - stake;
    for (let i = from; i < Math.min(to, last); i++) {
      const bar = bars[i];
      const worst = leg.dir > 0 ? bar.l : bar.h;
      const best = leg.dir > 0 ? bar.h : bar.l;
      if (leg.dir * (worst - liq) <= 0) return { net: -stake, done: "liquidated", exit: liq };
      if (exits.lose !== null && banked + leg.dir * q * (worst - open) <= -exits.lose) {
        return { net: -exits.lose, done: "stop", exit: open + (leg.dir * (-exits.lose - banked)) / q };
      }
      if (exits.gain !== null && banked + leg.dir * q * (best - open) >= exits.gain) {
        return { net: exits.gain, done: "target", exit: open + (leg.dir * (exits.gain - banked)) / q };
      }
    }

    const close = fillAt(Math.min(to, last));
    equity += leg.dir * q * (close - open) - FEE * notional * 2;
    exit = close;
    if (equity <= 0) return { net: -stake, done: "liquidated", exit: close };
    // Still inside this leg: it is marked, not closed, and nothing follows yet.
    if (to >= last) break;
  }

  return { net: Math.max(-stake, equity - stake), done: null, exit };
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
