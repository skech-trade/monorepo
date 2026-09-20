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
 * Exits, size, boost and the button that spends the money, hard right of the chart's header, beside
 * the press they price.
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
    Opens on hover only. Opening itself when a line finished stole the next click on the chart, so
    click-drawn lines lost their second point.
  */

  const settings = phase === "live" || phase === "drawing" || phase === "drawn";
  const long = shape?.long ?? true;
  /** There is a line, and it is finished. Until then the button is dim. */
  const ready = phase === "drawn" && shape !== null && quote !== null;
  /* One flex item: as two children the button's own gap left a hole in "Trade for $100". */
  const label = (
    <span>
      Trade<span className="hidden sm:inline"> for ${usd(stake, 0)}</span>
    </span>
  );

  return (
    /*
      On a phone this is not a group of its own: its children join the footer
      row so the button can sit between the pair on the left and the pair on
      the right. `contents` drops the box and keeps the children, which is the
      only way to interleave them without moving the markup around.
    */
    <div className={cn("flex items-center gap-1.5 max-sm:contents sm:gap-2", className)}>
      {/* When it ends, then what it costs, then the press. The two exits come
          first because they are the ones you leave alone most rounds. */}
      {settings ? (
        <>
          <ExitControls exits={exits} onExits={onExits} stake={stake} />
          {/* To the right of the button on a phone, mirroring rounds and the
              tools drawer on its left. */}
          <DrawControls className="max-sm:order-3" leverage={leverage} onLeverage={onLeverage} onStake={onStake} stake={stake} />
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
        Always present and dim until there is a line, so the row does not rearrange under the hand.
        Blue, because green and red mean money here.
      */}
      {settings ? (
        ready ? (
          <Popover>
            <PopoverTrigger delay={250} openOnHover render={<Button className="border-info bg-info text-white shadow-info/24 hover:bg-info/90 max-sm:order-2 max-sm:h-13 max-sm:min-w-0 max-sm:flex-[2] max-sm:rounded-xl max-sm:before:rounded-xl max-sm:text-base" onClick={onPlace} />}>
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
          <Button className="border-info bg-info text-white shadow-info/24 max-sm:order-2 max-sm:h-13 max-sm:min-w-0 max-sm:flex-[2] max-sm:rounded-xl max-sm:before:rounded-xl max-sm:text-base" disabled>
            {label}
          </Button>
        )
      ) : null}

      {/* Plainly what it does, like the button that opened it. "Take it off
          now" is how a desk talks about a position; this is the control that
          ends a trade, so it says so. */}
      {phase === "running" ? (
        <Button className="max-sm:order-2 max-sm:h-13 max-sm:min-w-0 max-sm:flex-[2] max-sm:rounded-xl max-sm:before:rounded-xl max-sm:text-base" onClick={onCloseNow} variant="outline">
          Close trade
        </Button>
      ) : null}

      {/* The same slot as "Close trade", so it says the same kind of thing:
          what pressing it gets you, in the words the rest of the screen uses
          for trades. */}
      {phase === "settled" ? (
        <Button className="max-sm:order-2 max-sm:h-13 max-sm:min-w-0 max-sm:flex-[2] max-sm:rounded-xl max-sm:before:rounded-xl max-sm:text-base" onClick={onDrawAgain} variant="outline">
          New trade
        </Button>
      ) : null}
    </div>
  );
}
