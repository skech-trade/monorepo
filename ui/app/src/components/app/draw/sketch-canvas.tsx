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
import { type Accuracy, lineAt, type Pt, type Shape, smoothPath } from "@/lib/sketch";
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
        "figures pointer-events-none absolute right-1 flex -translate-y-1/2 items-baseline gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-4",
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
  onHead,
  headLabel,
  horizonMinutes,
  showPoints = false,
  accuracy,
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
  /** The head of a drawn line, dragged to a new price. */
  onHead: (price: number) => void;
  /** What the line is worth where it ends, shown at the head while drawing. */
  headLabel?: string | null;
  /** How long the right edge is, in minutes. */
  horizonMinutes: number;
  /** Dots at every point, for a line made of clicks. */
  showPoints?: boolean;
  /** Which arrived candles closed inside the ribbon. */
  accuracy: Accuracy | null;
  /** Your last line, faint, so you notice your habits. */
  ghost: Pt[] | null;
  /** Half the ribbon's height, in price. */
  ribbon: number;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(box);
  const active = useRef(false);
  const dragging = useRef(false);
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
  const canDraw = phase === "live" || phase === "drawn";

  const local = (e: ReactPointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return null;
    const x = Math.min(plotR, Math.max(split, e.clientX - r.left));
    const yy = Math.min(plotB, Math.max(plotT, e.clientY - r.top));
    return { t: (x - split) / (plotR - split), price: priceAtY(yy) };
  };
  const onDown = (e: ReactPointerEvent) => {
    if (!canDraw) return;
    const p = local(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    active.current = true;
    onDownPt(p);
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
  };
  const onUp = () => {
    if (!active.current) return;
    active.current = false;
    onUpPt();
  };
  const headDown = (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
  };
  const headMove = (e: ReactPointerEvent) => {
    if (!dragging.current) return;
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    onHead(priceAtY(Math.min(plotB, Math.max(plotT, e.clientY - r.top))));
  };
  const headUp = () => {
    dragging.current = false;
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

  const plotted = pts.map((pt) => ({ x: split + pt.t * (plotR - split), y: y(pt.price) }));
  const ribbonPx = Math.min(36, (ribbon / span) * (plotB - plotT));
  const progress = run.length / runBars;
  const drawing = phase === "drawing";
  const hasLine = plotted.length > 1;
  const head = plotted.at(-1);
  const hint = smoothPath(
    HINT.map((f, i) => ({
      x: split + (i / (HINT.length - 1)) * (plotR - split),
      y: Math.min(plotB - 22, Math.max(plotT + 22, y(price) - f * (plotB - plotT))),
    })),
  );

  const tags: TagSpec[] = [{ key: "now", price, y: y(price) }];
  if (shape && phase !== "live") {
    tags.push({ key: "aim", label: "aiming", price: shape.target, tone: "up", y: y(shape.target) });
    if (shape.floor !== null) tags.push({ key: "out", label: "out", price: shape.floor, tone: "down", y: y(shape.floor) });
  }
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

          {shape && phase !== "live" ? (
            <g>
              <line stroke="var(--up)" strokeDasharray="3 4" strokeOpacity="0.6" x1={split} x2={plotR} y1={y(shape.target)} y2={y(shape.target)} />
              {shape.floor !== null ? (
                <line stroke="var(--down)" strokeDasharray="3 4" strokeOpacity="0.6" x1={split} x2={plotR} y1={y(shape.floor)} y2={y(shape.floor)} />
              ) : null}
            </g>
          ) : null}

          {/* How far the round has run, in the chart's own units. */}
          {run.length > 0 ? (
            <line stroke="var(--brand)" strokeWidth="2" x1={split} x2={split + progress * (plotR - split)} y1={plotB + 1} y2={plotB + 1} />
          ) : null}

          {/* Your last line, moved to today's price, so a habit shows. */}
          {ghost && ghost.length > 1 && phase === "live" ? (
            <path
              d={smoothPath(ghost.map((pt) => ({ x: split + pt.t * (plotR - split), y: y(pt.price) })))}
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
              <path d={smoothPath(plotted)} fill="none" stroke="var(--brand)" strokeLinecap="butt" strokeLinejoin="round" strokeOpacity="0.12" strokeWidth={Math.max(4, ribbonPx * 2)} />
              {accuracy?.flags.map((inside, i) => {
                const cy = y(lineAt(shape.prices, (i + 1) / runBars));
                return (
                  <rect
                    className={phase === "settled" ? "sk-in" : undefined}
                    fill={inside ? "var(--success)" : "var(--muted-foreground)"}
                    height={Math.max(4, ribbonPx * 2)}
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional
                    key={i}
                    fillOpacity={inside ? 0.3 : 0.16}
                    style={phase === "settled" ? { animationDelay: `${i * 35}ms` } : undefined}
                    width={runStep}
                    x={split + i * runStep}
                    y={cy - Math.max(2, ribbonPx)}
                  />
                );
              })}
            </g>
          ) : null}

          {hasLine ? (
            <g>
              {drawing ? (
                <polyline fill="none" points={plotted.map((p) => `${p.x},${p.y}`).join(" ")} stroke="var(--brand)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" />
              ) : (
                <path
                  d={smoothPath(plotted)}
                  fill="none"
                  stroke="var(--brand)"
                  strokeDasharray={phase === "settled" ? "5 4" : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeOpacity={phase === "running" ? 0.7 : phase === "settled" ? 0.6 : 1}
                  strokeWidth="2.4"
                />
              )}
              {showPoints
                ? plotted.slice(1, -1).map((p, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional
                    <circle cx={p.x} cy={p.y} fill="var(--card)" key={i} r="3" stroke="var(--brand)" strokeWidth="1.5" />
                  ))
                : null}
              {head && !drawing ? (
                <>
                  <circle cx={head.x} cy={head.y} fill="var(--brand)" opacity="0.25" r="6" />
                  <circle cx={head.x} cy={head.y} fill="var(--brand)" r="3" />
                </>
              ) : null}
              {/* The head is a handle while the line is yours to change: drag
                  it and the tail follows, the start stays where you got in. */}
              {head && phase === "drawn" ? (
                <circle
                  className="cursor-ns-resize"
                  cx={head.x}
                  cy={head.y}
                  fill="var(--card)"
                  onPointerCancel={headUp}
                  onPointerDown={headDown}
                  onPointerMove={headMove}
                  onPointerUp={headUp}
                  r="7"
                  stroke="var(--brand)"
                  strokeWidth="2"
                />
              ) : null}
            </g>
          ) : null}

          {phase === "live" ? (
            <g pointerEvents="none">
              <path d={hint} fill="none" stroke="var(--brand)" strokeDasharray="3 8" strokeLinecap="round" strokeOpacity="0.35" strokeWidth="2">
                <animate attributeName="stroke-dashoffset" dur="1.4s" from="0" repeatCount="indefinite" to="-22" />
              </path>
              <circle cx={split} cy={y(price)} fill="var(--brand)" r="3.5" />
              {/* A finger, twice, then it gets out of the way. */}
              <circle fill="var(--brand)" fillOpacity="0.9" r="5">
                <animateMotion dur="2.6s" fill="freeze" path={hint} repeatCount="2" />
                <animate attributeName="opacity" begin="5.2s" dur="0.3s" fill="freeze" from="0.9" to="0" />
              </circle>
              <text fill="var(--muted-foreground)" fontSize="12" style={{ fontFamily: "var(--font-sans)" }} textAnchor="middle" x={(split + plotR) / 2} y={plotB - 10}>
                drag to draw your line
              </text>
            </g>
          ) : null}
        </svg>
      ) : null}

      {w > 0 ? stackTags(tags, h).map((t) => <Tag {...t} key={t.key} />) : null}
      {crosshair && hover.x > split + 24 && hover.x < plotR - 24 ? (
        <span
          className="figures pointer-events-none absolute -translate-x-1/2 rounded-md border bg-popover px-1.5 py-0.5 text-[11px] leading-4 shadow-xs/5"
          style={{ left: hover.x, top: plotB + 4 }}
        >
          +{Math.round(((hover.x - split) / (plotR - split)) * horizonMinutes)}m
        </span>
      ) : null}

      {/* What the line is worth where the finger is. */}
      {head && headLabel && (phase === "drawing" || phase === "drawn") ? (
        <span
          className="figures pointer-events-none absolute -translate-x-full -translate-y-full whitespace-nowrap rounded-md bg-brand px-1.5 py-0.5 font-medium text-[11px] text-white leading-4"
          style={{ left: head.x - 8, top: Math.max(plotT + 20, head.y - 14) }}
        >
          {headLabel}
        </span>
      ) : null}

      {phase === "running" && pnl !== null && run.length > 0 ? (
        <span
          className={cn(
            "figures pointer-events-none absolute -translate-x-1/2 font-semibold text-xs [text-shadow:0_0_6px_var(--card),0_0_6px_var(--card)]",
            Math.abs(pnl) < 0.005 ? "text-muted-foreground" : pnl > 0 ? "text-up" : "text-down",
          )}
          style={{
            left: Math.min(plotR - 56, Math.max(56, split + (run.length - 0.5) * runStep)),
            top: Math.max(4, y(run[run.length - 1].h) - 22),
          }}
        >
          {signedUsd(pnl)}
          {accuracy && accuracy.flags.length > 0 ? (
            <span className={cn("ml-1.5 font-normal", accuracy.flags[accuracy.flags.length - 1] ? "text-up" : "text-muted-foreground")}>
              {accuracy.flags[accuracy.flags.length - 1] ? "inside" : "outside"}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
