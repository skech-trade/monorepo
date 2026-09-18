"use client";

import { useState } from "react";
import {
  type BookLevel,
  bookFor,
  price as fmtPrice,
  type Market,
  type Trade,
  tradesFor,
  usd,
} from "@/lib/market";
import { cn } from "@/lib/utils";
import { Pane, Segmented } from "./controls";

function Rows({
  levels,
  side,
  max,
  onPick,
}: {
  levels: BookLevel[];
  side: "bid" | "ask";
  max: number;
  onPick: (price: number) => void;
}) {
  return (
    <ul>
      {levels.map((l) => (
        <li key={l.price}>
          <button
            className="relative flex h-6 w-full items-center justify-between gap-2 px-3 text-xs hover:bg-accent"
            onClick={() => onPick(l.price)}
            type="button"
          >
            <span
              aria-hidden="true"
              className={cn("absolute inset-y-0 right-0", side === "bid" ? "bg-success/10" : "bg-destructive/10")}
              style={{ width: `${(l.total / max) * 100}%` }}
            />
            <span className={cn("figures relative", side === "bid" ? "text-up" : "text-down")}>{fmtPrice(l.price)}</span>
            <span className="figures relative text-muted-foreground">{usd(l.size, 3)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Tape({ trades }: { trades: Trade[] }) {
  return (
    <ul>
      {trades.map((t) => (
        <li className="flex h-6 items-center justify-between gap-2 px-3 text-xs" key={t.id}>
          <span className={cn("figures", t.side === "buy" ? "text-up" : "text-down")}>{fmtPrice(t.price)}</span>
          <span className="figures text-muted-foreground">{usd(t.size, 3)}</span>
          <span className="figures text-muted-foreground">
            {new Date(t.t).toLocaleTimeString(undefined, { hour: "2-digit", hour12: false, minute: "2-digit", second: "2-digit" })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function OrderBook({
  market,
  onPickPrice,
  collapsed,
  onCollapsed,
  className,
}: {
  market: Market;
  onPickPrice: (price: number) => void;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  className?: string;
}) {
  const [tab, setTab] = useState<"book" | "tape">("book");
  const { asks, bids, spread } = bookFor(market, 18);
  const trades = tradesFor(market);
  const max = Math.max(asks.at(-1)?.total ?? 0, bids.at(-1)?.total ?? 0);

  return (
    <Pane
      bodyClassName="flex min-h-0 flex-col"
      className={cn("min-h-0", className)}
      collapsed={collapsed}
      direction="column"
      header={
        <Segmented
          className="w-full"
          grow
          label="Book or tape"
          onChange={setTab}
          options={[{ value: "book", label: "Book" }, { value: "tape", label: "Trades" }]}
          size="sm"
          value={tab}
        />
      }
      label="Order book and recent trades"
      onCollapsed={onCollapsed}
      title="Book"
    >
      <div className="flex items-baseline justify-between px-3 pb-1 text-muted-foreground text-xs">
        <span>Price</span>
        <span>Size</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "book" ? (
          <>
            <Rows levels={[...asks].reverse()} max={max} onPick={onPickPrice} side="ask" />
            <div className="my-1 flex h-8 items-center justify-between gap-2 border-y px-3">
              <span className="figures font-medium">${fmtPrice(market.price)}</span>
              <span className="figures text-muted-foreground text-xs">{fmtPrice(spread)} spread</span>
            </div>
            <Rows levels={bids} max={max} onPick={onPickPrice} side="bid" />
          </>
        ) : (
          <Tape trades={trades} />
        )}
      </div>
    </Pane>
  );
}
