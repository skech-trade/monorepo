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
    <div className={cn("flex items-center gap-1.5 sm:gap-2", className)}>
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
        <>
          {/* Somewhere to put it down and start over, next to the button that
              commits it. Taken out when the header was being thinned and
              missed at once: a line you have decided against needs an exit
              that is not the eraser in the far rail. */}
          <Button className="hidden md:inline-flex" onClick={onDrawAgain} variant="ghost">
            Draw again
          </Button>
          <Popover onOpenChange={setOpen} open={open}>
          {/*
            Blue, whichever way the line goes.

            It was green for a long and red for a short, which reads as a
            verdict on the trade rather than a thing to press — and the two
            colours this app uses for money going up and money going down do
            not belong on a control. Blue says "this is the action"; the popup
            beside it says which way you are facing.
          */}
          <PopoverTrigger
            render={<Button className="border-info bg-info text-white shadow-info/24 hover:bg-info/90" onClick={onPlace} />}
          >
            Trade<span className="hidden sm:inline">&nbsp;for ${usd(stake, 0)}</span>
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-auto max-w-xs px-3 py-2">
            <p className="text-sm">
              {/* Where the line ends up is the call, and the call is the thing
                  worth reading back before you commit to it. */}
              <span className="font-medium">
                {market.name} {long ? "long" : "short"}
              </span>
              <span className="text-muted-foreground">, trading like </span>
              <span className="figures">${usd(quote.notional, 0)}</span>
              <span className="text-muted-foreground">.</span>
            </p>
          </PopoverPopup>
          </Popover>
        </>
      ) : null}

      {/* Plainly what it does, like the button that opened it. "Take it off
          now" is how a desk talks about a position; this is the control that
          ends a trade, so it says so. */}
      {phase === "running" ? (
        <Button onClick={onCloseNow} variant="outline">
          Close trade
        </Button>
      ) : null}

      {/* The same slot as "Close trade", so it says the same kind of thing:
          what pressing it gets you, in the words the rest of the screen uses
          for trades. */}
      {phase === "settled" ? (
        <Button onClick={onDrawAgain} variant="outline">
          New trade
        </Button>
      ) : null}
    </div>
  );
}
