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
  onDrawMore,
  drawingMore = false,
  enable,
  unavailableReason,
  recovery,
  closing = false,
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
  /** Keep drawing past the end of a running line, which adds positions. */
  onDrawMore?: () => void;
  drawingMore?: boolean;
  /** A wallet with no trading key yet: the button sets it up, once, before any trade. */
  enable?: { onEnable: () => void; pending: boolean };
  unavailableReason?: string;
  recovery?: { onClose: () => void; pending: boolean };
  closing?: boolean;
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
          {ready ? <ExitControls exits={exits} onExits={onExits} stake={stake} /> : null}
          {/* To the right of the button on a phone, mirroring rounds and the
              tools drawer on its left. */}
          <DrawControls className="max-sm:order-3" leverage={leverage} onLeverage={onLeverage} onStake={onStake} stake={stake} />
        </>
      ) : null}

      {/* Reset appears once there is a prediction to clear. */}
      {settings && ready ? (
        <Button className="hidden md:inline-flex" disabled={!ready} onClick={onDrawAgain} variant="ghost">
          Draw again
        </Button>
      ) : null}

      {/*
        Always present and dim until there is a line, so the row does not rearrange under the hand.
        Monochrome, matching the primary actions on skech.trade.
      */}
      {recovery ? (
        <Button className="max-sm:order-2 max-sm:h-13 max-sm:min-w-0 max-sm:flex-[2] max-sm:text-base" disabled={recovery.pending} onClick={recovery.onClose}>
          {recovery.pending ? "Closing…" : <><span className="sm:hidden">Close position</span><span className="max-sm:hidden">Close open position</span></>}
        </Button>
      ) : settings && ready && enable ? (
        <Button className="max-sm:order-2 max-sm:h-13 max-sm:min-w-0 max-sm:flex-[2] max-sm:text-base" disabled={enable.pending} loading={enable.pending} onClick={enable.onEnable}>
          Enable trading
        </Button>
      ) : settings ? (
        ready ? (
          <Popover>
            <PopoverTrigger delay={250} openOnHover render={<Button className="max-sm:order-2 max-sm:h-13 max-sm:min-w-0 max-sm:flex-[2] max-sm:text-base" disabled={!!unavailableReason} onClick={onPlace} />}>
              {unavailableReason ?? label}
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
          <Button className="max-sm:order-2 max-sm:h-13 max-sm:min-w-0 max-sm:flex-[2] max-sm:text-base" disabled>
            {unavailableReason ?? <><span className="sm:hidden">Draw to Trade</span><span className="max-sm:hidden">Draw a prediction first</span></>}
          </Button>
        )
      ) : null}

      {/* Plainly what it does, like the button that opened it. "Take it off
          now" is how a desk talks about a position; this is the control that
          ends a trade, so it says so. */}
      {!recovery && phase === "running" && onDrawMore ? (
        <Button aria-pressed={drawingMore} className="max-sm:order-1 max-sm:h-13 max-sm:min-w-0 max-sm:flex-1 max-sm:text-base" disabled={closing} onClick={onDrawMore} variant={drawingMore ? "default" : "outline"}>
          {drawingMore ? "Draw from the end…" : "Draw more"}
        </Button>
      ) : null}
      {!recovery && phase === "running" ? (
        <Button className="max-sm:order-2 max-sm:h-13 max-sm:min-w-0 max-sm:flex-[2] max-sm:text-base" disabled={closing} onClick={onCloseNow} variant="outline">
          {closing ? "Confirming close…" : "Close trade"}
        </Button>
      ) : null}

      {/* The same slot as "Close trade", so it says the same kind of thing:
          what pressing it gets you, in the words the rest of the screen uses
          for trades. */}
      {!recovery && phase === "settled" ? (
        <Button className="max-sm:order-2 max-sm:h-13 max-sm:min-w-0 max-sm:flex-[2] max-sm:text-base" onClick={onDrawAgain}>
          New trade
        </Button>
      ) : null}
    </div>
  );
}
