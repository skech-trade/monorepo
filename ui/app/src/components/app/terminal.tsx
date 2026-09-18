"use client";

import { useMemo, useState } from "react";
import { accountFor, type Market, type Position } from "@/lib/market";
import type { Mode } from "@/lib/mode";
import { AppBar } from "./app-bar";
import { Desk } from "./desk";
import { DrawScreen } from "./draw/draw-screen";
import { emptyOrder, type Order } from "./ticket";

/** The screen. Draw by default; Desk when you ask for it. */
export function Terminal({ market, positions }: { market: Market; positions: Position[] }) {
  const [mode, setMode] = useState<Mode>("draw");
  const [blurred, setBlurred] = useState(false);
  const [order, setOrder] = useState<Order>(emptyOrder);
  const patch = (next: Partial<Order>) => setOrder((c) => ({ ...c, ...next }));
  const account = useMemo(() => accountFor(positions), [positions]);

  return (
    <div className="flex h-svh flex-col bg-background" data-blurred={blurred ? "" : undefined}>
      <AppBar account={account} blurred={blurred} mode={mode} onBlurred={setBlurred} onMode={setMode} />
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
