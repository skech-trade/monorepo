"use client";

import { CheckIcon, Share2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type Market, price as fmtPrice, signedUsd, usd } from "@/lib/market";
import { type Outcome, type Quote, type Shape, verdictFor } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import { Pill } from "../controls";
import { DrawControls } from "./draw-controls";
import type { Phase } from "./sketch-canvas";
import { type Sketch, SketchThumb } from "./sketches";

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
  /** Share of the way the price stayed inside the ribbon. */
  inside: number;
  flags: boolean[];
  /** Mean of line minus price: positive means you drew too high. */
  bias: number;
};

export const VERDICT: Record<Result["outcome"], string> = {
  target: "Called it",
  floor: "Out where you drew it",
  time: "Time's up",
  closed: "Taken off",
  liquidated: "Wiped out",
};

/** One glyph per candle, filled inside the ribbon, hollow outside. Spoiler
    free and pastes into any chat, the way a Wordle grid does. */
export function shareText(market: Market, result: Result): string {
  const glyphs = result.flags.map((f) => (f ? "▮" : "▯")).join("");
  const word = result.outcome === "liquidated" ? "Wiped out" : verdictFor(result.inside);
  return `skech · ${market.symbol} ${result.long ? "up" : "down"} · ${Math.round(result.inside * 100)}% inside\n${glyphs}\n${word}. ${signedUsd(result.net, 0)} on skech.trade`;
}

function ShareButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      onClick={async () => {
        try {
          if (typeof navigator.share === "function") {
            await navigator.share({ text });
            return;
          }
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          // Dismissed or blocked.
        }
      }}
    >
      {done ? <CheckIcon /> : <Share2Icon />}
      {done ? "Copied" : "Show your call"}
    </Button>
  );
}

/** A figure inside a sentence. */
function F({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={cn("figures text-foreground", tone)}>{children}</span>;
}

/** A big figure with a word under it. Two of these carry the quote. */
function Money({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="flex flex-col leading-none">
      <span className={cn("figures font-semibold text-xl", tone)}>{value}</span>
      <span className="mt-1 text-muted-foreground text-xs">{label}</span>
    </span>
  );
}

export function SketchBar({
  market,
  phase,
  shape,
  entry,
  price,
  quote,
  stake,
  leverage,
  onStake,
  onLeverage,
  pnl,
  result,
  sketch,
  openCount,
  runCount,
  runBars,
  sketches,
  onPlace,
  onDrawAgain,
  onCloseNow,
  onOpenList,
}: {
  market: Market;
  phase: Phase;
  shape: Shape | null;
  entry: number;
  price: number;
  quote: Quote | null;
  stake: number;
  leverage: number;
  onStake: (stake: number) => void;
  onLeverage: (leverage: number) => void;
  pnl: number | null;
  result: Result | null;
  sketch: Sketch | null;
  openCount: number;
  runCount: number;
  runBars: number;
  sketches: Sketch[];
  onPlace: () => void;
  onDrawAgain: () => void;
  onCloseNow: () => void;
  onOpenList: () => void;
}) {
  const controls = <DrawControls leverage={leverage} onLeverage={onLeverage} onStake={onStake} stake={stake} />;
  const lines = (
    <Button onClick={onOpenList} variant="outline">
      Your lines <span className="figures text-muted-foreground">{openCount}</span>
    </Button>
  );

  if (phase === "live" || phase === "drawing") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-muted-foreground">
          <span className="font-medium text-foreground">Draw where you think {market.name} goes.</span> Drag across the right of the chart. Nothing&rsquo;s at
          stake until you press the button.
        </p>
        {controls}
        {lines}
      </div>
    );
  }

  if (phase === "drawn" && shape && quote) {
    return (
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Pill tone={shape.long ? "up" : "down"}>{shape.long ? "Going up" : "Going down"}</Pill>
        <Money label="if it gets there" tone="text-up" value={`+$${usd(quote.ifWorks, 0)}`} />
        <Money label="the most you can lose" tone="text-down" value={`$${usd(quote.mostLose, 0)}`} />
        <p className="mr-auto max-w-[28rem] text-muted-foreground text-xs">
          From <F>${fmtPrice(entry)}</F>, aiming for <F>${fmtPrice(shape.target)}</F>
          {shape.floor === null ? <>. Never dips, so all <F>${usd(stake, 0)}</F> is on the table.</> : <>, out at <F>${fmtPrice(shape.floor)}</F>.</>}{" "}
          <F>${usd(stake, 0)}</F> trades like <F>${usd(quote.notional, 0)}</F>.
        </p>
        {controls}
        <Button onClick={onDrawAgain} variant="ghost">
          Draw again
        </Button>
        <Button
          className={shape.long ? "border-success bg-success text-white shadow-success/24 hover:bg-success/90" : ""}
          onClick={onPlace}
          variant={shape.long ? "default" : "destructive"}
        >
          Draw it in for ${usd(stake, 0)}
        </Button>
      </div>
    );
  }

  if (phase === "running" && shape) {
    const live = pnl ?? 0;
    return (
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Pill tone={shape.long ? "up" : "down"}>{shape.long ? "Going up" : "Going down"}</Pill>
        <Money label="right now" tone={Math.abs(live) < 0.005 ? undefined : live > 0 ? "text-up" : "text-down"} value={signedUsd(live)} />
        <Money label="the most you can lose" tone="text-down" value={`$${usd(quote?.mostLose ?? stake, 0)}`} />
        <p className="mr-auto text-muted-foreground text-xs">
          <F>${usd(stake, 0)}</F> at <F>{leverage}×</F>. In at <F>${fmtPrice(entry)}</F>, now <F>${fmtPrice(price)}</F>, aiming for{" "}
          <F>${fmtPrice(shape.target)}</F>.
        </p>
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <span className="size-1.5 animate-pulse rounded-full bg-info" />
          Candle <F>{runCount}</F> of <F>{runBars}</F>
        </span>
        <Button onClick={onCloseNow} variant="outline">
          Take it off now
        </Button>
      </div>
    );
  }

  if (phase === "settled" && result) {
    const won = result.net >= 0;
    const word = result.outcome === "liquidated" ? "Wiped out" : verdictFor(result.inside);
    const pct = Math.round(result.inside * 100);
    const off = Math.abs(result.bias);
    const recent = sketches.filter((s) => s.accuracy !== undefined).slice(0, 8).reverse();
    return (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {sketch ? <SketchThumb className="h-10 w-[4.25rem] shrink-0" sketch={sketch} /> : null}
        <span className="flex flex-col leading-none">
          <span className={cn("font-semibold text-xl", pct >= 80 ? "text-up" : pct >= 55 ? "text-foreground" : "text-down")}>{word}</span>
          <span className="mt-1 text-muted-foreground text-xs">
            <F>{pct}%</F> inside your ribbon
          </span>
        </span>
        <Money label={VERDICT[result.outcome].toLowerCase()} tone={won ? "text-up" : "text-down"} value={signedUsd(result.net)} />
        <p className="mr-auto max-w-[26rem] text-muted-foreground text-xs">
          You drew {market.name} going {result.long ? "up" : "down"} from <F>${fmtPrice(result.entry)}</F>. It closed at <F>${fmtPrice(result.exit)}</F>.
          {off >= 1 ? (
            <>
              {" "}
              You drew too {result.bias > 0 ? "high" : "low"} by <F>${usd(off, 0)}</F> on average.
            </>
          ) : null}
        </p>
        {/* Your last rounds, as bars. A trend, not a coin flip. */}
        {recent.length > 1 ? (
          <span aria-label="Your recent accuracy" className="flex h-6 items-end gap-0.5" title="Inside the ribbon, last rounds">
            {recent.map((s) => (
              <span
                className={cn("w-1.5 rounded-sm", (s.accuracy ?? 0) >= 0.8 ? "bg-success" : (s.accuracy ?? 0) >= 0.55 ? "bg-primary/60" : "bg-input")}
                key={s.id}
                style={{ height: `${Math.max(15, (s.accuracy ?? 0) * 100)}%` }}
              />
            ))}
          </span>
        ) : null}
        {lines}
        <ShareButton text={shareText(market, result)} />
        <Button onClick={onDrawAgain} variant="outline">
          Draw another
        </Button>
      </div>
    );
  }
  return null;
}
