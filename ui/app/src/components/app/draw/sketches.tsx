"use client";

import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type Market, price as fmtPrice, signedUsd, usd } from "@/lib/market";
import { type Pt, legPath } from "@/lib/sketch";
import { cn } from "@/lib/utils";

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
    <svg aria-hidden="true" className={cn("rounded-md border bg-muted/40", className)} viewBox={`0 0 ${W} ${H}`}>
      <line stroke="var(--muted-foreground)" strokeDasharray="2 3" strokeOpacity="0.5" x1="0" x2={W} y1={y(sketch.entry)} y2={y(sketch.entry)} />
      <path d={legPath(pts)} fill="none" stroke="var(--brand)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      {head ? <circle cx={head.x} cy={head.y} fill="var(--brand)" r="2.4" /> : null}
    </svg>
  );
}

/** What became of a line, in as few words as it takes. */
function Outcome({ sketch }: { sketch: Sketch }) {
  if (sketch.status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-info" />
        playing out
      </span>
    );
  }
  if (sketch.liquidated) return <span className="text-warning-foreground">wiped out</span>;
  if (sketch.accuracy === undefined) return <span className="text-muted-foreground">{sketch.net >= 0 ? "called it" : "missed"}</span>;
  return <span className="figures text-muted-foreground">right {Math.round(sketch.accuracy * 100)}%</span>;
}

/**
 * The same table the desk keeps its positions in.
 *
 * A line is a position, so it is listed like one: a row per line, columns that
 * line up, figures right-aligned in the tabular face, the seams hairlines. It
 * was a stack of free-floating cards with the numbers stacked two-deep inside
 * each — nothing to read down, nothing to compare, and a column of air beneath.
 *
 * No side column. The drawing in the first cell is the side: a line that ends
 * above where it started is up, and you can see that faster than you can read
 * the word for it. A pill saying so as well was the same fact twice, in the
 * widest possible form, in a list whose whole point is the shapes.
 */
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
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          <TableHead className="pl-3">Line</TableHead>
          <TableHead>Size</TableHead>
          <TableHead>In at</TableHead>
          <TableHead>Out at</TableHead>
          <TableHead className="pr-3 text-right">Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sketches.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="pl-3">
              <SketchThumb className="h-7 w-12 shrink-0" sketch={s} />
            </TableCell>
            <TableCell className="figures whitespace-nowrap">
              ${usd(s.stake, 0)} <span className="text-muted-foreground">at {s.leverage}×</span>
            </TableCell>
            <TableCell className="figures whitespace-nowrap">${fmtPrice(s.entry)}</TableCell>
            <TableCell className="figures whitespace-nowrap">
              {s.exit === undefined ? <span className="text-muted-foreground">&mdash;</span> : `$${fmtPrice(s.exit)}`}
            </TableCell>
            <TableCell className="whitespace-nowrap pr-3 text-right">
              <span className={cn("figures font-medium", s.net >= 0 ? "text-up" : "text-down")}>{signedUsd(s.net)}</span>
              <span className="ml-2">
                <Outcome sketch={s} />
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function SketchesSheet({ open, onOpenChange, sketches, market }: { open: boolean; onOpenChange: (open: boolean) => void; sketches: Sketch[]; market: Market }) {
  const total = sketches.reduce((sum, s) => sum + s.net, 0);
  const settled = sketches.filter((s) => s.status === "settled");
  const won = settled.filter((s) => s.net >= 0).length;
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="sm:max-w-2xl" side="right" variant="inset">
        <SheetHeader>
          <SheetTitle>Your lines</SheetTitle>
          <SheetDescription>
            {market.name} today &middot; <span className={cn("figures", total >= 0 ? "text-up" : "text-down")}>{signedUsd(total)}</span>
            {settled.length > 0 ? (
              <>
                {" "}
                &middot; <span className="figures">{won}</span> of <span className="figures">{settled.length}</span> came good
              </>
            ) : null}
          </SheetDescription>
        </SheetHeader>
        {/* Flush to the panel's edges, the way the desk's own tables sit: the
            row is the unit and its hairline should reach both sides. */}
        <SheetPanel className="p-0">
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
