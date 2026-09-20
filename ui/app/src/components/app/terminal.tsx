"use client";

import { useMemo, useState } from "react";
import { accountFor, type Market, type Position } from "@/lib/market";
import type { Mode } from "@/lib/mode";
import { AppBar } from "./app-bar";
import { Desk } from "./desk";
import { DrawScreen } from "./draw/draw-screen";
import { emptyOrder, type Order } from "./ticket";

/**
 * Draw at the market's address, Desk one segment further in. The URL decides, not a toggle; the
 * full terminal stays a link away.
 */
export function Terminal({ market, positions, mode = "draw" }: { market: Market; positions: Position[]; mode?: Mode }) {
  const [blurred, setBlurred] = useState(false);
  const [order, setOrder] = useState<Order>(emptyOrder);
  const patch = (next: Partial<Order>) => setOrder((c) => ({ ...c, ...next }));
  const account = useMemo(() => accountFor(positions), [positions]);

  return (
    <div className="flex h-svh flex-col bg-background" data-blurred={blurred ? "" : undefined}>
      <AppBar account={account} blurred={blurred} onBlurred={setBlurred} />
      <main className="flex min-h-0 w-full flex-1 flex-col overflow-auto bg-muted/40">
        {mode === "desk" ? (
          <Desk market={market} order={order} patch={patch} positions={positions} />
        ) : (
          <DrawScreen market={market} />
        )}
      </main>
    </div>
  );
}
