"use client";

import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { type Market, usd } from "@/lib/market";
import type { Exits, Quote, Shape } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import { DrawControls } from "./draw-controls";
import { ExitControls } from "./exit-controls";
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
  exits,
  onStake,
  onLeverage,
  onExits,
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
  exits: Exits;
  onStake: (stake: number) => void;
  onLeverage: (leverage: number) => void;
  onExits: (exits: Exits) => void;
  onPlace: () => void;
  onDrawAgain: () => void;
  onCloseNow: () => void;
  className?: string;
}) {
  /*
    The note beside the button opens on hover, not on its own.

    It used to open itself the moment a line was finished, and the next click
    on the chart went to closing it instead of placing the second point. Every
    line that was drawn by clicking lost a point that way. The bar under the
    chart already answers "what does this cost me" the moment the pen lifts;
    this note adds which way you are facing and what the boost turns the
    stake into, for anyone who hovers to ask.
  */

  const settings = phase === "live" || phase === "drawing" || phase === "drawn";
  const long = shape?.long ?? true;
  /** There is a line, and it is finished. Until then the button is dim. */
  const ready = phase === "drawn" && shape !== null && quote !== null;
  /*
    One flex item, not two.

    "Trade" and the rest were separate children of a button whose own layout
    puts a gap between its children, and the non-breaking space between them
    added a second one on top: "Trade   for $100", with a hole in it.
  */
  const label = (
    <span>
      Trade<span className="hidden sm:inline"> for ${usd(stake, 0)}</span>
    </span>
  );

  return (
    <div className={cn("flex items-center gap-1.5 sm:gap-2", className)}>
      {/* When it ends, then what it costs, then the press. The two exits come
          first because they are the ones you leave alone most rounds. */}
      {settings ? (
        <>
          <ExitControls exits={exits} onExits={onExits} stake={stake} />
          <DrawControls leverage={leverage} onLeverage={onLeverage} onStake={onStake} stake={stake} />
        </>
      ) : null}

      {/* A line you have decided against needs an exit that is not the eraser
          in the far rail. Present and dim before there is one, like the button
          beside it, so the row does not rearrange itself mid-decision. */}
      {settings ? (
        <Button className="hidden md:inline-flex" disabled={!ready} onClick={onDrawAgain} variant="ghost">
          Draw again
        </Button>
      ) : null}

      {/*
        The button is always there, and dim until there is a line to send.

        It appeared only once something had been drawn, so the row rearranged
        itself under the reader's hand at the exact moment they were deciding
        something — and until then nothing on screen said what the drawing was
        for. Present and disabled says both: here is what happens next, and it
        is not available yet.

        One button, and it trades. It was two: a green button that opened a
        ticket and a green button inside the ticket that sent it, so the first
        press, the one that looked exactly like the thing to press, only
        dismissed something. Blue rather than green or red, because those two
        mean money up and money down everywhere else here and a control is not
        a figure. The popup beside it holds nothing to click and says the one
        thing not already on the row: which way you are facing, and what the
        boost turns the stake into.
      */}
      {settings ? (
        ready ? (
          <Popover>
            <PopoverTrigger delay={250} openOnHover render={<Button className="border-info bg-info text-white shadow-info/24 hover:bg-info/90" onClick={onPlace} />}>
              {label}
            </PopoverTrigger>
            <PopoverPopup align="end" className="w-auto max-w-xs px-3 py-2">
              <p className="text-sm">
                <span className="font-medium">
                  {market.name} {long ? "long" : "short"}
                </span>
                <span className="text-muted-foreground">, trading like </span>
                <span className="figures">${usd(quote.notional, 0)}</span>
                <span className="text-muted-foreground">.</span>
              </p>
            </PopoverPopup>
          </Popover>
        ) : (
          <Button className="border-info bg-info text-white shadow-info/24" disabled>
            {label}
          </Button>
        )
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
