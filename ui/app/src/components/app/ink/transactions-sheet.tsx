"use client";

import { ArrowUpRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { NETWORK } from "@/lib/chain";
import type { ActivityMsg, Incoming } from "@/lib/relayer";
import { cn } from "@/lib/utils";
import { useChain } from "./chain-context";

/** How often the count is asked for while the sheet is open: it climbs as they play. */
const EVERY_MS = 3_000;

/** A player's transactions on Monad, as the relayer counts them from the game's logs; asked for while `on`. */
export function useActivity(on: boolean): ActivityMsg | null {
  const chain = useChain();
  const [a, setA] = useState<ActivityMsg | null>(null);
  useEffect(() => {
    if (!on || !chain.player) return;
    let alive = true;
    const ask = async () => {
      const m = await chain.client.request({ type: "activity" }, (x: Incoming): x is ActivityMsg => x.type === "activity", 8_000);
      if (alive && m) setA(m);
    };
    void ask();
    const timer = setInterval(() => void ask(), EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [on, chain.client, chain.player]);
  return a && chain.player && a.player?.toLowerCase() === chain.player.toLowerCase() ? a : null;
}

/**
 * How hard they have played Monad: every transaction their play went out in,
 * counted from the chain's own logs, and the latest of them to look up. A
 * bottom sheet on a phone, a side panel on a desk.
 */
export function TransactionsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const a = useActivity(open);
  const n = (v: number | undefined) => (v ?? 0).toLocaleString("en-US");
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="sm:max-w-md" side="right" variant="inset">
        <SheetHeader className="px-5 pt-6 sm:px-6 sm:pt-8">
          <SheetTitle className="font-bold text-xl">Your transactions</SheetTitle>
          <SheetDescription>Every piece you draw goes on {NETWORK.label}.</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-3.5 px-5 pb-10 sm:px-6">
          <div className="flex flex-col gap-1 rounded-[18px] bg-muted px-4 pt-4 pb-4">
            <span className="text-[13px] text-muted-foreground">You spammed Monad with</span>
            <span className={cn("figures font-bold text-[44px] leading-none tracking-[-0.02em]", !a && "animate-pulse text-muted-foreground")} key={a?.txs}>
              {a ? n(a.txs) : "–"}
            </span>
            <span className="font-medium text-[15px]">{a?.txs === 1 ? "transaction" : "transactions"}</span>
            {a?.counting ? <span className="figures mt-1 text-[13px] text-muted-foreground">Still counting your history · {Math.round(a.progress * 100)}%</span> : null}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Pieces placed" value={a ? n(a.pieces) : "–"} />
            <Stat label="Deposits" value={a ? n(a.deposits) : "–"} />
            <Stat label="Withdrawals" value={a ? n(a.withdrawals) : "–"} />
          </div>
          {a?.recent.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="px-1 text-[13px] text-muted-foreground">Latest</span>
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-[18px] bg-muted">
                {a.recent.map((hash) => (
                  <li key={hash}>
                    <a className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-foreground/5" href={`${NETWORK.explorer}/tx/${hash}`} rel="noopener noreferrer" target="_blank">
                      <span className="figures truncate">{`${hash.slice(0, 10)}…${hash.slice(-8)}`}</span>
                      <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="px-1 text-[13px] text-muted-foreground">Counted once per transaction your play was in, read from the game&rsquo;s logs on chain.</p>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[14px] bg-muted px-3 py-2.5">
      <span className="text-[12px] text-muted-foreground leading-tight">{label}</span>
      <span className="figures font-semibold text-[17px]">{value}</span>
    </div>
  );
}
