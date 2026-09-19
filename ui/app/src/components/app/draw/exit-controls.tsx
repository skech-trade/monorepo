"use client";

import { SlidersHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { usd } from "@/lib/market";
import type { Exits } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/**
 * Where to get out, in money.
 *
 * "Close it if I lose $50, close it if I make $70" is a sentence someone who
 * has never traded can say out loud and check afterwards. A stop at
 * $63,412.80 is the same instruction wearing a costume, and it asks the reader
 * to do arithmetic against a price they have not looked up. Both fields are
 * dollars of the stake, and both are optional — left empty, the clock and the
 * margin are the only ways out, which is how the screen already worked.
 *
 * Behind a menu because it is the third thing anyone wants, after how much and
 * how hard, and a row that shows everything shows nothing.
 */

function Amount({
  id,
  label,
  hint,
  tone,
  value,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  tone: string;
  value: number | null;
  max: number;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-baseline justify-between gap-2 text-sm" htmlFor={id}>
        <span className={cn("font-medium", tone)}>{label}</span>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </label>
      <Input
        className="figures"
        id={id}
        inputMode="decimal"
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9.]/g, "");
          const n = Number.parseFloat(raw);
          onChange(raw === "" || !Number.isFinite(n) ? null : Math.min(max, Math.max(0, n)));
        }}
        placeholder="off"
        value={value === null ? "" : String(value)}
      />
    </div>
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
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button aria-label="Where to get out" className={cn("relative", className)} variant="outline">
            <SlidersHorizontalIcon />
            {/* A count rather than the figures: two numbers do not fit on a
                button, and whether you set any is the thing worth seeing. */}
            {set > 0 ? <span className="figures text-muted-foreground text-xs">{set}</span> : null}
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-72">
        <PopoverTitle>Where to get out</PopoverTitle>
        <PopoverDescription>In dollars, either one optional.</PopoverDescription>
        <div className="flex flex-col gap-3 pt-4">
          <Amount
            hint={`most you can lose is $${usd(stake, 0)}`}
            id="exit-lose"
            label="Close if I lose"
            max={stake}
            onChange={(lose) => onExits({ ...exits, lose })}
            tone="text-down"
            value={exits.lose}
          />
          <Amount
            hint="no ceiling"
            id="exit-gain"
            label="Close if I make"
            max={Number.POSITIVE_INFINITY}
            onChange={(gain) => onExits({ ...exits, gain })}
            tone="text-up"
            value={exits.gain}
          />
          <p className="text-muted-foreground text-xs leading-snug">
            Left empty, the round runs its time — or until the margin goes, which it can do on its own.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
