"use client";

import { CheckIcon, Share2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Pill } from "./controls";
import { DrawControls } from "./draw-controls";
import { type Market, price as fmtPrice, signedUsd, usd } from "./market";
import type { Order } from "./order-ticket";
import type { Phase } from "./sketch-canvas";
import type { Outcome, Quote, Shape } from "./sketch";
import { type Sketch, SketchThumb } from "./sketches";

/**
 * What sits under the chart on a phone and beside it on a desk.
 *
 * One panel, four faces. Empty it invites; with a line down it quotes the
 * trade in two dollar figures and lets you set how much; running it shows the
 * money moving; settled it hands you the result as a picture.
 *
 * Every number is in dollars at the stake you picked. Not a multiple, not a
 * percentage, not R:R. The loss is set at the same size as the gain, because
 * that is the honest half and the half that makes someone trust the other.
 */

export type Result = {
  net: number;
  /** How it ended. `closed` is you taking it off early. */
  outcome: Outcome | "closed";
  entry: number;
  exit: number;
  long: boolean;
};

/** Three words at most, and the colour is the money's, not the word's. */
export const VERDICT: Record<Result["outcome"], string> = {
  target: "Called it",
  floor: "Out where you drew it",
  time: "Time's up",
  closed: "Taken off",
  liquidated: "Wiped out",
};

function Money({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "up" | "down" | "default";
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span
        className={cn(
          "figures truncate text-price",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
        )}
      >
        {value}
      </span>
      <span className="text-kicker text-fg-subtle">{label}</span>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-caption text-fg-subtle">{label}</span>
      <span className={cn("figures text-caption", tone ?? "text-foreground")}>
        {value}
      </span>
    </div>
  );
}

function Direction({ long }: { long: boolean }) {
  return (
    <Pill tone={long ? "up" : "down"}>
      {long ? "Going up" : "Going down"}
    </Pill>
  );
}

/** The result as a line of text someone would paste into a group chat. */
export function shareText(market: Market, result: Result): string {
  const dir = result.long ? "up" : "down";
  const money = signedUsd(result.net, 0);
  const verdict = `${VERDICT[result.outcome]}.`;
  return `I drew ${market.name} going ${dir} from $${fmtPrice(result.entry)}. ${verdict} ${money} on skech.trade`;
}

function ShareButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      className="flex-1 rounded-full"
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
          // Dismissed or blocked. The text is still on screen.
        }
      }}
      size="xl"
    >
      {done ? <CheckIcon /> : <Share2Icon />}
      {done ? "Copied" : "Show your call"}
    </Button>
  );
}

export function SketchSheet({
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
  className,
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
  /** The sketch that just settled, for the picture on the result card. */
  sketch: Sketch | null;
  openCount: number;
  onPlace: () => void;
  onDrawAgain: () => void;
  onCloseNow: () => void;
  onOpenList: () => void;
  className?: string;
}) {
  const stake = Number.parseFloat(order.pay) || 100;
  const openButton = (
    <Button
      className="rounded-full lg:hidden"
      onClick={onOpenList}
      size="lg"
      variant="outline"
    >
      Your lines
      <span className="figures rounded-full bg-surface-3 px-2 text-kicker">
        {openCount}
      </span>
    </Button>
  );

  if (phase === "live" || phase === "drawing") {
    return (
      <div className={cn("flex flex-col gap-4", className)}>
        <div>
          <p className="text-title">Draw where you think {market.name} goes.</p>
          <p className="mt-1 text-caption text-fg-muted">
            Drag across the right of the chart. Nothing&rsquo;s at stake until
            you press the button.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DrawControls order={order} patch={patch} />
          <span className="ml-auto">{openButton}</span>
        </div>
      </div>
    );
  }

  if (phase === "drawn" && shape && quote) {
    return (
      <div className={cn("flex flex-col gap-5", className)}>
        <div className="flex flex-wrap items-center gap-3">
          <Direction long={shape.long} />
          <span className="text-caption text-fg-muted">
            from <span className="figures text-foreground">${fmtPrice(entry)}</span>
          </span>
          <Button
            className="ml-auto rounded-full"
            onClick={onDrawAgain}
            size="sm"
            variant="ghost"
          >
            Draw again
          </Button>
        </div>

        <div className="flex gap-6">
          <Money
            label="If it gets there"
            tone="up"
            value={`+$${usd(quote.ifWorks, 0)}`}
          />
          <Money
            label="The most you can lose"
            tone="down"
            value={`$${usd(quote.mostLose, 0)}`}
          />
        </div>

        {/* The chart already tags where you're aiming and where you're out,
            so on a phone, where the chart is paying for every row here, the
            rows go and the tags stay. */}
        <div className="well hidden flex-col gap-2 rounded-2xl p-4 sm:flex">
          <Row label="Where you're aiming" value={`$${fmtPrice(shape.target)}`} />
          <Row
            label="Where you're out"
            tone={shape.floor === null ? "text-fg-muted" : undefined}
            value={
              shape.floor === null
                ? `Never dips, so all $${usd(stake, 0)}`
                : `$${fmtPrice(shape.floor)}`
            }
          />
          <Row
            label="Put in"
            value={`$${usd(stake, 0)}, trades like $${usd(quote.notional, 0)}`}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <DrawControls order={order} patch={patch} />
        </div>

        <div className="flex flex-col gap-2">
          <Button className="w-full rounded-full" onClick={onPlace} size="xl">
            Draw it in for ${usd(stake, 0)}
          </Button>
          <p className="text-center text-caption text-fg-subtle">
            Interface preview. Nothing is placed.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "running" && shape) {
    const live = pnl ?? 0;
    return (
      <div className={cn("flex flex-col gap-5", className)}>
        <div className="flex flex-wrap items-center gap-3">
          <Direction long={shape.long} />
          <span className="text-caption text-fg-muted">
            ${usd(stake, 0)} at {order.leverage}×
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-kicker text-fg-subtle">
            <span className="size-1.5 animate-pulse rounded-full bg-brand" />
            Playing out
          </span>
        </div>

        <div className="flex gap-6">
          <Money
            label="Right now"
            tone={Math.abs(live) < 0.005 ? "default" : live > 0 ? "up" : "down"}
            value={signedUsd(live)}
          />
          <Money
            label="The most you can lose"
            tone="down"
            value={`$${usd(quote?.mostLose ?? stake, 0)}`}
          />
        </div>

        <div className="well hidden flex-col gap-2 rounded-2xl p-4 sm:flex">
          <Row label="You got in at" value={`$${fmtPrice(entry)}`} />
          <Row label="Now" value={`$${fmtPrice(price)}`} />
          <Row label="Where you're aiming" value={`$${fmtPrice(shape.target)}`} />
        </div>

        <div className="flex flex-col gap-2">
          <Button
            className="w-full rounded-full"
            onClick={onCloseNow}
            size="xl"
            variant="outline"
          >
            Take it off now
          </Button>
          <p className="text-center text-caption text-fg-subtle">
            Candles arrive every second in this preview.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "settled" && result) {
    const won = result.net >= 0;
    return (
      <div className={cn("flex flex-col gap-5", className)}>
        <div className="flex items-center gap-4">
          {sketch ? (
            <SketchThumb className="h-14 w-24 shrink-0" sketch={sketch} />
          ) : null}
          <div className="min-w-0">
            <p className={cn("text-kicker", won ? "text-up" : "text-down")}>
              {VERDICT[result.outcome]}
            </p>
            <p
              className={cn(
                "figures text-price",
                won ? "text-up" : "text-down",
              )}
            >
              {signedUsd(result.net)}
            </p>
          </div>
        </div>

        <p className="text-caption text-fg-muted">
          You drew {market.name} going {result.long ? "up" : "down"} from{" "}
          <span className="figures text-foreground">${fmtPrice(result.entry)}</span>.
          It closed at{" "}
          <span className="figures text-foreground">${fmtPrice(result.exit)}</span>.
        </p>

        <div className="flex gap-2">
          <ShareButton text={shareText(market, result)} />
          <Button
            className="flex-1 rounded-full"
            onClick={onDrawAgain}
            size="xl"
            variant="outline"
          >
            Draw another
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
