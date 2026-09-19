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
  label = "Leverage",
  className,
}: {
  steps: number[];
  value: number;
  stake: number;
  onChange: (value: number) => void;
  /** What this multiple is called on this screen. */
  label?: string;
  className?: string;
}) {
  const n = steps.length;
  const idx = steps.indexOf(nearestStep(steps, value));
  const max = steps[n - 1];
  /*
    Filled in proportion to the multiple, not to the notch.

    One notch per step lit six of twelve at 10x of 50 — half the track for a
    fifth of the leverage, because the steps are not evenly spaced and the bar
    was counting them rather than measuring them. A meter that reads "half" at
    a fifth is worse than no meter. The fill is value/max, the notches are
    ticks sitting at their own place along it, and 10x of 50 looks like 10x of
    50.
  */
  const at = (v: number) => (v / max) * 100;

  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const want = ((e.clientX - r.left) / Math.max(1, r.width)) * max;
    onChange(nearestStep(steps, want));
  };

  return (
    <div className={cn("flex w-full flex-col", className)}>
      {/* biome-ignore lint/a11y/useSemanticElements: a slider with its own ticks */}
      <div
        aria-label={label}
        aria-valuemax={max}
        aria-valuemin={steps[0]}
        aria-valuenow={value}
        aria-valuetext={`${value} times`}
        className="relative h-3 w-full cursor-pointer touch-none rounded-full bg-input focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4"
        onKeyDown={(e) => {
          const by = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
          if (by === 0) return;
          e.preventDefault();
          onChange(steps[Math.min(n - 1, Math.max(0, idx + by))]);
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pick(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) pick(e);
        }}
        role="slider"
        tabIndex={0}
      >
        <div className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-150" style={{ width: `${at(value)}%` }} />
        {/*
          A handle, because this is a thing you drag.

          It was a row of dots along the track, which is a picture of a scale
          and not a control: nothing about it said grab here, and the dots sat
          at the steps rather than at the reading. The handle sits where the
          fill ends, and the little shove of half its own width keeps it inside
          the track at either end instead of hanging off.

          Background rather than white, because the fill is near-black in the
          light theme and near-white in the dark one, and only a handle that
          flips with the page stays visible on both.
        */}
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-3 inset-y-0">
          <span
            className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 block size-6 rounded-full bg-background shadow-sm ring-1 ring-border"
            style={{ left: `${at(value)}%` }}
          />
        </span>
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
