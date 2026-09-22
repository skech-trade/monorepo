"use client";

import { CANDLE_SECONDS } from "@/lib/feed";

import { Button } from "@/components/ui/button";
import { type Market, price as fmtPrice } from "@/lib/market";
import type { Quote, Shape } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import type { Phase } from "./sketch-canvas";
import type { Sketch } from "./sketches";

/** The bar along the foot of the chart: invite, quote, playing out, done. It never covers the plot. */

/** A figure inside a sentence. */
function F({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={cn("figures text-foreground", tone)}>{children}</span>;
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
  phone,
  onVenue,
  venueAccount,
  venueProblem,
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
  /** Whether a real position is behind this round, and what went wrong if not. */
  /** A phone shows this row only when it has something to say. */
  phone?: boolean;
  onVenue?: boolean;
  /** The account it landed on, when that is not the reader's own. */
  venueAccount?: number | null;
  venueProblem?: string | null;
}) {
  /* On a phone this sits in the action row instead, where the thumb is. */
  const lines = phone ? null : (
    <Button onClick={onOpenList} variant="outline">
      Rounds <span className="figures text-muted-foreground">{openCount}</span>
    </Button>
  );

  /*
    Nothing to say yet, on the screen with the least room to say it.

    The chart itself reads "click to place your points" where the points go,
    which is the same instruction closer to the hand that follows it. So on a
    phone this row is not drawn at all until there is a figure or a result in
    it, and the bottom of the screen is one row of controls rather than two.
  */
  if (phone && (phase === "live" || phase === "drawing")) return null;

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
    return <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Target <F>${fmtPrice(shape.target)}</F> · <F>{Math.round(runBars*CANDLE_SECONDS)}</F>s. Execution and P&L come from Lighter.</p>{lines}</div>;
  }

  if (phase === "running" && shape) {
    /*
      Almost nothing while it plays: every figure is already on the plot. What is left is how far
      through it is.
    */
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="mr-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 animate-pulse rounded-full bg-info" />
            Candle <F>{runCount}</F> of <F>{Math.round(runBars)}</F>
          </span>
          {/* Whether there is money behind this. A round that did not reach
              the venue has to say so: the chart looks identical either way. */}
          {/* "On the venue" is true and not the whole truth while the trader
              holds one key for one account: the orders are real and they are
              not on the account whose balance is in the header. */}
          {onVenue && venueAccount === null ? <span className="text-up">On the venue</span> : null}
          {onVenue && venueAccount !== null ? (
            <span className="text-warning">
              On shared account <F>{venueAccount}</F>, not yours
            </span>
          ) : null}
          {venueProblem ? <span className="text-down">{venueProblem}</span> : null}
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
