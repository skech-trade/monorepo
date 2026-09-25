"use client";

import { useEffect, useRef } from "react";
import { type Bar, type Field, openFor, rowOf } from "@skech/core/dots";
import { drawingLayout, INK_CELL, VIEW_SECONDS, CHART_STEP_PX, CHART_LINE_PX, PEN_CELLS, type Cell, type InkBet, type Pen, type Stroke } from "@skech/core/ink";
import { roundedTerms as areaTerms } from "@skech/core/odds";
import type { Tick } from "@/lib/coinbase";
import { tracePricePath } from "./price-path";

/**
 * The stage: the price so far on the left, now in the middle, and the space
 * ahead of it to draw in.
 *
 * The space is a map of the odds: dark and cool where the price will likely
 * go, warming the further out you look, with the multiples written along it.
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
type Palette = { ink: Rgb; fg: Rgb; bg: Rgb; muted: Rgb; up: Rgb; upMark: Rgb; down: Rgb; downMark: Rgb; dark: boolean };

const rgba = (c: Rgb, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

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
    // Canvas cannot read CSS variables: resolve the app's two families once.
    const css = getComputedStyle(el);
    const MONO = css.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
    const SANS = css.getPropertyValue("--font-sans").trim() || "system-ui, sans-serif";
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let pal: Palette | null = null;
    /* Read again whenever the page changes between light and dark. */
    const readPalette = (dark: boolean): Palette => ({
      ink: resolve("var(--brand)", el.parentElement ?? document.body),
      fg: resolve("var(--foreground)", el.parentElement ?? document.body),
      bg: resolve("var(--background)", el.parentElement ?? document.body),
      muted: resolve("var(--muted-foreground)", el.parentElement ?? document.body),
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

    // Screen-spaced freehand guides. Each number is the same circular-nib
    // quote used by the hover preview, including partial-area eligibility.
    type MapLabel = { id: string; offset: number; p: number; py: number; low: number; high: number; text: string; was: string; changed: number; opacity: number };
    /** The glow under the map: how likely each spot is, as a coarse grid of the same quotes, smoothed when drawn. */
    type Shade = { cols: number; rows: number; v: Float32Array; t0: number; t1: number; pTop: number; pBottom: number; image: HTMLCanvasElement | null; dark: boolean | null };
    const map = { pen: "", width: 0, height: 0, step: 0, field: null as Field | null,
      labels: [] as MapLabel[], shade: null as Shade | null, was: null as Shade | null, shadeAt: 0 };
    const gPen = () => game.current!.drawing?.pen ?? game.current!.pen;
    const paintMap = (fl: Field) => {
      map.field = fl; map.pen = gPen(); map.width = w; map.height = h; map.step = game.current.step;
      const previous = new Map(map.labels.map(label => [label.id, label]));
      map.labels = [];
      const sampledAt = now(game.current);
      const terms = areaTerms(fl, fl.openAt - 1, game.current.step, 1);
      const anchor = fl.f.price;
      const tap = (t: number, p: number) => {
        const q = terms.line({ t0: t, p0: p, pts: [{ t: 0, p: 0 }], rt: radius() / pxMs(), rp: priceRadius() });
        return q.inPlay.length ? Math.max(...q.inPlay.map(c => c.multiple!)) : 0;
      };
      /*
        The glow: every second across and every ten pixels up and down,
        what a tap there pays, turned into brightness. Dark on the price, where
        a tap is likely and pays little; brighter as the rung climbs to 128x,
        so the glow shows how much you would get. The same quotes as the
        numbers, so the two cannot disagree.
      */
      {
        const rowStep = game.current.step * 10 / pitchY;
        const pTop = pAt(plotTop()) + rowStep, pBottom = pAt(plotBottom()) - rowStep;
        const rows = Math.max(2, Math.ceil((pTop - pBottom) / rowStep) + 1);
        const t0 = 1500, t1 = (VIEW_SECONDS + 1.5) * 1000;
        const cols = Math.max(2, Math.round((t1 - t0) / 1000) + 1);
        const v = new Float32Array(cols * rows);
        for (let i = 0; i < cols; i++) {
          const t = sampledAt + t0 + (i * (t1 - t0)) / (cols - 1);
          for (let j = 0; j < rows; j++) {
            const rung = tap(t, pTop - j * rowStep);
            // Faint at 1.1x, rising with every doubling to full at 128x.
            v[j * cols + i] = rung ? Math.min(1, Math.max(0, Math.log2(rung) / 7)) : 0;
          }
        }
        // Soften the steps between rungs and the noise of the quotes: a few box
        // passes, wider up and down than across, read as a smooth glow.
        const blur = (rx: number, ry: number) => {
          const out = new Float32Array(v.length);
          for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
            let sum = 0, n = 0;
            for (let dj = -ry; dj <= ry; dj++) for (let di = -rx; di <= rx; di++) {
              const jj = j + dj, ii = i + di;
              if (jj < 0 || jj >= rows || ii < 0 || ii >= cols) continue;
              sum += v[jj * cols + ii]; n++;
            }
            out[j * cols + i] = sum / n;
          }
          v.set(out);
        };
        blur(1, 2); blur(1, 2); blur(0, 1);
        // The last glow fades out under the new one, rather than being swapped.
        map.was = map.shade;
        map.shadeAt = performance.now();
        map.shade = { cols, rows, v, t0, t1, pTop, pBottom, image: null, dark: null };
      }
      /*
        The numbers: three columns, and only the doubling rungs (2x, 4x, 8x
        ... 128x) plus whatever the price's own band pays, far enough apart to
        read. The glow carries the rest.
      */
      const scan = game.current.step * 4 / pitchY;
      const low = Math.floor((pAt(plotBottom()) - anchor) / scan);
      const high = Math.ceil((pAt(plotTop()) - anchor) / scan);
      const doubling = (rung: number) => Number.isInteger(Math.log2(rung));
      for (const second of phone() ? [4, 11] : [3, 8, 13]) {
        // Stable future columns: do not scroll for a second then snap back.
        const offset = (second + 1.5) * 1000;
        const t = sampledAt + offset;
        let run: { rung: number; from: number; to: number } | null = null;
        const runs: { rung: number; from: number; to: number }[] = [];
        for (let k = low; k <= high; k++) {
          const p = anchor + k * scan;
          const rung = tap(t, p);
          if (run && run.rung === rung) run.to = p;
          else runs.push(run = { rung, from: p, to: p });
        }
        // Walk outward from the price on each side, labelling each doubling
        // band that has room from the last label.
        const gap = 34 / pitchY * game.current.step;
        const middle = runs.findIndex(r => r.from <= anchor && r.to >= anchor);
        const keep = new Set<number>();
        if (middle >= 0) keep.add(middle);
        for (const dir of [1, -1]) {
          // Each rung once per side: noise can split one band in two.
          const shown = new Set<number>(middle >= 0 ? [runs[middle].rung] : []);
          let last = middle >= 0 ? (runs[middle].from + runs[middle].to) / 2 : anchor;
          for (let i = (middle >= 0 ? middle + dir : dir > 0 ? runs.findIndex(r => r.from > anchor) : runs.findIndex(r => r.from > anchor) - 1); i >= 0 && i < runs.length; i += dir) {
            if (!doubling(runs[i].rung) || shown.has(runs[i].rung)) continue;
            const at = (runs[i].from + runs[i].to) / 2;
            if (Math.abs(at - last) < gap) continue;
            keep.add(i);
            shown.add(runs[i].rung);
            last = at;
          }
        }
        runs.forEach((r, i) => {
          if (!keep.has(i)) return;
          const p = (r.from + r.to) / 2;
          // The same rung on the same side keeps its label, so it eases rather than jumps.
          const side = r.to < anchor ? "below" : r.from > anchor ? "above" : "on";
          const id = `${second}:${r.rung}:${side}:${runs.filter((o, j) => j < i && o.rung === r.rung).length}`;
          const text = r.rung ? fmtMultiple(r.rung) : "—";
          const old = previous.get(id);
          // A changed number fades across from the old one; it never rolls or snaps.
          const changing = !!old && old.text !== text;
          map.labels.push({ id, offset, p, py: old?.py ?? y(p), low: r.rung, high: r.rung, text,
            was: changing ? old!.text : old?.was ?? text, changed: changing ? performance.now() : old?.changed ?? 0, opacity: old?.opacity ?? 0 });
        });
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
      const solid = rgba(pal.ink, 0.96);
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
          Rebuild the labels when viewport geometry changes. Drawing locks
          the camera so a stroke cannot move underneath the pointer.
        */
        if (map.field !== fl || map.pen !== gPen() || map.width !== w || map.height !== h || map.step !== g.step) paintMap(fl);
      }
      const nx = nowX();
      const step = g.step;
      const first = openFor(at) + 1000;

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
        ink(bet.stroke, rgba(pal.down, 0.9));
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

      // The map of the odds, over the ink, from the second a drawing can start.
      onLayer(labelLayer, labelCtx);
      if (fl && map.field === fl) {
        c.save();
        c.beginPath();
        c.rect(x(first), plotTop(), w - x(first), plotBottom() - plotTop());
        c.clip();
        c.font = `500 ${phone() ? 11 : 14}px ${MONO}`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        for (const l of map.labels) {
          const lx = nx + l.offset * pxMs();
          l.py += (y(l.p) - l.py) * ease(0.022);
          const ly = l.py;
          // Fade at the plot edges and around the live tag instead of blinking off.
          const edge = Math.max(0, Math.min(1, (ly - plotTop() - 8) / 16, (plotBottom() - 8 - ly) / 16));
          const tag = lx < nx + 110 ? Math.min(1, Math.max(0, (Math.abs(ly - y(p)) - 16) / 16)) : 1;
          const visible = lx < x(first) + 22 || lx > w - 28 ? 0 : edge * tag;
          l.opacity += (visible - l.opacity) * ease(0.025);
          if (l.opacity < 0.001) continue;
          // Every label is re-quoted each second, all at once: a new value
          // simply replaces the old one. Rolling digits made the whole map
          // flicker mid-roll once a second.
          const k = reducedMotion.matches ? 1 : Math.min(1, (ms - l.changed) / 260);
          const eased = k * k * (3 - 2 * k);
          const write = (text: string, alpha: number) => {
            if (alpha < 0.01) return;
            const tone = pal!;
            c.globalAlpha = l.opacity * alpha;
            c.strokeStyle = rgba(tone.bg, 0.85);
            c.lineWidth = 4;
            c.strokeText(text, lx, ly);
            c.fillStyle = rgba(text !== "—" ? tone.ink : tone.muted, text !== "—" ? 0.46 : 0.18);
            c.fillText(text, lx, ly);
          };
          if (l.was !== l.text && eased < 1) write(l.was, 1 - eased);
          write(l.text, l.was !== l.text ? eased : 1);
        }
        c.restore();
      }

      c = screen;
      const paintShade = (sh: Shade, alpha: number) => {
        if (!sh.image || sh.dark !== dark) {
          const img = document.createElement("canvas");
          img.width = sh.cols;
          img.height = sh.rows;
          const ictx = img.getContext("2d")!;
          const data = ictx.createImageData(sh.cols, sh.rows);
          const [r, gg, b] = pal!.ink;
          const top = dark ? 0.05 : 0.035;
          for (let k = 0; k < sh.v.length; k++) {
            const col = k % sh.cols, row = Math.floor(k / sh.cols);
            // Soft on every side: it fades in from now, out toward the horizon,
            // and out toward the chart's top and bottom, so it reads as light
            // rather than as a panel.
            const across = Math.min(1, (col + 1) / 2, (sh.cols - 1 - col) / 2 + 0.25);
            const updown = Math.min(1, Math.min(row, sh.rows - 1 - row) / 6);
            const v = Math.pow(sh.v[k], 1.4);
            const a = v * v * (3 - 2 * v) * across * updown * updown * (3 - 2 * updown);
            // Blue where it pays little, whitening toward white where it pays most.
            const white = 0.55 * sh.v[k] * sh.v[k];
            data.data[k * 4] = Math.round(r + (255 - r) * white);
            data.data[k * 4 + 1] = Math.round(gg + (255 - gg) * white);
            data.data[k * 4 + 2] = Math.round(b + (255 - b) * white);
            data.data[k * 4 + 3] = Math.round(255 * top * a);
          }
          ictx.putImageData(data, 0, 0);
          sh.image = img;
          sh.dark = dark;
        }
        const colW = (sh.t1 - sh.t0) / (sh.cols - 1) * pxMs();
        const rowH = (y(sh.pBottom) - y(sh.pTop)) / (sh.rows - 1);
        c.save();
        c.beginPath();
        c.rect(nx, plotTop(), w - nx, plotBottom() - plotTop());
        c.clip();
        c.globalAlpha = alpha;
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = "high";
        // From the price line itself to the horizon: stretched a little at the
        // start rather than leaving a seam where the first column begins.
        c.drawImage(sh.image, nx, y(sh.pTop) - rowH / 2, sh.t1 * pxMs() + colW / 2, y(sh.pBottom) - y(sh.pTop) + rowH);
        c.restore();
      };
      // The glow, under everything but the page: brightest where a hit pays most.
      // Each second's new glow fades in over the last one.
      if (map.field === fl && map.shade) {
        const k = reducedMotion.matches ? 1 : Math.min(1, (ms - map.shadeAt) / 450);
        const eased = k * k * (3 - 2 * k);
        if (map.was && eased < 1) paintShade(map.was, 1 - eased);
        paintShade(map.shade, eased < 1 && map.was ? eased : 1);
      }
      // A price on the left every so many steps, faint: enough to read where things are.
      c.font = `500 10px ${MONO}`;
      c.textBaseline = "middle";
      c.textAlign = "left";
      const desiredTick = step * 80 / pitchY;
      const magnitude = 10 ** Math.floor(Math.log10(desiredTick));
      const axisStep = [1, 2, 2.5, 5, 10].map(n => n * magnitude).reduce((best, n) => Math.abs(n - desiredTick) < Math.abs(best - desiredTick) ? n : best);
      const cents = axisStep % 1 !== 0;
      for (let r = rowOf(pAt(plotBottom()), axisStep); r <= rowOf(pAt(plotTop()), axisStep) + 1; r++) {
        const py = Math.round(y(r * axisStep)) + 0.5;
        // Not under the market's name and price, top left, the buttons bottom left on a phone, or the price's own tag.
        if (py < plotTop() || py > plotBottom()) continue;
        c.fillStyle = `rgba(${rgb},0.045)`;
        c.fillRect(0, py, w, 1);
        // On a phone the balance row sits just over the chart: no price under it.
        if (phone() && py < plotTop() + 18) continue;
        c.fillStyle = `rgba(${rgb},0.42)`;
        c.fillText(fmtPrice(r * axisStep, cents), phone() ? 12 : 24, py - 8);
      }

      /*
        The price, live: one line through every trade on hand, and each
        second's close before them, ending at the latest trade immediately.
        Shape-preserving curves soften corners without creating new extrema. A soft glow under it, and a fade to the page beneath.
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
          // The fade under the line, down to the foot.
          const fill = c.createLinearGradient(0, y(p) - 60, 0, Math.min(h, y(p) + 220));
          fill.addColorStop(0, rgba(pal.ink, pal.dark ? 0.12 : 0.07));
          fill.addColorStop(1, rgba(pal.ink, 0));
          const area = new Path2D(path);
          area.lineTo(nx, h);
          area.lineTo(line[0].x, h);
          area.closePath();
          c.fillStyle = fill;
          c.fill(area);
          c.strokeStyle = rgba(pal.ink, 0.14);
          c.lineWidth = 6;
          c.stroke(path);
          c.strokeStyle = rgba(pal.ink, 0.95);
          c.lineWidth = CHART_LINE_PX + 0.5;
          c.stroke(path);
        }
      }

      // Now: a line top to bottom, and the price on it.
      const glow = c.createLinearGradient(0, 0, 0, h);
      glow.addColorStop(0, `rgba(${rgb},0)`);
      glow.addColorStop(0.5, `rgba(${rgb},0.28)`);
      glow.addColorStop(1, `rgba(${rgb},0)`);
      c.fillStyle = glow;
      c.fillRect(nx - 0.5, 0, 1, h);
      const py = y(p);
      c.save();
      c.setLineDash([3, 6]);
      c.strokeStyle = rgba(pal.ink, 0.2);
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(nx + 8, py); c.lineTo(w, py); c.stroke();
      c.restore();
      const pulse = reducedMotion.matches ? 0 : (ms % 1400) / 1400;
      c.beginPath();
      c.arc(nx, py, 4 + pulse * 10, 0, Math.PI * 2);
      c.fillStyle = `rgba(${rgb},${0.2 * (1 - pulse)})`;
      c.fill();
      c.beginPath();
      c.arc(nx, py, 4, 0, Math.PI * 2);
      c.fillStyle = `rgb(${rgb})`;
      c.fill();
      c.font = `600 11px ${MONO}`;
      c.textAlign = "center";
      const label = fmtPrice(g.displayPrice || latest, true);
      // Just right of the live dot, where the eye already is, clear of the line behind it.
      const lw = c.measureText(label).width + 14;
      roundRect(c, nx + 10, py - 10, lw, 20, 10);
      c.fillStyle = `rgb(${rgb})`;
      c.fill();
      c.fillStyle = rgba(pal.bg);
      c.textBaseline = "middle";
      c.fillText(label, nx + 10 + lw / 2, py + 0.5);

      /*
        Where betting always counts. Ink opens on the second after it is drawn
        and the one after that is never part of it, so the first second in play
        is between one and two seconds ahead, stepping once a second. The line
        holds still at two seconds: ink right of it always counts, and ink
        left of it counts when it can.
      */
      {
        const fx0 = x(at + 2000);
        c.save();
        c.setLineDash([3, 5]);
        c.strokeStyle = `rgba(${rgb},0.18)`;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(Math.round(fx0) + 0.5, 0);
        c.lineTo(Math.round(fx0) + 0.5, plotBottom() + 18);
        c.stroke();
        c.restore();
        c.font = `500 10px ${MONO}`;
        c.textAlign = "center";
        c.fillStyle = `rgba(${rgb},0.42)`;
        if (fx0 - nx > 28) c.fillText("wait", (nx + fx0) / 2, plotBottom() + 28);
      }

      // Seconds ahead, along the foot.
      c.font = `500 10px ${MONO}`;
      c.fillStyle = `rgba(${rgb},0.42)`;
      for (let s = 5; s <= VIEW_SECONDS; s += 5) c.fillText(`+${s}s`, x(at + s * 1000), plotBottom() + 28);

      // The ink over the chart, and the multiples over the ink.
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(inkLayer, 0, 0);
      c.drawImage(labelLayer, 0, 0);
      c.restore();
      // The pen: its size, and what the spot under it pays.
      const tip = pen ? pen.last : hover && hover.x > nx ? hover : null;
      if (tip) {
        c.beginPath();
        c.arc(tip.x, tip.y, radius(), 0, Math.PI * 2);
        c.fillStyle = `rgba(${rgb},${pen ? 0.08 : 0.06})`;
        c.fill();
        c.strokeStyle = `rgba(${rgb},0.4)`;
        c.lineWidth = 1;
        c.stroke();
        const hoverStroke: Stroke = { t0: tAt(tip.x), p0: pAt(tip.y), pts: [{ t: 0, p: 0 }], rt: radius() / pxMs(), rp: priceRadius() };
        if (keyboard && ms - keyboardQuotedAt >= 100) {
          keyboardQuotedAt = ms;
          const q = g.quote?.(hoverStroke) ?? null;
          keyboardQuote = q ? { ...q, keyboard: true } : null;
          preview.current(keyboardQuote);
        }

      }

      // The first time: a ghost pen draws a stroke ahead of the price.
      if (g.hint && !pen) {
        const k = reducedMotion.matches ? 0.65 : (ms % 3200) / 3200;
        const x0 = nx + (w - nx) * 0.18;
        const x1 = nx + (w - nx) * 0.72;
        const along = (f: number) => ({ px: x0 + (x1 - x0) * f, py: py - Math.min(pitchY * 1.5, h * 0.16) * Math.sin(f * Math.PI * 1.3) - f * h * 0.08 });
        const upto = Math.min(1, k * 1.4);
        c.beginPath();
        for (let f = 0; f <= upto; f += 0.01) {
          const q = along(f);
          if (f === 0) c.moveTo(q.px, q.py);
          else c.lineTo(q.px, q.py);
        }
        c.strokeStyle = rgba(pal.ink, 0.25);
        c.lineWidth = radius() * 2;
        c.lineCap = "round";
        c.lineJoin = "round";
        c.stroke();
        const q = along(upto);
        c.beginPath();
        c.arc(q.px, q.py, 6, 0, Math.PI * 2);
        c.fillStyle = rgba(pal.ink, 0.7);
        c.fill();
      }

      // Hits burst and float what they paid; a drawing pops once when it goes in.
      g.fx = g.fx.filter((e) => ms - e.born < 1500);
      c.textAlign = "center";
      for (const e of g.fx) {
        const age = (ms - e.born) / 1500;
        const ex = x(e.t);
        const ey = y(e.price);
        if (e.kind === "hit") {
          // A glow where the price met the ink, then the burst.
          const glowR = (e.big ? 34 : 22) * (0.6 + age);
          const rg = c.createRadialGradient(ex, ey, 0, ex, ey, glowR);
          rg.addColorStop(0, green);
          rg.addColorStop(1, "rgba(0,0,0,0)");
          c.globalAlpha = 0.55 * (1 - age);
          c.fillStyle = rg;
          c.fillRect(ex - glowR, ey - glowR, glowR * 2, glowR * 2);
          c.globalAlpha = 1;
          const n = reducedMotion.matches ? 0 : e.big ? 16 : 9;
          c.fillStyle = green;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + e.born;
            const d = (e.big ? 44 : 24) * Math.min(1, age * 2.2);
            c.globalAlpha = 1 - age;
            c.beginPath();
            c.arc(ex + Math.cos(a) * d, ey + Math.sin(a) * d, 2.2 * (1 - age), 0, Math.PI * 2);
            c.fill();
          }
          // What it paid rises from where it was won, clear of the price's own label on the left of now.
          c.font = `700 ${e.big ? 18 : 13}px ${MONO}`;
          c.globalAlpha = Math.max(0, Math.min(1, 1.6 - age * 1.6));
          c.textAlign = "left";
          if (e.loss) c.fillStyle = rgba(pal.down);
          if (e.text) c.fillText(e.text, Math.max(ex, nx) + 12, ey - 16 - (reducedMotion.matches ? 0 : age * 36));
          c.textAlign = "center";
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
