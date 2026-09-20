"use client";

import { Button } from "@/components/ui/button";
import { type Market, price as fmtPrice, signedUsd, usd } from "@/lib/market";
import { type Outcome, type Quote, type Shape, verdictWord } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import type { Phase } from "./sketch-canvas";
import type { Sketch } from "./sketches";

/**
 * The bar along the foot of the chart. One line, four faces: invite, quote,
 * playing out, result. It never covers the plot; the chart gives it the row.
 */

export type Result = {
  net: number;
  outcome: Outcome | "closed";
  entry: number;
  exit: number;
  long: boolean;
  /** Share of the move that went your way. Over a half means it profited. */
  right: number;
  flags: boolean[];
  /** Mean of line minus price: positive means you drew too high. */
  bias: number;
};

export const VERDICT: Record<Result["outcome"], string> = {
  time: "Ran its course",
  closed: "Taken off",
  liquidated: "Wiped out",
  stop: "Stopped out",
  target: "Took the profit",
};

/** One glyph per candle, filled where it paid, hollow where it did not.
    Spoiler free and pastes into any chat, the way a Wordle grid does. */
export function shareText(market: Market, result: Result): string {
  const glyphs = result.flags.map((f) => (f ? "▮" : "▯")).join("");
  const word = verdictWord(result.outcome, result.right, result.net);
  return `skech · ${market.symbol} ${result.long ? "up" : "down"} · right ${Math.round(result.right * 100)}% of the way\n${glyphs}\n${word}. ${signedUsd(result.net, 0)} on skech.trade`;
}

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
  result,
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
  result: Result | null;
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
            what it costs — and that a point can still be moved. */}
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
      While it plays out, almost nothing.

      This read the whole position back at you — the running total, the entry,
      the live price, the target, the most you could lose — in a paragraph, at
      the one moment you are watching the chart and not the text. Every figure
      in it was already on the plot: the total rides a pill beside the candles,
      the entry and the target are ruled across it, and the handles ahead of
      now say for themselves that they can still be moved.

      What is left is the one thing the chart does not say: how far through it
      is, and how to get out.
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

  if (phase === "settled" && result) {
    const recent = sketches.filter((s) => s.accuracy !== undefined).slice(0, 8).reverse();
    /*
      The result is not here any more; it is the dialog that opens over the
      chart when the round ends. A finish is the one moment nothing else is
      going on, and it was being read out sideways in a row shared with the
      controls for starting again.

      What stays is the trend across rounds, which is about you rather than
      about this round, and the way back to Rounds.
    */
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="mr-auto text-muted-foreground">That one&rsquo;s done. It&rsquo;s in Rounds, with the replay. Start a new trade when you&rsquo;re ready.</span>
        {/* Your last rounds, as bars. A trend, not a coin flip. */}
        {recent.length > 1 ? (
          <span aria-label="Your recent rounds" className="flex h-6 items-end gap-0.5" title="How much of each move you called, last rounds">
            {recent.map((s) => (
              <span
                className={cn("w-1.5 rounded-sm", (s.accuracy ?? 0) >= 0.7 ? "bg-success" : (s.accuracy ?? 0) >= 0.5 ? "bg-primary/60" : "bg-input")}
                key={s.id}
                style={{ height: `${Math.max(15, (s.accuracy ?? 0) * 100)}%` }}
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
