"use client";

import { usd } from "@/lib/market";
import { cn } from "@/lib/utils";

/**
 * How hard, as a meter you can set. One notch per step, and under the lit
 * run what the multiple does to the money: "$100, 12×, $1,200", with the
 * ceiling at the far end. The lit run never takes less than half the track,
 * so the figures under it always have room.
 */

/** 1× to 15×, one notch each. Draw's range. */
export const DRAW_STEPS = Array.from({ length: 15 }, (_, i) => i + 1);
/** Up to 100×, the notches a desk trader reaches for. */
export const DESK_STEPS = [1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 40, 50, 75, 100];

const MIN_LIT = 0.5;

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
  const unlit = n - lit;
  const litRun = Math.max(lit / n, MIN_LIT);
  const columns = unlit === 0 ? `repeat(${n}, 1fr)` : `repeat(${lit}, ${litRun / lit}fr) repeat(${unlit}, ${(1 - litRun) / unlit}fr)`;
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
        style={{ gridTemplateColumns: columns }}
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
      <div className="mt-2.5 flex items-baseline gap-3 text-xs">
        <div className="flex min-w-0 items-baseline gap-2" style={{ width: `calc(${(litRun - 0.5 / n) * 100}% + 1.6rem)` }}>
          <span className="figures shrink-0 text-muted-foreground">${usd(stake, 0)}</span>
          <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-1 self-center text-muted-foreground/60">
            <span className="h-px min-w-0 flex-1 bg-current" />
            <span className="figures shrink-0 font-medium text-[11px] text-foreground leading-none">{value}×</span>
            <span className="h-px min-w-0 flex-1 bg-current" />
          </span>
          <span className="figures shrink-0 font-semibold text-foreground text-sm">${usd(stake * value, 0)}</span>
        </div>
        {value < max ? <span className="figures ml-auto shrink-0 text-muted-foreground">${usd(stake * max, 0)}</span> : null}
      </div>
    </div>
  );
}
