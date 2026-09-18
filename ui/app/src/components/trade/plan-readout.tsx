"use client";

import { Undo2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { price as fmtPrice, usd } from "./market";
import { fmtT, type Plan } from "./trace";

/**
 * What the drawing became.
 *
 * The one piece of writing that has to earn Draw its name. A reader has just
 * drawn a shape; this tells them, in the fewest words that are still true, that
 * the shape is now three positions, what each of them costs, and what a trader
 * would call the thing they drew.
 *
 * It sits on the chart rather than beside it, because the chart is the whole
 * screen in this mode and a panel under it would be a panel the chart has to
 * pay for. Glass, like the study labels, so the candles stay visible through it.
 *
 * Order of the figures is the order of the questions: how many trades, how much
 * money, which way first. Fees last, because it is the one people forget and
 * the one that decides whether trading eight small legs was ever worth it.
 */

/** One leg, small enough that four fit on a line. */
function LegChip({
  id,
  dir,
  from,
  to,
  at,
}: {
  id: number;
  dir: 1 | -1;
  from: number;
  to: number;
  at: number;
}) {
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-fg-subtle">{id}</span>
      <span className={cn("font-medium", dir > 0 ? "text-up" : "text-down")}>
        {dir > 0 ? "Long" : "Short"}
      </span>
      <span className="figures text-fg-muted">
        {fmtPrice(from)} → {fmtPrice(to)}
      </span>
      <span className="text-fg-subtle">at {fmtT(at)}</span>
    </span>
  );
}

export function PlanReadout({
  plan,
  leverage,
  onUndo,
  onClear,
  className,
}: {
  plan: Plan;
  leverage: number;
  onUndo: () => void;
  onClear: () => void;
  className?: string;
}) {
  const drawn = plan.spine.length > 0;
  const shown = plan.legs.slice(0, 4);

  return (
    <div
      className={cn(
        "glass pointer-events-auto flex max-w-[min(46rem,calc(100%-1rem))] flex-col gap-2 rounded-3xl px-4 py-3 shadow-card",
        className,
      )}
    >
      {drawn ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-semibold text-[0.9375rem] tracking-[-0.012em]">
              {plan.legs.length === 0
                ? "Nothing to trade"
                : `${plan.legs.length} position${plan.legs.length === 1 ? "" : "s"}`}
            </span>
            {plan.legs.length ? (
              <span className="text-caption text-fg-muted">
                <span className="figures">${usd(plan.notional, 0)}</span> each,
                which is <span className="figures">${usd(plan.notional / leverage, 0)}</span>{" "}
                of yours at <span className="figures">{leverage}×</span>
              </span>
            ) : null}
            {plan.legs.length ? (
              <span className="text-caption text-fg-subtle">
                fees about <span className="figures">${usd(plan.fees)}</span>
              </span>
            ) : null}
          </div>

          {shown.length ? (
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-kicker">
              {shown.map((leg) => (
                <LegChip
                  at={leg.t0}
                  dir={leg.dir}
                  from={leg.p0}
                  id={leg.id}
                  key={leg.id}
                  to={leg.p1}
                />
              ))}
              {plan.legs.length > shown.length ? (
                <span className="text-fg-subtle">
                  and {plan.legs.length - shown.length} more
                </span>
              ) : null}
            </div>
          ) : null}

          {/* One sentence, the first one. Naming the shape is the payoff; a
              list of every pattern it might also be is a lecture. */}
          {plan.shapes[0] ? (
            <p className="text-caption text-fg-muted">{plan.shapes[0]}</p>
          ) : null}
          {plan.warnings[0] ? (
            <p className="text-kicker text-warning">{plan.warnings[0]}</p>
          ) : null}
        </>
      ) : (
        <p className="text-caption text-fg-muted">
          Draw the price where you think it is going. Up is a long, down is a
          short, and lifting the pen sits that stretch out.
        </p>
      )}

      {drawn ? (
        <div className="-mb-1 -ml-2 flex items-center gap-1">
          <Button onClick={onUndo} size="sm" variant="ghost">
            <Undo2Icon />
            Undo
          </Button>
          <Button onClick={onClear} size="sm" variant="ghost">
            <XIcon />
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}
