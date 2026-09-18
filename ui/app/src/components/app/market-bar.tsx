"use client";

import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Card } from "@/components/ui/card";
import { compactUsd, price as fmtPrice, type Market, signedPct } from "@/lib/market";
import { cn } from "@/lib/utils";
import { MarketPicker, TokenAvatar } from "./market-header";

/** A label and a figure on one baseline. */
function Pair({ label, children, tone, className }: { label: string; children: ReactNode; tone?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-baseline gap-1.5 whitespace-nowrap", className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("figures", tone)}>{children}</span>
    </span>
  );
}

/** The market, and its day, on one line across the top of the desk. */
export function MarketBar({ market, className }: { market: Market; className?: string }) {
  const [picking, setPicking] = useState(false);
  const up = market.changePct >= 0;

  return (
    <Card className={cn("flex-row items-center gap-x-6 gap-y-2 px-3 py-2", className)} render={<header />}>
      <button
        aria-haspopup="dialog"
        className="-m-1 flex shrink-0 items-center gap-2.5 rounded-lg p-1 text-left hover:bg-accent"
        onClick={() => setPicking(true)}
        type="button"
      >
        <TokenAvatar className="size-7" symbol={market.symbol} />
        <span className="flex items-center gap-1 font-medium">
          {market.name}
          <span className="text-muted-foreground">{market.symbol}</span>
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </span>
      </button>

      <span className="flex items-baseline gap-2">
        <span className="figures font-semibold text-lg leading-none">${fmtPrice(market.price)}</span>
        <span className={cn("figures text-xs", up ? "text-up" : "text-down")}>{signedPct(market.changePct)}</span>
      </span>

      <div className="flex min-w-0 flex-wrap items-baseline gap-x-6 gap-y-1 text-xs">
        <Pair label="24h high">{fmtPrice(market.high24h)}</Pair>
        <Pair label="24h low">{fmtPrice(market.low24h)}</Pair>
        <Pair label="24h volume">{compactUsd(market.volume24h)}</Pair>
        <Pair className="hidden 2xl:inline-flex" label="Open interest">{compactUsd(market.openInterest)}</Pair>
        <Pair className="hidden 2xl:inline-flex" label="Funding" tone={market.funding >= 0 ? "text-up" : "text-down"}>
          {signedPct(market.funding * 100, 4)}
        </Pair>
      </div>

      <MarketPicker current={market} onOpenChange={setPicking} open={picking} />
    </Card>
  );
}
