"use client";

import { MoreHorizontalIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { usd } from "@/lib/market";
import type { Exits } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import { AmountWheel } from "./draw-controls";

/**
 * Where to get out, in money: "close it if I lose $50" is a sentence a non-trader can check, and a
 * price is the same instruction in a costume.
 */

/** How far a take profit can be wound. No ceiling in the model; a wheel needs
    an end, and ten times the stake is past anything a minute will do. */
const ceiling = (stake: number) => Math.max(200, Math.round(stake * 10));

/** Where a switch starts when it is turned on: a quarter of the stake down,
    and a third of it up. Both are a figure to adjust, never a default to keep. */
const opening = (stake: number, side: "lose" | "gain") =>
  Math.max(5, Math.round(((side === "lose" ? stake / 4 : stake / 3) / 5)) * 5);

function Exit({
  side,
  label,
  value,
  stake,
  onChange,
}: {
  side: "lose" | "gain";
  label: string;
  value: number | null;
  stake: number;
  onChange: (value: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const on = value !== null;
  return (
    <Popover onOpenChange={setOpen} open={open}>
      {/*
        Off: a switch. On: the figure, red for the loss cap, green for the gain. The chip is the
        trigger either way.
      */}
      <PopoverTrigger
        render={
          <button
            className={cn(
              "flex h-8 cursor-pointer items-center gap-1.5 rounded-full border pr-2.5 pl-3 text-sm transition-colors hover:bg-accent",
              on && "bg-accent/40",
            )}
            // Pressing it while off turns it on at a figure worth adjusting,
            // so the wheel that opens is already doing something. Opening a
            // wheel that sets nothing until it is scrolled is a dead end.
            onClick={() => {
              if (!on) onChange(opening(stake, side));
            }}
            type="button"
          />
        }
      >
        <span className="text-muted-foreground">{label}</span>
        {on ? (
          <>
            <span className={cn("figures font-medium", side === "lose" ? "text-down" : "text-up")}>${usd(value, 0)}</span>
            {/* A cross turns it off, as every venue does; the rest of the chip opens the amount. */}
            <span
              aria-label={`Turn off ${label.toLowerCase()}`}
              className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-background hover:text-foreground [&_svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                e.stopPropagation();
                onChange(null);
              }}
              role="button"
              tabIndex={0}
            >
              <XIcon />
            </span>
          </>
        ) : (
          // Shown, not operated: the chip around it is the control, and two
          // hit targets for one job is one too many.
          <Switch aria-hidden="true" checked={false} className="pointer-events-none" tabIndex={-1} />
        )}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-56">
        <PopoverTitle>{label}</PopoverTitle>
        <PopoverDescription>{side === "lose" ? "Close it if you are down this much." : "Close it if you are up this much."}</PopoverDescription>
        <div className="pt-4">
          <AmountWheel
            max={side === "lose" ? stake : ceiling(stake)}
            min={0}
            offAtZero
            onChange={(next) => onChange(next === 0 ? null : next)}
            value={value ?? opening(stake, side)}
          />
        </div>
      </PopoverPopup>
    </Popover>
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
  const set = Number(exits.lose !== null) + Number(exits.gain !== null);
  const pair = (
    <>
      <Exit label="Stop loss" onChange={(lose) => onExits({ ...exits, lose })} side="lose" stake={stake} value={exits.lose} />
      <Exit label="Take profit" onChange={(gain) => onExits({ ...exits, gain })} side="gain" stake={stake} value={exits.gain} />
    </>
  );

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="hidden items-center gap-2 sm:flex">{pair}</div>

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
        <PopoverPopup align="start" className="w-auto">
          <div className="flex flex-col gap-2">{pair}</div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
