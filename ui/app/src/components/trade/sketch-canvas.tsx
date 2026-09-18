"use client";

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { type Candle, price as fmtPrice, signedUsd } from "./market";
import { type Pt, type Shape, smoothPath } from "./sketch";

/**
 * The chart you draw on.
 *
 * Our own SVG, not lightweight-charts. Desk needs pan, zoom and indicator
 * panes and gets the library; Draw needs one thing the library cannot do,
 * which is turn a finger on the empty half into prices. Sized to its box in
 * pixels so a phone gets a tall chart rather than a letterbox.
 *
 * History on the left, the future on the right. The split is where "now" is.
 */

export type Phase = "live" | "drawing" | "drawn" | "running" | "settled";

export type Band = { lo: number; hi: number };

const PAD_T = 18;
const PAD_B = 26;
const PAD_L = 8;
const PAD_R = 8;
/** Share of the plot that is history. The rest is yours. */
const HISTORY_SHARE = 0.54;

/** The shape the hint draws for itself, a dip then a run, as fractions of
    the plot height above (+) or below (-) the live price. In pixels rather
    than price multiples: a quiet minute chart has a band a fraction of a
    percent wide, and a 4% arc drawn on it leaves the plot altogether. */
const HINT = [
  0, 0.02, -0.02, -0.07, -0.12, -0.14, -0.1, -0.03, 0.05, 0.13, 0.2, 0.26,
] as const;

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

function Tag({
  price,
  y,
  h,
  tone = "default",
  label,
}: {
  price: number;
  y: number;
  h: number;
  tone?: "default" | "up" | "down" | "brand";
  label?: string;
}) {
  const top = Math.min(h - 14, Math.max(14, y));
  return (
    <span
      className={cn(
        "figures pointer-events-none absolute right-1 flex -translate-y-1/2 items-baseline gap-1.5 rounded-full px-2.5 py-0.5 text-kicker shadow-[0_1px_4px_var(--card)]",
        tone === "default" && "bg-surface-3 text-foreground",
        tone === "up" && "bg-up text-background",
        tone === "down" && "bg-down text-background",
        tone === "brand" && "bg-brand text-background",
      )}
      style={{ top }}
    >
      {label ? <span className="font-normal opacity-80">{label}</span> : null}
      {fmtPrice(price)}
    </span>
  );
}

type TagSpec = {
  key: string;
  price: number;
  y: number;
  label?: string;
  tone?: "default" | "up" | "down" | "brand";
};

/** Tags closer than a tag's height are pushed apart, in order down the axis. */
function stackTags(tags: TagSpec[], h: number): TagSpec[] {
  const GAP = 24;
  const sorted = [...tags].sort((a, b) => a.y - b.y);
  for (let i = 0; i < sorted.length; i++) {
    const min = i === 0 ? 14 : sorted[i - 1].y + GAP;
    sorted[i] = { ...sorted[i], y: Math.max(min, sorted[i].y) };
  }
  // Walk back up if the bottom one ran off the plot.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const max = i === sorted.length - 1 ? h - 14 : sorted[i + 1].y - GAP;
    sorted[i] = { ...sorted[i], y: Math.min(max, sorted[i].y) };
  }
  return sorted;
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
  onDraw,
  onDrawEnd,
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
  /** Live P&L while a sketch runs. */
  pnl: number | null;
  /** A point of the finger, already converted to the line's own units. */
  onDraw: (pt: Pt, first: boolean) => void;
  onDrawEnd: () => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(box);
  const active = useRef(false);

  const plotL = PAD_L;
  const plotR = Math.max(plotL + 1, w - PAD_R);
  const plotT = PAD_T;
  const plotB = Math.max(plotT + 1, h - PAD_B);
  const split = plotL + (plotR - plotL) * HISTORY_SHARE;

  const span = band.hi - band.lo || 1;
  const y = useCallback(
    (p: number) => plotT + ((band.hi - p) / span) * (plotB - plotT),
    [band.hi, span, plotT, plotB],
  );
  const priceAtY = (yy: number) =>
    band.hi - ((yy - plotT) / (plotB - plotT)) * span;

  const step = (split - plotL) / Math.max(1, feed.length);
  const body = Math.max(2, step * 0.6);
  const runStep = (plotR - split) / runBars;
  const runBody = Math.max(2, runStep * 0.6);

  const toLocal = (e: ReactPointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return null;
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const canDraw = phase === "live" || phase === "drawn";

  const onDown = (e: ReactPointerEvent) => {
    if (!canDraw) return;
    const p = toLocal(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    active.current = true;
    const x = Math.min(plotR, Math.max(split, p.x));
    const yy = Math.min(plotB, Math.max(plotT, p.y));
    onDraw({ t: (x - split) / (plotR - split), price: priceAtY(yy) }, true);
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!active.current) return;
    const p = toLocal(e);
    if (!p) return;
    const x = Math.min(plotR, Math.max(split, p.x));
    const yy = Math.min(plotB, Math.max(plotT, p.y));
    onDraw({ t: (x - split) / (plotR - split), price: priceAtY(yy) }, false);
  };
  const onUp = () => {
    if (!active.current) return;
    active.current = false;
    onDrawEnd();
  };

  // Drawing on a phone must not scroll the page.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      if (active.current) e.preventDefault();
    };
    el.addEventListener("touchmove", block, { passive: false });
    return () => el.removeEventListener("touchmove", block);
  }, []);

  const plotted = pts.map((pt) => ({
    x: split + pt.t * (plotR - split),
    y: y(pt.price),
  }));
  const drawing = phase === "drawing";
  const hasLine = plotted.length > 1;
  const head = plotted.at(-1);

  const hint = smoothPath(
    HINT.map((f, i) => ({
      x: split + (i / (HINT.length - 1)) * (plotR - split),
      y: Math.min(
        plotB - 22,
        Math.max(plotT + 22, y(price) - f * (plotB - plotT)),
      ),
    })),
  );

  return (
    <div
      className={cn(
        "relative h-full w-full touch-none select-none overflow-hidden",
        canDraw && "cursor-crosshair",
        className,
      )}
      ref={box}
    >
      {w > 0 && h > 0 ? (
        <svg
          aria-label="A Bitcoin price chart you can draw on. Drag across the right-hand side to draw where you think the price goes."
          className="block h-full w-full"
          onPointerCancel={onUp}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          role="img"
          viewBox={`0 0 ${w} ${h}`}
        >
          <defs>
            <pattern
              height="16"
              id="sk-grid"
              patternUnits="userSpaceOnUse"
              width="16"
            >
              <path
                d="M16 0 H0 V16"
                fill="none"
                stroke="var(--grid-line)"
                strokeWidth="1"
              />
            </pattern>
          </defs>

          {/* The half you draw into reads as unwritten space. */}
          <rect
            fill="url(#sk-grid)"
            height={plotB - plotT}
            width={plotR - split}
            x={split}
            y={plotT}
          />

          {/* Now. */}
          <line
            stroke="var(--fg-subtle)"
            strokeDasharray="2 5"
            strokeOpacity="0.35"
            x1={split}
            x2={split}
            y1={plotT}
            y2={plotB}
          />
          <text
            fill="var(--fg-subtle)"
            fontSize="11"
            style={{ fontFamily: "var(--font-sans)" }}
            textAnchor="middle"
            x={split}
            y={plotB + 16}
          >
            now
          </text>

          {/* The live price, carried across to the tag. */}
          <line
            stroke="var(--fg-subtle)"
            strokeDasharray="3 4"
            strokeOpacity="0.4"
            x1={plotL}
            x2={plotR}
            y1={y(price)}
            y2={y(price)}
          />

          {/* Where you're aiming and where you're out, once there is a line. */}
          {shape && phase !== "live" ? (
            <g>
              <line
                stroke="var(--up)"
                strokeDasharray="3 4"
                strokeOpacity="0.5"
                x1={split}
                x2={plotR}
                y1={y(shape.target)}
                y2={y(shape.target)}
              />
              {shape.floor !== null ? (
                <line
                  stroke="var(--down)"
                  strokeDasharray="3 4"
                  strokeOpacity="0.5"
                  x1={split}
                  x2={plotR}
                  y1={y(shape.floor)}
                  y2={y(shape.floor)}
                />
              ) : null}
            </g>
          ) : null}

          {/* History. Quieter once a line is down: the line is the subject. */}
          <g opacity={hasLine ? 0.45 : 0.8}>
            {feed.map((c, i) => {
              const cx = plotL + i * step + step / 2;
              const up = c.c >= c.o;
              const tone = up ? "var(--up-mark)" : "var(--down-mark)";
              const top = y(Math.max(c.o, c.c));
              const bottom = y(Math.min(c.o, c.c));
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional
                <g fill={tone} key={i} stroke={tone}>
                  <line strokeWidth="1" x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} />
                  <rect
                    height={Math.max(1, bottom - top)}
                    width={body}
                    x={cx - body / 2}
                    y={top}
                  />
                </g>
              );
            })}
          </g>

          {/* What the market is doing about your line. */}
          <g>
            {run.map((c, i) => {
              const cx = split + i * runStep + runStep / 2;
              const up = c.c >= c.o;
              const tone = up ? "var(--up-mark)" : "var(--down-mark)";
              const top = y(Math.max(c.o, c.c));
              const bottom = y(Math.min(c.o, c.c));
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional
                <g fill={tone} key={i} stroke={tone}>
                  <line strokeWidth="1" x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} />
                  <rect
                    height={Math.max(1, bottom - top)}
                    width={runBody}
                    x={cx - runBody / 2}
                    y={top}
                  />
                </g>
              );
            })}
          </g>

          {/*
            The line. Raw points while the finger is down, so it wobbles the
            way a hand does; smoothed the moment it lifts. The settle is what
            tells you the app has read what you meant.
          */}
          {hasLine ? (
            <g>
              {drawing ? (
                <polyline
                  fill="none"
                  points={plotted.map((p) => `${p.x},${p.y}`).join(" ")}
                  stroke="var(--brand)"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.6"
                />
              ) : (
                <path
                  className="transition-[d] duration-medium ease-smooth-out"
                  d={smoothPath(plotted)}
                  fill="none"
                  stroke="var(--brand)"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeOpacity={phase === "running" ? 0.55 : 1}
                  strokeWidth="2.6"
                />
              )}
              {head && !drawing ? (
                <>
                  <circle cx={head.x} cy={head.y} fill="var(--brand)" r="6" opacity="0.25" />
                  <circle cx={head.x} cy={head.y} fill="var(--brand)" r="3.2" />
                </>
              ) : null}
            </g>
          ) : null}

          {/* The invitation: the gesture drawn faintly, once, and one line. */}
          {phase === "live" ? (
            <g pointerEvents="none">
              <path
                d={hint}
                fill="none"
                stroke="var(--brand)"
                strokeDasharray="3 8"
                strokeLinecap="round"
                strokeOpacity="0.3"
                strokeWidth="2"
              />
              <circle cx={split} cy={y(price)} fill="var(--brand)" r="3.5" />
              <text
                fill="var(--fg-subtle)"
                fontSize="12"
                style={{ fontFamily: "var(--font-sans)" }}
                textAnchor="middle"
                x={(split + plotR) / 2}
                y={plotB - 10}
              >
                drag to draw your line
              </text>
            </g>
          ) : null}
        </svg>
      ) : null}

      {w > 0
        ? stackTags(
            [
              { key: "now", price, y: y(price) },
              ...(shape && phase !== "live"
                ? [
                    {
                      key: "aim",
                      label: "aiming",
                      price: shape.target,
                      tone: "up" as const,
                      y: y(shape.target),
                    },
                    ...(shape.floor !== null
                      ? [
                          {
                            key: "out",
                            label: "out",
                            price: shape.floor,
                            tone: "down" as const,
                            y: y(shape.floor),
                          },
                        ]
                      : []),
                  ]
                : []),
            ],
            h,
          ).map((t) => (
            <Tag h={h} key={t.key} label={t.label} price={t.price} tone={t.tone} y={t.y} />
          ))
        : null}

      {/* The running figure, over the last candle. */}
      {phase === "running" && pnl !== null && run.length > 0 ? (
        <span
          className={cn(
            "figures pointer-events-none absolute -translate-x-1/2 font-semibold text-caption [text-shadow:0_0_6px_var(--card),0_0_6px_var(--card)]",
            Math.abs(pnl) < 0.005
              ? "text-fg-muted"
              : pnl > 0
                ? "text-up"
                : "text-down",
          )}
          style={{
            left: Math.min(
              plotR - 56,
              Math.max(56, split + (run.length - 0.5) * runStep),
            ),
            top: Math.max(4, y(run[run.length - 1].h) - 24),
          }}
        >
          {signedUsd(pnl)}
        </span>
      ) : null}
    </div>
  );
}
