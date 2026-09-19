"use client";

import { usd } from "@/lib/market";
import { cn } from "@/lib/utils";

/**
 * How hard, as a meter you can set. One notch per step, every notch the same
 * width, the scale written at each end and what you have picked between them.
 *
 * The lit run used to be stretched to half the track however few notches were
 * lit, so the figures under it would have room. That bought the room by lying
 * about the reading: at 10× of 50 the first six notches sat visibly wider than
 * the last six, and a meter whose divisions are uneven is not a meter. The
 * figures went under the track instead, where there is room for them anyway.
 */

/* Up to 50, because that is what the venue gives you. On a market that moves
   six dollars a second, ten times your money on a twenty-four second round is
   a rounding error — the leverage is what makes a drawn line worth drawing. */
export const DRAW_STEPS = [1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 40, 50];
/** Up to 100×, the notches a desk trader reaches for. */
export const DESK_STEPS = [1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 40, 50, 75, 100];

/** The step nearest a value, so a preset off the notches still lights one. */
export function nearestStep(steps: number[], value: number): number {
  return steps.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best), steps[0]);
}

export function LeverageMeter({
  steps,
  value,
  stake,
  onChange,
  className,
}: {
  steps: number[];
  value: number;
  stake: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  const n = steps.length;
  const idx = steps.indexOf(nearestStep(steps, value));
  const lit = idx + 1;
  const max = steps[n - 1];

  return (
    <div className={cn("flex w-full flex-col", className)}>
      <div
        aria-label="Leverage"
        aria-valuemax={max}
        aria-valuemin={steps[0]}
        aria-valuenow={value}
        aria-valuetext={`${value} times`}
        className="grid h-3 gap-1 rounded-full focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4"
        onKeyDown={(e) => {
          const by = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
          if (by === 0) return;
          e.preventDefault();
          onChange(steps[Math.min(n - 1, Math.max(0, idx + by))]);
        }}
        role="slider"
        style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}
        tabIndex={0}
      >
        {steps.map((s, i) => (
          <button
            aria-label={`${s} times`}
            className={cn("h-full cursor-pointer rounded-full transition-colors", i < lit ? "bg-primary" : "bg-input hover:bg-primary/30")}
            key={s}
            onClick={() => onChange(s)}
            tabIndex={-1}
            type="button"
          />
        ))}
      </div>
      {/* The two ends of the scale, and what you have picked between them.
          A lone "$16,000" used to float at the right with nothing saying it
          was the ceiling at full leverage. */}
      <div className="mt-2.5 flex items-baseline justify-between gap-2 text-muted-foreground text-xs">
        {/* An end that is where you are standing says it twice. */}
        <span className="figures shrink-0">{value === steps[0] ? "" : `${steps[0]}\u00d7`}</span>
        <span className="figures min-w-0 truncate font-medium text-foreground">
          {value}&times; <span className="text-muted-foreground">&middot;</span> ${usd(stake * value, 0)}
        </span>
        <span className="figures shrink-0">{value === max ? "" : `${max}\u00d7`}</span>
      </div>
    </div>
  );
}
