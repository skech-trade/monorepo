import type { Candle } from "./market";

export type Pt = { t: number; price: number };

export type Leg = { from: number; to: number; dir: 1 | -1 };

/** Samples of the drawn shape, evenly spaced across the window. */
export const SAMPLES = 32;

/** A reversal smaller than this fraction of entry is a wobble, not a turn. */
const TOL = 0.0022;
/** Under this total travel the drawing says nothing worth trading. */
const FLAT = 0.004;

/** Taker fee per side, as on the landing. */
export const FEE = 0.00045;
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
export function legsFrom(prices: number[]): Leg[] {
  const tol = prices[0] * TOL;
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
 * or a percentage. `mostLose` is the loss at the floor they drew, or the whole
 * stake if the line never dips below where they got in.
 */
export function quote(
  shape: Shape,
  entry: number,
  stake: number,
  leverage: number,
): Quote {
  const notional = stake * leverage;
  const move = (p: number) => Math.abs(p - entry) / entry;
  const ifWorks = notional * move(shape.target);
  const atFloor = shape.floor === null ? stake : notional * move(shape.floor);
  const dir = shape.long ? 1 : -1;
  return {
    ifWorks,
    mostLose: Math.min(stake, atFloor),
    wipedAt: entry * (1 - dir * (1 / leverage - MAINT)),
    notional,
  };
}

export type Outcome = "target" | "floor" | "time" | "liquidated";

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
export function settle(
  bars: Candle[],
  shape: Shape,
  entry: number,
  stake: number,
  leverage: number,
): Book {
  const dir = shape.long ? 1 : -1;
  const notional = stake * leverage;
  const q = notional / entry;
  const fees = FEE * notional * 2;
  // Losses stop at the stake, whatever the level rule says.
  const cap = (n: number) => Math.max(-stake, n);
  const pnlAt = (px: number) => cap(dir * q * (px - entry) - fees);
  // Where the venue would close it on its own, if the line never dips.
  const liq = entry * (1 - dir * (1 / leverage - MAINT));

  for (const bar of bars) {
    const worst = dir > 0 ? bar.l : bar.h;
    const best = dir > 0 ? bar.h : bar.l;
    if (dir * (worst - liq) <= 0) {
      return { net: -stake, done: "liquidated", exit: liq };
    }
    if (shape.floor !== null && dir * (worst - shape.floor) <= 0) {
      return { net: pnlAt(shape.floor), done: "floor", exit: shape.floor };
    }
    if (dir * (best - shape.target) >= 0) {
      return { net: pnlAt(shape.target), done: "target", exit: shape.target };
    }
  }

  const mark = bars.at(-1)?.c ?? entry;
  return { net: pnlAt(mark), done: null, exit: mark };
}

/**
 * A hand-drawn stroke reduced to the few points that shape it, so a pen line
 * becomes a point line and can be edited the same way. Ramer-Douglas-Peucker
 * with time scaled into price units; the tolerance grows until the line fits
 * the budget.
 */
export function simplify(pts: Pt[], priceSpan: number, maxPoints = 8): Pt[] {
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
  return out;
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
  /** Share of arrived candles that closed inside the ribbon, 0 to 1. */
  inside: number;
  /** One flag per candle, in order. */
  flags: boolean[];
  /** Mean of line minus close: positive means you drew too high. */
  bias: number;
};

export function accuracyOf(bars: Candle[], prices: number[], width: number, runBars: number): Accuracy {
  if (bars.length === 0) return { inside: 0, flags: [], bias: 0 };
  let sum = 0;
  const flags = bars.map((bar, i) => {
    const want = lineAt(prices, (i + 1) / runBars);
    sum += want - bar.c;
    return Math.abs(bar.c - want) <= width;
  });
  return { inside: flags.filter(Boolean).length / flags.length, flags, bias: sum / bars.length };
}

/** Three words, by how much of the way the price stayed inside. */
export function verdictFor(inside: number): "Called it" | "Close" | "Off" {
  if (inside >= 0.8) return "Called it";
  if (inside >= 0.55) return "Close";
  return "Off";
}

/**
 * The word for a round. Hitting where you aimed is a call whatever the path.
 * Otherwise the ribbon decides, but a round that lost money is never "Called
 * it": the path was right and the ending was not, and the word should not
 * argue with the figure beside it.
 */
export function verdictWord(outcome: Outcome | "closed", inside: number, net: number): string {
  if (outcome === "liquidated") return "Wiped out";
  if (outcome === "target") return "Called it";
  const word = verdictFor(inside);
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
  const pull = toward === null ? 0 : (toward - open) * follow;
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

/** Catmull-Rom through plotted points, as one cubic path. Reads as a hand. */
export function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    d +=
      ` C ${(p1.x + (p2.x - p0.x) / 6).toFixed(1)} ${(p1.y + (p2.y - p0.y) / 6).toFixed(1)}` +
      ` ${(p2.x - (p3.x - p1.x) / 6).toFixed(1)} ${(p2.y - (p3.y - p1.y) / 6).toFixed(1)}` +
      ` ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}
