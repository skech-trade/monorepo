"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { usd } from "@/lib/market";
import type { Exits } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import { AmountWheel, Setting } from "./draw-controls";

/**
 * Where to get out, in money.
 *
 * "Close it if I lose $50, close it if I make $70" is a sentence someone who
 * has never traded can say out loud and check afterwards. A stop at
 * $63,412.80 is the same instruction wearing a costume, and it asks a reader
 * to do arithmetic against a price they have not looked up. So both are
 * dollars of the stake, on the same wheel the stake itself uses, and zero
 * reads "Off" — which is where they both start.
 *
 * Two buttons where there is room for two buttons, because a stop loss is a
 * thing you should be able to see the state of without opening anything. On a
 * phone there is room for neither, so they fold behind the dots.
 */

/** How far up a take profit can be wound. No ceiling in the model; a wheel
    needs an end, and ten times the stake is past anything a minute will do. */
const GAIN_CEILING = (stake: number) => Math.max(200, Math.round(stake * 10));

function Lose({ exits, stake, onExits }: { exits: Exits; stake: number; onExits: (exits: Exits) => void }) {
  return (
    <>
      <PopoverTitle>Stop loss</PopoverTitle>
      <PopoverDescription>Close it if you are down this much.</PopoverDescription>
      <div className="pt-4">
        <AmountWheel max={stake} min={0} offAtZero onChange={(lose) => onExits({ ...exits, lose: lose === 0 ? null : lose })} value={exits.lose ?? 0} />
      </div>
    </>
  );
}

function Gain({ exits, stake, onExits }: { exits: Exits; stake: number; onExits: (exits: Exits) => void }) {
  return (
    <>
      <PopoverTitle>Take profit</PopoverTitle>
      <PopoverDescription>Close it if you are up this much.</PopoverDescription>
      <div className="pt-4">
        <AmountWheel
          max={GAIN_CEILING(stake)}
          min={0}
          offAtZero
          onChange={(gain) => onExits({ ...exits, gain: gain === 0 ? null : gain })}
          value={exits.gain ?? 0}
        />
      </div>
    </>
  );
}

export function ExitControls({
  exits,
  stake,
  onExits,
  className,
}: {
  exits: Exits;
  stake: number;
  onExits: (exits: Exits) => void;
  className?: string;
}) {
  const lose = exits.lose === null ? "Off" : `$${usd(exits.lose, 0)}`;
  const gain = exits.gain === null ? "Off" : `$${usd(exits.gain, 0)}`;
  const set = Number(exits.lose !== null) + Number(exits.gain !== null);

  return (
    <div className={cn("flex items-center gap-1.5 sm:gap-2", className)}>
      {/* Two buttons, wearing their values, exactly as Size and Boost do. */}
      <Popover>
        <PopoverTrigger render={<Button className="hidden sm:inline-flex" variant="outline" />}>
          <Setting label="Stop loss" value={lose} />
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-56">
          <Lose exits={exits} onExits={onExits} stake={stake} />
        </PopoverPopup>
      </Popover>

      <Popover>
        <PopoverTrigger render={<Button className="hidden sm:inline-flex" variant="outline" />}>
          <Setting label="Take profit" value={gain} />
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-56">
          <Gain exits={exits} onExits={onExits} stake={stake} />
        </PopoverPopup>
      </Popover>

      {/* And the pair of them behind the dots where there is no room. */}
      <Popover>
        <PopoverTrigger
          render={
            <Button aria-label="Stop loss and take profit" className="sm:hidden" variant="outline">
              <MoreHorizontalIcon />
              {set > 0 ? <span className="figures text-muted-foreground text-xs">{set}</span> : null}
            </Button>
          }
        />
        <PopoverPopup align="end" className="w-60">
          <Lose exits={exits} onExits={onExits} stake={stake} />
          <div className="mt-5 border-t pt-4">
            <Gain exits={exits} onExits={onExits} stake={stake} />
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
