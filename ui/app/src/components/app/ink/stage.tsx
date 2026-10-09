"use client";

import { useEffect, useRef } from "react";
import { type Bar, type Field, openFor } from "@skech/core/dots";
import { drawingLayout, INK_CELL, VIEW_SECONDS, CHART_STEP_PX, PEN_CELLS, type Cell, type InkBet, type Pen, type Stroke } from "@skech/core/ink";
import { roundedTerms as areaTerms } from "@skech/core/odds";
import type { Tick } from "@/lib/engine";
import { tracePricePath } from "./price-path";
import { feel, pen as penSound } from "@/lib/feel";
import { openPlayerProfile, remoteDrawings, socialMoney, visibleSocialDrawings } from "@/lib/social";
import { faceOf } from "@/lib/avatar";
import { playerHue, type DrawingPiece } from "@skech/core/social";

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

export type Fx = { kind: "hit" | "placed" | "drop"; t: number; price: number; born: number; text?: string; loss?: boolean; line?: string; big?: boolean };
/** What the stroke being drawn costs, the least and most a hit on it pays (in dollars), and which of its points are in play. */
export type Preview = { multipleLow: number; multipleHigh: number; units: number; cost: number; low: number; high: number; inPlay: Cell[]; out: Cell[]; keyboard?: boolean };

export type Game = {
  bars: Bar[];
  ticks: Tick[];
  /** Coinbase's clock minus this one's. */
  skew: number;
  /** Every slice's chance, for a drawing placed now. Null until the paths and the prices are in. */
  field: Field | null;
  /**
   * How far ahead of now ink counts as placed, ms: on chain a piece drawn in a second's last moments opens on the
   * next one, so this is the chain's lateness margin there and nothing in practice. The tiles and the pen's quote
   * both price from `now + placeLead`, the same moment the placement opens from, so what they show is what is paid.
   */
  placeLead: number;
  /** The chart's scale: price per row of pixels. */
  step: number;
  /** The pricing grid's scale: what `areaCells` and the map work in, so every screen prices the same. */
  priceStep: number;
  marketStep: number;
  viewport: { width: number; height: number };
  displayPrice: number;
  /** What a point costs. */
  perDot: number;
  pen: Pen;
  /** The pen's width, and the height of the rows its points are in, as a share of `step`. */
  cell: number;
  drawing?: { step: number; priceStep: number; perDot: number; pen: Pen };
  bets: InkBet[];
  /** Price a stroke as if it were placed now. Set by the screen, which has the paths and the market. */
  quote: ((st: Stroke) => Preview | null) | null;
  fx: Fx[];
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

/** Show the maximum return per section, rounded down to a tenth. */
export const fmtMultiple = (m: number) => `${Math.floor(m * 10 + 1e-8) / 10}×`;
const fmtPrice = (p: number, cents: boolean) => p.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });

/** The first index at or after time `t`, in a list kept in time order (bars and trades both are). */
export function firstAtOrAfter(list: readonly { t: number }[], t: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

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

/**
 * What placing a piece said: nothing (it went in, or there was nothing new to bet), why not, or why not and
 * that the stroke ends here, because nothing more of it could go in either (the balance ran out).
 */
export type Placed = string | { stop: string } | null;
const whyOf = (r: Placed) => (r && typeof r === "object" ? r.stop : r);

export function Stage({
  game,
  onPlace,
  onPreview,
  onViewport,
  className,
}: {
  game: React.RefObject<Game>;
  /**
   * Bet the stroke so far: called as the pen moves (`done` false) and once more when it lifts (`done` true). A
   * gesture the browser cancels is not called again, so ink drawn since the last piece is not bet. Returns an
   * explanation if it cannot be placed; `{ stop }` ends the stroke there.
   */
  onPlace: (stroke: Stroke, drawing: string, done: boolean) => Placed;
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
      A layer, so the ink can sit over the chart: the chart is painted on the
      canvas, the ink on a layer of its own (its spent ink is rubbed out
      there without touching the chart), laid over it. The multiples, the pen
      and what hits paid go on top, straight onto the canvas. With no ink on
      the screen the layer is not drawn at all: each one is a full-screen copy.
    */
    const inkLayer = document.createElement("canvas");
    const inkCtx = inkLayer.getContext("2d")!;
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
    // Worked out again only when the size or the scale changes: x() and y() ask for it several times each, many times a frame.
    let laid = { w: -1, h: -1, step: -1, layout: drawingLayout(0, 0, 1) };
    const layout = () => {
      const step = game.current.marketStep;
      if (laid.w !== w || laid.h !== h || laid.step !== step) laid = { w, h, step, layout: drawingLayout(w, h, step) };
      return laid.layout;
    };
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
    /** `x0` and `y0` are where it is on screen this frame, worked out once and read by everything that draws it. */
    type Tile = { id: string; left: number; width: number; offset: number; p: number; rung: number; text: string; was: string; changed: number; opacity: number; x0: number; y0: number };
    const map = { pen: "", width: 0, height: 0, step: 0, field: null as Field | null, tiles: [] as Tile[], rowPx: 36 };
    /*
      Each multiple's face and colour, by its text: a few dozen tiles show a dozen or so values, and building the
      font and colour strings per tile per frame was most of what writing them cost. Forgotten with the palette
      and with each new map (the size follows the screen).
    */
    const labelStyles = new Map<string, { font: string; fill: string }>();
    const labelStyle = (text: string) => {
      let s = labelStyles.get(text);
      if (!s) {
        const m = parseFloat(text);
        labelStyles.set(text, (s = { font: `${m >= 8 ? 600 : 500} ${phone() ? 11 : 14}px ${SANS}`, fill: rgba(mix(pal!.faint, pal!.ink, height(m))) }));
      }
      return s;
    };
    /** The price tag's width, measured again only when its text changes. */
    let tagMeasured = { text: "", w: 0 };
    const gPen = () => game.current!.drawing?.pen ?? game.current!.pen;
    /** Where the tiles start: the wait line, two seconds ahead, where ink always counts. */
    const WAIT_MS = 2000;
    /** Where drawing may begin: the wait line, less the nib, so ink's edge meets it. Left of it the zone is grey. */
    const waitX = () => nowX() + WAIT_MS * pxMs();
    const inkFrom = () => waitX() + radius();
    const paintMap = (fl: Field) => {
      map.field = fl; map.pen = gPen(); map.width = w; map.height = h; map.step = game.current.step;
      labelStyles.clear();
      const previous = new Map(map.tiles.map(tile => [tile.id, tile]));
      map.tiles = [];
      const sampledAt = now(game.current);
      // Priced from the moment a tap here would be placed, as the pen's quote and the placement itself are: not from
      // the map's own second, which read every tile one to two seconds further out than a tap there opens.
      const terms = areaTerms(fl, sampledAt + game.current.placeLead, game.current.priceStep, 1);
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
          map.tiles.push({ id, left, width, offset, p, rung, text, was: changing ? old!.text : old?.was ?? text, changed: changing ? performance.now() : old?.changed ?? 0, opacity: old?.opacity ?? 0, x0: 0, y0: 0 });
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
    let flash: { text: string; x: number; y: number; born: number; ms?: number } | null = null;
    /*
      The stroke ends where it can go no further: the ink stops at the last piece that went in, where the pen
      is, with the reason held long enough to read. Drawn on, ink past it would vanish when the pen lifts.
    */
    const stopPen = (p: Pen, why: string) => {
      penSound.up();
      pen = null;
      preview.current(null);
      place.current(p.stroke, p.drawing, true);
      game.current.drawing = undefined;
      if (el.hasPointerCapture(p.id)) el.releasePointerCapture(p.id);
      flash = { text: why, x: p.last.x, y: p.last.y, born: performance.now(), ms: 3200 };
    };
    /** Where the pen was at its last move, for the scratch's speed. */
    let penFrom = { x: 0, y: 0, at: 0 };

    /**
     * Re-price the stroke being drawn, at most twenty times a second, on the terms a drawing placed now gets:
     * what the pen's label says comes from the same place as what a hit pays.
     */
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
    /** Where other players' faces are on the chart this frame, behind the wait line: a tap there opens their profile. */
    let playerTargets: { x: number; y: number; player: string }[] = [];
    const down = (e: PointerEvent) => {
      const g = game.current;
      if (e.button !== 0 || pen || !g || !price(g) || !g.field) return;
      const q = point(e);
      if (q.y < plotTop() || q.y > plotBottom()) return;
      // Ahead of the wait line every touch draws; behind it, a face is a way to its player.
      if (q.x < waitX()) {
        const face = playerTargets.find((t) => Math.hypot(q.x - t.x, q.y - t.y) < 22);
        if (face) return openPlayerProfile(face.player);
      }
      // Not from the grey zone before the wait line: ink there cannot be bet yet. Said, felt, not silently ignored.
      if (q.x < waitX()) {
        feel("nope");
        flash = { text: "Draw right of the dashed line", x: Math.max(q.x, waitX() + 90), y: q.y, born: performance.now() };
        return;
      }
      keyboard = false;
      // Heard and seen the instant the finger lands, before anything is priced: a drop of ink.
      feel("tap");
      penSound.down();
      g.fx.push({ kind: "drop", t: tAt(Math.max(q.x, inkFrom())), price: pAt(q.y), born: performance.now() });
      el.focus({ preventScroll: true });
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* A pointer the browser no longer tracks: drawing still works while it stays over the canvas. */
      }
      // Ink starts at the wait line at the earliest: nothing is written in the grey zone.
      q.x = Math.max(q.x, inkFrom());
      g.drawing = { step: g.step, priceStep: g.priceStep, perDot: g.perDot, pen: g.pen };
      penFrom = { x: q.x, y: q.y, at: performance.now() };
      pen = { id: e.pointerId, drawing: crypto.randomUUID(), why: null, last: q, stroke: { t0: tAt(q.x), p0: pAt(q.y), pts: [{ t: 0, p: 0 }], rt: radius() / pxMs(), rp: priceRadius() }, quote: null, quotedAt: 0, finger: e.pointerType !== "mouse" };
      requote(pen, true);
      const placed = place.current(pen.stroke, pen.drawing, false);
      if (placed && typeof placed === "object") return stopPen(pen, placed.stop);
      if (placed) pen.why = placed;
    };
    const move = (e: PointerEvent) => {
      if (keyboard) preview.current(null);
      keyboard = false;
      const q = point(e);
      hover = e.pointerType === "mouse" ? q : null;
      if (!pen || e.pointerId !== pen.id) return;
      q.x = Math.max(q.x, inkFrom());
      // Ink stays on the chart: the pen stops at its top and bottom edges.
      q.y = Math.min(plotBottom(), Math.max(plotTop(), q.y));
      // Every position the pointer passed through since the last frame, not
      // just the last one, so a fast stroke keeps its shape. A light touch of
      // smoothing takes the hand's tremor out without the nib trailing behind.
      const r = el.getBoundingClientRect();
      const trail = (e.getCoalescedEvents?.() ?? []).map(c => ({ x: c.clientX - r.left, y: c.clientY - r.top }));
      let moved = false;
      for (const raw of [...trail.slice(0, -1), q]) {
        const at = { x: Math.max(raw.x, inkFrom()), y: Math.min(plotBottom(), Math.max(plotTop(), raw.y)) };
        const s = { x: pen.last.x + (at.x - pen.last.x) * 0.85, y: pen.last.y + (at.y - pen.last.y) * 0.85 };
        if (pen.stroke.pts.length >= 2048) break;
        if (Math.hypot(s.x - pen.last.x, s.y - pen.last.y) < 1.5) continue;
        pen.last = s;
        pen.stroke.pts.push({ t: tAt(s.x) - pen.stroke.t0, p: pAt(s.y) - pen.stroke.p0 });
        moved = true;
      }
      if (!moved) return;
      const s = pen.last;
      // The pen's scratch follows the hand: how far it went since the last move, over how long.
      const now = performance.now();
      penSound.move(Math.hypot(s.x - penFrom.x, s.y - penFrom.y) / Math.max(8, now - penFrom.at));
      penFrom = { x: s.x, y: s.y, at: now };
      requote(pen);
      // Ink is bet as it is drawn, not when the pen lifts.
      const placed = place.current(pen.stroke, pen.drawing, false);
      if (placed && typeof placed === "object") return stopPen(pen, placed.stop);
      const why = placed;
      if (why && why !== pen.why) {
        pen.why = why;
        flash = { text: why, x: s.x, y: s.y, born: performance.now() };
      }
    };
    const up = (e: PointerEvent) => {
      if (!pen || e.pointerId !== pen.id) return;
      penSound.up();
      const p = pen;
      pen = null;
      const q = point(e);
      q.x = Math.max(q.x, inkFrom());
      q.y = Math.min(plotBottom(), Math.max(plotTop(), q.y));
      // A tap remains a single dot, even while the market clock advances.
      if (Math.hypot(q.x - p.last.x, q.y - p.last.y) > 1.5 && p.stroke.pts.length < 2048)
        p.stroke.pts.push({ t: tAt(q.x) - p.stroke.t0, p: pAt(q.y) - p.stroke.p0 });
      preview.current(null);
      const why = whyOf(place.current(p.stroke, p.drawing, true));
      game.current.drawing = undefined;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (why && why !== p.why) flash = { text: why, x: q.x, y: q.y, born: performance.now() };
    };
    const cancel = () => {
      keyboard = false;
      penSound.up();
      // The browser took the pointer back mid-stroke (a gesture, a palm): ink drawn since the last piece is not bet.
      if (pen && process.env.NODE_ENV !== "production") console.warn(`[ink] stroke cancelled by the browser: ink drawn since the last piece (up to 150 ms) is not bet`);
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
      hover = { x: Math.min(w - radius(), Math.max(inkFrom(), tip.x + (e.key === "ArrowLeft" ? -move : e.key === "ArrowRight" ? move : 0))), y: Math.min(plotBottom(), Math.max(plotTop(), tip.y + (e.key === "ArrowUp" ? -move : e.key === "ArrowDown" ? move : 0))) };
      const st = { t0: tAt(hover.x), p0: pAt(hover.y), pts: [{ t: 0, p: 0 }], rt: radius() / pxMs(), rp: priceRadius() };
      if (e.key === "Enter" || e.key === " ") {
        keyboard = false;
        const why = whyOf(place.current(st, crypto.randomUUID(), true));
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
    // A finger lifted where the canvas never heard it (capture failed): the stroke ends, and the pen's scratch with it.
    const lost = (e: PointerEvent) => {
      if (pen && e.pointerId === pen.id) up(e);
    };
    el.addEventListener("lostpointercapture", lost);
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
      const pts = st.pts;
      c.moveTo(pts[0].t / st.rt, pts[0].p / st.rp);
      // Pointer smoothing already happens before storing points. Render exactly
      // the rounded capsules used to price the area, without curving away.
      for (let i = 1; i < pts.length - 1; i++) c.lineTo(pts[i].t / st.rt, pts[i].p / st.rp);
      const end = pts[pts.length - 1];
      c.lineTo(end.t / st.rt + (pts.length === 1 ? 1e-3 : 0), end.p / st.rp);
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
    /*
      Everyone else's ink, from the live feed (lib/social.ts): each piece's path made once and kept while the piece
      is, drawn faint in its player's colour, inside the bands it bought. Who is on which tile is counted twice a
      second, not every frame; their faces are images fetched once a minute at most.
    */
    const remotePaths = new WeakMap<DrawingPiece, Path2D>();
    const remotePath = (piece: DrawingPiece) => {
      let path = remotePaths.get(piece);
      const st = piece.stroke;
      if (path || !st?.pts.length) return path;
      path = new Path2D();
      st.pts.forEach((q, i) => (i ? path!.lineTo(q.t / st.rt, q.p / st.rp) : path!.moveTo(q.t / st.rt, q.p / st.rp)));
      if (st.pts.length === 1) path.lineTo(st.pts[0].t / st.rt + 1e-3, st.pts[0].p / st.rp);
      remotePaths.set(piece, path);
      return path;
    };
    const avatarImages = new Map<string, { image: HTMLImageElement; at: number }>();
    let crowdAt = 0;
    const tileCrowds = new Map<string, { players: Set<string>; stake: bigint }>();
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
    /*
      Each drawing's hit and missed cells, and the newest second of each: sorted out once per judged bet (a bet is
      replaced, never changed, when the price decides some of it), not filtered from all its cells twice a frame.
    */
    const decidedCells = new WeakMap<InkBet, { hits: InkBet["cells"]; misses: InkBet["cells"]; lastHit: number; lastMiss: number }>();
    const decidedOf = (bet: InkBet) => {
      let d = decidedCells.get(bet);
      if (!d) {
        d = { hits: [], misses: [], lastHit: -Infinity, lastMiss: -Infinity };
        for (const q of bet.cells) {
          if (q.status === "hit") {
            d.hits.push(q);
            d.lastHit = Math.max(d.lastHit, q.t);
          } else if (q.status === "miss") {
            d.misses.push(q);
            d.lastMiss = Math.max(d.lastMiss, q.t);
          }
        }
        decidedCells.set(bet, d);
      }
      return d;
    };

    /** The price line's points, kept from frame to frame and written over rather than made anew. */
    const line: { x: number; y: number }[] = [];
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
      if (!pal || pal.dark !== dark) {
        pal = readPalette(dark);
        labelStyles.clear();
      }
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
      // Who has ink on each tile still to come: counted twice a second.
      if (ms - crowdAt > 500) {
        crowdAt = ms;
        tileCrowds.clear();
        const first = map.tiles[0];
        const rowP = (map.rowPx * g.step) / pitchY;
        if (first) for (const drawing of visibleSocialDrawings().slice(0, 40)) {
          if (drawing.complete) continue;
          for (const piece of drawing.pieces) {
            const decided = piece.hitMask | piece.missMask | (piece.expiredMask ?? 0);
            piece.sections.forEach((section, i) => {
              if ((decided & (1 << i)) !== 0) return;
              const col = Math.floor((x(piece.openAt + section.second * 1000 + 500) - nx - first.left) / (first.width + 4));
              if (col < 0) return;
              const id = `${col}:${Math.floor((Number(section.lo) + Number(section.hi)) / 2e8 / rowP)}`;
              let crowd = tileCrowds.get(id);
              if (!crowd) tileCrowds.set(id, (crowd = { players: new Set(), stake: 0n }));
              crowd.players.add(drawing.player);
              crowd.stake += BigInt(section.stake);
            });
          }
        }
      }
      const people = remoteDrawings().slice(0, phone() ? 12 : w < 1024 ? 18 : 24);

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
      // No pen and no drawing on the chart (a hit or a miss is always in one): no ink, and no layer to clear and lay over.
      const inked = !!pen || renderedGroups.length > 0 || people.length > 0;
      if (inked) onLayer(inkLayer, inkCtx);
      // Other players' ink, under the player's own.
      for (const drawing of people) {
        const age = Math.max(0, Date.now() - drawing.updatedAt);
        if (drawing.complete && age > 15_000) continue;
        const style = `hsla(${playerHue(drawing.player)}, 55%, ${dark ? 70 : 42}%, ${drawing.complete ? 0.18 * Math.max(0, 1 - age / 15_000) : 0.26})`;
        for (const piece of drawing.pieces) {
          const st = piece.stroke, path = remotePath(piece);
          if (!st || !path || !st.rt || !st.rp) continue;
          const pad = Number(piece.unit) / 1e8;
          c.save();
          c.beginPath();
          for (const section of piece.sections) {
            const from = x(piece.openAt + section.second * 1000), top = y(Number(section.hi) / 1e8 + pad);
            c.rect(from, top, x(piece.openAt + (section.second + 1) * 1000) - from, y(Number(section.lo) / 1e8 - pad) - top);
          }
          c.clip();
          c.setTransform(dpr * st.rt * pxMs(), 0, 0, (dpr * -st.rp * pitchY) / g.step, dpr * x(st.t0), dpr * y(st.p0));
          c.lineWidth = 2;
          c.lineCap = "round";
          c.lineJoin = "round";
          c.strokeStyle = style;
          c.stroke(path);
          c.restore();
        }
      }
      for (const group of renderedGroups) {
        if (group.id !== pen?.drawing) {
          // The whole line faint, as ink too soon is while drawing, then solid wherever it is in play:
          // a part not in play (refused, or never bet) shows as faint ink, never as a gap in the line.
          ink(group.stroke, rgba(pal.ink, 0.3));
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
      if (inked) {
        c.save();
        c.globalCompositeOperation = "destination-out";
        c.fillStyle = "#000";
        c.fillRect(0, 0, nx, h);
        c.restore();
      }
      // Ink the price missed turns red as the price passes it, and fades, as a hit glows green.
      if (inked) for (const bet of g.bets) {
        const d = decidedOf(bet);
        if (at - (d.lastMiss + 1000) >= 2200) continue;
        const misses = d.misses.filter((q) => at - (q.t + 1000) < 2200);
        const pad = (bet.edgeCells ?? 0) * bet.step * INK_CELL;
        const age = Math.max(0, Math.min(1, (at - (d.lastMiss + 1000)) / 2200));
        c.save();
        c.beginPath();
        for (const q of misses) c.rect(x(q.t), y(q.hi + pad), pxMs() * 1000, y(q.lo - pad) - y(q.hi + pad));
        c.clip();
        c.globalAlpha = 1 - age * age;
        ink(bet.stroke, rgba(pal.down, 0.5));
        c.restore();
      }
      // Where the price ran through the ink, it glows green for a moment: there, and nowhere else.
      if (inked) for (const bet of g.bets) {
        const d = decidedOf(bet);
        if (at - (d.lastHit + 1000) >= 2200) continue;
        const hits = d.hits.filter((q) => at - (q.t + 1000) < 2200);
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
        const age = Math.max(0, Math.min(1, (at - (d.lastHit + 1000)) / 2200));
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalAlpha = 1 - age * age;
        c.drawImage(glowLayer, 0, 0);
        c.restore();
      }

      /* Where the pen is, and the price's own tag: a tile under either is picked out, or kept clear. */
      const tip = pen ? pen.last : hover && hover.x >= waitX() ? hover : null;
      const py = y(p);
      const tagText = fmtPrice(g.displayPrice || latest, true);
      if (tagMeasured.text !== tagText) {
        c.font = `600 12px ${SANS}`;
        tagMeasured = { text: tagText, w: c.measureText(tagText).width };
      }
      const tagW = tagMeasured.w + 20;
      // On a phone the tiles start close to now: the tag sits left of the dot, over the past, so the price's own row keeps its multiples.
      const tagX = phone() ? nx - 12 - tagW : nx + 12;
      const tag = { x0: tagX, x1: tagX + tagW, y0: py - 12, y1: py + 12 };
      const tileH = map.rowPx - 4;
      const tiles = fl && map.field === fl ? map.tiles : [];
      // Ease every tile toward whether it shows: on the chart, clear of the price's tag, and with a multiple.
      const top = plotTop(), bottom = plotBottom();
      for (const tile of tiles) {
        tile.x0 = nx + tile.left;
        tile.y0 = y(tile.p) - map.rowPx / 2 + 2;
        // Whole tiles only: one cut by the chart's edge reads as a mistake.
        const onChart = tile.y0 >= top && tile.y0 + tileH <= bottom;
        const underTag = tile.x0 < tag.x1 + 4 && tile.x0 + tile.width > tag.x0 - 4 && tile.y0 < tag.y1 + 4 && tile.y0 + tileH > tag.y0 - 4;
        const visible = onChart && tile.rung ? underTag ? 0.12 : 1 : 0;
        tile.opacity += (visible - tile.opacity) * ease(0.012);
      }
      const underPen = tip ? tiles.find(tile => tile.rung && tip.x >= tile.x0 - 2 && tip.x <= tile.x0 + tile.width + 2 && tip.y >= tile.y0 - 2 && tip.y <= tile.y0 + tileH + 2) : undefined;

      c = screen;
      // The tiles themselves, under everything but the page: bluer where a hit pays more.
      if (tiles.length) {
        c.save();
        c.beginPath();
        c.rect(0, plotTop(), w, plotBottom() - plotTop());
        c.clip();
        const most = dark ? 0.12 : 0.072;
        for (const tile of tiles) {
          if (tile.opacity < 0.01) continue;
          roundRect(c, tile.x0, tile.y0, tile.width, tileH, phone() ? 9 : 12);
          c.fillStyle = rgba(pal.ink, most * Math.pow(height(tile.rung), 0.6) * tile.opacity);
          c.fill();
        }
        c.restore();
      }

      // The wait zone, from now to the wait line: greyed out, as nothing can be drawn there.
      {
        const wx = waitX();
        if (wx - nx > 12) {
          roundRect(c, nx + 4, plotTop(), wx - nx - 8, plotBottom() - plotTop(), phone() ? 9 : 12);
          c.fillStyle = rgba(pal.fg, dark ? 0.07 : 0.045);
          c.fill();
        }
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
        let n = 0;
        const put = (px: number, py: number) => {
          const q = line[n++];
          if (!q) line.push({ x: px, y: py });
          else {
            q.x = px;
            q.y = py;
          }
        };
        // From the first bar and trade on screen, not through the minutes before it.
        for (let i = firstAtOrAfter(g.bars, from - 1000); i < g.bars.length; i++) {
          const bar = g.bars[i];
          if (bar.t >= firstTick) break;
          put(x(bar.t + 1000), y(bar.c));
        }
        let lastX = Number.NEGATIVE_INFINITY;
        for (let i = firstAtOrAfter(g.ticks, from); i < g.ticks.length; i++) {
          const tk = g.ticks[i];
          if (tk.t > at) continue;
          const px = x(tk.t);
          // Far back, many trades land on one pixel: the last of them stands for it.
          if (px - lastX < 0.75 && n) n--;
          put(px, y(tk.p));
          lastX = px;
        }
        put(nx, y(p));
        line.length = n;
        if (line.length > 1) {
          const path = new Path2D();
          tracePricePath(path, line);
          // The scale is fixed around the live price, so older prices can run off it: the line stays inside the
          // chart instead of running over the time axis and the dock below it.
          c.save();
          c.beginPath();
          c.rect(0, plotTop() - 6, w, plotBottom() - plotTop() + 12);
          c.clip();
          c.lineJoin = "round";
          c.lineCap = "round";
          c.strokeStyle = rgba(pal.fg);
          c.lineWidth = 2;
          c.stroke(path);
          c.restore();
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

      // The ink over the chart.
      if (inked) {
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.drawImage(inkLayer, 0, 0);
        c.restore();
      }

      // The multiples, over the ink.
      if (tiles.length) {
        c.save();
        c.beginPath();
        c.rect(0, plotTop(), w, plotBottom() - plotTop());
        c.clip();
        if (underPen) {
          roundRect(c, underPen.x0 - 1, underPen.y0 - 1, underPen.width + 2, tileH + 2, phone() ? 10 : 13);
          c.fillStyle = rgba(pal.ink, 0.14);
          c.fill();
          c.strokeStyle = rgba(pal.ink);
          c.lineWidth = 1.5;
          c.stroke();
        }
        c.textAlign = "center";
        c.textBaseline = "middle";
        const still = reducedMotion.matches;
        let font = "";
        for (const tile of tiles) {
          if (tile.opacity < 0.01) continue;
          const k = still ? 1 : Math.min(1, (ms - tile.changed) / 260);
          const eased = k * k * (3 - 2 * k);
          const write = (text: string, alpha: number) => {
            if (alpha < 0.01 || !text) return;
            const s = labelStyle(text);
            // Set only when it differs: most neighbours share a face.
            if (font !== s.font) c.font = font = s.font;
            c.globalAlpha = tile.opacity * alpha;
            c.fillStyle = s.fill;
            c.fillText(text, tile.x0 + tile.width / 2, tile.y0 + tileH / 2 + (crowd && !phone() && tile.width > 60 ? -5 : 0.5));
          };
          const crowd = tileCrowds.get(tile.id);
          // A changed number goes out, then the new one comes in: never both at once, which read as a smudge.
          if (tile.was !== tile.text && eased < 1) {
            if (eased < 0.5) write(tile.was, 1 - eased * 2);
            else write(tile.text, eased * 2 - 1);
          } else write(tile.text, 1);
          // How many have ink on this tile, and on a computer how much.
          if (crowd) {
            c.globalAlpha = tile.opacity;
            c.fillStyle = rgba(pal.fg, phone() ? 0.5 : 0.55);
            if (phone()) {
              c.font = font = `500 8px ${SANS}`;
              c.textAlign = "right";
              c.fillText(`${crowd.players.size}`, tile.x0 + tile.width - 3, tile.y0 + 7);
              c.textAlign = "center";
            } else if (tile.width > 60) {
              c.font = font = `500 10px ${SANS}`;
              c.fillText(`${crowd.players.size} · ${socialMoney(crowd.stake.toString())}`, tile.x0 + tile.width / 2, tile.y0 + tileH / 2 + 11);
            }
          }
        }
        c.globalAlpha = 1;
        c.restore();
      }
      // A face and a figure on each drawing being played: what it staked, then what it made. Canvas only, no React.
      playerTargets = [];
      const occupied: { x: number; y: number }[] = [];
      const labelLimit = phone() ? 4 : w < 1024 ? 6 : 8;
      for (const drawing of visibleSocialDrawings().slice(0, phone() ? 12 : w < 1024 ? 18 : 24)) {
        if (occupied.length >= labelLimit) break;
        const piece = drawing.pieces.find((pc) => pc.stroke?.pts.length);
        if (!piece?.stroke) continue;
        const age = Math.max(0, Date.now() - drawing.updatedAt);
        if (drawing.complete && age > 15_000) continue;
        const start = piece.stroke.pts[0];
        const ax = x(piece.stroke.t0 + start.t), ay = y(piece.stroke.p0 + start.p) - 24;
        if (ax < 24 || ax > w - 24 || ay < plotTop() + 24 || ay > plotBottom() - 20 || occupied.some((o) => Math.abs(o.x - ax) < 100 && Math.abs(o.y - ay) < 42)) continue;
        occupied.push({ x: ax, y: ay });
        c.save();
        c.globalAlpha = drawing.complete ? Math.max(0, 1 - age / 15_000) : 0.9;
        c.beginPath();
        c.arc(ax, ay, 14, 0, Math.PI * 2);
        c.fillStyle = `hsl(${playerHue(drawing.player)}, 45%, ${dark ? 55 : 45}%)`;
        c.fill();
        // Their face (a Dylan avatar, or their picture): an image made once per face, kept.
        const src = faceOf(drawing.profile);
        let cached = avatarImages.get(src);
        if (!cached) {
          if (avatarImages.size > 100) avatarImages.clear();
          const image = new Image();
          if (!src.startsWith("data:")) image.crossOrigin = "anonymous";
          image.src = src;
          avatarImages.set(src, (cached = { image, at: Date.now() }));
        }
        if (cached.image.complete && cached.image.naturalWidth) {
          c.save();
          c.clip();
          c.fillStyle = rgba(pal.bg);
          c.fillRect(ax - 14, ay - 14, 28, 28);
          c.drawImage(cached.image, ax - 14, ay - 14, 28, 28);
          c.restore();
        }
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.font = `600 12px ${SANS}`;
        c.strokeStyle = rgba(pal.bg);
        c.lineWidth = 2;
        c.stroke();
        const text = drawing.complete ? socialMoney(drawing.pnl, true) : socialMoney(drawing.stake);
        const wide = c.measureText(text).width + 16;
        const left = Math.min(w - wide - 8, ax + 19);
        roundRect(c, left, ay - 12, wide, 24, 12);
        c.fillStyle = rgba(pal.bg, 0.94);
        c.fill();
        c.fillStyle = drawing.complete && BigInt(drawing.pnl) > 0n ? rgba(pal.up) : rgba(pal.fg, 0.8);
        c.textAlign = "left";
        c.fillText(text, left + 8, ay + 0.5);
        c.restore();
        if (ax < waitX() - 18) playerTargets.push({ x: ax, y: ay, player: drawing.player });
      }
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
          // What the hit paid, in a green pill over where it was won.
          if (e.text) {
            c.globalAlpha = Math.max(0, Math.min(1, 1.6 - age * 1.6));
            c.font = `700 ${e.big ? 17 : 15}px ${SANS}`;
            const tw = c.measureText(e.text).width + 24;
            const cx = Math.min(w - tw / 2 - 8, Math.max(tw / 2 + 8, ex));
            const cy = ey - 62 - (reducedMotion.matches ? 0 : age * 24);
            roundRect(c, cx - tw / 2, cy - 14, tw, 28, 14);
            c.fillStyle = e.loss ? rgba(pal.down) : green;
            c.fill();
            c.fillStyle = "#ffffff";
            c.textBaseline = "middle";
            c.fillText(e.text, cx, cy + 0.5);
          }
          c.globalAlpha = 1;
        } else if (e.kind === "drop") {
          // The drop: a blot that swells under the finger, and a ring running out from it, both in the ink's colour.
          const life = Math.min(1, (ms - e.born) / 520);
          if (life >= 1) continue;
          const out = reducedMotion.matches ? 1 : 1 - (1 - life) ** 3;
          c.fillStyle = rgba(pal.ink, 0.28 * (1 - life));
          c.beginPath(); c.arc(ex, ey, 6 + 10 * out, 0, Math.PI * 2); c.fill();
          c.strokeStyle = rgba(pal.ink, 0.55 * (1 - life));
          c.lineWidth = 2 * (1 - life) + 0.5;
          c.beginPath(); c.arc(ex, ey, 10 + 30 * out, 0, Math.PI * 2); c.stroke();
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
        const age = (ms - flash.born) / (flash.ms ?? 1700);
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
      el.removeEventListener("lostpointercapture", lost);
      el.removeEventListener("pointerleave", leave);
    };
  }, [game]);

  return <canvas aria-label="Draw ahead of the price. Arrow keys move the pen; Enter places a dot; Escape cancels." className={`${className ?? ""} focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring`} ref={canvas} role="img" tabIndex={0} style={{ touchAction: "none", cursor: "none" }} />;
}
