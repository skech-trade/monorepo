"use client";

import { CheckIcon, Share2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type Market, price as fmtPrice, signedUsd, usd } from "@/lib/market";
import type { Outcome, Quote, Shape } from "@/lib/sketch";
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
};

export const VERDICT: Record<Result["outcome"], string> = {
  target: "Called it",
  floor: "Out where you drew it",
  time: "Time's up",
  closed: "Taken off",
  liquidated: "Wiped out",
};

export function shareText(market: Market, result: Result): string {
  return `I drew ${market.name} going ${result.long ? "up" : "down"} from $${fmtPrice(result.entry)}. ${VERDICT[result.outcome]}. ${signedUsd(result.net, 0)} on skech.trade`;
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
        <Button onClick={onPlace}>Draw it in for ${usd(stake, 0)}</Button>
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
          Playing out
        </span>
        <Button onClick={onCloseNow} variant="outline">
          Take it off now
        </Button>
      </div>
    );
  }

  if (phase === "settled" && result) {
    const won = result.net >= 0;
    return (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {sketch ? <SketchThumb className="h-10 w-[4.25rem] shrink-0" sketch={sketch} /> : null}
        <span className="flex flex-col leading-none">
          <span className={cn("figures font-semibold text-xl", won ? "text-up" : "text-down")}>{signedUsd(result.net)}</span>
          <span className={cn("mt-1 text-xs", won ? "text-up" : "text-down")}>{VERDICT[result.outcome]}</span>
        </span>
        <p className="mr-auto text-muted-foreground text-xs">
          You drew {market.name} going {result.long ? "up" : "down"} from <F>${fmtPrice(result.entry)}</F>. It closed at <F>${fmtPrice(result.exit)}</F>.
        </p>
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
