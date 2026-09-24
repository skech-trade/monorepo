/**
 * skech: draw ahead of the Bitcoin price. Every point of your line the price
 * touches pays.
 *
 * A drawing is a line in time and price. Each second it passes through a
 * row of prices is one point: a bet of its own, costing the same as every
 * other point (what you set, 25¢ say). A point pays that times its multiple
 * if the price trades in its row during its second, so a 10x point at 25¢
 * pays $2.50: the number under the pen is the number you get.
 *
 *   - rows are as tall as the pen is wide, so a wider pen's points are
 *     easier to hit and pay less;
 *   - a point's multiple is `rtp / chance`, the chance measured on
 *     thousands of real stretches of Bitcoin from moments like this one, as
 *     in `dots.ts`;
 *   - a longer line, or one that climbs or falls through more rows in a
 *     second, has more points and costs more;
 *   - a point too unlikely to measure, or too sure to pay anything, is not in
 *     play and costs nothing.
 *
 * Before this, ink was priced by area: every sliver of ink its own bet at a
 * share of a unit. It was fair, but nothing on the screen could be checked
 * against it: the map said 10x and a hit paid 17 cents.
 */

import { type Bar, chanceOf, type Features, features, type Field, type Library, LIB_SCALE, multipleFor, openFor, RULES, rtpAt, SWING_SCALE, weightsFor } from "./dots";

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
export const PEN_CELLS = { fine: 0.4, medium: 0.7, wide: 1 } as const;
export type Pen = keyof typeof PEN_CELLS;

export type CellStatus = "live" | "hit" | "miss";
/** A point: its second, its row of prices from `lo` up to (not including) `hi`, and how many points it is: one. */
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
  /** What a point costs. */
  perUnit: number;
  step: number;
  /** How tall its cells are, as a share of `step`. Missing on drawings from before pens had their own: `CELL`. */
  cell?: number;
  stroke: Stroke;
  /** The line it is part of: a line is placed as it is drawn, a few points at a time, each its own bet. */
  group?: string;
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

/**
 * The points a line makes, for a drawing opening at `openAt`: from the
 * second after it to the horizon, every row the line passes through in each
 * second, once. Walked finely enough, in time and in price, that no row it
 * crosses is skipped. A point's `area` is one point.
 */
export function cellsOf(st: Stroke, openAt: number, step: number, cell: number = CELL): Cell[] {
  const size = step * cell;
  const pts = st.pts.map((q) => ({ t: st.t0 + q.t, p: st.p0 + q.p }));
  const seen = new Map<string, Cell>();
  const visit = (t: number, p: number) => {
    const sec = Math.floor(t / 1000) * 1000;
    const j = (sec - openAt) / 1000;
    if (j < 1 || j > RULES.horizon) return;
    const r = Math.floor(p / size);
    const key = `${sec}:${r}`;
    if (!seen.has(key)) seen.set(key, { t: sec, lo: r * size, hi: (r + 1) * size, area: 1 });
  };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!b) {
      visit(a.t, a.p);
      continue;
    }
    const n = Math.max(1, Math.ceil(Math.abs(b.t - a.t) / 50), Math.ceil(Math.abs(b.p - a.p) / (size / 2)));
    for (let k = 0; k < n; k++) visit(a.t + ((b.t - a.t) * k) / n, a.p + ((b.p - a.p) * k) / n);
  }
  return [...seen.values()].sort((x, y) => x.t - y.t || x.lo - y.lo);
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
      // A price exactly on a cell's top edge is in the cell above, as in `dots.ts`: counted in both, prices on round numbers hit twice.
      if (hi >= at[s].lo && lo < at[s].hi) hit[s] += wi;
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

/**
 * The same, read off a field instead of the paths: for the stroke being
 * drawn, many times a second, where running every path each time stalls the
 * page. The field must be mapped in this pen's cells (`step * cell` tall),
 * so each cell is one of its rows. A field a second old is read as if it
 * opened now, each cell as far ahead of it as the cell is ahead of this
 * drawing's second. What a drawing pays is still set by `open`, on its own
 * second.
 */
export function quoteOn(fl: Field, st: Stroke, now: number, step: number, cell: number = CELL): { cells: Cell[]; multiples: (number | null)[] } {
  const openAt = openFor(now);
  const size = step * cell;
  const cells = cellsOf(st, openAt, step, cell);
  const same = Math.abs(fl.step - size) < size * 1e-9;
  return {
    cells,
    multiples: cells.map((c) => {
      if (!same) return null;
      const row = Math.round(c.lo / size);
      return multipleFor(chanceOf(fl, { t: fl.openAt + (c.t - openAt), row }), rtpAt(fl.f, (c.lo + c.hi) / 2));
    }),
  };
}

/* ------------------------------------------------------------------ */
/* A drawing's life                                                    */
/* ------------------------------------------------------------------ */

const cents = (n: number) => Math.round(n * 100) / 100;
/** What a line costs: every point in play at the same price. The one place it is worked out, with `payoutOf`; `odds.ts` states both. */
export const costOf = (perPoint: number, points: number) => cents(perPoint * points);
/** What a hit pays: the point times its multiple, rounded down to the cent. */
export const payoutOf = (perPoint: number, multiple: number) => Math.floor(perPoint * multiple * 100 + 1e-9) / 100;
const areaOf = (cells: Cell[]) => cells.reduce((s, g) => s + g.area, 0);
export const cost = (bet: InkBet) => costOf(bet.perUnit, areaOf(bet.drawn));
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

/** Some points of a line, as a drawing of their own: placed now, not priced yet. */
export function placePoints(points: Cell[], st: Stroke, group: string, perUnit: number, step: number, now: number, id: string, cell: number = CELL): InkBet | null {
  const openAt = openFor(now);
  const drawn = points.filter((c) => c.t >= openAt + 1000 && c.t <= openAt + RULES.horizon * 1000);
  if (!drawn.length) return null;
  return { id, group, placedAt: now, openAt, perUnit, step, cell, stroke: st, drawn, cells: [], status: "opening" };
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
 * Price a drawing off the map of its own second, instead of the paths: the
 * same chances, measured in a worker, so opening a drawing never holds the
 * page up. Only a map of the second the drawing opens on, in its pen's
 * cells, will do; anything else is null, and `open` prices it instead.
 */
export function openOn(bet: InkBet, fl: Field): InkBet | null {
  const size = bet.step * (bet.cell ?? CELL);
  if (fl.openAt !== bet.openAt || Math.abs(fl.step - size) > size * 1e-9) return null;
  const cells: BetCell[] = [];
  for (const s of bet.drawn) {
    const m = multipleFor(chanceOf(fl, { t: s.t, row: Math.round(s.lo / size) }), rtpAt(fl.f, (s.lo + s.hi) / 2));
    if (m !== null) cells.push({ ...s, multiple: m, status: "live" });
  }
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
    if (s.t === bar.t && bar.h >= s.lo && bar.l < s.hi) {
      changed = true;
      return { ...s, status: "hit" as const, paid: payoutOf(bet.perUnit * s.area, s.multiple), range: [bar.l, bar.h] as [number, number] };
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
