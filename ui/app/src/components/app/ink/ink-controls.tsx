"use client";

import { POINT_PRICES } from "@skech/core/odds";
import { AmountWheel } from "@/components/app/draw/draw-controls";
import { Button } from "@/components/ui/button";
import { Popover, PopoverClose, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { Brush } from "@/lib/practice";
import { cn } from "@/lib/utils";

/**
 * The game's two settings, in the places the trading screen keeps size and
 * pace, each a button wearing its value and opening a popover, as those are.
 *
 * The pen is how wide the ink is, and so how easily the price catches it: a
 * wider pen is caught more often and pays less for it, and the map redraws
 * its multiples for the pen in hand. The amount is what one point costs,
 * on the trading screen's own wheel, so what a hit pays in dollars: the
 * chart shows those dollars, and the multiples stay as they are.
 */

export const PENS: { id: Brush; name: string; dot: number; says: string }[] = [
  { id: "fine", name: "Fine", dot: 6, says: "Pays most" },
  { id: "medium", name: "Medium", dot: 10, says: "In between" },
  { id: "wide", name: "Wide", dot: 15, says: "Easiest to hit" },
];
export const penFor = (id: Brush) => PENS.find((p) => p.id === id) ?? PENS[1];
export const amountLabel = (n: number) => (n < 1 ? `${Math.round(n * 100)}¢` : Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/* The label goes on a phone and the value stays, as on the trading screen's buttons. */
function Setting({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="hidden text-muted-foreground sm:inline">{label}</span>
      {children}
    </>
  );
}

const Dot = ({ size }: { size: number }) => <span aria-hidden="true" className="block shrink-0 rounded-full bg-current" style={{ width: size, height: size }} />;

export function InkControls({ pen, amount, onPen, onAmount, className }: { pen: Brush; amount: number; onPen: (id: Brush) => void; onAmount: (n: number) => void; className?: string }) {
  const current = penFor(pen);
  return (
    <div className={cn("flex items-center gap-1.5 sm:gap-2", className)}>
      <Popover>
        <PopoverTrigger render={<Button aria-label={`Pen: ${current.name}`} className="max-sm:h-13 max-sm:flex-1 max-sm:text-base" variant="outline" />}>
          <Setting label="Pen">
            <span className="flex items-center gap-2">
              <Dot size={current.dot} />
              <span>{current.name}</span>
            </span>
          </Setting>
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-60 max-sm:w-56">
          <PopoverTitle>Pen</PopoverTitle>
          <PopoverDescription>A wider pen&rsquo;s points are hit more often and pay less. The chart shows the multiples for the pen in hand.</PopoverDescription>
          <div className="flex flex-col gap-1 pt-3">
            {PENS.map((p) => (
              <PopoverClose
                aria-pressed={p.id === pen}
                className={cn("flex h-11 items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors hover:bg-accent", p.id === pen && "bg-accent font-medium")}
                key={p.id}
                onClick={() => onPen(p.id)}
              >
                <span className="flex w-4 justify-center">
                  <Dot size={p.dot} />
                </span>
                <span className="flex-1">{p.name}</span>
                <span className="text-muted-foreground text-xs">{p.says}</span>
              </PopoverClose>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
      <Popover>
        <PopoverTrigger render={<Button aria-label={`${amountLabel(amount)} a point`} className="max-sm:h-13 max-sm:flex-1 max-sm:text-base" variant="outline" />}>
          <Setting label="Per point">
            <span className="figures">{amountLabel(amount)}</span>
            <span className="text-muted-foreground sm:hidden">a point</span>
          </Setting>
        </PopoverTrigger>
        {/* The trading screen's size wheel, in cents: what a point costs, and so what every hit pays. */}
        <PopoverPopup align="end" className="w-56 max-sm:w-48">
          <PopoverTitle>
            <span className="sm:hidden">Per point</span>
            <span className="max-sm:hidden">Pick your price</span>
          </PopoverTitle>
          <PopoverDescription className="max-sm:hidden">What each point costs, 10¢ to $100. A hit pays it times the multiple.</PopoverDescription>
          <div className="pt-3 sm:pt-4">
            <AmountWheel format={amountLabel} label="What a point costs" onChange={onAmount} value={amount} values={[...POINT_PRICES.values]} />
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

const DEPOSITS = [100, 1000, 10000];

/** Practice money in: it lands in the balance at once. Beside the way in, in the app bar. */
export function DepositButton({ onDeposit }: { onDeposit: (amount: number) => void }) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="secondary" />}>Deposit</PopoverTrigger>
      <PopoverPopup align="end" className="w-60">
        <PopoverTitle>Add practice money</PopoverTitle>
        <PopoverDescription>It lands in your balance at once. Every point you draw is paid for from there, and every hit paid into it.</PopoverDescription>
        <div className="grid grid-cols-3 gap-1.5 pt-3">
          {DEPOSITS.map((a) => (
            <PopoverClose className="figures h-10 rounded-lg border text-sm transition-colors hover:bg-accent" key={a} onClick={() => onDeposit(a)}>
              ${a.toLocaleString("en-US")}
            </PopoverClose>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
