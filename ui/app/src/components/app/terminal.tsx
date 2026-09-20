"use client";

import { useMemo, useState } from "react";
import { useSettings } from "@/lib/settings";
import { accountFor, type Market, type Position } from "@/lib/market";
import type { Mode } from "@/lib/mode";
import { AppBar } from "./app-bar";
import { Desk } from "./desk";
import { DrawScreen, HISTORY, RUN_MAX } from "./draw/draw-screen";
import { useFeed } from "@/lib/feed";
import { emptyOrder, type Order } from "./ticket";

/**
 * Draw at the market's address, Desk one segment further in. The URL decides, not a toggle; the
 * full terminal stays a link away.
 */
export function Terminal({ market, positions, mode = "draw" }: { market: Market; positions: Position[]; mode?: Mode }) {
  const [{ blurred }] = useSettings();
  const [order, setOrder] = useState<Order>(emptyOrder);
  const patch = (next: Partial<Order>) => setOrder((c) => ({ ...c, ...next }));
  const account = useMemo(() => accountFor(positions), [positions]);
  /*
    One socket for the page.

    The app bar carries the market on a phone, where the row under it went to
    the chart, so the price has to reach both it and Draw. Opening the stream
    twice would be two connections to the same market saying the same thing.
  */
  const stream = useFeed(HISTORY + RUN_MAX);
  const live = useMemo<Market>(() => {
    const price = stream?.bars.at(-1)?.c;
    if (!price || !stream?.stats) return market;
    const s = stream.stats;
    return { ...market, price, change: (price * s.changePct) / 100, changePct: s.changePct, high24h: s.high, low24h: s.low, volume24h: s.volume };
  }, [market, stream]);

  return (
    <div className="flex h-svh flex-col bg-background" data-blurred={blurred ? "" : undefined}>
      <AppBar account={account} market={live} />
      <main className="flex min-h-0 w-full flex-1 flex-col overflow-auto bg-muted/40">
        {mode === "desk" ? (
          <Desk market={market} order={order} patch={patch} positions={positions} />
        ) : (
          <DrawScreen market={market} stream={stream} />
        )}
      </main>
    </div>
  );
}
