"use client";

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ChevronLeftIcon, ChevronRightIcon, CrosshairIcon, RotateCcwIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type Candle, price as fmtPrice, signedUsd } from "@/lib/market";
import { lineAt, type Pt, type Shape, legPath } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/**
 * The chart you draw on. Our own SVG, sized to its box in pixels. History on
 * the left, the future on the right, "now" between them.
 */

export type Phase = "live" | "drawing" | "drawn" | "running" | "settled";
export type Band = { lo: number; hi: number };

const PAD_T = 16;
const PAD_B = 24;
const PAD_L = 8;
const PAD_R = 8;
/** Where now sits across the plot. Half and half, as asked. */
const HISTORY_SHARE = 0.5;
/** The hint, as fractions of plot height above (+) or below (-) the price. */
const HINT = [0, 0.02, -0.02, -0.07, -0.12, -0.14, -0.1, -0.03, 0.05, 0.13, 0.2, 0.26] as const;

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

type TagSpec = { key: string; price: number; y: number; label?: string; tone?: "default" | "up" | "down" | "probe" };

/** Tags closer than a tag's height are pushed apart down the axis. */
function stackTags(tags: TagSpec[], h: number): TagSpec[] {
  const GAP = 22;
  const sorted = [...tags].sort((a, b) => a.y - b.y);
  for (let i = 0; i < sorted.length; i++) {
    const min = i === 0 ? 12 : sorted[i - 1].y + GAP;
    sorted[i] = { ...sorted[i], y: Math.max(min, sorted[i].y) };
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const max = i === sorted.length - 1 ? h - 12 : sorted[i + 1].y - GAP;
    sorted[i] = { ...sorted[i], y: Math.min(max, sorted[i].y) };
  }
  return sorted;
}

function Tag({ price, y, tone = "default", label }: TagSpec) {
  return (
    <span
      className={cn(
        "figures pointer-events-none absolute right-1 flex -translate-y-1/2 items-baseline gap-1 rounded-full px-2 py-0.5 text-[11px] leading-4",
        tone === "default" && "border bg-popover text-foreground shadow-xs/5",
        // Where the cursor is, not where anything happened. Quieter than a level.
        tone === "probe" && "bg-muted text-muted-foreground",
        tone === "up" && "bg-success text-white",
        tone === "down" && "bg-destructive text-white",
      )}
      style={{ top: y }}
    >
      {label ? <span className="opacity-80">{label}</span> : null}
      {fmtPrice(price)}
    </span>
  );
}

function CandleMarks({ bars, x, body, y, dim }: { bars: Candle[]; x: (i: number) => number; body: number; y: (p: number) => number; dim?: boolean }) {
  return (
    <g opacity={dim ? 0.45 : 0.9}>
      {bars.map((c, i) => {
        const cx = x(i);
        const tone = c.c >= c.o ? "var(--up-mark)" : "var(--down-mark)";
        const top = y(Math.max(c.o, c.c));
        const bottom = y(Math.min(c.o, c.c));
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional
          <g fill={tone} key={i} stroke={tone}>
            <line strokeWidth="1" x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} />
            <rect height={Math.max(1, bottom - top)} width={body} x={cx - body / 2} y={top} />
          </g>
        );
      })}
    </g>
  );
}

export function SketchCanvas({
  feed,
  run,
  runBars,
  pts,
  phase,
  band,
  price,
  shape,
  pnl,
  onDown: onDownPt,
  onMove: onMovePt,
  onUp: onUpPt,
  onGrab,
  onRemove,
  editableFrom,
  headLabel,
  horizonSeconds,
  ghost,
  ribbon,
  className,
}: {
  feed: Candle[];
  run: Candle[];
  runBars: number;
  pts: Pt[];
  phase: Phase;
  band: Band;
  price: number;
  shape: Shape | null;
  pnl: number | null;
  onDown: (pt: Pt) => void;
  onMove: (pt: Pt) => void;
  onUp: () => void;
  /** A point taken hold of, by index. Moves then arrive through onMove. */
  onGrab: (index: number) => void;
  /** A point double-clicked away. */
  onRemove: (index: number) => void;
  /** Points at or before this time are fixed: they have already happened. */
  editableFrom: number;
  /** What the line is worth where it ends, shown at the head while drawing. */
  headLabel?: string | null;
  /**
   * How much future the right half shows, in seconds. Not the round's length:
   * the round is free to grow past it and arrive as the chart scrolls.
   */
  horizonSeconds: number;
  /** Your last line, faint, so you notice your habits. */
  ghost: Pt[] | null;
  /** Half the ribbon's height, in price. */
  ribbon: number;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(box);
  const active = useRef(false);
  /** Where the pointer is, for the loop that reads it while it is not moving. */
  const at = useRef<{ x: number; y: number } | null>(null);
  /** Held against the right edge, so the round should be opening up. */
  const [pushing, setPushing] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  /**
   * How the chart is being looked at. Display only: zoom and pan move the eye,
   * never the orders. `anchor` is the candle held on the split, and null means
   * hold the live one — which is all that following is.
   */
  const [view, setView] = useState<{ zoom: number; anchor: number | null }>({ zoom: 1, anchor: null });
  /** The view being dragged, from where it was grabbed. */
  const pan = useRef<{ x: number; anchor: number; moved: boolean } | null>(null);
  /*
    A new line starts on a fresh view.

    Pan and zoom belong to the round they were looking at. An anchor is a
    candle number, and the next round's candles start again at zero — so a view
    parked eighty candles into a finished round puts the new one somewhere off
    the left of the screen, and you get an empty chart with an axis reading
    +113m and no way to tell what went wrong. Adjusting state during render is
    the documented way to reset on a changing prop, and unlike an effect it
    leaves nothing stale on screen for a frame.
  */
  const [seenPhase, setSeenPhase] = useState(phase);

  const plotL = PAD_L;
  const plotR = Math.max(plotL + 1, w - PAD_R);
  const plotT = PAD_T;
  const plotB = Math.max(plotT + 1, h - PAD_B);
  const split = plotL + (plotR - plotL) * HISTORY_SHARE;
  const span = band.hi - band.lo || 1;
  const y = useCallback((p: number) => plotT + ((band.hi - p) / span) * (plotB - plotT), [band.hi, span, plotT, plotB]);
  const priceAtY = (yy: number) => band.hi - ((yy - plotT) / (plotB - plotT)) * span;

  /**
   * The picture slides left as the round runs.
   *
   * Bars are a fixed width and "now" is pinned to the split, so every candle
   * that arrives pushes the whole chart — the history, the run so far, your
   * line — one bar to the left, and a bar of fresh canvas appears on the right.
   * That canvas is the point of this: it is room to draw into, and drawing into
   * it is how the round gets longer. The right half is always `horizonSeconds`
   * ahead of now, whatever length the round itself has grown to.
   *
   * It did not move before. The round's end sat on the right edge and stayed
   * there while the candles walked up to it, so the future you could still
   * trade shrank to nothing and the only way out of a line you had outgrown was
   * to close the position.
   */
  // Settled, the round is over and all of it is behind now, so widen the bars
  // just enough that its first candle clears the left edge. Only when it has
  // to: a round that never outgrew the window keeps the window's own scale, and
  // the picture does not lurch at the moment it finishes.
  const fit = phase === "settled" ? (runBars * (plotR - split)) / Math.max(1, split - plotL) : 0;
  const VIEW = Math.max(1, horizonSeconds, fit);
  const baseStep = (plotR - split) / VIEW;
  const runStep = baseStep * view.zoom;
  const elapsed = phase === "running" || phase === "settled" ? run.length : 0;
  const following = view.anchor === null;
  /** The candle held on the split. Following, that is always the live one. */
  const anchor = view.anchor ?? elapsed;
  /** Candles since the round's first, to a place on the chart, and back. */
  const xOfBar = (bars: number) => split + (bars - anchor) * runStep;
  const barOfX = (x: number) => anchor + (x - split) / runStep;
  const xOfT = (t: number) => xOfBar(t * runBars);
  const tOfX = (x: number) => barOfX(x) / runBars;
  /** Where now actually is: the split, until you pan away from it. */
  const xNow = xOfBar(elapsed);
  /*
    A bar is a second, so the axis counts in seconds and only says minutes once
    it would otherwise be reading "+124s". It said "+24m" on a round that
    finished in twelve seconds, which is the sort of thing a reader notices and
    then stops trusting the rest of the numbers.
  */
  const label = (bars: number) => {
    const s = Math.round(bars);
    if (Math.abs(s) < 90) return `${s > 0 ? "+" : ""}${s}s`;
    const m = Math.round(s / 6) / 10;
    return `${m > 0 ? "+" : ""}${m}m`;
  };
  /** Held where there is something to see, as the reference clamps its own. */
  const holdAnchor = (a: number) => Math.min(Math.max(a, -feed.length), Math.max(runBars, elapsed) + VIEW);

  /*
    Zoom and pan, as the reference has them — and with its rule, which is worth
    keeping verbatim: they change the view only, orders never move. The factor
    is on the span, so a bigger number is further out.
  */
  const zoomTime = (spanFactor: number, px?: number) => {
    setView((v) => {
      const z = Math.min(8, Math.max(0.15, v.zoom / spanFactor));
      // Held about the place under the pointer — but only when the view is
      // yours. Following re-centres on the next candle regardless, so pinning
      // it to the cursor as well would just fight itself.
      if (v.anchor === null || px === undefined) return { ...v, zoom: z };
      const here = v.anchor + (px - split) / (baseStep * v.zoom);
      return { zoom: z, anchor: holdAnchor(here - (px - split) / (baseStep * z)) };
    });
  };
  const panTime = (dir: number) => {
    const step = ((plotR - plotL) / runStep) * 0.25 * dir;
    setView((v) => ({ ...v, anchor: holdAnchor((v.anchor ?? elapsed) + step) }));
  };
  const follow = () => setView((v) => ({ ...v, anchor: v.anchor === null ? elapsed : null }));
  /** Run the view forward, in candles. What the pen does as it draws. */
  const advance = (bars: number) => setView((v) => ({ ...v, anchor: (v.anchor ?? elapsed) + bars }));
  /** Where the pen is held while it draws: the middle of the plot. */
  const pivot = (plotL + plotR) / 2;

  /*
    The finished plan, framed.

    Letting go used to hand the round back at its own scale, which put its last
    point exactly on the right edge with nothing after it — the line looked cut
    off rather than finished, and there was nowhere for the eye to land. It sits
    across the middle sixty percent now: history still readable to the left, a
    tenth of the plot as air on the right, and the whole of what you drew
    between them.
  */
  const framePlan = () => {
    const width = plotR - plotL;
    const x0 = plotL + width * 0.3;
    const step = (width * 0.6) / Math.max(1, runBars);
    const base = (plotR - split) / Math.max(1, VIEW);
    return { zoom: step / base, anchor: (split - x0) / step };
  };

  if (seenPhase !== phase) {
    setSeenPhase(phase);
    /*
      A fresh line and a started round both want the live candle back on the
      split. A finished one wants framing: the pen may have run the view a long
      way ahead of now, and the plan is the thing to look at.
    */
    if (phase === "live" || phase === "running") setView({ zoom: 1, anchor: null });
    else if (phase === "drawn") setView(framePlan());
  }
  const reset = () => setView({ zoom: 1, anchor: null });
  // Points can still be placed while it runs — ahead of the candles, never behind.
  const canDraw = phase === "live" || phase === "drawn" || phase === "running";

  const local = (e: ReactPointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return null;
    const x = Math.min(plotR, Math.max(xNow, e.clientX - r.left));
    /*
      Across, the pen is penned in: you cannot draw before now, and the right
      edge is where the chart runs forward to make room.

      Up and down it is not. Clamping the price to the band meant the top of
      the plot was the highest call you were allowed to make — draw at the
      ceiling and the line flattened along it, and the band never learned you
      had wanted to go higher, because the clamp had already thrown that away.
      The reading is taken wherever the hand is and the scale opens to meet it.
    */
    return { t: tOfX(x), price: priceAtY(e.clientY - r.top) };
  };
  /** Within this of the right edge counts as pushing against it. */
  const EDGE = 18;
  /** Candles a second the view runs forward while the pen holds the edge. */
  const PAN_BARS = 6;
  const track = (e: ReactPointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    at.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    setPushing(active.current && phase === "drawing" && at.current.x > pivot);
  };

  const onDown = (e: ReactPointerEvent) => {
    /*
      A press that is dismissing a panel is not a press on the chart.

      The chart is the drawing surface, so the click that closed a popover
      landed here and started a line — which made every one of those panels a
      thing you could open and not get out of without drawing something. The
      panel is closing on this same press; the chart sits it out.

      Asked of the trigger rather than the panel. The panel stays in the
      document after it shuts, so "is one present" is true for the rest of the
      session once any has been opened — a guard that would have quietly
      stopped the screen drawing at all. `aria-expanded` is the button's own
      account of whether its thing is open, it is a contract rather than an
      implementation detail, and it flips the instant the panel does.
    */
    if (typeof document !== "undefined" && document.querySelector('[aria-expanded="true"]')) return;
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const px = e.clientX - r.left;
    /*
      One surface, two gestures, divided where now is.

      The past is for looking at, so dragging it moves the view; the future is
      for drawing in, so dragging that draws. Nobody has to find a tool for it,
      and there is no mode to be in the wrong one of.
    */
    if (!canDraw || px < xNow) {
      e.currentTarget.setPointerCapture(e.pointerId);
      pan.current = { x: px, anchor, moved: false };
      setHover(null);
      return;
    }
    const p = local(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    active.current = true;
    onDownPt(p);
    track(e);
  };
  const onMove = (e: ReactPointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const px = e.clientX - r.left;
    const grabbed = pan.current;
    if (grabbed) {
      // Following stops when you actually drag, not when you touch. A click on
      // the past is a click on the past; unfollowing there meant one stray tap
      // quietly detached the chart from the market and left it behind.
      const dx = px - grabbed.x;
      if (!grabbed.moved && Math.abs(dx) < 3) return;
      grabbed.moved = true;
      setView((v) => ({ ...v, anchor: holdAnchor(grabbed.anchor - dx / runStep) }));
      return;
    }
    if (canDraw) {
      const yy = e.clientY - r.top;
      setHover(px >= xNow && px <= plotR && yy >= plotT && yy <= plotB ? { x: px, y: yy } : null);
    }
    if (!active.current) return;
    const p = local(e);
    if (p) onMovePt(p);
    track(e);
  };
  const onUp = () => {
    if (pan.current) {
      pan.current = null;
      return;
    }
    if (!active.current) return;
    active.current = false;
    setPushing(false);
    onUpPt();
  };
  /** Taking hold of a point: the svg's own move and up handlers take it from here. */
  const grab = (index: number) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    active.current = true;
    onGrab(index);
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      if (active.current) e.preventDefault();
    };
    el.addEventListener("touchmove", block, { passive: false });
    return () => el.removeEventListener("touchmove", block);
  }, []);

  /* Scroll to zoom time, as the reference does — attached by hand because it
     has to call preventDefault, and React's own wheel listener is passive. */
  const wheel = useRef(zoomTime);
  useEffect(() => {
    wheel.current = zoomTime;
  });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return;
      e.preventDefault();
      wheel.current(e.deltaY > 0 ? 1.25 : 1 / 1.25, e.clientX - el.getBoundingClientRect().left);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /* The handlers as of this render, for the loop below to call. It is started
     once per push and must not be torn down every time the round grows. */
  const now = useRef({ advance, move: onMovePt, price: priceAtY, edgeT: 1, step: 1, pivot: 0, right: 0 });
  useEffect(() => {
    now.current = { advance, move: onMovePt, price: priceAtY, edgeT: tOfX(plotR), step: runStep, pivot, right: plotR };
  });

  /**
   * Held against the edge, the canvas opens.
   *
   * On a clock rather than on pointer moves, because holding the pen still is
   * exactly how someone asks for more room and a still pointer fires no moves
   * at all — which is why it stopped expanding the moment you stopped wiggling.
   * Frame by frame, by however much time has actually passed, so the speed is
   * the same on any machine.
   *
   * The head is pushed back to the end on every frame too. Growing the round
   * shrinks every point's share of it, including the one under your finger, so
   * without this the line would shrink away from the edge you are pressing
   * against instead of drawing on into the room it just made.
   */
  useEffect(() => {
    if (!pushing) return;
    let last = performance.now();
    const id = setInterval(() => {
      const t = performance.now();
      // By elapsed time rather than per tick, so the speed is the same whatever
      // rate the browser actually gives us.
      const seconds = Math.min(0.12, (t - last) / 1000);
      last = t;
      const here = at.current;
      if (!here) return;
      /*
        The pen leads and the chart follows, on a clock and at a capped speed.

        Past the middle of the plot the view runs forward to bring the tip back
        to it, but never faster than PAN_BARS candles a second. It used to do
        this from the move handler, by the whole overshoot, every event: several
        pointer moves land between two renders, each one reads a tip that has
        not been brought back yet, and each adds the full correction again. Ten
        moves across a third of the screen ran the view a hundred and ten
        candles forward and took the round to its ceiling. A clock cannot
        compound — it advances by elapsed time, whatever the browser does with
        the events.
      */
      const over = (here.x - now.current.pivot) / now.current.step;
      if (over > 0) now.current.advance(Math.min(over, seconds * PAN_BARS));
      // Held right against the edge, keep laying points down: that is someone
      // asking for more room rather than drawing a flat line.
      if (here.x >= now.current.right - EDGE) now.current.move({ t: now.current.edgeT, price: now.current.price(here.y) });
    }, 50);
    return () => clearInterval(id);
  }, [pushing]);

  const plotted = pts.map((pt) => ({ x: xOfT(pt.t), y: y(pt.price) }));
  const ribbonPx = Math.min(36, (ribbon / span) * (plotB - plotT));
  const drawing = phase === "drawing";
  const hasLine = plotted.length > 1;
  const head = plotted.at(-1);
  const hint = legPath(
    HINT.map((f, i) => ({
      x: xNow + (i / (HINT.length - 1)) * (plotR - xNow),
      y: Math.min(plotB - 22, Math.max(plotT + 22, y(price) - f * (plotB - plotT))),
    })),
  );

  /*
    The live price, and nothing else.

    There were two more rules here — "aiming" where the line ends up and "out"
    at the far side — and they described exits this product does not have. A
    drawn line is not a target you get taken out at and not a stop you get
    stopped at; the only thing that closes a position here is running out of
    money. Two coloured levels promising otherwise were answering a question
    nobody had asked, in the one place the reader is trying to read their own
    line.
  */
  const tags: TagSpec[] = [{ key: "now", price, y: y(price) }];
  /*
    The crosshair, unless it is standing on the price.

    Two dashed rules a few pixels apart, each with a plate reading a price
    within a few dollars of the other, is one line as far as a reader is
    concerned — and they will spend a moment working out which is which every
    time. Near the live price the crosshair has nothing to add, so it gets out
    of the way and the price keeps its own rule.
  */
  const onPrice = !!hover && Math.abs(hover.y - y(price)) < 14;
  const crosshair = hover && !drawing && !onPrice;
  if (crosshair) tags.push({ key: "hover", price: priceAtY(hover.y), y: hover.y, tone: "probe" });

  return (
    <div className={cn("relative h-full w-full touch-none select-none overflow-hidden", canDraw && "cursor-crosshair", className)} ref={box}>
      {w > 0 && h > 0 ? (
        <svg
          aria-label="A Bitcoin price chart you can draw on. Drag across the right-hand side to draw where you think the price goes."
          className="block h-full w-full"
          onPointerCancel={onUp}
          onPointerDown={onDown}
          onPointerLeave={() => setHover(null)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          role="img"
          viewBox={`0 0 ${w} ${h}`}
        >
          <defs>
            <pattern height="16" id="sk-grid" patternUnits="userSpaceOnUse" width="16">
              <path d="M16 0 H0 V16" fill="none" stroke="var(--border)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect fill="url(#sk-grid)" height={plotB - plotT} width={Math.max(0, plotR - Math.max(plotL, xNow))} x={Math.max(plotL, xNow)} y={plotT} />
          {xNow > plotL && xNow < plotR ? (
            <>
              <line stroke="var(--muted-foreground)" strokeDasharray="2 5" strokeOpacity="0.5" x1={xNow} x2={xNow} y1={plotT} y2={plotB} />
              <text fill="var(--muted-foreground)" fontSize="11" style={{ fontFamily: "var(--font-sans)" }} textAnchor="middle" x={xNow} y={plotB + 15}>
                now
              </text>
            </>
          ) : null}
          {/* Minutes from now, read off the axis itself rather than assumed, so
              they stay true however far you have zoomed or panned — and laid
              across the whole plot rather than the half ahead of now, because
              panning back into the history used to take now off the screen and
              the entire axis with it. Behind now they simply read negative. */}
          {[0.2, 0.4, 0.6, 0.8, 1].map((f) => {
            const x = plotL + f * (plotR - plotL);
            if (Math.abs(x - xNow) < 34) return null;
            const away = barOfX(x) - elapsed;
            return (
              <text
                fill="var(--muted-foreground)"
                fontSize="11"
                key={f}
                style={{ fontFamily: "var(--font-sans)" }}
                textAnchor={f === 1 ? "end" : "middle"}
                x={x}
                y={plotB + 15}
              >
                {label(away)}
              </text>
            );
          })}

          {/* Crosshair over the half you draw into, so a level is a level. */}
          {crosshair ? (
            <g pointerEvents="none">
              <line stroke="var(--muted-foreground)" strokeDasharray="2 3" strokeOpacity="0.6" x1={plotL} x2={plotR} y1={hover.y} y2={hover.y} />
              <line stroke="var(--muted-foreground)" strokeDasharray="2 3" strokeOpacity="0.6" x1={hover.x} x2={hover.x} y1={plotT} y2={plotB} />
            </g>
          ) : null}
          <line stroke="var(--muted-foreground)" strokeDasharray="3 4" strokeOpacity="0.5" x1={plotL} x2={plotR} y1={y(price)} y2={y(price)} />

          {/* How far the round has run — behind now, because now has moved. */}
          {run.length > 0 ? (
            <line stroke="var(--brand)" strokeWidth="2" x1={Math.max(plotL, xOfT(0))} x2={Math.min(plotR, xNow)} y1={plotB + 1} y2={plotB + 1} />
          ) : null}

          {/* Your last line, moved to today's price, so a habit shows. */}
          {ghost && ghost.length > 1 && phase === "live" ? (
            <path
              d={legPath(ghost.map((pt) => ({ x: xOfT(pt.t), y: y(pt.price) })))}
              fill="none"
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              strokeOpacity="0.35"
              strokeWidth="1.5"
            />
          ) : null}

          {/* One axis for both. History used to be squeezed to fit the left
              half at its own bar width, which is fine while nothing moves and
              impossible once it scrolls: the run's candles cross the split and
              have to land among bars the same size as themselves. So history is
              laid out in the same units, running back from the round's start,
              and falls off the left edge as the round goes on. */}
          <CandleMarks bars={feed} body={Math.max(2, runStep * 0.6)} dim={hasLine} x={(i) => xOfBar(i - feed.length + 0.5)} y={y} />
          <CandleMarks bars={run} body={Math.max(2, runStep * 0.6)} x={(i) => xOfBar(i + 0.5)} y={y} />

          {/* The ribbon: stay inside it and the candle counts. Coloured as
              candles arrive, green inside, grey out. */}
          {hasLine && !drawing && shape ? (
            <g>
              {/* Mitred, like the line it wraps. Round joins put a dome on the outside
                  of every turn, which is the one place the band should come to a
                  point: a turn is where one position ends and the next begins. */}
              <path d={legPath(plotted)} fill="none" stroke="var(--brand)" strokeLinecap="butt" strokeLinejoin="miter" strokeMiterlimit={2} strokeOpacity="0.12" strokeWidth={Math.max(4, ribbonPx * 2)} />
              {/*
                Coloured by what each candle made, not by whether it landed in
                the ribbon.

                Inside is not the same as right. Hold a short while the price
                edges up and the candle can sit well inside the band — the shape
                was close — while the position loses money the whole way. Green
                there said you were doing well at the moment you were not, which
                is the worst thing a colour on this chart can do.

                So: the direction the line is going at that moment is the
                position you are in, the candle's own move is what the market
                did, and the two multiplied is whether that minute paid.
              */}
              {run.map((candle, i) => {
                const was = lineAt(shape.prices, i / runBars);
                const goes = lineAt(shape.prices, (i + 1) / runBars);
                const made = (goes >= was ? 1 : -1) * (candle.c - candle.o);
                return (
                  <rect
                    className={phase === "settled" ? "sk-in" : undefined}
                    fill={made >= 0 ? "var(--success)" : "var(--destructive)"}
                    height={Math.max(4, ribbonPx * 2)}
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional
                    key={i}
                    fillOpacity={0.26}
                    style={phase === "settled" ? { animationDelay: `${i * 35}ms` } : undefined}
                    width={runStep}
                    x={xOfBar(i)}
                    y={y(goes) - Math.max(2, ribbonPx)}
                  />
                );
              })}
            </g>
          ) : null}

          {hasLine ? (
            <g>
              {drawing ? (
                <polyline fill="none" points={plotted.map((p) => `${p.x},${p.y}`).join(" ")} stroke="var(--brand)" strokeLinecap="round" strokeLinejoin="miter" strokeMiterlimit={2} strokeWidth="2.4" />
              ) : (
                <path
                  d={legPath(plotted)}
                  fill="none"
                  stroke="var(--brand)"
                  strokeDasharray={phase === "settled" ? "5 4" : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="miter"
                  strokeMiterlimit={2}
                  strokeOpacity={phase === "running" ? 0.7 : phase === "settled" ? 0.6 : 1}
                  strokeWidth="2.4"
                />
              )}
              {/* Every point is a handle once the line is down. Ahead of
                  now they move and go; behind now they have happened. */}
              {!drawing && (phase === "drawn" || phase === "running")
                ? plotted.slice(1).map((p, i) => {
                    const index = i + 1;
                    const live = pts[index].t > editableFrom;
                    return (
                      <circle
                        className={cn(live && "cursor-move hover:fill-brand")}
                        cx={p.x}
                        cy={p.y}
                        fill={live ? "var(--card)" : "var(--brand)"}
                        key={index}
                        onDoubleClick={live ? () => onRemove(index) : undefined}
                        onPointerDown={live ? grab(index) : undefined}
                        r={live ? 6 : 3}
                        stroke="var(--brand)"
                        strokeWidth={live ? 2 : 0}
                      />
                    );
                  })
                : null}
              {head && !drawing && phase === "settled" ? <circle cx={head.x} cy={head.y} fill="var(--brand)" r="3" /> : null}
            </g>
          ) : null}

          {phase === "live" ? (
            <g pointerEvents="none">
              <path d={hint} fill="none" stroke="var(--brand)" strokeDasharray="3 8" strokeLinecap="round" strokeOpacity="0.35" strokeWidth="2">
                <animate attributeName="stroke-dashoffset" dur="1.4s" from="0" repeatCount="indefinite" to="-22" />
              </path>
              <circle cx={xNow} cy={y(price)} fill="var(--brand)" r="3.5" />
              <text fill="var(--muted-foreground)" fontSize="12" style={{ fontFamily: "var(--font-sans)" }} textAnchor="middle" x={(xNow + plotR) / 2} y={plotB - 10}>
                click to place your points
              </text>
            </g>
          ) : null}
          {/* The past, as a surface you can take hold of. Transparent rather
              than absent, so it hit-tests and can carry the cursor; the svg's
              own handlers still see every event. */}
          {xNow > plotL ? (
            <rect
              className="cursor-grab active:cursor-grabbing"
              fill="transparent"
              height={plotB - plotT}
              width={Math.min(plotR, xNow) - plotL}
              x={plotL}
              y={plotT}
            />
          ) : null}
        </svg>
      ) : null}

      {/*
        The eye, not the order book.

        Zoom and pan are display only — nothing here moves a position, and the
        chart says so by leaving the line exactly where it was. Following is a
        toggle rather than a mode you fall out of silently: drag the past and it
        turns itself off, press it and now comes back to the middle.
      */}
      {w > 0 ? (
        <div className="absolute right-2 bottom-7 flex items-center gap-0.5 rounded-xl border bg-card/85 p-0.5 backdrop-blur-sm [&_svg]:size-3.5">
          <Button aria-label="Pan earlier" className="size-7 rounded-lg" onClick={() => panTime(-1)} variant="ghost">
            <ChevronLeftIcon />
          </Button>
          <Button aria-label="Zoom out" className="size-7 rounded-lg" onClick={() => zoomTime(1.5)} variant="ghost">
            <ZoomOutIcon />
          </Button>
          <Button aria-label="Zoom in" className="size-7 rounded-lg" onClick={() => zoomTime(1 / 1.5)} variant="ghost">
            <ZoomInIcon />
          </Button>
          <Button aria-label="Pan later" className="size-7 rounded-lg" onClick={() => panTime(1)} variant="ghost">
            <ChevronRightIcon />
          </Button>
          <Button
            aria-label="Follow now"
            aria-pressed={following}
            className={cn("size-7 rounded-lg", following && "bg-accent text-foreground")}
            onClick={follow}
            variant="ghost"
          >
            <CrosshairIcon />
          </Button>
          <Button aria-label="Reset the view" className="size-7 rounded-lg" disabled={following && view.zoom === 1} onClick={reset} variant="ghost">
            <RotateCcwIcon />
          </Button>
        </div>
      ) : null}

      {w > 0 ? stackTags(tags, h).map((t) => <Tag {...t} key={t.key} />) : null}
      {crosshair && hover.x > xNow + 28 && hover.x < plotR - 44 ? (
        <span
          className="figures pointer-events-none absolute -translate-x-1/2 rounded-full border bg-popover px-2 py-0.5 text-[11px] leading-4 shadow-xs/5"
          style={{ left: hover.x, top: plotB + 4 }}
        >
          {label(barOfX(hover.x) - elapsed)}
        </span>
      ) : null}

      {/*
        Where it bought and where it sold.

        Every turn on this line is a close and an open, so a turn the candles
        have already reached is a trade that has already happened. The word says
        which: the line leaves a trough going up, so that is a buy; it leaves a
        peak going down, so that is a sell. Above the peaks and below the
        troughs, out of the line's way.

        Only behind the candles. Ahead of them these are still intentions, and
        the handles you can drag say so already.
      */}
      {(phase === "running" || phase === "settled") && pts.length > 1
        ? plotted.map((p, i) => {
            const next = pts[i + 1];
            // Once it has settled the whole round is behind us, so every turn
            // is a trade that happened. `editableFrom` is zero then — it means
            // "nothing is editable", not "nothing has happened" — and reading
            // it as the boundary hid every mark the moment the round ended.
            const behind = phase === "settled" ? 1 : editableFrom;
            if (!next || pts[i].t > behind) return null;
            const buy = next.price > pts[i].price;
            /*
              Only where the direction actually changes.

              A bend in the middle of a rise is not a trade. Editing a handle
              can leave two rising segments joined at a point — the compiler
              reads that as one long, quite rightly, because nothing closes
              there — but marking every point put a "Buy" on each of them, five
              in a row up one hill, as though the position were being sold and
              bought back at every kink. The first point is the entry; after
              that a mark belongs only where the line turns round.
            */
            const prev = pts[i - 1];
            if (prev && buy === pts[i].price > prev.price) return null;
            return (
              <span
                className={cn(
                  // Bordered in its own colour and set in the same size as the
                  // price tags. These mark the two moments on the chart that
                  // actually cost money; a 10px grey chip made them the
                  // quietest thing on it.
                  "pointer-events-none absolute -translate-x-1/2 rounded-full border bg-popover px-2 py-0.5 font-semibold text-xs leading-4 shadow-xs/5",
                  buy ? "border-up/40 text-up" : "border-down/40 text-down",
                )}
                // biome-ignore lint/suspicious/noArrayIndexKey: positional
                key={i}
                style={{ left: p.x, top: buy ? p.y + 12 : p.y - 32 }}
              >
                {buy ? "Buy" : "Sell"}
              </span>
            );
          })
        : null}

      {/* What the line is worth where the finger is. */}
      {head && headLabel && (phase === "drawing" || phase === "drawn") ? (
        <span
          className="figures pointer-events-none absolute -translate-x-full -translate-y-full whitespace-nowrap rounded-full bg-brand px-2 py-0.5 font-medium text-[11px] text-white leading-4"
          style={{ left: head.x - 8, top: Math.max(plotT + 20, head.y - 14) }}
        >
          {headLabel}
        </span>
      ) : null}

      {/*
        What it is worth, and only that.

        A pill, like the one the line carries while you draw, because it is the
        same kind of thing: a number attached to a place on the chart. It read
        "−$0.08 inside" before — a running total with a verdict stapled to it on
        whether the last candle landed in the ribbon. Two answers to two
        different questions in one line, and only one of them is money. The
        ribbon already says inside by colouring itself.
      */}
      {phase === "running" && pnl !== null && run.length > 0 ? (
        <span
          className={cn(
            // The same plate the price tags wear — a dark fill and a hairline —
            // so the figure is what carries the colour. A solid green lozenge
            // shouted the sign twice and drowned the number doing it.
            "figures pointer-events-none absolute -translate-x-1/2 rounded-full border bg-popover px-2 py-0.5 font-semibold text-[11px] leading-4 shadow-xs/5",
            Math.abs(pnl) < 0.005 ? "text-muted-foreground" : pnl > 0 ? "text-up" : "text-down",
          )}
          style={{
            left: Math.min(plotR - 56, Math.max(56, xOfBar(run.length - 0.5))),
            top: Math.max(4, y(run[run.length - 1].h) - 24),
          }}
        >
          {signedUsd(pnl)}
        </span>
      ) : null}
    </div>
  );
}
