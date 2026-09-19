"use client";

import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { type Market, price as fmtPrice, signedUsd, usd } from "@/lib/market";
import { type Pt, legPath } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import { Pill } from "../controls";

/** A sketch is a position you can look at. The list keeps the drawing. */
export type Sketch = {
  id: string;
  long: boolean;
  stake: number;
  leverage: number;
  entry: number;
  pts: Pt[];
  placedAt: number;
  status: "running" | "settled";
  net: number;
  exit?: number;
  liquidated?: boolean;
  /** Share of the move that went your way. Over a half means it profited. */
  accuracy?: number;
};

export function SketchThumb({ sketch, className }: { sketch: Sketch; className?: string }) {
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
    <svg aria-hidden="true" className={cn("rounded-xl border bg-muted/50", className)} viewBox={`0 0 ${W} ${H}`}>
      <line stroke="var(--muted-foreground)" strokeDasharray="2 3" strokeOpacity="0.5" x1="0" x2={W} y1={y(sketch.entry)} y2={y(sketch.entry)} />
      <path d={legPath(pts)} fill="none" stroke="var(--brand)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      {head ? <circle cx={head.x} cy={head.y} fill="var(--brand)" r="2.4" /> : null}
    </svg>
  );
}

function SketchRow({ sketch }: { sketch: Sketch }) {
  const won = sketch.net >= 0;
  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent">
      <SketchThumb className="h-10 w-[4.25rem] shrink-0" sketch={sketch} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2">
          <Pill tone={sketch.long ? "up" : "down"}>{sketch.long ? "Up" : "Down"}</Pill>
          <span className="figures">
            ${usd(sketch.stake, 0)} <span className="text-muted-foreground">at {sketch.leverage}×</span>
          </span>
        </p>
        <p className="figures mt-0.5 truncate text-muted-foreground text-xs">from ${fmtPrice(sketch.entry)}</p>
      </div>
      <div className="text-right">
        <p className={cn("figures font-medium", won ? "text-up" : "text-down")}>{signedUsd(sketch.net)}</p>
        <p className="text-muted-foreground text-xs">
          {sketch.status === "running"
            ? "playing out"
            : sketch.liquidated
              ? "wiped out"
              : sketch.accuracy !== undefined
                ? `right ${Math.round(sketch.accuracy * 100)}%`
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

export function SketchesSheet({ open, onOpenChange, sketches, market }: { open: boolean; onOpenChange: (open: boolean) => void; sketches: Sketch[]; market: Market }) {
  const total = sketches.reduce((sum, s) => sum + s.net, 0);
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup side="right" variant="inset">
        <SheetHeader>
          <SheetTitle>Your lines</SheetTitle>
          <SheetDescription>
            {market.name} today: <span className={cn("figures", total >= 0 ? "text-up" : "text-down")}>{signedUsd(total)}</span>
          </SheetDescription>
        </SheetHeader>
        <SheetPanel className="px-4 pb-4">
          <SketchList sketches={sketches} />
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}

/** Two lines from earlier, so the list is reviewable. Mock, like every figure here. */
export function seedSketches(market: Market): Sketch[] {
  const e1 = market.price * 0.994;
  const e2 = market.price * 1.003;
  const shape = (entry: number, ms: number[]): Pt[] => ms.map((m, i) => ({ t: i / (ms.length - 1), price: entry * m }));
  return [
    { id: "seed-1", long: true, stake: 100, leverage: 5, entry: e1, pts: shape(e1, [1, 0.996, 0.992, 0.995, 1.002, 1.008, 1.012, 1.016]), placedAt: Date.now() - 3 * 3_600_000, status: "settled", net: 23.4, exit: e1 * 1.0047, accuracy: 0.83 },
    { id: "seed-2", long: false, stake: 50, leverage: 10, entry: e2, pts: shape(e2, [1, 1.003, 0.998, 0.993, 0.99, 0.986, 0.985]), placedAt: Date.now() - 55 * 60_000, status: "settled", net: -17.9, exit: e2 * 1.0036, accuracy: 0.38 },
  ];
}
