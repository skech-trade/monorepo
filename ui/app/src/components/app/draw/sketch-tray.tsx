"use client";

import { CANDLE_SECONDS } from "@/lib/feed";

import { Button } from "@/components/ui/button";
import type { BoostTag } from "@/lib/boost";
import { type Market, price as fmtPrice, signedUsd } from "@/lib/market";
import type { Quote, Shape } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import type { Phase } from "./sketch-canvas";
import type { Sketch } from "./sketches";

/** The bar along the foot of the chart: invite, quote, playing out, done. It never covers the plot. */

/**
 * What is left of what you put in, as a battery, with the line where a Wild
 * round ends drawn on it. `mine` is already your share of the round.
 */
function BoostBattery({ tag, mine }: { tag: BoostTag; mine: number | null }) {
  const left = tag.stake + (mine ?? 0);
  const share = Math.max(0, left / tag.stake);
  const floor = 1 - tag.closeAt / tag.stake;
  const tone = share > 1 ? "bg-up" : share <= floor + 0.05 ? "bg-down" : share < 0.5 ? "bg-warning" : "bg-info";
  return (
    <span className="flex min-w-48 flex-1 flex-col gap-1 sm:max-w-80">
      <span className="flex items-baseline justify-between gap-2 text-sm">
        <F tone={share > 1 ? "text-up" : share <= floor + 0.05 ? "text-down" : undefined}>{mine === null ? "…" : `$${fmtUsd(Math.max(0, left))}`}</F>
        <span className="text-muted-foreground">
          / <F>${fmtUsd(tag.stake)}</F>
        </span>
      </span>
      <span aria-label={`${Math.round(share * 100)}% of what you put in is left. The round ends at ${Math.round(floor * 100)}%.`} className="relative h-2.5 overflow-visible rounded-full bg-input" role="img">
        <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 motion-reduce:transition-none", tone)} style={{ width: `${Math.min(100, share * 100)}%` }} />
        <span className="-inset-y-1 absolute w-0.5 rounded-full bg-foreground/70" style={{ left: `${floor * 100}%` }} title="The round ends here" />
      </span>
    </span>
  );
}

const fmtUsd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A figure inside a sentence. */
function F({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={cn("figures text-foreground", tone)}>{children}</span>;
}

export function SketchBar({
  market,
  phase,
  shape,
  quote,
  openCount,
  runCount,
  live,
  runBars,
  sketches,
  onOpenList,
  phone,
  onVenue,
  venueAccount,
  venueProblem,
  boost,
}: {
  market: Market;
  phase: Phase;
  shape: Shape | null;
  quote: Quote | null;
  openCount: number;
  runCount: number;
  /** The round's P&L as it moves, and the open trade's. Ticks with the price. */
  live?: { net: number | null; open: { dir: 1 | -1; pnl: number } | null; trades: number };
  runBars: number;
  sketches: Sketch[];
  onOpenList: () => void;
  /** Whether a real position is behind this round, and what went wrong if not. */
  /** A phone shows this row only when it has something to say. */
  phone?: boolean;
  onVenue?: boolean;
  /** The account it landed on, when that is not the reader's own. */
  venueAccount?: number | null;
  venueProblem?: string | null;
  /** The running or last round's Boost terms and result, when skech's money was in it. */
  boost?: BoostTag | null;
}) {
  /* On a phone this sits in the action row instead, where the thumb is. */
  const lines = phone ? null : (
    <Button onClick={onOpenList} variant="outline">
      Rounds <span className="figures text-muted-foreground">{openCount}</span>
    </Button>
  );

  /*
    Nothing to say yet, on the screen with the least room to say it.

    The chart itself reads "click to place your points" where the points go,
    which is the same instruction closer to the hand that follows it. So on a
    phone this row is not drawn at all until there is a figure or a result in
    it, and the bottom of the screen is one row of controls rather than two.
  */
  if (phone && (phase === "live" || phase === "drawing")) return null;

  if (phase === "live" || phase === "drawing") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        {/* The instruction survives on a phone; the reassurance after it takes
            three lines of a small screen to say what the button already says
            by not having been pressed. */}
        <p className="mr-auto text-muted-foreground">
          <span className="font-medium text-foreground">Draw where you think {market.name} goes.</span>{" "}
          <span className="hidden sm:inline">Click on the right of the chart to place points, or drag to draw. Nothing&rsquo;s at stake until you press the button.</span>
        </p>
        {lines}
      </div>
    );
  }

  if (phase === "drawn" && shape && quote) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Target <F>${fmtPrice(shape.target)}</F> · <F>{Math.round(runBars * CANDLE_SECONDS)}</F>s. Execution and P&L come from Lighter.
        </p>
        {lines}
      </div>
    );
  }

  if (phase === "running" && shape) {
    /*
      Almost nothing while it plays: every figure is already on the plot. What is left is how far
      through it is.
    */
    const left = Math.max(0, Math.ceil((runBars - runCount) * CANDLE_SECONDS));
    const tone = (n: number) => (Math.abs(n) < 0.005 ? "text-muted-foreground" : n > 0 ? "text-up" : "text-down");
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {/* Boosted: what is yours is the number worth watching, and how close the round is to closing itself. */}
        {live && boost ? <BoostBattery mine={live.net} tag={boost} /> : null}
        {/* The number somebody is watching, big and moving with the price. */}
        {live ? (
          <span aria-live="off" className="flex items-baseline gap-2">
            <span className={cn("figures font-semibold text-2xl tabular-nums leading-none", live.net === null ? "text-muted-foreground" : tone(live.net))}>
              {live.net === null ? "—" : signedUsd(live.net)}
            </span>
            {live.open ? (
              <span className="text-muted-foreground text-sm">
                {live.open.dir > 0 ? "Long" : "Short"} <F tone={tone(live.open.pnl)}>{signedUsd(live.open.pnl)}</F>
              </span>
            ) : null}
            <span className="text-muted-foreground text-sm">
              · <F>{live.trades}</F> {live.trades === 1 ? "trade" : "trades"}
            </span>
          </span>
        ) : null}
        <span className="mr-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 animate-pulse rounded-full bg-info" />
            <F>{left}</F>s left
          </span>
          {/* Whether there is money behind this. A round that did not reach
              the venue has to say so: the chart looks identical either way. */}
          {/* And if the orders ever land on an account other than the one
              whose balance is in the header, the round says so rather than
              claiming them as yours. */}
          {onVenue && venueAccount === null ? <span className="text-up">{boost ? "Wild, on the venue" : "On the venue"}</span> : null}
          {onVenue && venueAccount !== null ? (
            <span className="text-warning">
              On shared account <F>{venueAccount}</F>, not yours
            </span>
          ) : null}
          {venueProblem ? <span className="text-down">{venueProblem}</span> : null}
        </span>
        {lines}
      </div>
    );
  }

  if (phase === "settled") {
    const recent = sketches.filter((s) => s.right !== undefined).slice(0, 8).reverse();
    /* The result lives in the Rounds sheet; what stays here is the trend across rounds and the way back. */
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {boost?.settlement ? (
          <span className="mr-auto">
            <F tone={boost.settlement.back >= boost.stake ? "text-up" : "text-down"}>{signedUsd(boost.settlement.back - boost.stake)}</F>
          </span>
        ) : boost ? (
          <span className="mr-auto text-muted-foreground">{boost.problem ?? "Settling…"}</span>
        ) : (
          <span className="mr-auto text-muted-foreground">That one&rsquo;s done. It&rsquo;s in Rounds, with the replay. Start a new trade when you&rsquo;re ready.</span>
        )}
        {/* Your last rounds, as bars. A trend, not a coin flip. */}
        {recent.length > 1 ? (
          <span aria-label="Your recent rounds" className="flex h-6 items-end gap-0.5" title="How much of each move you called, last rounds">
            {recent.map((s) => (
              <span
                className={cn("w-1.5 rounded-sm", (s.right ?? 0) >= 0.7 ? "bg-success" : (s.right ?? 0) >= 0.5 ? "bg-primary/60" : "bg-input")}
                key={s.id}
                style={{ height: `${Math.max(15, (s.right ?? 0) * 100)}%` }}
              />
            ))}
          </span>
        ) : null}
        {lines}
      </div>
    );
  }
  return null;
}
