"use client";

import { Segmented } from "@/components/app/controls";
import { announceSoon } from "@/components/app/soon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { Brush } from "@/lib/practice";

/**
 * The game's controls, in the places the trading screen keeps size and pace.
 *
 * One choice before you draw: the pen, as three dots. The dot is the pen's
 * size and what its ink costs together, so there is one thing to pick
 * rather than two: a small dot draws thin ink at 10¢ a unit, a large one
 * thick ink at 50¢. What any of it pays is the chart's to say, the same for
 * every pen.
 *
 * Drawing places itself when the pen lifts, straight from the balance, so
 * the only buttons are the ones that move money: deposit and withdraw.
 */

export const PENS: { id: Brush; name: string; perUnit: number; dot: number }[] = [
  { id: "fine", name: "Small", perUnit: 0.1, dot: 6 },
  { id: "medium", name: "Medium", perUnit: 0.25, dot: 10 },
  { id: "wide", name: "Large", perUnit: 0.5, dot: 15 },
];
export const penFor = (id: Brush) => PENS.find((p) => p.id === id) ?? PENS[1];
export const perUnitLabel = (n: number) => (n < 1 ? `${Math.round(n * 100)}¢` : `$${n}`);

/** The pen, as three dots in the app's segmented control. The price shows beside each dot on a desk. */
export function PenPicker({ pen, onPen, className }: { pen: Brush; onPen: (id: Brush) => void; className?: string }) {
  return (
    <div className={className}>
      <Segmented
        grow
        label="Pen"
        onChange={onPen}
        options={PENS.map((p) => ({
          value: p.id,
          label: (
            <span className="flex items-center gap-1.5" title={`${p.name} pen, ${perUnitLabel(p.perUnit)} of ink a unit`}>
              <span aria-hidden="true" className="block rounded-full bg-current" style={{ width: p.dot, height: p.dot }} />
              <span className="sr-only">{p.name}</span>
              <span className="figures max-sm:hidden">{perUnitLabel(p.perUnit)}</span>
            </span>
          ),
        }))}
        size="lg"
        value={pen}
      />
    </div>
  );
}

const AMOUNTS = [100, 500, 1000];

/** Deposit and withdraw. Practice money for now: deposit tops it up, and withdraw says when it will be real. */
export function MoneyButtons({ onDeposit, className }: { onDeposit: (amount: number) => void; className?: string }) {
  return (
    <div className={className}>
      <Popover>
        <PopoverTrigger render={<Button className="max-sm:h-13 max-sm:flex-1 max-sm:text-base" />}>Deposit</PopoverTrigger>
        <PopoverPopup align="end" className="w-60">
          <PopoverTitle>Add practice money</PopoverTitle>
          <PopoverDescription>It lands in your balance at once, and every drawing takes its ink from there.</PopoverDescription>
          <div className="grid grid-cols-3 gap-1.5 pt-3">
            {AMOUNTS.map((a) => (
              <Button className="figures" key={a} onClick={() => onDeposit(a)} variant="outline">
                ${a.toLocaleString("en-US")}
              </Button>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
      <Button className="max-sm:h-13 max-sm:flex-1 max-sm:text-base" onClick={() => announceSoon("Practice money stays in the game. Withdrawals open with real money.")} variant="outline">
        Withdraw
      </Button>
    </div>
  );
}
