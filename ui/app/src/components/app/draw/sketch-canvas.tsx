"use client";

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
const HISTORY_SHARE = 0.54;
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

type TagSpec = { key: string; price: number; y: number; label?: string; tone?: "default" | "up" | "down" };

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
  onExtend,
  editableFrom,
  headLabel,
  horizonMinutes,
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
  /** Held at the right edge: lengthen the round by this many seconds of growth. */
  onExtend?: (seconds: number) => void;
  /** Points at or before this time are fixed: they have already happened. */
  editableFrom: number;
  /** What the line is worth where it ends, shown at the head while drawing. */
  headLabel?: string | null;
  /** How long the right edge is, in minutes. */
  horizonMinutes: number;
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

  const plotL = PAD_L;
  const plotR = Math.max(plotL + 1, w - PAD_R);
  const plotT = PAD_T;
  const plotB = Math.max(plotT + 1, h - PAD_B);
  const split = plotL + (plotR - plotL) * HISTORY_SHARE;
  const span = band.hi - band.lo || 1;
  const y = useCallback((p: number) => plotT + ((band.hi - p) / span) * (plotB - plotT), [band.hi, span, plotT, plotB]);
  const priceAtY = (yy: number) => band.hi - ((yy - plotT) / (plotB - plotT)) * span;

  const step = (split - plotL) / Math.max(1, feed.length);
  const runStep = (plotR - split) / runBars;
  // Points can still be placed while it runs — ahead of the candles, never behind.
  const canDraw = phase === "live" || phase === "drawn" || phase === "running";

  const local = (e: ReactPointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return null;
    const x = Math.min(plotR, Math.max(split, e.clientX - r.left));
    const yy = Math.min(plotB, Math.max(plotT, e.clientY - r.top));
    return { t: (x - split) / (plotR - split), price: priceAtY(yy) };
  };
  /** Within this of the right edge counts as pushing against it. */
  const EDGE = 18;
  const track = (e: ReactPointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    at.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    setPushing(active.current && !!onExtend && at.current.x >= plotR - EDGE);
  };

  const onDown = (e: ReactPointerEvent) => {
    if (!canDraw) return;
    const p = local(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    active.current = true;
    onDownPt(p);
    track(e);
  };
  const onMove = (e: ReactPointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (r && canDraw) {
      const x = e.clientX - r.left;
      const yy = e.clientY - r.top;
      setHover(x >= split && x <= plotR && yy >= plotT && yy <= plotB ? { x, y: yy } : null);
    }
    if (!active.current) return;
    const p = local(e);
    if (p) onMovePt(p);
    track(e);
  };
  const onUp = () => {
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

  /* The handlers as of this render, for the loop below to call. It is started
     once per push and must not be torn down every time the round grows. */
  const now = useRef({ extend: onExtend, move: onMovePt, price: priceAtY });
  useEffect(() => {
    now.current = { extend: onExtend, move: onMovePt, price: priceAtY };
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
      now.current.extend?.(seconds);
      // Reach for the end of the round. The pen lays a point down once enough
      // fresh canvas has arrived under it, so holding here draws rather than
      // stretching one segment.
      now.current.move({ t: 1, price: now.current.price(here.y) });
    }, 50);
    return () => clearInterval(id);
  }, [pushing]);

  const plotted = pts.map((pt) => ({ x: split + pt.t * (plotR - split), y: y(pt.price) }));
  const ribbonPx = Math.min(36, (ribbon / span) * (plotB - plotT));
  const progress = run.length / runBars;
  const drawing = phase === "drawing";
  const hasLine = plotted.length > 1;
  const head = plotted.at(-1);
  const hint = legPath(
    HINT.map((f, i) => ({
      x: split + (i / (HINT.length - 1)) * (plotR - split),
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
  const crosshair = hover && !drawing;
  if (crosshair) tags.push({ key: "hover", price: priceAtY(hover.y), y: hover.y });

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
          <rect fill="url(#sk-grid)" height={plotB - plotT} width={plotR - split} x={split} y={plotT} />
          <line stroke="var(--muted-foreground)" strokeDasharray="2 5" strokeOpacity="0.5" x1={split} x2={split} y1={plotT} y2={plotB} />
          <text fill="var(--muted-foreground)" fontSize="11" style={{ fontFamily: "var(--font-sans)" }} textAnchor="middle" x={split} y={plotB + 15}>
            now
          </text>
          {/* The right edge in minutes, so the half you draw into has a length. */}
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <text
              fill="var(--muted-foreground)"
              fontSize="11"
              key={f}
              style={{ fontFamily: "var(--font-sans)" }}
              textAnchor={f === 1 ? "end" : "middle"}
              x={split + f * (plotR - split)}
              y={plotB + 15}
            >
              +{Math.round(f * horizonMinutes)}m
            </text>
          ))}

          {/* Crosshair over the half you draw into, so a level is a level. */}
          {hover && !drawing ? (
            <g pointerEvents="none">
              <line stroke="var(--muted-foreground)" strokeDasharray="2 3" strokeOpacity="0.6" x1={plotL} x2={plotR} y1={hover.y} y2={hover.y} />
              <line stroke="var(--muted-foreground)" strokeDasharray="2 3" strokeOpacity="0.6" x1={hover.x} x2={hover.x} y1={plotT} y2={plotB} />
            </g>
          ) : null}
          <line stroke="var(--muted-foreground)" strokeDasharray="3 4" strokeOpacity="0.5" x1={plotL} x2={plotR} y1={y(price)} y2={y(price)} />

          {/* How far the round has run, in the chart's own units. */}
          {run.length > 0 ? (
            <line stroke="var(--brand)" strokeWidth="2" x1={split} x2={split + progress * (plotR - split)} y1={plotB + 1} y2={plotB + 1} />
          ) : null}

          {/* Your last line, moved to today's price, so a habit shows. */}
          {ghost && ghost.length > 1 && phase === "live" ? (
            <path
              d={legPath(ghost.map((pt) => ({ x: split + pt.t * (plotR - split), y: y(pt.price) })))}
              fill="none"
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              strokeOpacity="0.35"
              strokeWidth="1.5"
            />
          ) : null}

          <CandleMarks bars={feed} body={Math.max(2, step * 0.6)} dim={hasLine} x={(i) => plotL + i * step + step / 2} y={y} />
          <CandleMarks bars={run} body={Math.max(2, runStep * 0.6)} x={(i) => split + i * runStep + runStep / 2} y={y} />

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
                    x={split + i * runStep}
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
              <circle cx={split} cy={y(price)} fill="var(--brand)" r="3.5" />
              <text fill="var(--muted-foreground)" fontSize="12" style={{ fontFamily: "var(--font-sans)" }} textAnchor="middle" x={(split + plotR) / 2} y={plotB - 10}>
                click to place your points
              </text>
            </g>
          ) : null}
        </svg>
      ) : null}

      {w > 0 ? stackTags(tags, h).map((t) => <Tag {...t} key={t.key} />) : null}
      {crosshair && hover.x > split + 28 && hover.x < plotR - 44 ? (
        <span
          className="figures pointer-events-none absolute -translate-x-1/2 rounded-full border bg-popover px-2 py-0.5 text-[11px] leading-4 shadow-xs/5"
          style={{ left: hover.x, top: plotB + 4 }}
        >
          +{Math.round(((hover.x - split) / (plotR - split)) * horizonMinutes)}m
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
            left: Math.min(plotR - 56, Math.max(56, split + (run.length - 0.5) * runStep)),
            top: Math.max(4, y(run[run.length - 1].h) - 24),
          }}
        >
          {signedUsd(pnl)}
        </span>
      ) : null}
    </div>
  );
}
