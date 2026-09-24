"use client";

import { useEffect, useRef } from "react";
import { type Bar, type Field, multipleOf, openFor, RULES, rowOf } from "@skech/core/dots";
import type { Cell, InkBet, Pen, Stroke } from "@skech/core/ink";
import { payoutOf, terms } from "@skech/core/odds";
import type { Tick } from "@/lib/binance";

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
 * Underneath, area is counted in small slices, one second wide and one price
 * step tall, because that is how finely the price data runs. None of that
 * is drawn.
 *
 * One canvas, drawn every frame from a game object the screen mutates, since
 * sixty frames a second of moving ink is not a job for React. The screen
 * owns the rules and the money; this owns the picture and the pen.
 */

export type Fx = { kind: "hit" | "placed"; t: number; price: number; born: number; text?: string; big?: boolean };
/** What the stroke being drawn costs, the least and most a hit on it pays (in dollars), and which of its points are in play. */
export type Preview = { cost: number; low: number; high: number; inPlay: Cell[]; out: Cell[] };

export type Game = {
  bars: Bar[];
  ticks: Tick[];
  /** Binance's clock minus this one's. */
  skew: number;
  /** Every slice's chance, for a drawing placed now. Null until the paths and the prices are in. */
  field: Field | null;
  step: number;
  /** What a point costs. */
  perDot: number;
  pen: Pen;
  /** The pen's width, and the height of the rows its points are in, as a share of `step`. */
  cell: number;
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
type Palette = { ink: Rgb; fg: Rgb; bg: Rgb; muted: Rgb; up: Rgb; dark: boolean };
const rgba = (c: Rgb, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** The multiples written along the map. */
const LEVELS = [2, 5, 10, 25, 50];
/** How many pixels a slice gets in the map's own picture, before it is blurred and scaled onto the screen. */
const MAP_PX = 12;

/**
 * A small image's alpha, softened in place: two passes of a three-wide box
 * each way. Cheap at the map's size, one pixel a cell. Every pixel takes the
 * ink's colour, so the soft edge fades to nothing rather than to black.
 */
function blurAlpha(d: Uint8ClampedArray, w: number, h: number, rgb: readonly number[]) {
  const a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = d[i * 4 + 3];
  const tmp = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        tmp[i] = (a[i] * 2 + a[c > 0 ? i - 1 : i] + a[c < w - 1 ? i + 1 : i]) / 4;
      }
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        a[i] = (tmp[i] * 2 + tmp[r > 0 ? i - w : i] + tmp[r < h - 1 ? i + w : i]) / 4;
      }
  }
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = rgb[0];
    d[i * 4 + 1] = rgb[1];
    d[i * 4 + 2] = rgb[2];
    d[i * 4 + 3] = a[i];
  }
}

/** Dollars as a hit pays them: to the cent, and without the cents only when there are none. */
const dollars = (n: number) => (Math.abs(n - Math.round(n)) < 0.005 && n >= 1 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

export const fmtMultiple = (m: number) => `${m >= 10 ? Math.round(m) : m.toFixed(1)}×`;
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
  className,
}: {
  game: React.RefObject<Game>;
  /**
   * The stroke so far, while it is drawn and once more when the pen lifts
   * (`done`): the screen places whatever points of it are new, then and
   * there, and answers with why not, or null.
   */
  onPlace: (stroke: Stroke, drawing: string, done: boolean) => string | null;
  onPreview: (p: Preview | null) => void;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const place = useRef(onPlace);
  const preview = useRef(onPreview);
  useEffect(() => {
    place.current = onPlace;
    preview.current = onPreview;
  });

  useEffect(() => {
    const el = canvas.current!;
    const c = el.getContext("2d")!;
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
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);

    /* Geometry. One scale of time for past and future, so the price runs straight into the space you draw in. */
    let centre = 0;
    let at = 0;
    const phone = () => w < 640;
    const nowX = () => Math.round(w * (phone() ? 0.26 : 0.36));
    const pxMs = () => (w - nowX() - (phone() ? 10 : 24)) / ((RULES.horizon + 1.5) * 1000);
    /**
     * How tall a price step is on screen. Eased towards whatever fits the
     * range the price can reach in the next thirty seconds, so the space is
     * the part of the future that matters.
     */
    let pitchY = 22;
    const x = (t: number) => nowX() + (t - at) * pxMs();
    const tAt = (px: number) => at + (px - nowX()) / pxMs();
    const y = (p: number) => h / 2 - ((p - centre) / game.current!.step) * pitchY;
    const pAt = (py: number) => centre + ((h / 2 - py) * game.current!.step) / pitchY;
    /** The pen's radius on screen: half its cell, so the ink is exactly as tall as what it is judged on. */
    const radius = () => (game.current!.cell * pitchY) / 2;

    /*
      The map, redrawn only when the field changes: one pixel per slice,
      softened and scaled up smoothly, so it reads as a landscape of odds
      rather than a grid. And where along it each multiple is reached.
    */
    const map = { field: null as Field | null, pal: null as Palette | null, small: document.createElement("canvas"), big: document.createElement("canvas"), labels: [] as { t: number; row: number; m: number }[] };
    const paintMap = (fl: Field, pal: Palette) => {
      const began = performance.now();
      try {
        paintMapNow(fl, pal);
      } finally {
        const ms = performance.now() - began;
        if (process.env.NODE_ENV !== "production" && ms > 50) console.warn(`[ink] slow map: ${Math.round(ms)} ms (rows ${fl.rows})`);
      }
    };
    const paintMapNow = (fl: Field, pal: Palette) => {
      map.field = fl;
      map.pal = pal;
      map.small.width = fl.seconds;
      map.small.height = fl.rows;
      const s = map.small.getContext("2d")!;
      const img = s.createImageData(fl.seconds, fl.rows);
      for (let j = 1; j <= fl.seconds; j++)
        for (let r = 0; r < fl.rows; r++) {
          const m = multipleOf(fl, { t: fl.openAt + j * 1000, row: fl.row0 + r });
          if (m === null) continue;
          // Brightest where the price is likeliest to go, fading into the page as the multiples grow.
          const k = Math.min(1, Math.max(0, Math.log(m) / Math.log(RULES.maxMultiple)));
          const o = ((fl.rows - 1 - r) * fl.seconds + (j - 1)) * 4;
          img.data[o] = pal.ink[0];
          img.data[o + 1] = pal.ink[1];
          img.data[o + 2] = pal.ink[2];
          img.data[o + 3] = Math.round(255 * (pal.dark ? 0.22 : 0.15) * (1 - k) ** 1.2);
        }
      blurAlpha(img.data, fl.seconds, fl.rows, pal.ink);
      s.putImageData(img, 0, 0);
      // Never more than about a thousand pixels tall, however many rows the market needs.
      const px = Math.max(2, Math.min(MAP_PX, Math.floor(1024 / fl.rows)));
      map.big.width = fl.seconds * px;
      map.big.height = fl.rows * px;
      const b = map.big.getContext("2d")!;
      b.imageSmoothingEnabled = true;
      b.imageSmoothingQuality = "high";
      // Softened at its own size already, so scaling it up smoothly is all it needs: a canvas blur at full size held the page up once a second.
      b.drawImage(map.small, 0, 0, map.big.width, map.big.height);
      // The first slice out from the price, above and below, that pays each level, at three moments ahead.
      map.labels = [];
      const here = rowOf(fl.f.price, fl.step);
      // Three columns of multiples on a wide screen; two on a phone, where three crowd each other.
      for (const j of phone() ? [9, 24] : [7, 16, 26]) {
        if (j > fl.seconds) continue;
        const t = fl.openAt + j * 1000;
        for (const dir of [1, -1]) {
          let last = Number.NEGATIVE_INFINITY;
          for (const level of phone() ? [5, 25, 50] : LEVELS) {
            for (let r = here; Math.abs(r - here) < fl.rows; r += dir) {
              const m = multipleOf(fl, { t, row: r });
              if (m === null) {
                if (Math.abs(r - here) > 3) break;
                continue;
              }
              if (m < level) continue;
              // Only where the map is near this level, and never on top of the last label: a jump from 2x straight to 9x is not a 5x.
              if (m < level * 1.6 && Math.abs(r - here) - last >= 2) {
                map.labels.push({ t: t + 500, row: r, m: level });
                last = Math.abs(r - here);
              }
              break;
            }
          }
        }
      }
    };

    /* The pen: the stroke so far, and what it would cost and pay. */
    type Pen = { id: number; drawing: string; last: { x: number; y: number }; stroke: Stroke; quote: Preview | null; quotedAt: number; finger: boolean; why: string | null };
    let pen: Pen | null = null;
    let hover: { x: number; y: number } | null = null;
    let flash: { text: string; x: number; y: number; born: number } | null = null;

    /** The terms of the game for a drawing placed now: what the pen's label says comes from the same place as what a hit pays. */
    const termsNow = () => {
      const g = game.current!;
      return g.field ? terms(g.field, now(g), g.step, g.pen, g.perDot) : null;
    };
    /** Re-price the stroke being drawn, at most twenty times a second. */
    const requote = (p: Pen, force = false) => {
      const t = performance.now();
      if (!force && t - p.quotedAt < 50) return;
      const began = t;
      p.quotedAt = t;
      p.quote = game.current!.quote?.(p.stroke) ?? null;
      // Placed as it is drawn: every new point is bet, and paid for, the moment the pen covers it.
      const why = place.current(p.stroke, p.drawing, false);
      if (why && why !== p.why) flash = { text: why, x: p.last.x, y: p.last.y, born: performance.now() };
      p.why = why;
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
      if (pen || !g || !price(g) || !g.field) return;
      const q = point(e);
      if (q.x < nowX() + 4) return;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* A pointer the browser no longer tracks: drawing still works while it stays over the canvas. */
      }
      pen = { id: e.pointerId, drawing: crypto.randomUUID(), why: null, last: q, stroke: { t0: tAt(q.x), p0: pAt(q.y), pts: [{ t: 0, p: 0 }], rt: radius() / pxMs(), rp: (g.cell * g.step) / 2 }, quote: null, quotedAt: 0, finger: e.pointerType !== "mouse" };
      requote(pen, true);
    };
    const move = (e: PointerEvent) => {
      const q = point(e);
      hover = e.pointerType === "mouse" ? q : null;
      if (!pen || e.pointerId !== pen.id) return;
      // A little lag on the pen smooths the hand's tremor out of the line, as a real nib does.
      const s = { x: pen.last.x + (q.x - pen.last.x) * 0.6, y: pen.last.y + (q.y - pen.last.y) * 0.6 };
      if (Math.hypot(s.x - pen.last.x, s.y - pen.last.y) < 1.5) return;
      pen.last = s;
      pen.stroke.pts.push({ t: tAt(s.x) - pen.stroke.t0, p: pAt(s.y) - pen.stroke.p0 });
      requote(pen);
    };
    const up = (e: PointerEvent) => {
      if (!pen || e.pointerId !== pen.id) return;
      const p = pen;
      pen = null;
      const q = point(e);
      p.stroke.pts.push({ t: tAt(q.x) - p.stroke.t0, p: pAt(q.y) - p.stroke.p0 });
      preview.current(null);
      const why = place.current(p.stroke, p.drawing, true);
      if (why && why !== p.why) flash = { text: why, x: q.x, y: q.y, born: performance.now() };
    };
    const cancel = () => {
      pen = null;
      preview.current(null);
    };
    const leave = () => {
      hover = null;
    };
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
      // Through the midpoints, with each point as the control: a smooth line with no corners, as a pen leaves.
      for (let i = 1; i < pts.length - 1; i++) c.quadraticCurveTo(pts[i].u, pts[i].v, (pts[i].u + pts[i + 1].u) / 2, (pts[i].v + pts[i + 1].v) / 2);
      const end = pts[pts.length - 1];
      c.lineTo(end.u + (pts.length === 1 ? 1e-3 : 0), end.v);
      c.lineCap = "round";
      c.lineJoin = "round";
      c.lineWidth = 2 + grow;
      c.strokeStyle = style;
      c.stroke();
      c.restore();
    };
    /*
      Ink not in play is faded through a soft mask: the cells drawn small,
      one pixel for every six, and scaled back up smoothly, so the fade has
      soft edges and never shows the cells it is made of.
    */
    const MASK = 6;
    const mask = document.createElement("canvas");
    /* The mask again, blurred at its own small size: blurring the full screen every frame stalled the page. */
    const soft = document.createElement("canvas");
    const soften = (cells: Cell[], bands: [number, number][], keep: number) => {
      if (!cells.length && !bands.length) return;
      // Sized once per screen size: setting a canvas's size, even to the same, throws its pixels away and allocates them again.
      if (mask.width !== Math.ceil(w / MASK) || mask.height !== Math.ceil(h / MASK)) {
        mask.width = Math.ceil(w / MASK);
        mask.height = Math.ceil(h / MASK);
        soft.width = mask.width;
        soft.height = mask.height;
      }
      const m = mask.getContext("2d")!;
      m.clearRect(0, 0, mask.width, mask.height);
      m.fillStyle = "#000";
      const wide = pxMs() * 1000;
      for (const q of cells) {
        const top = y(q.hi);
        m.fillRect(x(q.t) / MASK, top / MASK, wide / MASK, (y(q.lo) - top) / MASK);
      }
      for (const [x0, x1] of bands) m.fillRect(x0 / MASK, 0, (x1 - x0) / MASK, mask.height);
      const sb = soft.getContext("2d")!;
      sb.clearRect(0, 0, soft.width, soft.height);
      sb.filter = "blur(1.5px)";
      sb.drawImage(mask, 0, 0);
      sb.filter = "none";
      c.save();
      c.globalCompositeOperation = "destination-out";
      c.globalAlpha = 1 - keep;
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = "high";
      c.drawImage(soft, 0, 0, soft.width * MASK, soft.height * MASK);
      c.restore();
    };
    /*
      Where the price met the ink, it glows: the stroke drawn again in
      green on a layer of its own, kept only in soft spots around each place
      the price crossed it, and laid over the ink. No edges, and nowhere the
      price did not go.
    */
    const glowLayer = document.createElement("canvas");

    let raf = 0;
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
      const p = price(g);
      const ms = performance.now();
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
      const rowsOnScreen = h / pitchY;
      centre += (p - centre) * (Math.abs(off) > rowsOnScreen * 0.3 ? 0.12 : Math.abs(off) > rowsOnScreen * 0.12 ? 0.03 : 0.006);
      const fl = g.field;
      if (fl) {
        // Three typical moves over twenty seconds, either side, in the middle 90% of the screen.
        const reach = (3 * fl.f.sigma * fl.f.price * Math.sqrt(20)) / g.step;
        const want = Math.max(8, Math.min(44, (h * 0.45) / Math.max(1, reach)));
        pitchY += (want - pitchY) * 0.05;
        if (map.field !== fl || map.pal !== pal) paintMap(fl, pal);
      }
      const nx = nowX();
      const step = g.step;
      const first = openFor(at) + 1000;

      /*
        The ink first, so it can be softened and rubbed out before anything
        else is drawn. Ink is solid while it is in play; ink that is not
        (too soon, or too far to measure) fades out softly.
      */
      const faint: Cell[] = [];
      const bands: [number, number][] = [];
      // A line is placed as it is drawn, a few points at a time: each of those bets shares the line, and it is drawn once.
      const drawnOnce = new Set<string>(pen ? [pen.drawing] : []);
      for (const bet of g.bets) {
        const st = bet.stroke;
        if (bet.status === "void") continue;
        if (x(st.t0 + Math.max(...st.pts.map((q) => q.t))) + radius() < nx - pxMs() * 2500) continue;
        const line = bet.group ?? bet.id;
        if (!drawnOnce.has(line)) ink(st, solid);
        drawnOnce.add(line);
        if (bet.status !== "opening") {
          const inPlay = new Set(bet.cells.map((q) => `${q.t}:${q.lo}`));
          for (const q of bet.drawn) if (!inPlay.has(`${q.t}:${q.lo}`)) faint.push(q);
        }
      }
      // The stroke being drawn, the same way; and anything of it in the second after now, which no drawing can be.
      if (pen) {
        ink(pen.stroke, solid);
        if (pen.quote) faint.push(...pen.quote.out);
        bands.push([nx, x(first)]);
      }
      soften(faint, bands, 0.2);
      // Ink the price has passed is spent: it fades away behind the price line, over about two seconds.
      c.save();
      c.globalCompositeOperation = "destination-out";
      const trail = Math.max(40, pxMs() * 2000);
      const spent = c.createLinearGradient(nx - trail, 0, nx, 0);
      spent.addColorStop(0, "rgba(0,0,0,1)");
      spent.addColorStop(1, "rgba(0,0,0,0.25)");
      c.fillStyle = spent;
      c.fillRect(0, 0, nx, h);
      c.restore();
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
          const cx = x(q.t + 500);
          const cy = (y(lo) + y(hi)) / 2;
          const r = Math.max(22, pxMs() * 900, (y(lo) - y(hi)) * 0.8);
          const spot = gl.createRadialGradient(cx, cy, 0, cx, cy, r);
          spot.addColorStop(0, "rgba(0,0,0,1)");
          spot.addColorStop(0.55, "rgba(0,0,0,0.85)");
          spot.addColorStop(1, "rgba(0,0,0,0)");
          gl.fillStyle = spot;
          gl.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
        gl.restore();
        const age = Math.max(0, Math.min(1, (at - (Math.max(...hits.map((q) => q.t)) + 1000)) / 2200));
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalAlpha = 1 - age * age;
        c.drawImage(glowLayer, 0, 0);
        c.restore();
      }

      // The map of the odds, under the ink, from the second a drawing can start.
      if (fl && map.field === fl) {
        c.save();
        c.globalCompositeOperation = "destination-over";
        c.beginPath();
        c.rect(Math.max(nx, x(first) - pxMs() * 400), 0, w, h);
        c.clip();
        // Laid from the second a drawing placed now opens on: the map is a second behind it, and priced for it.
        const shift = openFor(at) - fl.openAt;
        const x0 = x(fl.openAt + shift + 1000);
        const x1 = x(fl.openAt + shift + (fl.seconds + 1) * 1000);
        c.drawImage(map.big, x0, y((fl.row0 + fl.rows) * fl.step), x1 - x0, y(fl.row0 * fl.step) - y((fl.row0 + fl.rows) * fl.step));
        c.restore();
        // The multiples, written where the map reaches them: the further out, the more it pays.
        c.font = `600 10px ${MONO}`;
        c.textAlign = "center";
        const placed: { x: number; y: number }[] = [];
        for (const l of map.labels) {
          const lx = x(l.t + shift);
          const ly = y((l.row + 0.5) * fl.step);
          if (lx < x(first) + 12 || lx > w - 12 || ly < 14 || ly > h - 22) continue;
          if (placed.some((q) => Math.abs(q.x - lx) < 30 && Math.abs(q.y - ly) < 16)) continue;
          placed.push({ x: lx, y: ly });
          c.fillStyle = rgba(pal.muted, 0.85);
          // What a hit there pays at the price set, so the chart moves when the price does.
          c.fillText(dollars(payoutOf(g.perDot, l.m)), lx, ly);
        }
      }

      // A price on the left every so many steps, faint: enough to read where things are.
      c.font = `500 10px ${MONO}`;
      c.textBaseline = "middle";
      c.textAlign = "left";
      const every = Math.max(1, Math.round(44 / pitchY));
      const cents = step < 1;
      for (let r = rowOf(pAt(h), step) - 1; r <= rowOf(pAt(0), step) + 1; r++) {
        if (r % every) continue;
        const py = Math.round(y(r * step)) + 0.5;
        // Not under the market's name and price, top left.
        if (py < 66) continue;
        c.fillStyle = `rgba(${rgb},0.04)`;
        c.fillRect(0, py, nx, 1);
        c.fillStyle = `rgba(${rgb},0.32)`;
        c.fillText(fmtPrice(r * step, cents), 8, py - 7);
      }

      // The price so far: each second's low and high in turn before the trades on hand, then every trade, so the line touches whatever ink was judged on.
      const from = tAt(-20);
      const firstTick = g.ticks[0]?.t ?? Number.POSITIVE_INFINITY;
      c.beginPath();
      let started = false;
      const to = (tt: number, pr: number) => {
        const px = x(Math.min(tt, at));
        if (!started) {
          c.moveTo(px, y(pr));
          started = true;
        } else c.lineTo(px, y(pr));
      };
      let prev = 0;
      for (const bar of g.bars) {
        if (bar.t + 1000 < from || bar.t >= firstTick) {
          prev = bar.c;
          continue;
        }
        const rising = bar.c >= (prev || bar.c);
        to(bar.t + 250, rising ? bar.l : bar.h);
        to(bar.t + 600, rising ? bar.h : bar.l);
        to(bar.t + 1000, bar.c);
        prev = bar.c;
      }
      for (const tk of g.ticks) if (tk.t >= from) to(tk.t, tk.p);
      to(at, p);
      c.lineJoin = "round";
      c.lineCap = "round";
      c.strokeStyle = `rgba(${rgb},0.1)`;
      c.lineWidth = 7;
      c.stroke();
      c.strokeStyle = `rgba(${rgb},0.92)`;
      c.lineWidth = 1.75;
      c.stroke();

      // Now: a line top to bottom, and the price on it.
      const glow = c.createLinearGradient(0, 0, 0, h);
      glow.addColorStop(0, `rgba(${rgb},0)`);
      glow.addColorStop(0.5, `rgba(${rgb},0.28)`);
      glow.addColorStop(1, `rgba(${rgb},0)`);
      c.fillStyle = glow;
      c.fillRect(nx - 0.5, 0, 1, h);
      const py = y(p);
      const pulse = (ms % 1400) / 1400;
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
      const label = fmtPrice(p, true);
      const lw = c.measureText(label).width + 14;
      roundRect(c, nx - lw - 10, py - 10, lw, 20, 10);
      c.fillStyle = `rgb(${rgb})`;
      c.fill();
      c.fillStyle = rgba(pal.bg);
      c.fillText(label, nx - 10 - lw / 2, py + 0.5);

      // Seconds ahead, along the foot.
      c.font = `500 10px ${MONO}`;
      c.fillStyle = `rgba(${rgb},0.32)`;
      for (let s = 10; s <= RULES.horizon; s += 10) c.fillText(`${s}s`, x(at + s * 1000), h - 10);

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
        const tn = termsNow();
        const sec = Math.floor(tAt(tip.x) / 1000) * 1000;
        const m = tn ? tn.multiple(sec, tn.rowOf(pAt(tip.y))) : null;
        // The multiple and what a hit there pays at the price set: the same figure a hit shows.
        const text = m !== null && tn ? `${fmtMultiple(m)} · ${dollars(tn.pays(sec, tn.rowOf(pAt(tip.y)))!)}` : tAt(tip.x) < first ? "Too soon" : "—";
        c.font = `700 12px ${MONO}`;
        const tw = c.measureText(text).width + 14;
        // Beside a mouse; well above a finger, which would cover it.
        const finger = pen?.finger ?? false;
        const bx = finger ? Math.min(w - tw - 6, Math.max(6, tip.x - tw / 2)) : Math.min(w - tw - 6, tip.x + radius() + 8);
        const by = Math.max(14, tip.y - radius() - (finger ? 52 : 16));
        roundRect(c, bx, by - 11, tw, 22, 11);
        c.fillStyle = m !== null ? rgba(pal.fg) : rgba(pal.fg, 0.12);
        c.fill();
        c.fillStyle = m !== null ? rgba(pal.bg) : rgba(pal.muted);
        c.textAlign = "center";
        c.fillText(text, bx + tw / 2, by + 0.5);
      }

      // The first time: a ghost pen draws a stroke ahead of the price.
      if (g.hint && !pen) {
        const k = reducedMotion.matches ? 0.65 : (ms % 3200) / 3200;
        const x0 = nx + (w - nx) * 0.18;
        const x1 = nx + (w - nx) * 0.72;
        const along = (f: number) => ({ px: x0 + (x1 - x0) * f, py: py - pitchY * 4 * Math.sin(f * Math.PI * 1.3) - f * pitchY * 2 });
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
          const n = e.big ? 16 : 9;
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
          c.fillText(e.text ?? "", Math.max(ex, nx) + 12, ey - 16 - age * 36);
          c.textAlign = "center";
          c.globalAlpha = 1;
        } else {
          c.beginPath();
          c.arc(ex, ey, 8 + age * 30, 0, Math.PI * 2);
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
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("pointerleave", leave);
    };
  }, [game]);

  return <canvas aria-label="The price, and a map of the odds ahead of it: draw there to bet" className={className} ref={canvas} role="img" style={{ touchAction: "none", cursor: "none" }} />;
}
