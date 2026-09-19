"use client";

import { CheckIcon, Share2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { type Market, price as fmtPrice, signedUsd, usd } from "@/lib/market";
import { verdictWord } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import type { Phase } from "./sketch-canvas";
import { type Result, shareText, VERDICT } from "./sketch-tray";
import { type Sketch, SketchThumb } from "./sketches";

/**
 * How it went, once it is over.
 *
 * The result used to be a sentence along the foot of the chart, sharing a row
 * with the controls for the next line — and a finish is the one moment nothing
 * else is happening and the one thing worth stopping for. So it stops for it.
 *
 * Laid out the way the desk lays out a position: the figure that matters set
 * large and on its own, everything else a labelled row on a hairline, figures
 * right-aligned in the tabular face.
 */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="figures text-sm">{children}</span>
    </div>
  );
}

export function SettleDialog({
  market,
  phase,
  result,
  sketch,
  stake,
  onDrawAgain,
}: {
  market: Market;
  phase: Phase;
  result: Result | null;
  sketch: Sketch | null;
  stake: number;
  onDrawAgain: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Opens itself the moment the round ends, the way the ticket opens itself
  // when a line is finished. Adjusting state during render rather than in an
  // effect, so nothing shows the wrong thing for a frame.
  const [seen, setSeen] = useState(phase);
  if (seen !== phase) {
    setSeen(phase);
    if (phase === "settled") setOpen(true);
  }

  if (!result) return null;
  const won = result.net >= 0;
  const word = verdictWord(result.outcome, result.right, result.net);
  const pct = Math.round(result.right * 100);
  const back = stake > 0 ? result.net / stake : 0;
  const text = shareText(market, result);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {sketch ? <SketchThumb className="h-8 w-14 shrink-0" sketch={sketch} /> : null}
            <span className={cn(pct >= 70 ? "text-up" : pct >= 50 ? "text-foreground" : "text-down")}>{word}</span>
          </DialogTitle>
          <DialogDescription>
            {VERDICT[result.outcome]} &middot; {market.name} {result.long ? "up" : "down"}
          </DialogDescription>
        </DialogHeader>

        {/* The one figure worth reading from across the room. */}
        <p className="flex items-baseline gap-2 pt-2">
          <span className={cn("figures font-semibold text-3xl leading-none tracking-tight", won ? "text-up" : "text-down")}>{signedUsd(result.net)}</span>
          <span className="figures text-muted-foreground text-sm">
            {back >= 0 ? "up" : "down"} {Math.abs(Math.round(back * 100))}% on ${usd(stake, 0)}
          </span>
        </p>

        <div className="mt-4 divide-y border-y">
          <Row label="You were right">{pct}% of the way</Row>
          <Row label="In at">${fmtPrice(result.entry)}</Row>
          <Row label="Out at">${fmtPrice(result.exit)}</Row>
        </div>

        {/*
          Every minute of the round, green where it paid.

          One bar per candle, each taking an equal share of the width, so a
          round of any length fits and reads at a glance. It was a row of
          monospace glyphs that ran off the end of the dialog and finished in
          an ellipsis — the shape of the round, cropped.
        */}
        <div aria-label={`${pct}% of the move went your way`} className="mt-4 flex h-5 gap-px overflow-hidden rounded-sm">
          {result.flags.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional
            <span className={cn("min-w-px flex-1", f ? "bg-up/70" : "bg-down/55")} key={i} />
          ))}
        </div>
        <p className="pt-1.5 text-muted-foreground text-xs">Each minute of the round, green where it paid.</p>

        <DialogFooter className="pt-5">
          <DialogClose
            render={
              <Button
                onClick={() => {
                  setOpen(false);
                  onDrawAgain();
                }}
                variant="outline"
              />
            }
          >
            New trade
          </DialogClose>
          <Button
            onClick={async () => {
              try {
                if (typeof navigator.share === "function") {
                  await navigator.share({ text });
                  return;
                }
                await navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              } catch {
                // Dismissed or blocked.
              }
            }}
          >
            {copied ? <CheckIcon /> : <Share2Icon />}
            {copied ? "Copied" : "Show your call"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
