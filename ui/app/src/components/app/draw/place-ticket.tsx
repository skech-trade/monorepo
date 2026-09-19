"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { type Market, usd } from "@/lib/market";
import type { Quote, Shape } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import { DrawControls } from "./draw-controls";
import type { Phase } from "./sketch-canvas";

/**
 * Size, leverage, and the button that spends the money — hard right of the
 * chart's own header, across from the market it acts on.
 *
 * They sat along the bottom beside the prose explaining the line. Size and
 * leverage are not commentary: they decide what a press costs, so they belong
 * beside the press, and all three belong on the chart rather than in the row
 * that carries the wordmark and the account.
 */

export function PlaceTicket({
  market,
  phase,
  shape,
  quote,
  stake,
  leverage,
  onStake,
  onLeverage,
  onPlace,
  onDrawAgain,
  onCloseNow,
  className,
}: {
  market: Market;
  phase: Phase;
  shape: Shape | null;
  quote: Quote | null;
  stake: number;
  leverage: number;
  onStake: (stake: number) => void;
  onLeverage: (leverage: number) => void;
  onPlace: () => void;
  onDrawAgain: () => void;
  onCloseNow: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  /*
    The ticket opens itself the moment a line is finished.

    Putting the pen down is the question "so what does this cost me?", and the
    answer should not need a second gesture to ask for. Adjusting state during
    render is the documented way to react to a changing prop, and unlike an
    effect it leaves nothing wrong on screen for a frame.
  */
  const [seen, setSeen] = useState(phase);
  if (seen !== phase) {
    setSeen(phase);
    setOpen(phase === "drawn");
  }

  const settings = phase === "live" || phase === "drawing" || phase === "drawn";
  const long = shape?.long ?? true;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {settings ? <DrawControls leverage={leverage} onLeverage={onLeverage} onStake={onStake} stake={stake} /> : null}

      {phase === "drawn" && shape && quote ? (
        /*
          One button, and it trades.

          It was two: a green button that opened a ticket, and a green button
          inside the ticket that sent it — so the first press, the one that
          looked exactly like the thing to press, only dismissed something. The
          button does the trade now, first press, and the popup beside it holds
          nothing to click.

          And it says one thing. It listed the stake, the leverage, the
          notional, the entry, the target, the floor, the worst case and the
          best — beside a button reading "Trade for $100" and two more
          reading "Size $100" and "Leverage 10x". Everything but the side and
          what the leverage turns the stake into was already on screen, twice.
        */
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger
            render={
              <Button
                className={long ? "border-success bg-success text-white shadow-success/24 hover:bg-success/90" : ""}
                onClick={onPlace}
                variant={long ? "default" : "destructive"}
              />
            }
          >
            Trade for ${usd(stake, 0)}
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-auto max-w-xs px-3 py-2">
            <p className="text-sm">
              <span className="font-medium">
                {long ? "Long" : "Short"} {market.name}
              </span>
              <span className="text-muted-foreground">, trading like </span>
              <span className="figures">${usd(quote.notional, 0)}</span>
              <span className="text-muted-foreground">.</span>
            </p>
          </PopoverPopup>
        </Popover>
      ) : null}

      {phase === "running" ? (
        <Button onClick={onCloseNow} variant="outline">
          Take it off now
        </Button>
      ) : null}

      {phase === "settled" ? (
        <Button onClick={onDrawAgain} variant="outline">
          Draw another
        </Button>
      ) : null}
    </div>
  );
}
