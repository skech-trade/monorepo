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
import { EthereumMark } from "./marks";
import { Pill } from "./controls";
import { NetworkBadge } from "./network-badge";

/** The token's mark. Bitcoin's and Ether's own; a monogram for anything we have no art for. */
export function TokenAvatar({ symbol, className }: { symbol: string; className?: string }) {
  if (symbol === "BTC") return <BitcoinMark className={cn("size-9 shrink-0", className)} />;
  if (symbol === "ETH") return <EthereumMark className={cn("size-9 shrink-0", className)} />;
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
    The one on screen carries the live price; a listing on its own has none.
    The picker once listed a stale $64,180 under a header reading $81,133,
    which is the app disagreeing with itself in two places a thumb apart.
  */
  const markets = LISTED.map(marketFor)
    .filter((m): m is Market => m !== null)
    .map((m) => (m.address === current.address ? current : m));
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Markets</DialogTitle>
          <DialogDescription>Bitcoin and Ethereum, both on Lighter.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput aria-label="Search markets" disabled placeholder="Search. Bitcoin and Ethereum, for now" type="search" />
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
                    aria-current={here ? "page" : undefined}
                    aria-label={`Open ${m.name}`}
                    className="absolute inset-0 rounded-lg"
                    nativeButton={false}
                    render={<Link href={`/app/${m.address}`} />}
                  />
                  <TokenAvatar symbol={m.symbol} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{m.name}</p>
                    <CopyAddress address={m.address} />
                  </div>
                  <div className="text-right">
                    <p className="figures">{m.price > 0 ? `$${fmtPrice(m.price)}` : "—"}</p>
                    <p className={cn("figures text-xs", m.changePct >= 0 ? "text-up" : "text-down")}>
                      {m.price > 0 ? signedPct(m.changePct) : "—"}
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
/**
 * `fixed`: one market and nothing to switch to, and no venue to name: the
 * practice game, on Binance's price. The same heading without the button,
 * the chevron, the picker or the network badge.
 */
export function MarketHeader({ market, className, fixed = false }: { market: Market; className?: string; fixed?: boolean }) {
  const [picking, setPicking] = useState(false);
  const up = market.changePct >= 0;
  if (fixed)
    return (
      <div className={cn("flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 max-sm:h-10 max-sm:border max-sm:border-input max-sm:bg-card/85 max-sm:px-3 max-sm:backdrop-blur-sm sm:gap-3", className)}>
        <TokenAvatar className="size-6 sm:size-9" symbol={market.symbol} />
        <span className="flex min-w-0 items-center gap-2 sm:flex-col sm:items-start sm:gap-1.5">
          <span className="truncate font-medium text-sm leading-5 max-sm:hidden">{market.name}</span>
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="figures truncate font-semibold text-base leading-6 tracking-tight sm:text-xl">{market.price > 0 ? `$${fmtPrice(market.price)}` : "Connecting…"}</span>
            <Pill className="shrink-0 max-sm:hidden" tone={up ? "up" : "down"}>
              <span className="figures">{market.price > 0 ? signedPct(market.changePct) : "—"}</span>
            </Pill>
          </span>
        </span>
      </div>
    );
  return (
    <div className={cn("flex min-w-0 items-center", className)}>
      {/*
        Our own button, and on a phone it wears the same coat as everything
        else floating over that chart: outline, card behind it, blurred. Bare
        text and a chevron over a drawing reads as a caption, not a control.
        On a desk it is the heading of a panel, so the ghost variant leaves it
        plain until a pointer is on it.
      */}
      <Button
        aria-haspopup="dialog"
        className="h-auto min-w-0 max-w-full justify-start gap-2 rounded-lg px-2 py-2 text-left max-sm:h-10 max-sm:border max-sm:border-input max-sm:bg-card/85 max-sm:px-3 max-sm:backdrop-blur-sm sm:h-auto sm:gap-3"
        onClick={() => setPicking(true)}
        variant="ghost"
      >
        {/* Stacked and large where there is room; one quiet line on a phone. */}
        <TokenAvatar className="size-6 sm:size-9" symbol={market.symbol} />
        {/* Everything here can shrink. In the app bar on a phone this sits
            between the logo and the way in, and a price that refuses to give
            ground pushes both off the screen. */}
        <span className="flex min-w-0 items-center gap-2 sm:flex-col sm:items-start sm:gap-1.5">
          {/*
            The name and the chevron that opens on it, on a desk only.

            Hidden as a pair rather than one at a time: an empty span still
            takes a gap from the row it is in, so the mark and the price sat
            two gaps apart while everything after them sat one.

            The mark says which market on a phone, and the price is the number
            somebody is here for, so the name is what gives up the room rather
            than both of them ending in an ellipsis.
          */}
          <span className="flex min-w-0 items-center gap-1 font-medium text-sm leading-5 max-sm:hidden">
            <span className="truncate">{market.name}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </span>
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="figures truncate font-semibold text-base leading-6 tracking-tight sm:text-xl">{market.price > 0 ? `$${fmtPrice(market.price)}` : "Connecting…"}</span>
            {/* The day's move is the first thing to go when the row has to
                hold the controls as well. The price is the number a round is
                judged against; this one is context. */}
            <Pill className="shrink-0 max-sm:hidden" tone={up ? "up" : "down"}>
              <span className="figures">{market.price > 0 ? signedPct(market.changePct) : "—"}</span>
            </Pill>
            {/* Which venue this price is from, said where it means something.
                On a phone this pill is the whole of the app bar's middle, and
                the badge beside it in the bar left no room to centre it. */}
            <NetworkBadge className="sm:hidden" compact />
            <ChevronDownIcon className="size-3.5 shrink-0 self-center text-muted-foreground sm:hidden" />
          </span>
        </span>
      </Button>
      <MarketPicker current={market} onOpenChange={setPicking} open={picking} />
    </div>
  );
}
