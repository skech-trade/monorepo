/**
 * skech: draw ahead of the Bitcoin price. The ink the price runs through pays.
 *
 * A drawing is a pen stroke: a path in time and price, and a pen with a
 * width. The ink is the bet, exactly as drawn, and only the ink the price
 * touches pays. To make that exact on data that comes a second at a time,
 * the ink is measured on a fine grid, one second wide and half a price step
 * tall, and each cell of it is a bet of its own:
 *
 *   - it costs its area: the share of the cell the ink covers, in units of
 *     one price step for one second, times what a unit costs;
 *   - it is hit if that second's trades reach the cell's prices;
 *   - it pays its cost times `rtp / chance`, where the chance is measured on
 *     thousands of real stretches of Bitcoin from moments like this one, as
 *     in `dots.ts`.
 *
 * So thicker and longer ink costs more; ink near the price is likely and
 * pays a little; ink far from it, in price or in time, pays a lot; and a
 * stroke the price crosses pays for the part it crossed, not all of it.
 * Ink too unlikely to measure is not in play: it costs nothing.
 */

import { type Bar, type Features, features, type Library, LIB_SCALE, multipleFor, openFor, RULES, rtpAt, SWING_SCALE, weightsFor } from "./dots";

export { RULES } from "./dots";

/** A pen stroke: points in time (ms, the feed's clock) and price, from `t0` and `p0`; the pen's half-width in each. */
export type Stroke = { t0: number; p0: number; pts: { t: number; p: number }[]; rt: number; rp: number };

/**
 * How tall a cell of ink is, as a share of the price step: the finest the
 * ink is judged at, and the default. Each pen judges its ink in cells as
 * tall as the pen is wide, so a bigger pen catches the price more easily
 * and pays less for it; see `PEN_CELLS`.
 */
export const CELL = 0.5;
/** Each pen's cell, in price steps: its width. */
export const PEN_CELLS = { fine: 0.5, medium: 1, wide: 1.5 } as const;
export type Pen = keyof typeof PEN_CELLS;

export type CellStatus = "live" | "hit" | "miss";
/** A cell of ink: its second, its prices from `lo` up to `hi`, and how much ink is in it, in step-seconds. */
export type Cell = { t: number; lo: number; hi: number; area: number };
export type BetCell = Cell & {
  multiple: number;
  status: CellStatus;
  paid?: number;
  /** For a hit: the prices that second traded across, so the picture shows where the price met the ink. */
  range?: [number, number];
};

export type InkBetStatus = "opening" | "live" | "done" | "void";
export type InkBet = {
  id: string;
  placedAt: number;
  openAt: number;
  /** What a unit of ink costs: one price step, for one second. */
  perUnit: number;
  step: number;
  /** How tall its cells are, as a share of `step`. Missing on drawings from before pens had their own: `CELL`. */
  cell?: number;
  stroke: Stroke;
  /** As drawn, before it opened. */
  drawn: Cell[];
  /** As priced: the ink in play when it opened, each cell with its multiple. */
  cells: BetCell[];
  status: InkBetStatus;
  why?: string;
};

/* ------------------------------------------------------------------ */
/* From a stroke to cells of ink                                       */
/* ------------------------------------------------------------------ */

function union(spans: [number, number][]): [number, number][] {
  const s = spans.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The ink at one instant: the price ranges the pen covered at time `t`, as an ellipse `rt` by `rp` walked along the path. */
export function crossSection(st: Stroke, t: number): [number, number][] {
  const spans: [number, number][] = [];
  const pts = st.pts;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1] ?? a;
    const steps = pts[i + 1] ? Math.max(1, Math.ceil(Math.max(Math.abs(b.t - a.t) / (st.rt / 3), Math.abs(b.p - a.p) / (st.rp / 3)))) : 1;
    for (let k = 0; k < steps; k++) {
      const u = k / steps;
      const ct = st.t0 + a.t + (b.t - a.t) * u;
      const dt = (t - ct) / st.rt;
      if (Math.abs(dt) > 1) continue;
      const cp = st.p0 + a.p + (b.p - a.p) * u;
      const h = st.rp * Math.sqrt(1 - dt * dt);
      spans.push([cp - h, cp + h]);
    }
  }
  return union(spans);
}

/** Moments a second of ink is measured at. */
const SAMPLES = 20;
/** Less ink than this share of a cell is not a bet: a sliver at the edge of the pen. */
const MIN_COVER = 0.04;

/**
 * The cells of ink a stroke makes, for a drawing opening at `openAt`: from
 * the second after it to the horizon. A cell's area is how much of it the
 * ink covers, averaged across its second.
 */
export function cellsOf(st: Stroke, openAt: number, step: number, cell: number = CELL): Cell[] {
  const size = step * cell;
  const ts = st.pts.map((q) => st.t0 + q.t);
  const from = Math.min(...ts) - st.rt;
  const to = Math.max(...ts) + st.rt;
  const out: Cell[] = [];
  for (let j = 1; j <= RULES.horizon; j++) {
    const t = openAt + j * 1000;
    if (t + 1000 <= from || t > to) continue;
    const cover = new Map<number, number>();
    for (let k = 0; k < SAMPLES; k++) {
      for (const [a, b] of crossSection(st, t + ((k + 0.5) * 1000) / SAMPLES)) {
        // A pen taller than 400 cells is not a stroke anyone drew: leave it out rather than count it.
        if ((b - a) / size > 400) continue;
        for (let r = Math.floor(a / size); r * size < b; r++) {
          const overlap = Math.min(b, (r + 1) * size) - Math.max(a, r * size);
          if (overlap > 0) cover.set(r, (cover.get(r) ?? 0) + overlap / size / SAMPLES);
        }
      }
    }
    for (const [r, c] of [...cover].sort((x, y) => x[0] - y[0])) if (c >= MIN_COVER) out.push({ t, lo: r * size, hi: (r + 1) * size, area: Math.min(1, c) * cell });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Pricing                                                              */
/* ------------------------------------------------------------------ */

/**
 * Each cell's chance of being hit, from a drawing opening at `openAt` on
 * `f`: the share of like paths whose second reaches its prices. The paths
 * are those of `dots.ts`, weighted the same way, with each path's swings
 * scaled to now; and the same correction for how thin the estimate is, so a
 * rare cell is not overpaid.
 */
export function chances(lib: Library, cells: Cell[], openAt: number, f: Features): number[] {
  const { w } = weightsFor(lib, f);
  const k = f.sigma / LIB_SCALE;
  // Each cell, as the paths store a move: log from the price, in volatilities, times the scale.
  const at = cells.map((s) => ({ j: Math.round((s.t - openAt) / 1000), lo: Math.log(s.lo / f.price) / k, hi: Math.log(s.hi / f.price) / k }));
  const hit = new Float64Array(cells.length);
  let all = 0;
  let sq = 0;
  for (let i = 0; i < lib.n; i++) {
    const wi = w[i];
    if (wi < 1e-5) continue;
    all += wi;
    sq += wi * wi;
    const base = i * lib.seconds;
    const swing = (Math.min(3, Math.max(0.33, f.wick / lib.wick[i])) * LIB_SCALE) / SWING_SCALE;
    for (let s = 0; s < at.length; s++) {
      const j = at[s].j;
      if (j < 1 || j >= lib.seconds) continue;
      const prev = lib.close[base + j - 1];
      const c = lib.close[base + j];
      const hi = Math.max(prev, c) + lib.up[base + j] * swing;
      const lo = Math.min(prev, c) - lib.down[base + j] * swing;
      if (hi >= at[s].lo && lo <= at[s].hi) hit[s] += wi;
    }
  }
  const paths = sq > 0 ? (all * all) / sq : 0;
  return [...hit].map((h) => {
    if (!(all > 0) || !(paths > 0)) return 0;
    const p = h / all;
    return p > 0 ? p + (1 - p) / paths : 0;
  });
}

/** What a stroke would pay, cell by cell, if it were placed now: null for a cell not in play. */
export function quote(lib: Library, st: Stroke, now: number, step: number, f: Features, cell: number = CELL): { cells: Cell[]; multiples: (number | null)[] } {
  const openAt = openFor(now);
  const cells = cellsOf(st, openAt, step, cell);
  return { cells, multiples: chances(lib, cells, openAt, f).map((p, i) => multipleFor(p, rtpAt(f, (cells[i].lo + cells[i].hi) / 2))) };
}

/* ------------------------------------------------------------------ */
/* A drawing's life                                                    */
/* ------------------------------------------------------------------ */

const cents = (n: number) => Math.round(n * 100) / 100;
const areaOf = (cells: Cell[]) => cells.reduce((s, g) => s + g.area, 0);
export const cost = (bet: InkBet) => cents(bet.perUnit * areaOf(bet.drawn));
/** What comes back when it opens: the ink no longer in play, or all of it when it is voided. */
export const refund = (bet: InkBet) => (bet.status === "void" ? cost(bet) : bet.status === "opening" ? 0 : cents(cost(bet) - bet.perUnit * areaOf(bet.cells)));
export const won = (bet: InkBet) => cents(bet.cells.reduce((s, g) => s + (g.paid ?? 0), 0));
/** How much of the ink in play the price ran through. */
export const hitShare = (bet: InkBet) => {
  const all = areaOf(bet.cells);
  return all > 0 ? areaOf(bet.cells.filter((g) => g.status === "hit")) / all : 0;
};
export const decided = (bet: InkBet) => bet.status === "done" || bet.status === "void";

/** A stroke, as a drawing: not priced yet. It costs all its ink; what is not in play when it opens comes back. */
export function place(st: Stroke, perUnit: number, step: number, now: number, id: string, cell: number = CELL): InkBet | null {
  const openAt = openFor(now);
  const drawn = cellsOf(st, openAt, step, cell);
  if (!drawn.length) return null;
  return { id, placedAt: now, openAt, perUnit, step, cell, stroke: st, drawn, cells: [], status: "opening" };
}

/** Price a drawing on the second it opened, from the bars before it. */
export function open(bet: InkBet, lib: Library, bars: Bar[]): InkBet {
  const f = features(bars, bet.openAt);
  if (!f) return { ...bet, status: "void", why: "No price to open on." };
  const ps = chances(lib, bet.drawn, bet.openAt, f);
  const cells: BetCell[] = [];
  bet.drawn.forEach((s, i) => {
    const m = multipleFor(ps[i], rtpAt(f, (s.lo + s.hi) / 2));
    if (m !== null) cells.push({ ...s, multiple: m, status: "live" });
  });
  if (!cells.length) return { ...bet, status: "void", why: "The price moved, and none of it is in play now." };
  return { ...bet, status: "live", cells };
}

/**
 * Judge a live drawing on one second's bar, as it stands: the ink in that
 * second is hit where the bar's range reaches it, cell by cell, the moment
 * it does; the rest of that second's ink is missed once the second is over
 * (`closed`, after a margin for trades that arrive late).
 */
export function judge(bet: InkBet, bar: Bar, closed: boolean): InkBet {
  if (bet.status !== "live") return bet;
  let changed = false;
  const cells = bet.cells.map((s) => {
    if (s.status !== "live") return s;
    if (s.t === bar.t && bar.h >= s.lo && bar.l <= s.hi) {
      changed = true;
      return { ...s, status: "hit" as const, paid: Math.floor(bet.perUnit * s.area * s.multiple * 100) / 100, range: [bar.l, bar.h] as [number, number] };
    }
    if (closed && s.t <= bar.t) {
      changed = true;
      return { ...s, status: "miss" as const };
    }
    return s;
  });
  if (!changed) return bet;
  return { ...bet, cells, status: cells.every((s) => s.status !== "live") ? "done" : "live" };
}
