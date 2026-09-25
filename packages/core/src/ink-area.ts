import type { Cell, Stroke } from "./ink";
import { RULES } from "./dots";

/** Two screen pixels at the chart's fixed price-step scale. Time is
 * resolved to one second, the resolution of the historical pricing feed. */
export const INK_CELL = 0.1;
export const CHART_STEP_PX = 20;
export const CHART_LINE_PX = INK_CELL * CHART_STEP_PX;
export const MIN_INK_MULTIPLE = 1.1;
export const MAX_INK_MULTIPLE = 25;
/** Two CSS pixels of paid price-edge tolerance for new drawings. */
export const INK_EDGE_CELLS = 1;
/** Shared by the canvas and replay: pricing atoms stay one chart-line
 * thick even on tall displays. Pen choice never participates in the camera. */
export function drawingLayout(width: number, height: number, marketStep: number) {
  const phone = width < 640;
  const top = phone ? 160 : 142;
  const bottom = Math.max(top + 120, height - (phone ? 174 : 116));
  const plotHeight = bottom - top;
  const nowX = Math.round(width * (phone ? 0.24 : 0.28));
  return { top, bottom, nowX, pitch: CHART_STEP_PX,
    // Six market steps in view: 2x the previous vertical price range.
    step: marketStep * 6 * CHART_STEP_PX / plotHeight,
    pxMs: (width - nowX - (phone ? 10 : 20)) / ((RULES.horizon + 1.5) * 1000) };
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
  const bands: Cell[][] = [];
  for (const cell of areaCells(st, openAt, step)) {
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

/** New drawing range: preserve ordinary probability-priced returns through
 * 10x, then soften the long-shot tail with a square-root curve up to 25x.
 * For raw >= 10, 1.1 + sqrt((raw-1.1)*8.9) <= raw, so expected payouts
 * remain bounded by the existing pricing target before downward rounding. */
export function roundedMultiple(p: number, rtp: number, area: number): number | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const raw = area * rtp / p;
  if (raw < MIN_INK_MULTIPLE) return null;
  const tail = raw <= 10 ? raw : MIN_INK_MULTIPLE + Math.sqrt((raw - MIN_INK_MULTIPLE) * (10 - MIN_INK_MULTIPLE));
  const value = Math.floor(Math.min(MAX_INK_MULTIPLE, tail) * 10 + 1e-9) / 10;
  const multiple = value / area;
  return value >= MIN_INK_MULTIPLE && multiple >= RULES.minMultiple ? multiple : null;
}
