"use client";

import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { Palette } from "./theme";
import {
  type Plan,
  penPoint,
  type Point,
  polylines,
  type Stroke,
} from "./trace";

/**
 * The drawing surface.
 *
 * A transparent canvas over the price pane. Everything on it is stored in
 * (seconds from now, price) and converted to pixels on the frame it is painted,
 * so the ink is attached to the market rather than to the screen: the chart
 * scrolls, a new bar opens, and the line you drew stays on the prices you drew
 * it at.
 *
 * The layers are the Trace sandbox's, in its order, because the order is the
 * argument. Bottom to top:
 *
 *   1. The stretches with no position, hatched — what the plan is *not* doing.
 *   2. Your hand, in grey. The line as drawn, smoothed through its own points.
 *   3. The sampled path, thin: your hand read off at one price per column.
 *      Dashed where a pen lift was short enough to bridge.
 *   4. The spine, thick: the simplified turns that will actually trade.
 *   5. The markers: a triangle where each position opens, pointing the way it
 *      goes, and a ring where it closes.
 *
 * Four of those five are the same line at decreasing fidelity, which is the
 * point — a reader can watch their wobble become a straight leg and understand,
 * without being told, that the wobble was never a trade.
 *
 * Direction lives in the markers rather than in the spine's colour. The spine is
 * one object and it is brand blue; green and red belong to the triangles, which
 * is where a decision is being made.
 */

/** How much of the previous point each new one keeps. */
const SMOOTH = 0.45;

/** Below this, a forward move is the pen jittering inside one column. */
const MIN_STEP_PX = 2;

/** How near a turn you have to press to grab it, in pixels. */
const GRAB_PX = 12;

/**
 * The time axis, ours rather than the library's.
 *
 * Everything drawn here lives past the last candle, and the chart has no
 * reliable answer out there. `logicalToCoordinate` folds back towards the left
 * edge for an index the series does not have — which is how five entry markers
 * ended up stacked against the side of the chart with their labels clipped to a
 * single letter, while the ink they belonged to sat correctly two thirds of the
 * way across — and `timeToCoordinate` answers as though the right offset were
 * not there.
 *
 * So Draw does not ask. It pins the time scale instead: the bar spacing is set
 * to the pane divided by every bar there is to show, the right offset to the
 * horizon, and scrolling and scaling are turned off. With the axis nailed down,
 * where a second falls is arithmetic — and the pen and the painter run the same
 * arithmetic, which is what actually matters.
 *
 * Pinning it is not a compromise. A surface you draw on that slides under your
 * hand is a surface you cannot draw on.
 */
type Axis = {
  /** Bar length in seconds. */
  barSeconds: number;
  /** Candles on the chart. */
  bars: number;
  /** Empty bars of future reserved past the last candle. */
  future: number;
  /** The pane, in pixels. */
  width: number;
};

function axisMap(a: Axis) {
  const total = a.bars + a.future;
  if (a.width <= 0 || total <= 0 || a.barSeconds <= 0) return null;
  const perBar = a.width / total;
  // The last candle sits exactly `future` bars in from the right edge, which is
  // what `rightOffset` means and what the chart was told to do.
  const xNow = a.width - a.future * perBar;
  const perSecond = perBar / a.barSeconds;
  return {
    tOfX: (x: number) => (x - xNow) / perSecond,
    xOfT: (t: number) => xNow + t * perSecond,
  };
}

export function Sketch({
  chart,
  series,
  palette,
  strokes,
  onStrokes,
  ghost,
  onGhost,
  plan,
  bars,
  future,
  barSeconds,
  horizon,
  columnSeconds,
}: {
  chart: RefObject<IChartApi | null>;
  series: RefObject<ISeriesApi<SeriesType> | null>;
  palette: Palette | null;
  strokes: Stroke[];
  onStrokes: (next: Stroke[]) => void;
  /** The hand as originally drawn, kept behind once the plan is being edited. */
  ghost: Stroke[];
  onGhost: (next: Stroke[]) => void;
  plan: Plan | null;
  /** Candles on the chart. */
  bars: number;
  /** Empty bars of future past the last candle. */
  future: number;
  /** Bar length in seconds. */
  barSeconds: number;
  /** Seconds of future that can be drawn on. */
  horizon: number;
  /** One column of the plan, in seconds. A turn cannot be dragged inside one. */
  columnSeconds: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  /** The stroke in progress. Kept out of React: it changes every pointermove. */
  const live = useRef<Stroke | null>(null);
  /** The finished strokes as they were when the live one began. */
  const base = useRef<Stroke[]>([]);

  /** Whether the pen is down, so the stroke being made can be lit differently. */
  const [penDown, setPenDown] = useState(false);
  /** Which turn is being dragged, if any. */
  const [held, setHeld] = useState<{ gi: number; vi: number } | null>(null);
  /** The polylines under the drag. Mutated in place, copied out to React. */
  const polys = useRef<Stroke[]>([]);

  /** The pane, as the painter last measured it. The pen reads the same box. */
  const paneWidth = () => canvas.current?.getBoundingClientRect().width ?? 0;
  const axis = (): Axis => ({ barSeconds, bars, future, width: paneWidth() });

  /* ---- painting ----------------------------------------------------------- */

  useEffect(() => {
    let frame = 0;

    const paint = () => {
      const el = canvas.current;
      const api = chart.current;
      const line = series.current;
      const colours = palette;
      if (!el || !api || !line || !colours) return;

      const pane = api.paneSize(0);
      if (pane.width === 0 || pane.height === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(pane.width * dpr);
      const h = Math.round(pane.height * dpr);
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
      }
      el.style.width = `${pane.width}px`;
      el.style.height = `${pane.height}px`;

      const ctx = el.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, pane.width, pane.height);

      const map = axisMap({ barSeconds, bars, future, width: pane.width });
      if (!map) return;
      const xOf = map.xOfT;
      const at = (q: Point) => {
        const y = line.priceToCoordinate(q.p);
        return y === null ? null : { x: xOf(q.t), y };
      };

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";

      /* ---- 0. now, and the canvas past it --------------------------------- */

      const edge = xOf(0);
      {
        ctx.fillStyle = colours.surface2;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(edge, 0, pane.width - edge, pane.height);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colours.hairline;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(edge + 0.5, 0);
        ctx.lineTo(edge + 0.5, pane.height);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const compiled = plan;

      /* ---- 1. the stretches with no position ------------------------------ */

      if (compiled) {
        for (const flat of compiled.flats) {
          const xa = xOf(flat.t0);
          const xb = xOf(flat.t1);
          if (xb - xa < 1) continue;
          ctx.save();
          ctx.beginPath();
          ctx.rect(xa, 0, xb - xa, pane.height);
          ctx.clip();
          ctx.strokeStyle = colours.fgSubtle;
          ctx.globalAlpha = 0.22;
          ctx.lineWidth = 1;
          // Diagonal hatching, the way a chart says "nothing here" without
          // printing a word across the part you are working on.
          for (let x = xa - pane.height; x < xb; x += 9) {
            ctx.beginPath();
            ctx.moveTo(x, pane.height);
            ctx.lineTo(x + pane.height, 0);
            ctx.stroke();
          }
          ctx.restore();
          if (xb - xa > 44) {
            ctx.fillStyle = colours.fgSubtle;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(
              flat.kind === "start"
                ? "not yet"
                : flat.kind === "tail"
                  ? "closed"
                  : "flat",
              (xa + xb) / 2,
              14,
            );
          }
        }
      }

      /* ---- 2. your hand --------------------------------------------------- */

      /**
       * Quadratic through the midpoints: each recorded point becomes a control
       * point rather than a corner, which is what turns a polyline sampled off a
       * pointer into something that looks drawn.
       */
      const sketch = (st: Stroke) => {
        if (!st.length) return;
        const first = at(st[0]);
        if (!first) return;
        ctx.beginPath();
        ctx.moveTo(first.x, first.y);
        if (st.length < 3) {
          for (const q of st) {
            const c = at(q);
            if (c) ctx.lineTo(c.x, c.y);
          }
          // A single tap still has to leave a mark.
          if (st.length === 1) ctx.lineTo(first.x + 0.1, first.y);
        } else {
          for (let i = 1; i < st.length - 1; i++) {
            const p = at(st[i]);
            const q = at(st[i + 1]);
            if (!p || !q) continue;
            ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
          }
          const last = at(st[st.length - 1]);
          if (last) ctx.lineTo(last.x, last.y);
        }
        ctx.stroke();
      };

      // What was drawn before the plan started being edited by its turns. It
      // stays on the chart so a reader can see the shape they asked for behind
      // the straight lines it became.
      ctx.strokeStyle = colours.fgSubtle;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2;
      for (const st of ghost) sketch(st);

      // The stroke under the pen is brand-coloured, so you can tell which of the
      // lines on the chart is the one you are making.
      const settled = penDown ? strokes.slice(0, -1) : strokes;
      ctx.globalAlpha = 0.65;
      for (const st of settled) sketch(st);
      ctx.globalAlpha = 1;
      if (penDown && strokes.length) {
        ctx.strokeStyle = colours.brand;
        ctx.lineWidth = 2.5;
        sketch(strokes[strokes.length - 1]);
      }

      if (!compiled) return;

      /* ---- 3. the sampled path -------------------------------------------- */

      type Dot = { x: number; y: number; bridged: boolean };
      const runs: Dot[][] = [];
      let run: Dot[] | null = null;
      for (const col of compiled.cols) {
        if (col.gap) {
          run = null;
          continue;
        }
        const c = at(col);
        if (!c) continue;
        if (!run) {
          run = [];
          runs.push(run);
        }
        run.push({ bridged: col.bridged, x: c.x, y: c.y });
      }
      ctx.strokeStyle = colours.brand;
      ctx.lineWidth = 1.5;
      for (const sg of runs) {
        for (let i = 1; i < sg.length; i++) {
          ctx.save();
          ctx.globalAlpha = 0.38;
          // Dashed across a bridged hole: that stretch is the compiler's guess
          // at what the pen did between two touches, not something you drew.
          if (sg[i].bridged || sg[i - 1].bridged) ctx.setLineDash([4, 5]);
          ctx.beginPath();
          ctx.moveTo(sg[i - 1].x, sg[i - 1].y);
          ctx.lineTo(sg[i].x, sg[i].y);
          ctx.stroke();
          ctx.restore();
        }
      }

      /* ---- 4. the spine that will trade ----------------------------------- */

      const items = [
        ...compiled.legs,
        ...compiled.flats.filter((f) => f.kind === "horizontal"),
      ].sort((x, y) => x.t0 - y.t0);
      const spines: { x: number; y: number }[][] = [];
      let vertices: { x: number; y: number }[] | null = null;
      let seg = Number.NaN;
      for (const it of items) {
        const a0 = at({ p: it.p0, t: it.t0 });
        const a1 = at({ p: it.p1, t: it.t1 });
        if (!a0 || !a1) continue;
        if (it.seg !== seg) {
          vertices = [a0];
          spines.push(vertices);
          seg = it.seg;
        }
        vertices?.push(a1);
      }
      for (const sg of spines) {
        if (sg.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(sg[0].x, sg[0].y);
        for (let i = 1; i < sg.length; i++) ctx.lineTo(sg[i].x, sg[i].y);
        ctx.strokeStyle = colours.brand;
        ctx.globalAlpha = 0.24;
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      /* ---- 5. where each position opens and closes ------------------------ */

      for (const leg of compiled.legs) {
        const a0 = at({ p: leg.p0, t: leg.t0 });
        const a1 = at({ p: leg.p1, t: leg.t1 });
        if (!a0) continue;
        const tone = leg.dir > 0 ? colours.up : colours.down;

        // A triangle pointing the way the position goes, numbered in order.
        ctx.fillStyle = tone;
        ctx.beginPath();
        if (leg.dir > 0) {
          ctx.moveTo(a0.x, a0.y - 9);
          ctx.lineTo(a0.x - 7, a0.y + 5);
          ctx.lineTo(a0.x + 7, a0.y + 5);
        } else {
          ctx.moveTo(a0.x, a0.y + 9);
          ctx.lineTo(a0.x - 7, a0.y - 5);
          ctx.lineTo(a0.x + 7, a0.y - 5);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = colours.bg;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(leg.id), a0.x, a0.y + (leg.dir > 0 ? 1.5 : -1.5));

        // An open ring where it closes: the same mark hollow, because getting
        // out is the same event as getting in with the sign turned round.
        if (a1) {
          ctx.strokeStyle = tone;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(a1.x, a1.y, 4, 0, Math.PI * 2);
          ctx.stroke();
        }

        /*
          What the turn is called, and how fast the leg gets there.

          These are the two things a trader says out loud about a shape — "lower
          high", "that is a steep leg" — and printing them is how someone who
          has never traded picks the words up. The turn word goes at the turn;
          the rate goes along the leg, and only when the leg is wide enough for
          it not to sit on top of its own neighbours.
        */
        ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
        if (a1 && leg.turn) {
          ctx.fillStyle = colours.fgSubtle;
          ctx.fillText(leg.turn, a1.x, a1.y + (leg.dir > 0 ? -14 : 16));
        }
        if (a1 && a1.x - a0.x > 64) {
          // Off the line rather than above or below it: on a steep leg a
          // vertical offset still lands the words on top of the stroke they are
          // labelling. This pushes them out along the normal instead.
          const dx = a1.x - a0.x;
          const dy = a1.y - a0.y;
          const len = Math.hypot(dx, dy) || 1;
          ctx.fillStyle = tone;
          ctx.fillText(
            `${leg.slope} ${leg.rate >= 0 ? "+" : ""}${
              Math.abs(leg.rate) >= 10 ? leg.rate.toFixed(0) : leg.rate.toFixed(2)
            }%/min`,
            (a0.x + a1.x) / 2 + (dy / len) * 16 * leg.dir,
            (a0.y + a1.y) / 2 - (dx / len) * 16 * leg.dir,
          );
        }
        ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
      }

      /* ---- 6. the turns, as things you can move --------------------------- */

      const groups = polys.current.length ? polys.current : polylines(compiled);
      for (const [gi, poly] of groups.entries()) {
        for (const [vi, v] of poly.entries()) {
          const c = at(v);
          if (!c) continue;
          // A ring around the turn rather than a disc on top of it: the
          // numbered triangle underneath is what the turn *is*, and a handle
          // that hides it trades the explanation for the grip.
          const active = held?.gi === gi && held?.vi === vi;
          ctx.beginPath();
          ctx.arc(c.x, c.y, 10, 0, Math.PI * 2);
          if (active) {
            ctx.fillStyle = colours.brand;
            ctx.globalAlpha = 0.14;
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = colours.brand;
          ctx.globalAlpha = active ? 1 : 0.45;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    };

    /**
     * Paint now, then once a frame.
     *
     * The loop is for the chart moving under the ink — panning, a new bar, the
     * live price. The call before it is for everything else: a browser runs no
     * animation frames for a tab you cannot see and throttles them whenever it
     * likes, and a stroke that only appears on the next frame is a stroke that
     * does not appear.
     */
    const loop = () => {
      frame = requestAnimationFrame(loop);
      paint();
    };

    /**
     * Keep trying until the chart exists.
     *
     * This is a child of the chart, so its effects run *before* the parent's —
     * on the first pass there is no chart instance and no series to ask for
     * coordinates, and the canvas is left at its default 300×150. That is not
     * only an unpainted canvas: it is a 300px box where a pointer is supposed
     * to find a 1600px drawing surface.
     */
    let retry = 0;
    const settle = (left: number) => {
      paint();
      if (!canvas.current?.style.width && left > 0) {
        retry = window.setTimeout(() => settle(left - 1), 80);
      }
    };
    settle(20);
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(retry);
    };
  }, [
    barSeconds,
    bars,
    chart,
    future,
    ghost,
    held,
    palette,
    penDown,
    plan,
    series,
    strokes,
  ]);

  /* ---- the pen ------------------------------------------------------------ */

  const point = (event: React.PointerEvent): Point | null => {
    const el = canvas.current;
    const linear = series.current;
    if (!el || !linear) return null;
    const rect = el.getBoundingClientRect();
    const map = axisMap(axis());
    const p = linear.coordinateToPrice(event.clientY - rect.top);
    if (!map || p === null) return null;
    // Only the future is drawable. The past already happened, and a line over it
    // would be a plan for a fill you cannot get.
    return {
      p: Number(p),
      t: Math.min(Math.max(map.tOfX(event.clientX - rect.left), 0), horizon),
    };
  };

  /** Two times less than a couple of pixels apart. */
  const samePixel = (a: number, b: number) => {
    const map = axisMap(axis());
    if (!map) return false;
    return Math.abs(map.xOfT(a) - map.xOfT(b)) < MIN_STEP_PX;
  };

  /**
   * The turn nearest the pointer, if one is near enough to grab.
   *
   * Pixels rather than seconds, because a grab is a gesture and twelve pixels
   * is twelve pixels whatever the chart is zoomed to.
   */
  const grabbed = (event: React.PointerEvent) => {
    const el = canvas.current;
    const linear = series.current;
    if (!el || !linear || !plan) return null;
    const rect = el.getBoundingClientRect();
    const map = axisMap(axis());
    if (!map) return null;
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let best: { gi: number; vi: number; d: number } | null = null;
    const groups = polys.current.length ? polys.current : polylines(plan);
    for (const [gi, poly] of groups.entries()) {
      for (const [vi, v] of poly.entries()) {
        const y = linear.priceToCoordinate(v.p);
        if (y === null) continue;
        const d = Math.hypot(map.xOfT(v.t) - px, y - py);
        if (d < GRAB_PX && (!best || d < best.d)) best = { d, gi, vi };
      }
    }
    return best;
  };

  /** Drag a turn: the plan becomes the thing being edited, not the hand. */
  const move = (event: React.PointerEvent) => {
    const at = held;
    const q = point(event);
    if (!at || !q) return;
    const poly = polys.current[at.gi];
    const prev = poly[at.vi - 1];
    const next = poly[at.vi + 1];
    // A turn cannot be dragged into its neighbour: two turns inside one column
    // are one turn as far as the compiler is concerned, and the drag would come
    // apart under your hand.
    const low = prev ? prev.t + columnSeconds : 0;
    const high = next ? next.t - columnSeconds : horizon;
    poly[at.vi] = { p: q.p, t: Math.min(Math.max(q.t, low), Math.max(low, high)) };
    onStrokes(polys.current.map((p) => [...p]));
  };

  const extend = (event: React.PointerEvent) => {
    const pts = live.current;
    const q = point(event);
    if (!pts || !q) return;
    const next = penPoint(q, pts[pts.length - 1] ?? null, SMOOTH, samePixel);
    if (!next) return;
    if ("update" in next) pts[pts.length - 1].p = next.p;
    else pts.push(next);
    // A fresh array each time, or React holds the same reference and the plan
    // never recompiles while the pen is down — which is the half of this that
    // teaches anything.
    onStrokes([...base.current, [...pts]]);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drawing surface is a
    // pointer instrument. The same plan is reachable without one — Desk's ticket
    // is the keyboard path to a position.
    <canvas
      className="absolute top-0 left-0 z-10 cursor-crosshair touch-none"
      onPointerCancel={() => {
        live.current = null;
        setPenDown(false);
        setHeld(null);
      }}
      onPointerDown={(event) => {
        const q = point(event);
        if (!q) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // No capture is survivable: the stroke ends on pointerup either way.
        }

        /*
          Press on a turn and you are editing the plan; press anywhere else and
          you are drawing a new one.

          Taking the turn freezes the plan into its own polyline and puts the
          hand that drew it behind, in grey. From here the line and the orders
          are the same object: drag the turn, and the entry moves with it.
        */
        const hit = grabbed(event);
        if (hit && plan) {
          if (!polys.current.length) {
            polys.current = polylines(plan);
            if (!ghost.length) onGhost(strokes);
            onStrokes(polys.current.map((p) => [...p]));
          }
          setHeld({ gi: hit.gi, vi: hit.vi });
          return;
        }

        base.current = strokes;
        live.current = [q];
        setPenDown(true);
        // Drawing again means the frozen polyline is no longer what is being
        // edited; the new stroke is.
        polys.current = [];
        onStrokes([...strokes, [q]]);
      }}
      onPointerMove={(event) => {
        if (held) move(event);
        else if (live.current) extend(event);
      }}
      onPointerUp={() => {
        // The stroke is already in `strokes`; dropping the reference just ends
        // it, so the next press starts a new one rather than continuing this.
        live.current = null;
        setPenDown(false);
        setHeld(null);
      }}
      ref={canvas}
    />
  );
}
