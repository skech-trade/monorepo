import type { Cell, Stroke } from "./ink";
import { RULES } from "./dots";

/** Two screen pixels at the chart's fixed price-step scale. Time is
 * resolved to one second, the resolution of the historical pricing feed. */
export const INK_CELL = 0.1;
export const CHART_STEP_PX = 20;
export const CHART_LINE_PX = INK_CELL * CHART_STEP_PX;
export const MIN_INK_MULTIPLE = 1.1;
/** The most one section of a new drawing pays, in dots. Past it, far ink
 * stakes less rather than paying less, so this bounds a single payout and
 * never the return per dollar. */
export const MAX_INK_MULTIPLE = 256;
/** rounded-v3's ceiling, kept for drawings saved on those terms. */
export const V3_MAX_MULTIPLE = 25;
/** Two CSS pixels of paid price-edge tolerance for new drawings. */
export const INK_EDGE_CELLS = 1;
/** Seconds ahead of now the chart shows, on every screen. Ink can be bet up to
 * RULES.horizon ahead; the view shows the nearer half of that, stretched, so
 * the chart moves at twice the pace it did showing all thirty seconds. */
export const VIEW_SECONDS = 15;
/** Shared by the canvas and replay: pricing atoms stay one chart-line
 * thick even on tall displays. Pen choice never participates in the camera. */
export function drawingLayout(width: number, height: number, marketStep: number) {
  const phone = width < 640;
  const top = phone ? 160 : 142;
  const bottom = Math.max(top + 120, height - (phone ? 174 : 116));
  const plotHeight = bottom - top;
  const nowX = Math.round(width * (phone ? 0.24 : 0.28));
  return { top, bottom, nowX, pitch: CHART_STEP_PX,
    // Nine market steps in view, so the ladder's 32x rung reaches the edge.
    step: marketStep * 9 * CHART_STEP_PX / plotHeight,
    pxMs: (width - nowX - (phone ? 10 : 20)) / ((VIEW_SECONDS + 1.5) * 1000) };
}

const SAMPLES = 24;

/** Round the total stake up once, so sub-cent area cannot be undercharged.
 * Exact whole dots keep their selected price. Never round per piece. */
export const areaCostOf = (perDot: number, units: number) => Math.ceil(perDot * units * 100 - 1e-9) / 100;

/** Exact vertical cross-section of the union of round, elliptical capsules.
 * Work in nib radii so this remains independent of zoom and pointer speed. */
function section(st: Stroke, time: number): [number, number][] {
  const x = (time - st.t0) / st.rt;
  const spans: [number, number][] = [];
  const circle = (px: number, py: number) => {
    const dx = x - px;
    if (Math.abs(dx) >= 1) return;
    const r = Math.sqrt(1 - dx * dx);
    spans.push([py - r, py + r]);
  };
  for (let i = 0; i < st.pts.length; i++) {
    const a = st.pts[i];
    const ax = a.t / st.rt, ay = a.p / st.rp;
    circle(ax, ay);
    const b = st.pts[i + 1];
    if (!b) continue;
    const bx = b.t / st.rt, by = b.p / st.rp;
    if (x < Math.min(ax, bx) - 1 || x > Math.max(ax, bx) + 1) continue;
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 1e-12) continue;
    const nx = -(by - ay) / length, ny = (bx - ax) / length;
    const corners = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
    const ys: number[] = [];
    for (let k = 0; k < 4; k++) {
      const c = corners[k], d = corners[(k + 1) % 4];
      if (x < Math.min(c[0], d[0]) || x > Math.max(c[0], d[0])) continue;
      if (Math.abs(c[0] - d[0]) < 1e-12) ys.push(c[1], d[1]);
      else ys.push(c[1] + ((x - c[0]) / (d[0] - c[0])) * (d[1] - c[1]));
    }
    if (ys.length) spans.push([Math.min(...ys), Math.max(...ys)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [lo, hi] of spans) {
    const last = merged.at(-1);
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged.map(([lo, hi]) => [st.p0 + lo * st.rp, st.p0 + hi * st.rp]);
}

/** Covered area in units of one full nib-sized dot (π rt rp). Retracing the
 * same ink costs nothing extra. Cells are an internal accounting detail.
 * Integrate each second with midpoint quadrature, clipping before charging. */
export function areaCells(st: Stroke, openAt: number, step: number): Cell[] {
  if (!(st.rt > 0 && st.rp > 0 && step > 0) || ![st.rt, st.rp, step, st.t0, st.p0, openAt].every(Number.isFinite) || !st.pts.length || st.pts.length > 2048 || st.pts.some(p => !Number.isFinite(p.t) || !Number.isFinite(p.p))) return [];
  const size = step * INK_CELL;
  const start = st.t0 + Math.min(...st.pts.map(p => p.t)) - st.rt;
  const end = st.t0 + Math.max(...st.pts.map(p => p.t)) + st.rt;
  const first = Math.max(Math.floor(start / 1000) * 1000, openAt + 1000);
  const last = Math.min(Math.floor(end / 1000) * 1000, openAt + RULES.horizon * 1000);
  const unit = Math.PI * st.rt * st.rp;
  const cells: Cell[] = [];
  for (let t = first; t <= last; t += 1000) {
    const a = Math.max(t, start), b = Math.min(t + 1000, end);
    if (b <= a) continue;
    const dt = (b - a) / SAMPLES;
    const rows = new Map<number, number>();
    for (let k = 0; k < SAMPLES; k++) {
      for (const [lo, hi] of section(st, a + (k + 0.5) * dt)) {
        const r0 = Math.floor(lo / size), r1 = Math.ceil(hi / size) - 1;
        // Bound malformed/extreme inputs, without silently charging truncated ink.
        if (r1 - r0 > 2048) return [];
        for (let r = r0; r <= r1; r++) {
          const overlap = Math.max(0, Math.min(hi, (r + 1) * size) - Math.max(lo, r * size));
          rows.set(r, (rows.get(r) ?? 0) + overlap * dt / unit);
        }
      }
    }
    for (const [r, area] of rows) if (area > 1e-10) cells.push({ t, lo: r * size, hi: (r + 1) * size, area });
  }
  // A complete isolated tap is exactly one unit, independent of alignment.
  const point = st.pts[0];
  if (start >= openAt + 1000 && end <= openAt + (RULES.horizon + 1) * 1000 && st.pts.every(p => p.t === point.t && p.p === point.p)) {
    const total = cells.reduce((n, c) => n + c.area, 0);
    if (total > 0) for (const c of cells) c.area /= total;
  }
  return cells.sort((a, b) => a.t - b.t || a.lo - b.lo);
}

/** Bound the return of a covered piece, rather than treating a microscopic
 * fraction as a whole $1 wager. The unweighted odds remain rtp / probability. */
export function areaMultiple(p: number, rtp: number, area: number): number | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const fair = rtp / p;
  if (fair < RULES.minMultiple || fair * area < MIN_INK_MULTIPLE || fair * area > RULES.maxMultiple) return null;
  const unit = fair >= 10 ? 1 : fair >= 2 ? 0.1 : 0.01;
  const rounded = Math.round(Math.floor(fair / unit + 1e-9) * unit * 100) / 100;
  return rounded * area + 1e-9 >= MIN_INK_MULTIPLE ? rounded : null;
}

/** Price connected ink in each second as one section. Any edge touch pays
 * that section once; its probability covers the whole band, not its centre.
 * Area (and therefore stake) is unchanged by grouping. */
export function roundedCells(st: Stroke, openAt: number, step: number): Cell[] {
  return sectionsOf(areaCells(st, openAt, step), step);
}

/** Group fine cells into rounded sections: each second's connected band,
 * split into adjacent sections of about two dots or less. */
export function sectionsOf(cells: Cell[], step: number): Cell[] {
  const bands: Cell[][] = [];
  for (const cell of [...cells].sort((a, b) => a.t - b.t || a.lo - b.lo)) {
    const previous = bands.at(-1);
    const last = previous?.at(-1);
    if (last && last.t === cell.t && cell.lo <= last.hi + step * 1e-8) previous!.push(cell);
    else bands.push([cell]);
  }
  // A steep stroke can cover many dots in one second. Never make that
  // entire stake compete for one capped payout: subdivide it into adjacent
  // price sections, preserving every row and every unit of charged area.
  const maxArea = Math.min(2, RULES.maxMultiple / RULES.minMultiple / 2);
  return bands.flatMap(rows => {
    const total = rows.reduce((n, c) => n + c.area, 0);
    const count = Math.ceil(total / maxArea);
    let remaining = total;
    let target = total / count;
    const sections: Cell[] = [];
    let current: Cell | null = null;
    for (const row of rows) {
      if (current && sections.length < count - 1 && current.area >= target * 0.75 && current.area + row.area > target) {
        sections.push(current);
        remaining -= current.area;
        target = remaining / (count - sections.length);
        current = null;
      }
      if (!current) current = { ...row };
      else { current.hi = row.hi; current.area += row.area; }
    }
    if (current) sections.push(current);
    return sections;
  });
}

/** The ink `st` adds to `prev` (the same stroke, drawn less far), as sections,
 * for ink bet as it is drawn. Both are measured on the same opening, so ink
 * that was in play when `prev` was bet and is too soon now is in neither.
 * The total is exactly the growth of the stroke's measured area, so bets on
 * successive pieces add up to the whole stroke with nothing charged twice. */
export function newInk(st: Stroke, prev: Stroke | null, openAt: number, step: number): Cell[] {
  const full = areaCells(st, openAt, step);
  if (!prev) return sectionsOf(full, step);
  const old = new Map(areaCells(prev, openAt, step).map(c => [`${c.t}:${c.lo}`, c.area]));
  const grown = full.reduce((n, c) => n + c.area, 0) - [...old.values()].reduce((n, a) => n + a, 0);
  if (!(grown > 1e-6)) return [];
  // Re-measuring the old ink in the second the stroke grew in moves a little
  // area between its cells; keep the growth, spread over where it grew.
  const added = full.map(c => ({ ...c, area: c.area - (old.get(`${c.t}:${c.lo}`) ?? 0) })).filter(c => c.area > 1e-9);
  const sum = added.reduce((n, c) => n + c.area, 0);
  if (!(sum > 0)) return [];
  return sectionsOf(added.map(c => ({ ...c, area: c.area * grown / sum })), step);
}

/** Rounded sections may quote below fair odds at the cap; a long shot stays
 * drawable without raising its payout or inventing a probability. */
export function cappedRoundedMultiple(p: number, rtp: number, area: number): number | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const value = Math.floor(Math.min(area * rtp / p, RULES.maxMultiple) * 10 + 1e-9) / 10;
  const multiple = value / area;
  return value >= MIN_INK_MULTIPLE && multiple >= RULES.minMultiple ? multiple : null;
}

/** A smooth cap for new contracts. It is monotone in the uncapped return,
 * always at or below it, and approaches the cap without flattening every
 * long shot to 10x. Applying the same function to previews and openings
 * keeps the displayed approximate quotes backed by actual payout terms. */
export function smoothRoundedMultiple(p: number, rtp: number, area: number): number | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const raw = area * rtp / p;
  if (raw < MIN_INK_MULTIPLE) return null;
  const span = RULES.maxMultiple - MIN_INK_MULTIPLE;
  if (!(span > 0)) return null;
  const log = Math.log1p((raw - MIN_INK_MULTIPLE) / span);
  const value = Math.floor((MIN_INK_MULTIPLE + span * log / (1 + log)) * 10 + 1e-9) / 10;
  const multiple = value / area;
  return value >= MIN_INK_MULTIPLE && multiple >= RULES.minMultiple ? multiple : null;
}

/** The ladder new drawings pay on, per dollar of ink, from the price outward:
 * doubling, with a rung between each pair so rounding down costs little. */
export const LADDER = [1.1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128] as const;
/** What the best-placed ink returns per dollar at the default difficulty: a
 * spot whose chance puts it exactly on a rung. Everywhere else rounds down to
 * the rung below. The game reads RULES.ladderBest, set by difficulty. */
export const LADDER_BEST = RULES.ladderBest;

/** ladder-v1, the terms for new drawings: a section's fair multiple
 * (LADDER_BEST over its chance, less the momentum margin rtpAt takes on the
 * side the price just moved toward) rounded down to a rung, so every label
 * is a rung from 1.1x to 128x and only ink the price actually crosses pays.
 * Ink too likely for 1.1x still pays 1.1x, so no stroke is cut; where it is
 * over 91% likely that ink returns more than a dollar. Ink past 128x pays 128x.
 * The stake is the ink drawn, up to what MAX_INK_MULTIPLE dots pays for. */
export function ladderSection(p: number, rtp: number, area: number): { area: number; multiple: number } | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const fair = (RULES.ladderBest - (RULES.rtp - rtp)) / p;
  // The floor is the first rung: 1.1x, easing to 1x at the hardest setting.
  let multiple: number = RULES.ladderFloor;
  for (const rung of LADDER) if (rung <= fair + 1e-9 && rung > multiple) multiple = rung;
  // One section never pays past MAX_INK_MULTIPLE dots: a big one stakes only what that pays for.
  return { area: Math.min(area, MAX_INK_MULTIPLE / multiple), multiple };
}

/** fair-v1 (saved drawings only), the terms before the ladder: every section pays its target
 * (the difficulty's rtp) over its chance, rounded down to a hundredth per
 * dollar, so a section returns the same per dollar however big it is,
 * whatever the pen and whatever screen drew it. Two exceptions:
 *
 * - Past MAX_INK_MULTIPLE a section pays that and is charged less instead:
 *   its stake shrinks to the area that multiple is exactly fair for, so far
 *   ink stays drawable without a cap taking from it.
 * - Ink so likely to be touched that its fair price is under 1.1x pays 1.1x,
 *   so a stroke across the live price is never cut. That ink returns more
 *   than the target, and more than a dollar where it is over 91% likely.
 *
 * Returns the area to charge and the multiple on it, or null. */
export function fairSection(p: number, rtp: number, area: number): { area: number; multiple: number } | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const multiple = Math.max(MIN_INK_MULTIPLE, Math.floor((rtp / p) * 100 + 1e-9) / 100);
  return area * multiple > MAX_INK_MULTIPLE ? { area: MAX_INK_MULTIPLE / multiple, multiple } : { area, multiple };
}

/** rounded-v3 (saved drawings only): preserve ordinary probability-priced returns through
 * 10x, then soften the long-shot tail with a square-root curve up to 25x.
 * For raw >= 10, 1.1 + sqrt((raw-1.1)*8.9) <= raw, so expected payouts
 * remain bounded by the existing pricing target before downward rounding. */
export function roundedMultiple(p: number, rtp: number, area: number): number | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const raw = area * rtp / p;
  if (raw < MIN_INK_MULTIPLE) return null;
  const tail = raw <= 10 ? raw : MIN_INK_MULTIPLE + Math.sqrt((raw - MIN_INK_MULTIPLE) * (10 - MIN_INK_MULTIPLE));
  const value = Math.floor(Math.min(V3_MAX_MULTIPLE, tail) * 10 + 1e-9) / 10;
  const multiple = value / area;
  return value >= MIN_INK_MULTIPLE && multiple >= RULES.minMultiple ? multiple : null;
}
