"use client";

import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  type Account,
  compactUsd,
  price as fmtPrice,
  type Market,
  signedPct,
  signedUsd,
  usd,
} from "@/lib/market";
import { cn } from "@/lib/utils";
import { FoldButton } from "./controls";
import { MarketPicker, TokenAvatar } from "./market-header";

/**
 * One strip across the top of the desk: the market on the left, its day and
 * your account as a single row of small figures. The way a terminal does it,
 * not a row of tiles.
 */

function Item({ label, children, tone, className }: { label: string; children: ReactNode; tone?: string; className?: string }) {
  return (
    <div className={cn("flex shrink-0 flex-col gap-0.5 leading-none", className)}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn("figures text-[13px]", tone)}>{children}</span>
    </div>
  );
}

function healthTone(h: number): { tone: string; word: string; dot: string } {
  if (h >= 2) return { tone: "text-up", word: "healthy", dot: "bg-success" };
  if (h >= 1.25) return { tone: "", word: "steady", dot: "bg-primary" };
  if (h >= 1.1) return { tone: "text-warning-foreground", word: "tight", dot: "bg-warning" };
  return { tone: "text-down", word: "at risk", dot: "bg-destructive" };
}

export function MarketBar({
  market,
  account,
  collapsed,
  onCollapsed,
  className,
}: {
  market: Market;
  account: Account;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  className?: string;
}) {
  const [picking, setPicking] = useState(false);
  const up = market.changePct >= 0;
  const open = Number.isFinite(account.health);
  const h = healthTone(account.health);

  return (
    <Card className={cn("flex-row items-center gap-5 px-3 py-2", className)} render={<header />}>
      <button
        aria-haspopup="dialog"
        className="-m-1 flex shrink-0 items-center gap-2.5 rounded-lg p-1 text-left hover:bg-accent"
        onClick={() => setPicking(true)}
        type="button"
      >
        <TokenAvatar className="size-8" symbol={market.symbol} />
        <span className="flex items-center gap-1 font-medium">
          {market.name}
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </span>
      </button>

      <span className="figures font-semibold text-lg leading-none">${fmtPrice(market.price)}</span>
      <Item label="24h change" tone={up ? "text-up" : "text-down"}>
        {signedPct(market.changePct)}
      </Item>

      {collapsed ? null : (
        <>
          <Item label="24h high">{fmtPrice(market.high24h)}</Item>
          <Item label="24h low">{fmtPrice(market.low24h)}</Item>
          <Item label="24h volume">{compactUsd(market.volume24h)}</Item>
          <Item className="hidden 2xl:flex" label="Open interest">{compactUsd(market.openInterest)}</Item>
          <Item className="hidden 2xl:flex" label="Funding / h" tone={market.funding >= 0 ? "text-up" : "text-down"}>
            {signedPct(market.funding * 100, 4)}
          </Item>

          <Separator className="h-7" orientation="vertical" />

          <Item label="Equity">${usd(account.equity)}</Item>
          <Item label="Unrealised" tone={account.unrealised >= 0 ? "text-up" : "text-down"}>
            {signedUsd(account.unrealised)}
          </Item>
          <Item className="hidden 2xl:flex" label="Margin used">${usd(account.used)}</Item>
          <Item className="hidden 2xl:flex" label="Free">${usd(account.free)}</Item>
          <Item label="Health" tone={open ? h.tone : "text-muted-foreground"}>
            {open ? (
              <span className="inline-flex items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", h.dot)} />
                {usd(account.health, 1)}× {h.word}
              </span>
            ) : (
              "no positions"
            )}
          </Item>
        </>
      )}

      <FoldButton className="ml-auto shrink-0" collapsed={collapsed} onCollapsed={onCollapsed} title="the day and account figures" />
      <MarketPicker current={market} onOpenChange={setPicking} open={picking} />
    </Card>
  );
}
