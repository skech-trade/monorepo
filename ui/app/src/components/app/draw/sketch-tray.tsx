"use client";

import { CheckIcon, Share2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type Market, price as fmtPrice, signedUsd, usd } from "@/lib/market";
import type { Outcome, Quote, Shape } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import { Figure, Pill } from "../controls";
import type { Order } from "../ticket";
import { DrawControls } from "./draw-controls";
import type { Phase } from "./sketch-canvas";
import { type Sketch, SketchThumb } from "./sketches";

/**
 * The tray beside the chart. Four faces: invite, quote, playing out, result.
 * Every number in dollars at the stake you picked, the loss at the same size
 * as the gain.
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
      className="flex-1"
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
      size="lg"
    >
      {done ? <CheckIcon /> : <Share2Icon />}
      {done ? "Copied" : "Show your call"}
    </Button>
  );
}

/** A figure inside a sentence. */
function F({ children }: { children: React.ReactNode }) {
  return <span className="figures text-foreground">{children}</span>;
}

function Direction({ long }: { long: boolean }) {
  return <Pill tone={long ? "up" : "down"}>{long ? "Going up" : "Going down"}</Pill>;
}

export function SketchTray({
  market,
  phase,
  shape,
  entry,
  price,
  quote,
  order,
  patch,
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
  order: Order;
  patch: (next: Partial<Order>) => void;
  pnl: number | null;
  result: Result | null;
  sketch: Sketch | null;
  openCount: number;
  onPlace: () => void;
  onDrawAgain: () => void;
  onCloseNow: () => void;
  onOpenList: () => void;
}) {
  const stake = Number.parseFloat(order.pay) || 100;

  if (phase === "live" || phase === "drawing") {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-base">Draw where you think {market.name} goes.</p>
          <p className="text-muted-foreground">Drag across the right of the chart. Nothing&rsquo;s at stake until you press the button.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DrawControls order={order} patch={patch} />
          <Button className="ml-auto lg:hidden" onClick={onOpenList} variant="outline">
            Your lines <span className="figures text-muted-foreground">{openCount}</span>
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "drawn" && shape && quote) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Direction long={shape.long} />
          <span className="text-muted-foreground">
            from <span className="figures text-foreground">${fmtPrice(entry)}</span>
          </span>
          <Button className="ml-auto" onClick={onDrawAgain} size="sm" variant="ghost">
            Draw again
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Figure label="If it gets there" size="lg" tone="text-up" value={`+$${usd(quote.ifWorks, 0)}`} />
          <Figure label="The most you can lose" size="lg" tone="text-down" value={`$${usd(quote.mostLose, 0)}`} />
        </div>
        <p className="text-muted-foreground">
          Aiming for <F>${fmtPrice(shape.target)}</F>
          {shape.floor === null ? (
            <>, and it never dips, so all <F>${usd(stake, 0)}</F> is on the table.</>
          ) : (
            <>, out at <F>${fmtPrice(shape.floor)}</F>.</>
          )}{" "}
          <F>${usd(stake, 0)}</F> trades like <F>${usd(quote.notional, 0)}</F>.
        </p>
        <DrawControls order={order} patch={patch} />
        <Button className="w-full" onClick={onPlace} size="lg">
          Draw it in for ${usd(stake, 0)}
        </Button>
      </div>
    );
  }

  if (phase === "running" && shape) {
    const live = pnl ?? 0;
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Direction long={shape.long} />
          <span className="text-muted-foreground">
            ${usd(stake, 0)} at {order.leverage}×
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="size-1.5 animate-pulse rounded-full bg-info" />
            Playing out
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Figure label="Right now" size="lg" tone={Math.abs(live) < 0.005 ? undefined : live > 0 ? "text-up" : "text-down"} value={signedUsd(live)} />
          <Figure label="The most you can lose" size="lg" tone="text-down" value={`$${usd(quote?.mostLose ?? stake, 0)}`} />
        </div>
        <p className="text-muted-foreground">
          In at <F>${fmtPrice(entry)}</F>, now <F>${fmtPrice(price)}</F>. Aiming for <F>${fmtPrice(shape.target)}</F>
          {shape.floor !== null ? <>, out at <F>${fmtPrice(shape.floor)}</F></> : null}.
        </p>
        <div className="flex flex-col gap-2">
          <Button className="w-full" onClick={onCloseNow} size="lg" variant="outline">
            Take it off now
          </Button>
          <p className="text-center text-muted-foreground text-xs">Candles arrive every second in this preview.</p>
        </div>
      </div>
    );
  }

  if (phase === "settled" && result) {
    const won = result.net >= 0;
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          {sketch ? <SketchThumb className="h-14 w-24 shrink-0" sketch={sketch} /> : null}
          <div className="min-w-0">
            <p className={cn("font-medium text-xs", won ? "text-up" : "text-down")}>{VERDICT[result.outcome]}</p>
            <p className={cn("figures font-semibold text-2xl", won ? "text-up" : "text-down")}>{signedUsd(result.net)}</p>
          </div>
        </div>
        <p className="text-muted-foreground">
          You drew {market.name} going {result.long ? "up" : "down"} from <span className="figures text-foreground">${fmtPrice(result.entry)}</span>. It closed at{" "}
          <span className="figures text-foreground">${fmtPrice(result.exit)}</span>.
        </p>
        <div className="flex gap-2">
          <ShareButton text={shareText(market, result)} />
          <Button className="flex-1" onClick={onDrawAgain} size="lg" variant="outline">
            Draw another
          </Button>
        </div>
      </div>
    );
  }
  return null;
}
