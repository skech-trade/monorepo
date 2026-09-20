"use client";

import { Button } from "@/components/ui/button";
import { type Market, price as fmtPrice, signedUsd, usd } from "@/lib/market";
import type { Quote, Shape } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import type { Phase } from "./sketch-canvas";
import type { Sketch } from "./sketches";

/** The bar along the foot of the chart: invite, quote, playing out, done. It never covers the plot. */

/** A figure inside a sentence. */
function F({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={cn("figures text-foreground", tone)}>{children}</span>;
}

/** The one figure that leads a line. */
function Lead({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={cn("figures shrink-0 font-semibold text-xl leading-none", tone)}>{children}</span>;
}

export function SketchBar({
  market,
  phase,
  shape,
  quote,
  openCount,
  runCount,
  runBars,
  sketches,
  onOpenList,
}: {
  market: Market;
  phase: Phase;
  shape: Shape | null;
  quote: Quote | null;
  openCount: number;
  runCount: number;
  runBars: number;
  sketches: Sketch[];
  onOpenList: () => void;
}) {
  const lines = (
    <Button onClick={onOpenList} variant="outline">
      Rounds <span className="figures text-muted-foreground">{openCount}</span>
    </Button>
  );

  if (phase === "live" || phase === "drawing") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        {/* The instruction survives on a phone; the reassurance after it takes
            three lines of a small screen to say what the button already says
            by not having been pressed. */}
        <p className="mr-auto text-muted-foreground">
          <span className="font-medium text-foreground">Draw where you think {market.name} goes.</span>{" "}
          <span className="hidden sm:inline">Click on the right of the chart to place points, or drag to draw. Nothing&rsquo;s at stake until you press the button.</span>
        </p>
        {lines}
      </div>
    );
  }

  if (phase === "drawn" && shape && quote) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Lead tone={quote.ifWorks >= 0 ? "text-up" : "text-down"}>{signedUsd(quote.ifWorks, 0)}</Lead>
        {/* The stake, the leverage and what they multiply to are all in the
            header now, twice over. What is left is what the line is worth and
            what it costs, and that a point can still be moved. */}
        <p className="mr-auto max-w-[34rem] text-muted-foreground">
          if it gets to <F>${fmtPrice(shape.target)}</F>, after fees. Most you can lose <F tone="text-down">${usd(quote.mostLose, 0)}</F>, wiped out at{" "}
          <F>${fmtPrice(quote.wipedAt)}</F>. Runs <F>{Math.round(runBars)}</F> seconds, as long as the line. Drag a point to change it.
        </p>
        {lines}
      </div>
    );
  }

  if (phase === "running" && shape) {
    /*
      Almost nothing while it plays: every figure is already on the plot. What is left is how far
      through it is.
    */
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="mr-auto flex items-center gap-1.5 text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-info" />
          Candle <F>{runCount}</F> of <F>{Math.round(runBars)}</F>
        </span>
        {lines}
      </div>
    );
  }

  if (phase === "settled") {
    const recent = sketches.filter((s) => s.right !== undefined).slice(0, 8).reverse();
    /* The result lives in the Rounds sheet; what stays here is the trend across rounds and the way back. */
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="mr-auto text-muted-foreground">That one&rsquo;s done. It&rsquo;s in Rounds, with the replay. Start a new trade when you&rsquo;re ready.</span>
        {/* Your last rounds, as bars. A trend, not a coin flip. */}
        {recent.length > 1 ? (
          <span aria-label="Your recent rounds" className="flex h-6 items-end gap-0.5" title="How much of each move you called, last rounds">
            {recent.map((s) => (
              <span
                className={cn("w-1.5 rounded-sm", (s.right ?? 0) >= 0.7 ? "bg-success" : (s.right ?? 0) >= 0.5 ? "bg-primary/60" : "bg-input")}
                key={s.id}
                style={{ height: `${Math.max(15, (s.right ?? 0) * 100)}%` }}
              />
            ))}
          </span>
        ) : null}
        {lines}
      </div>
    );
  }
  return null;
}
