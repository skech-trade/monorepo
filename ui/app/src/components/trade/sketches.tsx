"use client";

import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { Pill } from "./controls";
import { type Market, price as fmtPrice, signedUsd, usd } from "./market";
import { type Pt, smoothPath } from "./sketch";

/**
 * A sketch is a position you can look at.
 *
 * Every terminal lists positions as a row of figures. Ours were drawn, so the
 * list keeps the drawing: the line you made, which way it faced, what it is
 * worth. This is also the picture people send each other, which the landing
 * calls "show your call".
 */
export type Sketch = {
  id: string;
  long: boolean;
  stake: number;
  leverage: number;
  entry: number;
  /** The line, in its own units: 0 to 1 across the window, and a price. */
  pts: Pt[];
  placedAt: number;
  status: "running" | "settled";
  net: number;
  exit?: number;
  liquidated?: boolean;
};

/** The line alone, small. Entry as a dashed rule so up and down read. */
export function SketchThumb({
  sketch,
  className,
}: {
  sketch: Sketch;
  className?: string;
}) {
  const W = 96;
  const H = 56;
  const prices = sketch.pts.map((p) => p.price).concat(sketch.entry);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const pad = (hi - lo || sketch.entry * 0.01) * 0.15;
  const y = (p: number) => 8 + ((hi + pad - p) / (hi - lo + pad * 2)) * (H - 16);
  const pts = sketch.pts.map((p) => ({ x: 6 + p.t * (W - 12), y: y(p.price) }));
  const head = pts.at(-1);
  return (
    <svg
      aria-hidden="true"
      className={cn("well rounded-xl", className)}
      viewBox={`0 0 ${W} ${H}`}
    >
      <line
        stroke="var(--fg-subtle)"
        strokeDasharray="2 3"
        strokeOpacity="0.5"
        x1="0"
        x2={W}
        y1={y(sketch.entry)}
        y2={y(sketch.entry)}
      />
      <path
        d={smoothPath(pts)}
        fill="none"
        stroke="var(--brand)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      {head ? <circle cx={head.x} cy={head.y} fill="var(--brand)" r="2.4" /> : null}
    </svg>
  );
}

function SketchRow({ sketch }: { sketch: Sketch }) {
  const won = sketch.net >= 0;
  return (
    <li className="rowable flex items-center gap-3 rounded-2xl px-3 py-3">
      <SketchThumb className="h-12 w-20 shrink-0" sketch={sketch} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <Pill tone={sketch.long ? "up" : "down"}>
            {sketch.long ? "Up" : "Down"}
          </Pill>
          <span className="figures text-caption">
            ${usd(sketch.stake, 0)}
            <span className="text-fg-subtle"> at {sketch.leverage}×</span>
          </span>
        </p>
        <p className="figures mt-1 text-kicker text-fg-subtle">
          from ${fmtPrice(sketch.entry)}
          {sketch.status === "settled" && sketch.exit !== undefined
            ? ` to $${fmtPrice(sketch.exit)}`
            : null}
        </p>
      </div>
      <div className="text-right">
        <p
          className={cn(
            "figures text-caption font-medium",
            won ? "text-up" : "text-down",
          )}
        >
          {signedUsd(sketch.net)}
        </p>
        <p className="text-kicker text-fg-subtle">
          {sketch.status === "running"
            ? "playing out"
            : sketch.liquidated
              ? "wiped out"
              : won
                ? "called it"
                : "missed"}
        </p>
      </div>
    </li>
  );
}

export function SketchList({ sketches }: { sketches: Sketch[] }) {
  if (sketches.length === 0) {
    return (
      <Empty className="py-8 md:py-8">
        <EmptyHeader>
          <EmptyDescription>Nothing drawn yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className="flex flex-col">
      {sketches.map((s) => (
        <SketchRow key={s.id} sketch={s} />
      ))}
    </ul>
  );
}

export function SketchesDialog({
  open,
  onOpenChange,
  sketches,
  market,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sketches: Sketch[];
  market: Market;
}) {
  const total = sketches.reduce((sum, s) => sum + s.net, 0);
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="bg-card" side="right" variant="inset">
        <SheetHeader>
          <SheetTitle className="text-title">Your lines</SheetTitle>
          <SheetDescription className="text-caption text-fg-muted">
            {market.name} today:{" "}
            <span className={cn("figures", total >= 0 ? "text-up" : "text-down")}>
              {signedUsd(total)}
            </span>
          </SheetDescription>
        </SheetHeader>
        <SheetPanel className="px-2 pb-4">
          <SketchList sketches={sketches} />
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}

/**
 * Two lines from earlier, so the list is reviewable as a list. Mock, like
 * every other figure on this screen.
 */
export function seedSketches(market: Market): Sketch[] {
  const e1 = market.price * 0.994;
  const e2 = market.price * 1.003;
  const shape = (entry: number, ms: number[]): Pt[] =>
    ms.map((m, i) => ({ t: i / (ms.length - 1), price: entry * m }));
  return [
    {
      id: "seed-1",
      long: true,
      stake: 100,
      leverage: 5,
      entry: e1,
      pts: shape(e1, [1, 0.996, 0.992, 0.995, 1.002, 1.008, 1.012, 1.016]),
      placedAt: Date.now() - 3 * 3_600_000,
      status: "settled",
      net: 23.4,
      exit: e1 * 1.0047,
    },
    {
      id: "seed-2",
      long: false,
      stake: 50,
      leverage: 10,
      entry: e2,
      pts: shape(e2, [1, 1.003, 0.998, 0.993, 0.99, 0.986, 0.985]),
      placedAt: Date.now() - 55 * 60_000,
      status: "settled",
      net: -17.9,
      exit: e2 * 1.0036,
    },
  ];
}
