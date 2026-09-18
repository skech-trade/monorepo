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
    <div className="flex min-h-full flex-col bg-muted/40" data-blurred={blurred ? "" : undefined}>
      <AppBar account={account} blurred={blurred} mode={mode} onBlurred={setBlurred} onMode={setMode} />
      <main className="mx-auto w-full max-w-[120rem] flex-1 p-3">
        {mode === "desk" ? (
          <Desk market={market} order={order} patch={patch} positions={positions} />
        ) : (
          <DrawScreen market={market} />
        )}
      </main>
    </div>
  );
}
