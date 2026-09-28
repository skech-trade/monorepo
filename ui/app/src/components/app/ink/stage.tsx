"use client";

import { useEffect, useRef } from "react";
import { type Bar, type Field, openFor } from "@skech/core/dots";
import { drawingLayout, INK_CELL, VIEW_SECONDS, CHART_STEP_PX, PEN_CELLS, type Cell, type InkBet, type Pen, type Stroke } from "@skech/core/ink";
import { roundedTerms as areaTerms } from "@skech/core/odds";
import type { Tick } from "@/lib/coinbase";
import { tracePricePath } from "./price-path";

/**
 * The stage: the price so far on the left, now in the middle, and the space
 * ahead of it to draw in.
 *
 * The space is a map of the odds: soft tiles, each with the multiple a tap
 * there pays, faint near the price and bluer the more it pays.
 * You draw on it with a pen, as on paper, and the ink is the bet: every bit
 * of area it covers costs the same and pays what the map says there, if the
 * price runs through it. The ink is solid where it is in play, faint where
 * it is not (too soon, too near the price, too far from it), and green where
 * the price has been through it.
 *
 * Underneath, area is counted in small slices, one second wide and one chart-line
 * thickness tall, because that is how finely the price data runs. None of that
 * is drawn.
 *
 * One canvas, drawn every frame from a game object the screen mutates, since
 * sixty frames a second of moving ink is not a job for React. The screen
 * owns the rules and the money; this owns the picture and the pen.
 */

export type Fx = { kind: "hit" | "placed"; t: number; price: number; born: number; text?: string; loss?: boolean; line?: string; big?: boolean };
/** What the stroke being drawn costs, the least and most a hit on it pays (in dollars), and which of its points are in play. */
export type Preview = { multipleLow: number; multipleHigh: number; units: number; cost: number; low: number; high: number; inPlay: Cell[]; out: Cell[]; keyboard?: boolean };

export type Game = {
  bars: Bar[];
  ticks: Tick[];
  /** Coinbase's clock minus this one's. */
  skew: number;
  /** Every slice's chance, for a drawing placed now. Null until the paths and the prices are in. */
  field: Field | null;
  step: number;
  marketStep: number;
  viewport: { width: number; height: number };
  displayPrice: number;
  /** What a point costs. */
  perDot: number;
  pen: Pen;
  /** The pen's width, and the height of the rows its points are in, as a share of `step`. */
  cell: number;
  drawing?: { step: number; perDot: number; pen: Pen };
  bets: InkBet[];
  /** Price a stroke as if it were placed now. Set by the screen, which has the paths and the market. */
  quote: ((st: Stroke) => Preview | null) | null;
  fx: Fx[];
  /** Draw the first-visit guide: a ghost pen drawing a stroke. */
  hint: boolean;
  /** Whether the screen is dark, read from the page. */
  dark: boolean;
};

const now = (g: Game) => Date.now() + g.skew;
const price = (g: Game) => g.ticks.at(-1)?.p ?? g.bars.at(-1)?.c ?? 0;

/** A colour the app defines, as the numbers a canvas can use: whatever a CSS colour is written in, drawn once and read back. */
type Rgb = [number, number, number];
const probe = typeof document === "undefined" ? null : document.createElement("canvas");
function resolve(css: string, into: HTMLElement): Rgb {
  const el = document.createElement("span");
  el.style.color = css;
  el.style.display = "none";
  into.appendChild(el);
  const value = getComputedStyle(el).color;
  el.remove();
  if (!probe) return [128, 128, 128];
  probe.width = probe.height = 1;
  const p = probe.getContext("2d", { willReadFrequently: true })!;
  p.clearRect(0, 0, 1, 1);
  p.fillStyle = value;
  p.fillRect(0, 0, 1, 1);
  const [r, g, b] = p.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}
/** The app's own shades, from its CSS: the text, the page, the quiet text, and the green it uses for a gain. */
type Palette = { ink: Rgb; fg: Rgb; bg: Rgb; muted: Rgb; faint: Rgb; up: Rgb; upMark: Rgb; down: Rgb; downMark: Rgb; dark: boolean };

const rgba = (c: Rgb, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k].map(Math.round) as Rgb;
/** How far up the ladder a multiple is, 0 at 1× to 1 at 128×. */
const height = (m: number) => Math.min(1, Math.max(0, Math.log2(m) / 7));

/** Dollars as a hit pays them: to the cent, and without the cents only when there are none. */

/** Show the maximum return per section, rounded down to a tenth. */
export const fmtMultiple = (m: number) => `${Math.floor(m * 10 + 1e-8) / 10}×`;
const fmtPrice = (p: number, cents: boolean) => p.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

export function Stage({
  game,
  onPlace,
  onPreview,
  onViewport,
  className,
}: {
  game: React.RefObject<Game>;
  /**
   * Commit the complete stroke on pointer release. Cancelled gestures
   * never debit a balance. Returns an explanation if it cannot be placed.
   */
  onPlace: (stroke: Stroke, drawing: string, done: boolean) => string | null;
  onPreview: (p: Preview | null) => void;
  onViewport: (size: { width: number; height: number }) => void;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const place = useRef(onPlace);
  const preview = useRef(onPreview);
  const viewport = useRef(onViewport);
  useEffect(() => {
    place.current = onPlace;
    preview.current = onPreview;
    viewport.current = onViewport;
  });

  useEffect(() => {
    const el = canvas.current!;
    const screen = el.getContext("2d")!;
    /*
      Layers, so the ink can sit over the chart: the chart is painted on the
      canvas, the ink on a layer of its own (its spent ink is rubbed out
      there without touching the chart), and the multiples on another, laid
      over the ink. The pen and what hits paid go on top of all of it.
    */
    const inkLayer = document.createElement("canvas");
    const labelLayer = document.createElement("canvas");
    const inkCtx = inkLayer.getContext("2d")!;
    const labelCtx = labelLayer.getContext("2d")!;
    let c = screen;
    const onLayer = (layer: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
      if (layer.width !== el.width || layer.height !== el.height) { layer.width = el.width; layer.height = el.height; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, layer.width, layer.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      c = ctx;
    };
    // Canvas cannot read CSS variables: resolve the app's face once. The phone's own first, as the page does.
    const geist = getComputedStyle(el).getPropertyValue("--font-geist").trim();
    const SANS = `-apple-system, BlinkMacSystemFont, "SF Pro Text", ${geist ? `${geist}, ` : ""}"Helvetica Neue", sans-serif`;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let pal: Palette | null = null;
    /* Read again whenever the page changes between light and dark. */
    const readPalette = (dark: boolean): Palette => ({
      ink: resolve("var(--brand)", el.parentElement ?? document.body),
      fg: resolve("var(--foreground)", el.parentElement ?? document.body),
      bg: resolve("var(--background)", el.parentElement ?? document.body),
      muted: resolve("var(--muted-foreground)", el.parentElement ?? document.body),
      faint: resolve("var(--faint)", el.parentElement ?? document.body),
      up: resolve("var(--success)", el.parentElement ?? document.body),
      upMark: resolve("var(--up-mark)", el.parentElement ?? document.body),
      downMark: resolve("var(--down-mark)", el.parentElement ?? document.body),
      down: resolve("var(--destructive)", el.parentElement ?? document.body),
      dark,
    });
    let w = 0;
    let h = 0;
    let dpr = 1;
    const size = () => {
      const r = el.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width;
      h = r.height;
      viewport.current({ width: w, height: h });
      const width = Math.round(w * dpr), height = Math.round(h * dpr);
      if (el.width !== width) el.width = width;
      if (el.height !== height) el.height = height;
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);

    /* Geometry. One scale of time for past and future, so the price runs straight into the space you draw in. */
    let centre = 0;
    let at = 0;
    const phone = () => w < 640;
    const layout = () => drawingLayout(w, h, game.current.marketStep);
    const nowX = () => layout().nowX;
    const pxMs = () => layout().pxMs;
    const pitchY = CHART_STEP_PX;
    const plotTop = () => layout().top;
    const plotBottom = () => layout().bottom;
    const middleY = () => (plotTop() + plotBottom()) / 2;
    /*
      Time, left to right. Ahead of now, and the last few seconds behind it,
      one scale, so ink runs straight into the price. Further back, the last
      minute (half a minute on a phone) squeezed into what is left, so the line
      has a shape and is seen to move.
    */
    const NEAR_MS = 4000;
    const pastMs = () => (phone() ? 30_000 : 60_000);
    const farPxMs = () => Math.max(0.0004, (nowX() - 8 - NEAR_MS * pxMs()) / (pastMs() - NEAR_MS));
    const x = (t: number) => {
      const d = at - t;
      return d <= NEAR_MS ? nowX() - d * pxMs() : nowX() - NEAR_MS * pxMs() - (d - NEAR_MS) * farPxMs();
    };
    const tAt = (px: number) => {
      const edge = nowX() - NEAR_MS * pxMs();
      return px >= edge ? at + (px - nowX()) / pxMs() : at - NEAR_MS - (edge - px) / farPxMs();
    };
    const y = (p: number) => middleY() - ((p - centre) / game.current!.step) * pitchY;
    const pAt = (py: number) => centre + ((middleY() - py) * game.current!.step) / pitchY;
    /** The pen's radius on screen: half its cell, so the ink is exactly as tall as what it is judged on. */
    const radius = () => (PEN_CELLS[game.current!.drawing?.pen ?? game.current!.pen] * CHART_STEP_PX) / 2;
    const priceRadius = () => radius() * game.current!.step / pitchY;

    /*
      The map: a grid of tiles ahead of the wait line, each the multiple a
      tap at its middle pays, from the same quotes a stroke is priced on.
      Columns are fixed distances ahead of now, as the pen sees them; rows
      are fixed prices, so they ride with the chart.
    */
    type Tile = { id: string; left: number; width: number; offset: number; p: number; rung: number; text: string; was: string; changed: number; opacity: number };
    const map = { pen: "", width: 0, height: 0, step: 0, field: null as Field | null, tiles: [] as Tile[], rowPx: 36 };
    const gPen = () => game.current!.drawing?.pen ?? game.current!.pen;
    /** Where the tiles start: the wait line, two seconds ahead, where ink always counts. */
    const WAIT_MS = 2000;
    const paintMap = (fl: Field) => {
      map.field = fl; map.pen = gPen(); map.width = w; map.height = h; map.step = game.current.step;
      const previous = new Map(map.tiles.map(tile => [tile.id, tile]));
      map.tiles = [];
      const sampledAt = now(game.current);
      const terms = areaTerms(fl, fl.openAt - 1, game.current.step, 1);
      const tap = (t: number, p: number) => {
        const q = terms.line({ t0: t, p0: p, pts: [{ t: 0, p: 0 }], rt: radius() / pxMs(), rp: priceRadius() });
        return q.inPlay.length ? Math.max(...q.inPlay.map(c => c.multiple!)) : 0;
      };
      const gap = 4;
      const pitchX = phone() ? 42 : 88;
      map.rowPx = phone() ? 36 : 46;
      const start = WAIT_MS * pxMs(), end = w - nowX() - 6;
      const cols = Math.max(1, Math.floor((end - start + gap) / pitchX));
      const width = (end - start + gap) / cols - gap;
      const rowP = map.rowPx * game.current.step / pitchY;
      const kLo = Math.floor(pAt(plotBottom()) / rowP) - 3, kHi = Math.ceil(pAt(plotTop()) / rowP) + 3;
      for (let i = 0; i < cols; i++) {
        const left = start + i * (width + gap);
        const offset = (left + width / 2) / pxMs();
        for (let k = kLo; k <= kHi; k++) {
          const p = (k + 0.5) * rowP;
          const rung = tap(sampledAt + offset, p);
          const id = `${i}:${k}`;
          const text = rung ? fmtMultiple(rung) : "";
          const old = previous.get(id);
          // A changed number fades across from the old one; it never rolls or snaps.
          const changing = !!old && old.text !== text;
          map.tiles.push({ id, left, width, offset, p, rung, text, was: changing ? old!.text : old?.was ?? text, changed: changing ? performance.now() : old?.changed ?? 0, opacity: old?.opacity ?? 0 });
        }
      }
    };

    /* The pen: the stroke so far, and what it would cost and pay. */
    type Pen = { id: number; drawing: string; last: { x: number; y: number }; stroke: Stroke; quote: Preview | null; quotedAt: number; finger: boolean; why: string | null };
    let pen: Pen | null = null;
    let hover: { x: number; y: number } | null = null;
    let keyboard = false;
    let keyboardQuote: Preview | null = null;
    let keyboardQuotedAt = 0;
    let flash: { text: string; x: number; y: number; born: number } | null = null;

    /** The terms of the game for a drawing placed now: what the pen's label says comes from the same place as what a hit pays. */
    /** Re-price the stroke being drawn, at most twenty times a second. */
    const requote = (p: Pen, force = false) => {
      const t = performance.now();
      if (!force && t - p.quotedAt < 50) return;
      const began = t;
      p.quotedAt = t;
      p.quote = game.current!.quote?.(p.stroke) ?? null;
      preview.current(p.quote);
      const ms = performance.now() - began;
      if (process.env.NODE_ENV !== "production" && ms > 50) console.warn(`[ink] slow requote: ${Math.round(ms)} ms`);
    };
    const point = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      const g = game.current;
      if (e.button !== 0 || pen || !g || !price(g) || !g.field) return;
      const q = point(e);
      if (q.x < nowX() + 4 || q.y < plotTop() || q.y > plotBottom()) return;
      keyboard = false;
      el.focus({ preventScroll: true });
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* A pointer the browser no longer tracks: drawing still works while it stays over the canvas. */
      }
      // Ink starts at now at the earliest: behind it is the past, which no drawing can bet on.
      q.x = Math.max(q.x, nowX() + 2);
      g.drawing = { step: g.step, perDot: g.perDot, pen: g.pen };
      pen = { id: e.pointerId, drawing: crypto.randomUUID(), why: null, last: q, stroke: { t0: tAt(q.x), p0: pAt(q.y), pts: [{ t: 0, p: 0 }], rt: radius() / pxMs(), rp: priceRadius() }, quote: null, quotedAt: 0, finger: e.pointerType !== "mouse" };
      requote(pen, true);
      const why = place.current(pen.stroke, pen.drawing, false);
      if (why) pen.why = why;
    };
    const move = (e: PointerEvent) => {
      if (keyboard) preview.current(null);
      keyboard = false;
      const q = point(e);
      hover = e.pointerType === "mouse" ? q : null;
      if (!pen || e.pointerId !== pen.id) return;
      q.x = Math.max(q.x, nowX() + 2);
      // Ink stays on the chart: the pen stops at its top and bottom edges.
      q.y = Math.min(plotBottom(), Math.max(plotTop(), q.y));
      // Every position the pointer passed through since the last frame, not
      // just the last one, so a fast stroke keeps its shape. A light touch of
      // smoothing takes the hand's tremor out without the nib trailing behind.
      const r = el.getBoundingClientRect();
      const trail = (e.getCoalescedEvents?.() ?? []).map(c => ({ x: c.clientX - r.left, y: c.clientY - r.top }));
      let moved = false;
      for (const raw of [...trail.slice(0, -1), q]) {
        const at = { x: Math.max(raw.x, nowX() + 2), y: Math.min(plotBottom(), Math.max(plotTop(), raw.y)) };
        const s = { x: pen.last.x + (at.x - pen.last.x) * 0.85, y: pen.last.y + (at.y - pen.last.y) * 0.85 };
        if (pen.stroke.pts.length >= 2048) break;
        if (Math.hypot(s.x - pen.last.x, s.y - pen.last.y) < 1.5) continue;
        pen.last = s;
        pen.stroke.pts.push({ t: tAt(s.x) - pen.stroke.t0, p: pAt(s.y) - pen.stroke.p0 });
        moved = true;
      }
      if (!moved) return;
      const s = pen.last;
      requote(pen);
      // Ink is bet as it is drawn, not when the pen lifts.
      const why = place.current(pen.stroke, pen.drawing, false);
      if (why && why !== pen.why) {
        pen.why = why;
        flash = { text: why, x: s.x, y: s.y, born: performance.now() };
      }
    };
    const up = (e: PointerEvent) => {
      if (!pen || e.pointerId !== pen.id) return;
      const p = pen;
      pen = null;
      const q = point(e);
      q.x = Math.max(q.x, nowX() + 2);
      q.y = Math.min(plotBottom(), Math.max(plotTop(), q.y));
      // A tap remains a single dot, even while the market clock advances.
      if (Math.hypot(q.x - p.last.x, q.y - p.last.y) > 1.5 && p.stroke.pts.length < 2048)
        p.stroke.pts.push({ t: tAt(q.x) - p.stroke.t0, p: pAt(q.y) - p.stroke.p0 });
      preview.current(null);
      const why = place.current(p.stroke, p.drawing, true);
      game.current.drawing = undefined;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (why && why !== p.why) flash = { text: why, x: q.x, y: q.y, born: performance.now() };
    };
    const cancel = () => {
      keyboard = false;
      if (pen && el.hasPointerCapture(pen.id)) el.releasePointerCapture(pen.id);
      game.current.drawing = undefined;
      pen = null;
      preview.current(null);
    };
    const leave = () => {
      if (!keyboard) hover = null;
    };
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { cancel(); hover = null; return; }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " "].includes(e.key)) return;
      e.preventDefault();
      if (pen || e.repeat && (e.key === "Enter" || e.key === " ")) return;
      const g = game.current;
      if (!g.field) return;
      const tip = hover ?? { x: nowX() + (w - nowX()) * 0.5, y: middleY() };
      const move = e.shiftKey ? 30 : 8;
      hover = { x: Math.min(w - radius(), Math.max(x(openFor(now(g)) + 1000) + radius(), tip.x + (e.key === "ArrowLeft" ? -move : e.key === "ArrowRight" ? move : 0))), y: Math.min(plotBottom(), Math.max(plotTop(), tip.y + (e.key === "ArrowUp" ? -move : e.key === "ArrowDown" ? move : 0))) };
      const st = { t0: tAt(hover.x), p0: pAt(hover.y), pts: [{ t: 0, p: 0 }], rt: radius() / pxMs(), rp: priceRadius() };
      if (e.key === "Enter" || e.key === " ") {
        keyboard = false;
        const why = place.current(st, crypto.randomUUID(), true);
        if (why) flash = { text: why, ...hover, born: performance.now() };
        preview.current(null);
      } else {
        keyboard = true;
        keyboardQuotedAt = 0;
      }
    };
    const blur = () => { if (!pen) { keyboard = false; hover = null; preview.current(null); } };
    el.addEventListener("keydown", keydown);
    el.addEventListener("blur", blur);
    // For tests in development: where on screen a moment and a price are.
    if (process.env.NODE_ENV !== "production") (window as unknown as { __stage?: unknown }).__stage = { x, y, tAt, pAt, nowX, pitchY: () => pitchY };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("pointerleave", leave);

    /**
     * A stroke, in ink. Drawn in its own units, where the pen is round, and
     * scaled onto the screen, so it is the same shape whatever the zoom: a
     * stroke drawn when a step was 20 pixels tall still covers the same
     * prices when it is 30.
     */
    const ink = (st: Stroke, style: string, grow = 0, on: CanvasRenderingContext2D = c) => {
      const a = st.rt * pxMs();
      const d = (-st.rp * pitchY) / game.current!.step;
      const c = on;
      c.save();
      c.setTransform(dpr * a, 0, 0, dpr * d, dpr * x(st.t0), dpr * y(st.p0));
      c.beginPath();
      const pts = st.pts.map((q) => ({ u: q.t / st.rt, v: q.p / st.rp }));
      c.moveTo(pts[0].u, pts[0].v);
      // Pointer smoothing already happens before storing points. Render exactly
      // the rounded capsules used to price the area, without curving away.
      for (let i = 1; i < pts.length - 1; i++) c.lineTo(pts[i].u, pts[i].v);
      const end = pts[pts.length - 1];
      c.lineTo(end.u + (pts.length === 1 ? 1e-3 : 0), end.v);
      c.lineCap = "round";
      c.lineJoin = "round";
      c.lineWidth = 2 + grow;
      c.strokeStyle = style;
      c.stroke();
      c.restore();
    };
    // Merge paid bands, including the same edge margin used in pricing.
    // Clip the original round nib once against their union: independently
    // rounding each second would put visible seams back into the stroke.
    const bandCache = new WeakMap<Cell[], { pad: number; bands: Cell[] }>();
    const inkInPlay = (st: Stroke, cells: Cell[], style: string, edgeCells = 0, step = game.current.step) => {
      if (!cells.length) return;
      const pad = edgeCells * step * INK_CELL;
      let cached = bandCache.get(cells);
      if (!cached || cached.pad !== pad) {
        const bands: Cell[] = [];
        for (const q of [...cells].sort((a, b) => a.t - b.t || a.lo - b.lo)) {
          const last = bands.at(-1);
          if (last && last.t === q.t && q.lo - pad <= last.hi) last.hi = Math.max(last.hi, q.hi + pad);
          else bands.push({ ...q, lo: q.lo - pad, hi: q.hi + pad });
        }
        cached = { pad, bands };
        bandCache.set(cells, cached);
      }
      c.save();
      c.beginPath();
      for (const q of cached.bands) {
        const left = x(q.t), top = y(q.hi), wide = pxMs() * 1000, tall = y(q.lo) - top;
        c.rect(left, top, wide, tall);
      }
      c.clip();
      ink(st, style);
      c.restore();
    };
    /*
      Where the price met the ink, it glows: the stroke drawn again in
      green on a layer of its own, kept only in soft spots around each place
      the price crossed it, and laid over the ink. No edges, and nowhere the
      price did not go.
    */
    const glowLayer = document.createElement("canvas");

    let renderedBets: InkBet[] | null = null;
    let renderedGroups: { id: string; stroke: Stroke; cells: Cell[]; edgeCells: number; step: number }[] = [];
    let raf = 0;
    let previousFrame = performance.now();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const began = performance.now();
      try {
        draw();
      } finally {
        const ms = performance.now() - began;
        if (process.env.NODE_ENV !== "production" && ms > 50) console.warn(`[ink] slow frame: ${Math.round(ms)} ms (w ${Math.round(w)} pitchY ${pitchY.toFixed(1)} bets ${game.current?.bets.length} pen ${pen ? pen.stroke.pts.length : 0})`);
      }
    };
    const draw = () => {
      const g = game.current;
      if (!g || !w) return;
      at = now(g);
      const latest = price(g);
      const ms = performance.now();
      const dt = Math.min(64, Math.max(0, ms - previousFrame));
      previousFrame = ms;
      const ease = (rate: number) => reducedMotion.matches ? 1 : 1 - Math.exp(-rate * dt);
      // Paint the newest trade immediately. Camera easing is independent;
      // never add synthetic lag to the market price itself.
      const p = latest;
      c = screen;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      if (!p) return;
      const dark = g.dark;
      if (!pal || pal.dark !== dark) pal = readPalette(dark);
      const rgb = pal.fg.join(",");
      const solid = rgba(pal.ink, 0.92);
      const green = rgba(pal.up);
      // Follow the price, gently: fast when it is leaving the screen, barely at all near the middle.
      if (!centre) centre = p;
      const off = (p - centre) / g.step;
      const rowsOnScreen = (plotBottom() - plotTop()) / pitchY;
      if (!pen) centre += (p - centre) * ease(Math.abs(off) > rowsOnScreen * 0.3 ? 0.0077 : Math.abs(off) > rowsOnScreen * 0.12 ? 0.00183 : 0.00036);
      const fl = g.field;
      if (fl) {
        /*
          Keep the responsive camera independent of brush-dependent offers.
          Rebuild the tiles when viewport geometry changes. Drawing locks
          the camera so a stroke cannot move underneath the pointer.
        */
        if (map.field !== fl || map.pen !== gPen() || map.width !== w || map.height !== h || map.step !== g.step) paintMap(fl);
      }
      const nx = nowX();

      onLayer(inkLayer, inkCtx);
      /*
        The ink first, so it can be softened and rubbed out before anything
        else is drawn. Ink is solid while it is in play; ink that is not
        (too soon, or too far to measure) fades out softly.
      */
      // Rebuild accepted geometry on market/settlement updates, not at 60fps.
      if (renderedBets !== g.bets) {
        renderedBets = g.bets;
        const groups = new Map<string, typeof renderedGroups[number]>();
        for (const bet of g.bets) {
          if (bet.status === "void") continue;
          const id = bet.group ?? bet.id;
          let group = groups.get(id);
          if (!group) groups.set(id, group = { id, stroke: bet.stroke, cells: [], edgeCells: bet.edgeCells ?? 0, step: bet.step });
          // A drawing bet as it was drawn: each piece carries the stroke so far; draw the longest.
          else if (bet.stroke.pts.length > group.stroke.pts.length) group.stroke = bet.stroke;
          group.cells.push(...(bet.status === "opening" ? bet.drawn : bet.cells));
        }
        renderedGroups = [...groups.values()];
      }
      for (const group of renderedGroups) {
        if (group.id !== pen?.drawing) {
          // Only ink in play is drawn: nothing marks what was refunded.
          inkInPlay(group.stroke, group.cells, solid, group.edgeCells, group.step);
        }
      }
      if (pen) {
        // Ink shows the moment it is drawn, solid wherever it can be in play,
        // without waiting on a quote: it is bet as it is drawn. Ink too soon
        // to count (before the first second a piece can open on) stays faint.
        const from = x(openFor(at) + 1000);
        c.save();
        c.beginPath();
        c.rect(from, 0, w - from, h);
        c.clip();
        ink(pen.stroke, solid);
        c.restore();
        c.save();
        c.beginPath();
        c.rect(0, 0, from, h);
        c.clip();
        ink(pen.stroke, rgba(pal.ink, 0.3));
        c.restore();
      }
      // Keep settled cells in the mask; deleting misses tears holes in the stroke.
      // Ink the price has passed is spent: it ends at the price line. Faded
      // over the chart behind it, it read as a smudge, not as ink.
      c.save();
      c.globalCompositeOperation = "destination-out";
      c.fillStyle = "#000";
      c.fillRect(0, 0, nx, h);
      c.restore();
      // Ink the price missed turns red as the price passes it, and fades, as a hit glows green.
      for (const bet of g.bets) {
        const misses = bet.cells.filter((q) => q.status === "miss" && at - (q.t + 1000) < 2200);
        if (!misses.length) continue;
        const pad = (bet.edgeCells ?? 0) * bet.step * INK_CELL;
        const age = Math.max(0, Math.min(1, (at - (Math.max(...misses.map((q) => q.t)) + 1000)) / 2200));
        c.save();
        c.beginPath();
        for (const q of misses) c.rect(x(q.t), y(q.hi + pad), pxMs() * 1000, y(q.lo - pad) - y(q.hi + pad));
        c.clip();
        c.globalAlpha = 1 - age * age;
        ink(bet.stroke, rgba(pal.down, 0.5));
        c.restore();
      }
      // Where the price ran through the ink, it glows green for a moment: there, and nowhere else.
      for (const bet of g.bets) {
        const hits = bet.cells.filter((q) => q.status === "hit" && at - (q.t + 1000) < 2200);
        if (!hits.length) continue;
        if (glowLayer.width !== el.width || glowLayer.height !== el.height) {
          glowLayer.width = el.width;
          glowLayer.height = el.height;
        }
        const gl = glowLayer.getContext("2d")!;
        gl.setTransform(1, 0, 0, 1, 0, 0);
        gl.clearRect(0, 0, glowLayer.width, glowLayer.height);
        ink(bet.stroke, green, 0.35, gl);
        gl.save();
        gl.globalCompositeOperation = "destination-in";
        gl.setTransform(dpr, 0, 0, dpr, 0, 0);
        for (const q of hits) {
          const lo = Math.max(q.lo, q.range?.[0] ?? q.lo);
          const hi = Math.min(q.hi, q.range?.[1] ?? q.hi);
          // Only the band the price crossed, a pen's width either side of
          // it, across the second it crossed in. Wider, it lit ink the price
          // never reached, and a mostly missed stroke read as a win.
          const cx = x(q.t + 500);
          const cy = (y(lo) + y(hi)) / 2;
          const rx = pxMs() * 600;
          const ry = Math.max(4, (y(lo) - y(hi)) / 2) + radius();
          gl.save();
          gl.translate(cx, cy);
          gl.scale(rx / ry, 1);
          const spot = gl.createRadialGradient(0, 0, 0, 0, 0, ry);
          spot.addColorStop(0, "rgba(0,0,0,1)");
          spot.addColorStop(0.7, "rgba(0,0,0,0.9)");
          spot.addColorStop(1, "rgba(0,0,0,0)");
          gl.fillStyle = spot;
          gl.fillRect(-ry, -ry, ry * 2, ry * 2);
          gl.restore();
        }
        gl.restore();
        // Only ink the price has reached: a hit in the second under way does
        // not light the part of it still ahead of the price.
        gl.save();
        gl.globalCompositeOperation = "destination-out";
        gl.setTransform(dpr, 0, 0, dpr, 0, 0);
        gl.fillRect(nx, 0, w - nx, h);
        gl.restore();
        const age = Math.max(0, Math.min(1, (at - (Math.max(...hits.map((q) => q.t)) + 1000)) / 2200));
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalAlpha = 1 - age * age;
        c.drawImage(glowLayer, 0, 0);
        c.restore();
      }

      /* Where the pen is, and the price's own tag: a tile under either is picked out, or kept clear. */
      const tip = pen ? pen.last : hover && hover.x > nx ? hover : null;
      const py = y(p);
      c.font = `600 12px ${SANS}`;
      const tagText = fmtPrice(g.displayPrice || latest, true);
      const tagW = c.measureText(tagText).width + 20;
      const tag = { x0: nx + 12, x1: nx + 12 + tagW, y0: py - 12, y1: py + 12 };
      const tileBox = (tile: Tile) => {
        const ty = y(tile.p);
        return { x0: nx + tile.left, y0: ty - map.rowPx / 2 + 2, w: tile.width, h: map.rowPx - 4 };
      };
      const tiles = fl && map.field === fl ? map.tiles : [];
      // Ease every tile toward whether it shows: on the chart, clear of the price's tag, and with a multiple.
      for (const tile of tiles) {
        const b = tileBox(tile);
        // Whole tiles only: one cut by the chart's edge reads as a mistake.
        const onChart = b.y0 >= plotTop() && b.y0 + b.h <= plotBottom();
        const underTag = b.x0 < tag.x1 + 4 && b.x0 + b.w > tag.x0 - 4 && b.y0 < tag.y1 + 4 && b.y0 + b.h > tag.y0 - 4;
        const visible = onChart && tile.rung ? underTag ? 0.12 : 1 : 0;
        tile.opacity += (visible - tile.opacity) * ease(0.012);
      }
      const underPen = tip ? tiles.find(tile => { const b = tileBox(tile); return tile.rung && tip.x >= b.x0 - 2 && tip.x <= b.x0 + b.w + 2 && tip.y >= b.y0 - 2 && tip.y <= b.y0 + b.h + 2; }) : undefined;

      // The multiples, over the ink.
      onLayer(labelLayer, labelCtx);
      if (tiles.length) {
        c.save();
        c.beginPath();
        c.rect(0, plotTop(), w, plotBottom() - plotTop());
        c.clip();
        if (underPen) {
          const b = tileBox(underPen);
          roundRect(c, b.x0 - 1, b.y0 - 1, b.w + 2, b.h + 2, phone() ? 10 : 13);
          c.fillStyle = rgba(pal.ink, 0.14);
          c.fill();
          c.strokeStyle = rgba(pal.ink);
          c.lineWidth = 1.5;
          c.stroke();
        }
        c.textAlign = "center";
        c.textBaseline = "middle";
        const size = phone() ? 11 : 14;
        for (const tile of tiles) {
          if (tile.opacity < 0.01) continue;
          const b = tileBox(tile);
          const k = reducedMotion.matches ? 1 : Math.min(1, (ms - tile.changed) / 260);
          const eased = k * k * (3 - 2 * k);
          const write = (text: string, alpha: number) => {
            if (alpha < 0.01 || !text) return;
            const m = parseFloat(text);
            c.font = `${m >= 8 ? 600 : 500} ${size}px ${SANS}`;
            c.globalAlpha = tile.opacity * alpha;
            c.fillStyle = rgba(mix(pal!.faint, pal!.ink, height(m)));
            c.fillText(text, b.x0 + b.w / 2, b.y0 + b.h / 2 + 0.5);
          };
          if (tile.was !== tile.text && eased < 1) write(tile.was, 1 - eased);
          write(tile.text, tile.was !== tile.text ? eased : 1);
        }
        c.globalAlpha = 1;
        c.restore();
      }

      c = screen;
      // The tiles themselves, under everything but the page: bluer where a hit pays more.
      if (tiles.length) {
        c.save();
        c.beginPath();
        c.rect(0, plotTop(), w, plotBottom() - plotTop());
        c.clip();
        const top = dark ? 0.12 : 0.072;
        for (const tile of tiles) {
          if (tile.opacity < 0.01) continue;
          const b = tileBox(tile);
          roundRect(c, b.x0, b.y0, b.w, b.h, phone() ? 9 : 12);
          c.fillStyle = rgba(pal.ink, top * Math.pow(height(tile.rung), 0.6) * tile.opacity);
          c.fill();
        }
        c.restore();
      }

      /*
        The price, live: one line through every trade on hand, and each
        second's close before them, ending at the latest trade immediately.
        Shape-preserving curves soften corners without creating new extrema.
        A plain line in the text colour, as a pen would draw it.
      */
      {
        const from = tAt(0);
        const firstTick = g.ticks[0]?.t ?? Number.POSITIVE_INFINITY;
        const line: { x: number; y: number }[] = [];
        for (const bar of g.bars) {
          if (bar.t >= firstTick) break;
          if (bar.t + 1000 >= from) line.push({ x: x(bar.t + 1000), y: y(bar.c) });
        }
        let lastX = Number.NEGATIVE_INFINITY;
        for (const tk of g.ticks) {
          if (tk.t < from || tk.t > at) continue;
          const px = x(tk.t);
          // Far back, many trades land on one pixel: the last of them stands for it.
          if (px - lastX < 0.75 && line.length) line[line.length - 1] = { x: px, y: y(tk.p) };
          else line.push({ x: px, y: y(tk.p) });
          lastX = px;
        }
        line.push({ x: nx, y: y(p) });
        if (line.length > 1) {
          const path = new Path2D();
          tracePricePath(path, line);
          c.lineJoin = "round";
          c.lineCap = "round";
          c.strokeStyle = rgba(pal.fg);
          c.lineWidth = 2;
          c.stroke(path);
        }
      }

      // Now: a line top to bottom, and the price on it, in a tag of its own.
      const axisY = plotBottom() + 14;
      c.fillStyle = rgba(pal.fg, 0.16);
      c.fillRect(Math.round(nx) - 0.5, 0, 1, axisY);
      const pulse = reducedMotion.matches ? 0 : (ms % 1400) / 1400;
      c.beginPath();
      c.arc(nx, py, 10 + pulse * 6, 0, Math.PI * 2);
      c.fillStyle = rgba(pal.fg, 0.12 * (1 - pulse * 0.6));
      c.fill();
      c.beginPath();
      c.arc(nx, py, 4.5, 0, Math.PI * 2);
      c.fillStyle = rgba(pal.fg);
      c.fill();
      c.font = `600 12px ${SANS}`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      roundRect(c, tag.x0, tag.y0, tagW, 24, 12);
      c.fillStyle = rgba(pal.fg);
      c.fill();
      c.fillStyle = rgba(pal.bg);
      c.fillText(tagText, tag.x0 + tagW / 2, py + 0.5);

      // Seconds ahead, along the foot: a tick each second, a longer one every five.
      c.fillStyle = rgba(pal.faint);
      for (let s = 0; s <= VIEW_SECONDS; s++) {
        const tx = Math.round(nx + s * 1000 * pxMs()) + 0.5;
        const major = s % 5 === 0;
        c.fillRect(tx - 0.5, axisY - (major ? 8 : 4), 1, major ? 8 : 4);
      }
      c.font = `400 11px ${SANS}`;
      c.fillStyle = rgba(pal.muted);
      for (let s = 0; s <= VIEW_SECONDS; s += 5) c.fillText(s ? `${s}s` : "Now", nx + s * 1000 * pxMs(), axisY + 14);

      // The ink over the chart, and the multiples over the ink.
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(inkLayer, 0, 0);
      c.drawImage(labelLayer, 0, 0);
      c.restore();
      // The pen: a soft ring around the nib, and the nib.
      if (tip) {
        c.beginPath();
        c.arc(tip.x, tip.y, Math.max(18, radius() + 8), 0, Math.PI * 2);
        c.fillStyle = rgba(pal.ink, pen ? 0.16 : 0.1);
        c.fill();
        c.beginPath();
        c.arc(tip.x, tip.y, 6.5, 0, Math.PI * 2);
        c.fillStyle = rgba(pal.bg);
        c.fill();
        c.strokeStyle = rgba(pal.ink);
        c.lineWidth = 3;
        c.stroke();
        const hoverStroke: Stroke = { t0: tAt(tip.x), p0: pAt(tip.y), pts: [{ t: 0, p: 0 }], rt: radius() / pxMs(), rp: priceRadius() };
        if (keyboard && ms - keyboardQuotedAt >= 100) {
          keyboardQuotedAt = ms;
          const q = g.quote?.(hoverStroke) ?? null;
          keyboardQuote = q ? { ...q, keyboard: true } : null;
          preview.current(keyboardQuote);
        }

      }

      // The first time: a dotted stroke ahead of the price, where to draw, and the spot it ends on.
      if (g.hint && !pen) {
        const x0 = nx + WAIT_MS * pxMs() + radius() + 4;
        const x1 = nx + (w - nx) * 0.72;
        const along = (f: number) => ({ px: x0 + (x1 - x0) * f, py: py - Math.min(pitchY * 1.5, h * 0.16) * Math.sin(f * Math.PI * 1.3) - f * h * 0.08 });
        c.beginPath();
        for (let f = 0; f <= 1.0001; f += 0.01) {
          const q = along(f);
          if (f === 0) c.moveTo(q.px, q.py);
          else c.lineTo(q.px, q.py);
        }
        c.save();
        c.setLineDash([0.001, 18]);
        c.lineDashOffset = reducedMotion.matches ? 0 : -((ms / 40) % 18);
        c.strokeStyle = rgba(pal.ink, 0.55);
        c.lineWidth = Math.max(8, radius() * 2);
        c.lineCap = "round";
        c.lineJoin = "round";
        c.stroke();
        c.restore();
        const q = along(1);
        c.beginPath();
        c.arc(q.px, q.py, 20, 0, Math.PI * 2);
        c.fillStyle = rgba(pal.ink, 0.1);
        c.fill();
        c.beginPath();
        c.arc(q.px, q.py, 11, 0, Math.PI * 2);
        c.strokeStyle = rgba(pal.ink, 0.6);
        c.lineWidth = 2;
        c.stroke();
      }

      // Hits burst and float what they paid; a drawing pops once when it goes in.
      g.fx = g.fx.filter((e) => ms - e.born < 1500);
      c.textAlign = "center";
      for (const e of g.fx) {
        const age = (ms - e.born) / 1500;
        const ex = x(e.t);
        const ey = y(e.price);
        if (e.kind === "hit") {
          // Two rings open out from where the price met the ink, and a spray of dots.
          const grow = reducedMotion.matches ? 1 : 0.6 + age * 0.8;
          c.lineWidth = 2;
          c.strokeStyle = rgba(pal.up, 0.5 * (1 - age));
          c.beginPath(); c.arc(ex, ey, (e.big ? 34 : 26) * grow, 0, Math.PI * 2); c.stroke();
          c.lineWidth = 1.2;
          c.strokeStyle = rgba(pal.up, 0.25 * (1 - age));
          c.beginPath(); c.arc(ex, ey, (e.big ? 52 : 40) * grow, 0, Math.PI * 2); c.stroke();
          const n = reducedMotion.matches ? 0 : e.big ? 22 : 14;
          c.fillStyle = green;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + e.born;
            const d = (e.big ? 44 : 30) * (0.55 + 0.45 * ((i * 7919) % 11) / 11) * Math.min(1, age * 2.2);
            c.globalAlpha = 1 - age;
            c.beginPath();
            c.arc(ex + Math.cos(a) * d, ey + Math.sin(a) * d, (1.8 + (i % 3) * 0.6) * (1 - age * 0.6), 0, Math.PI * 2);
            c.fill();
          }
          // The drawing's running result, in a pill over where it was won: green ahead, red behind.
          if (e.text) {
            c.globalAlpha = Math.max(0, Math.min(1, 1.6 - age * 1.6));
            c.font = `700 ${e.big ? 17 : 15}px ${SANS}`;
            const tw = c.measureText(e.text).width + 24;
            const cx = Math.min(w - tw / 2 - 8, Math.max(tw / 2 + 8, Math.max(ex, nx)));
            const cy = ey - 62 - (reducedMotion.matches ? 0 : age * 24);
            roundRect(c, cx - tw / 2, cy - 14, tw, 28, 14);
            c.fillStyle = e.loss ? rgba(pal.down) : green;
            c.fill();
            c.fillStyle = "#ffffff";
            c.textBaseline = "middle";
            c.fillText(e.text, cx, cy + 0.5);
          }
          c.globalAlpha = 1;
        } else {
          c.beginPath();
          c.arc(ex, ey, 8 + (reducedMotion.matches ? 0 : 20 * (1 - (1 - age) ** 3)), 0, Math.PI * 2);
          c.strokeStyle = `rgba(${rgb},${0.4 * (1 - age)})`;
          c.lineWidth = 1.5;
          c.stroke();
        }
      }

      // Why a drawing did not go in, where the pen was.
      if (flash) {
        const age = (ms - flash.born) / 1700;
        if (age >= 1) flash = null;
        else {
          c.font = `600 12px ${SANS}`;
          const tw = c.measureText(flash.text).width + 22;
          const fx = Math.min(w - tw / 2 - 8, Math.max(tw / 2 + 8, flash.x));
          roundRect(c, fx - tw / 2, flash.y - 46, tw, 28, 14);
          c.fillStyle = rgba(pal.fg, 0.95 * (1 - age * age));
          c.fill();
          c.fillStyle = rgba(pal.bg, 1 - age * age);
          c.fillText(flash.text, fx, flash.y - 31.5);
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancel();
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("keydown", keydown);
      el.removeEventListener("blur", blur);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("pointerleave", leave);
    };
  }, [game]);

  return <canvas aria-label="Draw ahead of the price. Arrow keys move the pen; Enter places a dot; Escape cancels." className={`${className ?? ""} focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring`} ref={canvas} role="img" tabIndex={0} style={{ touchAction: "none", cursor: "none" }} />;
}
