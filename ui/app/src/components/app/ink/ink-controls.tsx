"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { POINT_PRICES } from "@skech/core/odds";
import { AmountWheel } from "./amount-wheel";
import { Button } from "@/components/ui/button";
import { Popover, PopoverClose, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { Brush } from "@/lib/practice";
import { cn } from "@/lib/utils";
import feedback from "./drawing-feedback.module.css";

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
  { id: "fine", name: "Fine", dot: 8, says: "Higher multiples" },
  { id: "medium", name: "Medium", dot: 14, says: "Balanced" },
  { id: "wide", name: "Wide", dot: 20, says: "More coverage" },
];
export const penFor = (id: Brush) => PENS.find((p) => p.id === id) ?? PENS[1];
export const amountLabel = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

const Dot = ({ size }: { size: number }) => <span aria-hidden="true" className="block shrink-0 rounded-full bg-current transition-[width,height] duration-150 ease-out motion-reduce:transition-none" style={{ width: size, height: size }} />;

export function InkControls({ pen, amount, onPen, onAmount, className }: { pen: Brush; amount: number; onPen: (id: Brush) => void; onAmount: (n: number) => void; className?: string }) {
  return (
    <div className={cn(feedback.penControls, className)}>
      <Popover>
        <PopoverTrigger render={<Button aria-label={`Pen: ${penFor(pen).name}`} className={feedback.dockButton} variant="outline" />}>
          <Dot size={penFor(pen).dot} /><span>{penFor(pen).name}</span><ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverPopup side="top" sideOffset={12} className="w-56">
          <PopoverTitle>Pen size</PopoverTitle>
          <div className="mt-3 flex flex-col gap-1">
            {PENS.map(p => <PopoverClose key={p.id} render={<Button variant="ghost" className="h-12 justify-start px-3" />} onClick={() => onPen(p.id)} aria-label={`Use ${p.name} pen`}>
              <span className="flex w-6 items-center justify-center"><Dot size={p.dot} /></span><span>{p.name}</span>{pen === p.id ? <CheckIcon className="ml-auto text-primary" /> : null}
            </PopoverClose>)}
          </div>
        </PopoverPopup>
      </Popover>
      <Popover>
        <PopoverTrigger render={<Button aria-label={`${amountLabel(amount)} per dot`} className={feedback.dockButton} variant="outline" />}>
          <span className="figures font-semibold">{amountLabel(amount)}</span><ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </PopoverTrigger>
        {/* The trading screen's size wheel, in cents: what per dot costs, and so what every hit pays. */}
        <PopoverPopup side="top" sideOffset={12} align="end" className="w-56 max-sm:w-48">
          <PopoverTitle>
            <span className="sm:hidden">Per dot</span>
            <span className="max-sm:hidden">Pick your price</span>
          </PopoverTitle>
          <div className="pt-3 sm:pt-4">
            <AmountWheel format={amountLabel} label="What per dot costs" onChange={onAmount} value={amount} values={[...POINT_PRICES.values]} />
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
