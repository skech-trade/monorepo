/**
 * The intent compiler: a drawing in, a set of positions out.
 *
 * Ported from the Trace sandbox (github.com/DevSwayam/skech), which is where
 * this idea was worked out. Nothing here touches the DOM or the chart — it
 * takes points in (time, price) and returns legs, so the same function can run
 * under a canvas, under a test, or one day under whatever places the orders.
 *
 * The whole of it in one paragraph: the canvas is cut into columns; each
 * column keeps the middle of whatever ink crossed it; empty columns are either
 * a slip of the pen (bridged) or a decision to be flat (left as a hole); what
 * survives is simplified to its turning points; and every run between two
 * turns in the same direction is one position. A rising run is a long, a
 * falling run is a short, a lifted pen is flat. That is the entire contract
 * between the drawing and the book.
 *
 * Two things a reader should know before trusting the output:
 *
 *   The simplification is lossy on purpose. A hand-drawn line has a hundred
 *   wobbles in it and none of them are trades. Anything smaller than the
 *   tolerance is not a turn, and if the drawing still asks for more legs than
 *   the budget allows, the smallest swings are dropped until it fits — the
 *   largest are always kept, so what trades is what you meant.
 *
 *   The prices on the legs are where the drawing *is*, not where it will fill.
 *   A leg starting at t = 0 on a line touching now is a market order. Every
 *   other leg is a scheduled entry: it fires at its time, at whatever the
 *   market is then.
 */

/** A point on the canvas: seconds from now, and a price. */
export type Point = { t: number; p: number };

/** One press of the pen. */
export type Stroke = Point[];

export type TraceConfig = {
  /** Seconds of future the canvas covers. */
  horizon: number;
  /** Columns the horizon is cut into. One per future bar. */
  columns: number;
  /** The live price. Ink touching "now" is pinned to it. */
  refPrice: number;
  /**
   * Empty columns that count as "stay flat" rather than as a slip of the pen.
   * Shorter holes are bridged; this long or longer means you meant it.
   */
  gapMin: number;
  /** Simplify tolerance, as a percent of the price. */
  tolPct: number;
  /** The most legs a drawing may compile to. */
  legBudget: number;
  /** What you put in, in dollars. Margin, in the venue's word. */
  margin: number;
  leverage: number;
  /** Taker fee per side, as a fraction of notional. */
  feeRate: number;
};

/**
 * The maintenance buffer, as a fraction of the initial margin.
 *
 * The same 0.9 the order ticket uses. Two liquidation prices on one screen that
 * disagree by half a percent is worse than either of them being slightly wrong.
 */
const MAINTENANCE = 0.9;

export type Turn = "SH" | "SL" | "HH" | "LH" | "HL" | "LL";

/** One position: a run of the drawing in one direction. */
export type Leg = {
  /** 1-based, in the order they will be opened. */
  id: number;
  /** 1 long, -1 short. */
  dir: 1 | -1;
  /** Seconds from now. */
  t0: number;
  t1: number;
  /** The drawn prices at each end. Not fills. */
  p0: number;
  p1: number;
  /** This leg opens the instant the one before it closed. */
  reversal: boolean;
  movePct: number;
  minutes: number;
  /** Percent per minute. */
  rate: number;
  slope: "shallow" | "moderate" | "steep" | "parabolic";
  /** The kind of turn at the *end* of this leg, if the next one reverses. */
  turn?: Turn;
  /** Which unbroken run of the drawing it belongs to. */
  seg: number;
  /** Dollars of exposure. */
  notional: number;
  /** Units of the asset. */
  qty: number;
  /** Where this leg would be wiped out. */
  liq: number;
};

/** One column of the canvas, after the ink has been read off it. */
export type Col = {
  t: number;
  p: number;
  /** Nothing was drawn here. */
  gap: boolean;
  /** Nothing was drawn here either, but it was short enough to fill in. */
  bridged: boolean;
};

/** A stretch the plan sits out, and why. */
export type Flat = {
  t0: number;
  t1: number;
  p0: number;
  p1: number;
  /** Which unbroken run of the drawing it belongs to. -1 for a pen lift. */
  seg: number;
  kind: "gap" | "horizontal" | "tail" | "start";
};

export type Plan = {
  legs: Leg[];
  /** The sampled path: one point per column, which is what the plan reads. */
  cols: Col[];
  /** The compiled path, for drawing: what the columns kept. */
  spine: Point[];
  flats: Flat[];
  /** The drawing touches now, so leg 1 is a market order. */
  anchored: boolean;
  /** Dollars of exposure per leg. */
  notional: number;
  /** Both sides of every leg, at the taker rate. */
  fees: number;
  /** Legs before the budget was applied. */
  legsAtBase: number;
  simplified: boolean;
  warnings: string[];
  /** What the legs spell out, in the words traders use. */
  shapes: string[];
};

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** m:ss, which is how long a horizon this is. */
export function fmtT(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * How much you are putting at risk, and how much of the market that buys.
 *
 * The one place the money is decided. Margin is what leaves your balance;
 * leverage multiplies it into exposure; every leg opens at that exposure and
 * closes flat, so the drawing never compounds — ten legs is ten separate
 * $1,000 positions, not $1,000 rolled ten times.
 */
export function sizing(cfg: Pick<TraceConfig, "margin" | "leverage">) {
  return {
    leverage: cfg.leverage,
    margin: cfg.margin,
    notional: cfg.margin * cfg.leverage,
  };
}

/** Where a leg is wiped out. Matches the order ticket's formula exactly. */
export function liquidation(entry: number, dir: 1 | -1, leverage: number) {
  const move = MAINTENANCE / leverage;
  return dir > 0 ? entry * (1 - move) : entry * (1 + move);
}

/**
 * Ramer–Douglas–Peucker.
 *
 * Keeps the points that carry the shape and drops the ones that only carry the
 * hand. Vertical distance rather than perpendicular, because the two axes here
 * are seconds and dollars and a perpendicular distance between them would be
 * measuring the hypotenuse of two unrelated units.
 */
function rdp(pts: Point[], tol: number): Point[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Array(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop() as [number, number];
    const a = pts[i];
    const b = pts[j];
    let maxd = 0;
    let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const u = (pts[k].t - a.t) / (b.t - a.t || 1e-9);
      const d = Math.abs(pts[k].p - (a.p + (b.p - a.p) * u));
      if (d > maxd) {
        maxd = d;
        idx = k;
      }
    }
    if (maxd > tol) {
      keep[idx] = true;
      stack.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

const slopeTerm = (rate: number): Leg["slope"] => {
  const a = Math.abs(rate);
  if (a >= 2) return "parabolic";
  if (a >= 0.5) return "steep";
  if (a >= 0.1) return "moderate";
  return "shallow";
};

/**
 * Name the shape, in the words traders use.
 *
 * Not decoration. Someone who has never traded draws a shape because it looks
 * like what they think will happen; being told "that is a double bottom, and
 * it is four trades, and a discretionary trader would only take the second
 * one" is the fastest way they learn what they just asked for.
 *
 * Largest patterns first, and a leg already explained is not explained twice.
 */
function readShape(legs: Leg[], ref: number): string[] {
  const out: string[] = [];
  if (!legs.length) return out;
  const dirs = legs.map((l) => l.dir);
  const close = (a: number, b: number) => Math.abs(a - b) / ref < 0.012;
  const covered = new Array(legs.length).fill(false);
  const mark = (a: number, b: number) => {
    for (let k = a; k <= b; k++) covered[k] = true;
  };

  if (legs.length === 1) {
    out.push(
      `A single ${legs[0].dir > 0 ? "long" : "short"}, ${legs[0].slope} at ${legs[0].rate >= 0 ? "+" : ""}${legs[0].rate.toFixed(2)}% a minute.`,
    );
  }
  if (legs.length === 2 && legs[1].reversal) {
    out.push(
      dirs[0] < 0
        ? `A V bottom at ${fmtT(legs[0].t1)}: short into the low, long out of it.`
        : `An inverted V at ${fmtT(legs[0].t1)}: long into the high, short out of it.`,
    );
  }
  for (let i = 0; i + 5 < legs.length; i++) {
    const alt = [0, 1, 2, 3, 4].every(
      (k) => dirs[i + k] === -dirs[i + k + 1] && legs[i + k + 1].reversal,
    );
    if (!alt) continue;
    const shoulders = close(legs[i].p1, legs[i + 4].p1);
    if (
      dirs[i] > 0 &&
      legs[i + 2].p1 > legs[i].p1 &&
      legs[i + 2].p1 > legs[i + 4].p1 &&
      shoulders
    ) {
      out.push("Head and shoulders: a shoulder, a higher head, a lower shoulder.");
      mark(i, i + 5);
    }
    if (
      dirs[i] < 0 &&
      legs[i + 2].p1 < legs[i].p1 &&
      legs[i + 2].p1 < legs[i + 4].p1 &&
      shoulders
    ) {
      out.push("An inverse head and shoulders: a lower head between two shoulders.");
      mark(i, i + 5);
    }
  }
  for (let i = 0; i + 3 < legs.length; i++) {
    if ([i, i + 1, i + 2, i + 3].some((k) => covered[k])) continue;
    const alt = [0, 1, 2].every(
      (k) => dirs[i + k] === -dirs[i + k + 1] && legs[i + k + 1].reversal,
    );
    if (!alt) continue;
    if (dirs[i] < 0 && close(legs[i].p1, legs[i + 2].p1)) {
      out.push(
        "A double bottom — two lows at the same price. This trades all four legs; by hand you would only buy the second low.",
      );
      mark(i, i + 3);
    }
    if (dirs[i] > 0 && close(legs[i].p1, legs[i + 2].p1)) {
      out.push(
        "A double top — two highs at the same price. This trades all four legs; by hand you would only sell the second high.",
      );
      mark(i, i + 3);
    }
  }
  for (let i = 0; i + 2 < legs.length; i++) {
    if ([i, i + 1, i + 2].some((k) => covered[k])) continue;
    if (
      dirs[i] === dirs[i + 2] &&
      dirs[i + 1] === -dirs[i] &&
      legs[i + 1].reversal &&
      legs[i + 2].reversal &&
      Math.abs(legs[i + 1].movePct) < Math.abs(legs[i].movePct) * 0.5 &&
      Math.abs(legs[i + 1].movePct) < Math.abs(legs[i + 2].movePct) * 0.5
    ) {
      out.push(
        `A ${dirs[i] > 0 ? "bull" : "bear"} flag: a run, a ${Math.abs(legs[i + 1].movePct).toFixed(1)}% pullback, then the run again.`,
      );
      mark(i, i + 2);
    }
  }

  const turns = legs.map((l) => l.turn).filter(Boolean) as Turn[];
  const count = (t: Turn) => turns.filter((x) => x === t).length;
  const hh = count("HH");
  const hl = count("HL");
  const lh = count("LH");
  const ll = count("LL");
  if (turns.length >= 3 && hh + hl >= 2 && lh + ll === 0) {
    out.push("An uptrend: every high and every low above the last.");
  } else if (turns.length >= 3 && lh + ll >= 2 && hh + hl === 0) {
    out.push("A downtrend: every high and every low below the last.");
  } else if (legs.length >= 3 && out.length === 0) {
    out.push(`A zigzag of ${legs.length} legs, with no repeating structure.`);
  }
  return out;
}

/** Percent, minutes, slope, and which turns are higher or lower than the last. */
function annotate(legs: Leg[]) {
  let lastHigh: number | null = null;
  let lastLow: number | null = null;
  legs.forEach((l, i) => {
    l.movePct = (l.p1 / l.p0 - 1) * 100;
    l.minutes = Math.max((l.t1 - l.t0) / 60, 1e-6);
    l.rate = l.movePct / l.minutes;
    l.slope = slopeTerm(l.rate);
    const next = legs[i + 1];
    if (next && Math.abs(next.t0 - l.t1) < 1e-6 && next.dir !== l.dir) {
      if (l.dir > 0) {
        l.turn = lastHigh === null ? "SH" : l.p1 > lastHigh ? "HH" : "LH";
        lastHigh = l.p1;
      } else {
        l.turn = lastLow === null ? "SL" : l.p1 < lastLow ? "LL" : "HL";
        lastLow = l.p1;
      }
    }
  });
}

type Raw = {
  t0: number;
  t1: number;
  p0: number;
  p1: number;
  dir: number;
  seg: number;
};

/**
 * The compiler.
 *
 * Columns, then holes, then turning points, then legs. Each stage throws away
 * detail the next one would only have to ignore.
 */
export function compile(strokes: Stroke[], cfg: TraceConfig): Plan {
  const H = cfg.horizon;
  const K = cfg.columns;
  const colW = H / K;
  const ref = cfg.refPrice;
  const size = sizing(cfg);

  /* ---- 1. ink into columns ------------------------------------------------ */

  const mn = new Array<number>(K).fill(Number.POSITIVE_INFINITY);
  const mx = new Array<number>(K).fill(Number.NEGATIVE_INFINITY);
  const hit = new Array<boolean>(K).fill(false);
  const add = (c: number, p1: number, p2: number) => {
    if (c < 0 || c >= K) return;
    hit[c] = true;
    mn[c] = Math.min(mn[c], p1, p2);
    mx[c] = Math.max(mx[c], p1, p2);
  };
  for (const s of strokes) {
    if (!s.length) continue;
    if (s.length === 1) {
      add(Math.floor(s[0].t / colW), s[0].p, s[0].p);
      continue;
    }
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i];
      const b = s[i + 1];
      const tmin = Math.min(a.t, b.t);
      const tmax = Math.max(a.t, b.t);
      const c0 = clamp(Math.floor(tmin / colW), 0, K - 1);
      const c1 = clamp(Math.floor(Math.min(tmax, H - 1e-9) / colW), 0, K - 1);
      if (tmax - tmin < 1e-9) {
        add(c0, a.p, b.p);
        continue;
      }
      for (let c = c0; c <= c1; c++) {
        const ta = Math.max(tmin, c * colW);
        const tb = Math.min(tmax, (c + 1) * colW);
        const pa = a.p + ((b.p - a.p) * (ta - a.t)) / (b.t - a.t);
        const pb = a.p + ((b.p - a.p) * (tb - a.t)) / (b.t - a.t);
        add(c, pa, pb);
      }
    }
  }

  const cols = Array.from({ length: K }, (_, c) => ({
    bridged: false,
    c,
    gap: !hit[c],
    p: hit[c] ? (mn[c] + mx[c]) / 2 : 0,
    t: (c + 0.5) * colW,
  }));
  // Ink touching "now" is pinned to the live quote: you cannot draw a line that
  // starts at a price the market is not at.
  const anchored = hit[0];
  if (anchored) {
    cols[0].p = ref;
    cols[0].t = 0;
  }

  /* ---- 2. holes: a slip of the pen, or a decision to be flat --------------- */

  const flats: Flat[] = [];
  let c = 0;
  while (c < K) {
    if (!cols[c].gap) {
      c++;
      continue;
    }
    let e = c;
    while (e < K && cols[e].gap) e++;
    const len = e - c;
    const hole = (kind: Flat["kind"], t0: number, t1: number) => {
      const p = cols[c - 1]?.p ?? cols[e]?.p ?? ref;
      flats.push({ kind, p0: p, p1: p, seg: -1, t0, t1 });
    };
    if (c === 0) {
      hole("start", 0, e * colW);
    } else if (e === K) {
      hole("tail", c * colW, H);
    } else if (len < cfg.gapMin) {
      // Short enough to be the pen leaving the surface, not a decision.
      const pa = cols[c - 1];
      const pb = cols[e];
      for (let k = c; k < e; k++) {
        cols[k].p = lerp(pa.p, pb.p, (cols[k].t - pa.t) / (pb.t - pa.t));
        cols[k].gap = false;
        cols[k].bridged = true;
      }
    } else {
      hole("gap", c * colW, e * colW);
    }
    c = e;
  }

  /* ---- 3. what is left, cut into unbroken runs ----------------------------- */

  const segs: Point[][] = [];
  c = 0;
  while (c < K) {
    if (cols[c].gap) {
      c++;
      continue;
    }
    let e = c;
    while (e < K && !cols[e].gap) e++;
    const points = cols.slice(c, e).map((x) => ({ p: x.p, t: x.t }));
    // Runs start and end on column boundaries so they meet the holes exactly;
    // "now" stays pinned at t = 0.
    if (!(c === 0 && anchored)) points[0] = { p: points[0].p, t: c * colW };
    points[points.length - 1] = {
      p: points[points.length - 1].p,
      t: e * colW,
    };
    segs.push(points);
    c = e;
  }

  /* ---- 4. turning points -------------------------------------------------- */

  const tol = (ref * cfg.tolPct) / 100;

  /**
   * A step smaller than the tolerance and shorter than a hole is wobble at a
   * turn, not a flat. Drop the less extreme of the two vertices.
   */
  const absorbWobble = (v0: Point[]) => {
    const v = v0.slice();
    let changed = true;
    while (changed && v.length > 2) {
      changed = false;
      for (let i = 0; i < v.length - 1; i++) {
        const a = v[i];
        const b = v[i + 1];
        if (Math.abs(b.p - a.p) <= tol && b.t - a.t < cfg.gapMin * colW) {
          let drop: number;
          if (i === 0) drop = i + 1;
          else if (i + 1 === v.length - 1) drop = i;
          else {
            const mid = (v[i - 1].p + v[i + 2].p) / 2;
            drop = Math.abs(a.p - mid) >= Math.abs(b.p - mid) ? i + 1 : i;
          }
          v.splice(drop, 1);
          changed = true;
          break;
        }
      }
    }
    return v;
  };

  /** Keep only the vertices where the direction actually changes. */
  const collapse = (v0: Point[]) => {
    const v = absorbWobble(v0);
    if (v.length < 3) return v;
    const out = [v[0]];
    for (let i = 1; i < v.length - 1; i++) {
      const prev = out[out.length - 1];
      const d1 = Math.abs(v[i].p - prev.p) <= tol ? 0 : sgn(v[i].p - prev.p);
      const d2 =
        Math.abs(v[i + 1].p - v[i].p) <= tol ? 0 : sgn(v[i + 1].p - v[i].p);
      if (d1 !== d2 || d1 === 0) out.push(v[i]);
    }
    out.push(v[v.length - 1]);
    return out;
  };

  const legsFromVerts = (vertsBySeg: Point[][]) => {
    const legs: Raw[] = [];
    const held: Raw[] = [];
    for (const [si, verts0] of vertsBySeg.entries()) {
      const verts = absorbWobble(verts0);
      const raw: Raw[] = [];
      for (let i = 0; i < verts.length - 1; i++) {
        const dp = verts[i + 1].p - verts[i].p;
        raw.push({
          dir: Math.abs(dp) <= tol ? 0 : sgn(dp),
          p0: verts[i].p,
          p1: verts[i + 1].p,
          seg: si,
          t0: verts[i].t,
          t1: verts[i + 1].t,
        });
      }
      // Runs in the same direction are one position, not two: the pen wandering
      // across a column boundary is not a reason to pay the fee twice.
      const merged: Raw[] = [];
      for (const l of raw) {
        const last = merged[merged.length - 1];
        if (last && last.dir === l.dir && l.dir !== 0) {
          last.t1 = l.t1;
          last.p1 = l.p1;
        } else merged.push({ ...l });
      }
      for (const l of merged) {
        if (l.dir === 0) held.push(l);
        else legs.push(l);
      }
    }
    return { held, legs };
  };

  /* ---- 5. fit the leg budget ---------------------------------------------- */

  const vertsBySeg = segs.map((seg) => collapse(rdp(seg, tol)));
  let res = legsFromVerts(vertsBySeg);
  const legsAtBase = res.legs.length;
  let simplified = false;
  let guard = 0;
  while (res.legs.length > cfg.legBudget && guard++ < 500) {
    // The smallest swing anywhere: a directional step between two turns.
    let best: { si: number; i: number; amp: number } | null = null;
    vertsBySeg.forEach((v, si) => {
      for (let i = 0; i < v.length - 1; i++) {
        const amp = Math.abs(v[i + 1].p - v[i].p);
        if (amp <= tol) continue;
        if (!best || amp < best.amp) best = { amp, i, si };
      }
    });
    if (!best) break;
    const { i, si } = best as { si: number; i: number; amp: number };
    const v = vertsBySeg[si];
    simplified = true;
    if (v.length <= 2) v.splice(1, 1);
    else if (i === 0) v.splice(1, 1);
    else if (i === v.length - 2) v.splice(i, 1);
    else v.splice(i, 2);
    vertsBySeg[si] = collapse(v);
    res = legsFromVerts(vertsBySeg);
  }

  /* ---- 6. positions ------------------------------------------------------- */

  const legs: Leg[] = res.legs.map((l, i) => {
    const dir = (l.dir > 0 ? 1 : -1) as 1 | -1;
    return {
      dir,
      id: i + 1,
      liq: liquidation(l.p0, dir, cfg.leverage),
      minutes: 0,
      movePct: 0,
      notional: size.notional,
      p0: l.p0,
      p1: l.p1,
      qty: size.notional / l.p0,
      rate: 0,
      reversal: i > 0 && Math.abs(res.legs[i - 1].t1 - l.t0) < 1e-6,
      seg: l.seg,
      slope: "shallow",
      t0: l.t0,
      t1: l.t1,
    };
  });
  annotate(legs);

  for (const h of res.held) {
    flats.push({
      kind: "horizontal",
      p0: h.p0,
      p1: h.p1,
      seg: h.seg,
      t0: h.t0,
      t1: h.t1,
    });
  }
  flats.sort((a, b) => a.t0 - b.t0);

  const spine = cols.filter((x) => !x.gap).map((x) => ({ p: x.p, t: x.t }));

  /* ---- 7. what the reader needs telling ----------------------------------- */

  const warnings: string[] = [];
  if (strokes.length && !legs.length) {
    warnings.push(
      "Nothing to trade. The line has no direction once the wobble is taken out of it.",
    );
  }
  if (legs.length && !anchored) {
    warnings.push(
      `The line does not start at now, so nothing opens until ${fmtT(legs[0].t0)}.`,
    );
  }
  if (simplified) {
    warnings.push(
      `That is ${legsAtBase} turns and the limit is ${cfg.legBudget}. The ${legsAtBase - legs.length} smallest were dropped; the biggest moves are kept.`,
    );
  }

  return {
    anchored,
    cols,
    fees: legs.length * 2 * cfg.feeRate * size.notional,
    flats,
    legs,
    legsAtBase,
    notional: size.notional,
    shapes: readShape(legs, ref),
    simplified,
    spine,
    warnings,
  };
}

/**
 * The plan as editable polylines, one per unbroken run of the drawing.
 *
 * The turning points, in order, with the flats left in so a held stretch is a
 * straight piece of the same line rather than a hole in it. This is what a
 * vertex drag edits: grab a turn, and what you are moving is the plan itself,
 * not the hand that drew it.
 */
export function polylines(plan: Plan): Stroke[] {
  const items = [...plan.legs, ...plan.flats.filter((f) => f.seg >= 0)].sort(
    (a, b) => a.t0 - b.t0,
  );
  const out: Stroke[] = [];
  let current: Stroke | null = null;
  let seg = Number.NaN;
  for (const it of items) {
    if (it.seg !== seg) {
      current = [{ p: it.p0, t: it.t0 }];
      out.push(current);
      seg = it.seg;
    }
    current?.push({ p: it.p1, t: it.t1 });
  }
  return out;
}

/** The words for a turn, for the label printed at it. */
export const TURN_WORD: Record<Turn, string> = {
  HH: "higher high",
  HL: "higher low",
  LH: "lower high",
  LL: "lower low",
  SH: "swing high",
  SL: "swing low",
};

/**
 * One place for pen input.
 *
 * Three rules, and every one of them is about the fact that a hand is not a
 * price feed.
 *
 * Time only ever moves forward. Dragging back over your own line edits the
 * price of the tip rather than writing a second price at the same instant,
 * because a price curve that doubles back is not a thing a market can do.
 *
 * Forward motion of less than a couple of pixels does the same, for the same
 * reason from the other side: a dozen points inside one column is a dozen
 * chances for the noise between them to be read as a turn.
 *
 * And the price is smoothed towards the pointer rather than taken from it, so
 * the tremor in a hand drawing a straight line does not arrive as structure.
 */
export function penPoint(
  next: Point,
  last: Point | null,
  smooth: number,
  samePixel?: (a: number, b: number) => boolean,
): Point | { update: true; p: number } | null {
  if (!last) return next;
  const p = last.p + (1 - smooth) * (next.p - last.p);
  if (next.t <= last.t + 1e-9) return { p, update: true };
  if (samePixel?.(next.t, last.t)) return { p, update: true };
  return { p, t: next.t };
}
