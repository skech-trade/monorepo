"use client";

import { CheckIcon, ChevronDownIcon, CopyIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  price as fmtPrice,
  LISTED,
  type Market,
  marketFor,
  shortAddress,
  signedPct,
} from "@/lib/market";
import { cn } from "@/lib/utils";
import { BitcoinMark } from "./bitcoin-mark";
import { Pill } from "./controls";

/** The token's mark. Bitcoin's own; a monogram for anything we have no art for. */
export function TokenAvatar({ symbol, className }: { symbol: string; className?: string }) {
  if (symbol === "BTC") return <BitcoinMark className={cn("size-9 shrink-0", className)} />;
  return (
    <Avatar className={cn("size-9 rounded-full", className)}>
      <AvatarFallback className="font-semibold text-xs">{symbol.slice(0, 3)}</AvatarFallback>
    </Avatar>
  );
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      aria-label={`Copy ${address}`}
      className="relative -ml-1.5 text-muted-foreground"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          // Blocked clipboard. The address is on screen.
        }
      }}
      size="xs"
      variant="ghost"
    >
      <span className="figures">{shortAddress(address)}</span>
      {copied ? <CheckIcon className="text-up" /> : <CopyIcon />}
    </Button>
  );
}

export function MarketPicker({
  open,
  onOpenChange,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: Market;
}) {
  /*
    The one on screen carries the live price; the mock's own figure is about a
    market that is no longer there. The picker listed $64,180 under a header
    reading $81,133, which is the app disagreeing with itself in two places a
    thumb apart.
  */
  const markets = LISTED.map(marketFor)
    .filter((m): m is Market => m !== null)
    .map((m) => (m.address === current.address ? current : m));
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Markets</DialogTitle>
          <DialogDescription>One listed today. The list is the shape it keeps at two hundred.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput aria-label="Search markets" disabled placeholder="Search. Bitcoin only, for now" type="search" />
          </InputGroup>
          <ul className="-mx-2 flex flex-col">
            {markets.map((m) => {
              const here = m.address === current.address;
              return (
                <li
                  className={cn(
                    "relative flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent",
                    here && "bg-muted",
                  )}
                  key={m.address}
                >
                  <DialogClose
                    aria-label={`Open ${m.name}`}
                    className="absolute inset-0 rounded-lg"
                    nativeButton={false}
                    render={<Link href={`/app/${m.address}`} />}
                  />
                  <TokenAvatar symbol={m.symbol} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-medium">
                      {m.name}
                      {here ? <Pill>Open</Pill> : null}
                    </p>
                    <CopyAddress address={m.address} />
                  </div>
                  <div className="text-right">
                    <p className="figures">${fmtPrice(m.price)}</p>
                    <p className={cn("figures text-xs", m.changePct >= 0 ? "text-up" : "text-down")}>
                      {signedPct(m.changePct)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** Which market and what it costs, at the top of the Draw chart. The left
    half is the button that opens the picker. */
export function MarketHeader({ market, className }: { market: Market; className?: string }) {
  const [picking, setPicking] = useState(false);
  const up = market.changePct >= 0;
  return (
    <div className={cn("flex items-center", className)}>
      <button
        aria-haspopup="dialog"
        /* A button on a phone, where it sits in a row of them; a plain
           heading on a desk, where it is the title of the panel. */
        className="flex min-w-0 items-center gap-2 rounded-full border px-3 text-left max-sm:h-11 sm:-m-1.5 sm:gap-3 sm:rounded-lg sm:border-0 sm:p-1.5 sm:hover:bg-accent"
        onClick={() => setPicking(true)}
        type="button"
      >
        {/* Stacked and large where there is room; one quiet line on a phone. */}
        <TokenAvatar className="size-6 sm:size-9" symbol={market.symbol} />
        {/* Everything here can shrink. In the app bar on a phone this sits
            between the logo and the way in, and a price that refuses to give
            ground pushes both off the screen. */}
        <span className="flex min-w-0 items-baseline gap-2 sm:block">
          <span className="flex min-w-0 items-center gap-1 font-medium text-sm leading-none sm:text-base">
            {/* The mark says which market on a phone, and the price is the
                number somebody is here for, so the name gives up the room
                rather than both of them ending in an ellipsis. */}
            <span className="truncate max-sm:hidden">{market.name}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </span>
          <span className="flex min-w-0 items-baseline gap-2 sm:mt-1">
            <span className="figures truncate font-semibold text-base sm:text-xl">${fmtPrice(market.price)}</span>
            {/* The day's move is the first thing to go when the row has to
                hold the controls as well. The price is the number a round is
                judged against; this one is context. */}
            <Pill className="max-sm:hidden" tone={up ? "up" : "down"}>
              <span className="figures">{signedPct(market.changePct)}</span>
            </Pill>
          </span>
        </span>
      </button>
      <MarketPicker current={market} onOpenChange={setPicking} open={picking} />
    </div>
  );
}
