"use client";

import { useMemo } from "react";
import { useSettings } from "@/lib/settings";
import { type Market } from "@/lib/market";
import { useAccount } from "./auth";
import { AppBar } from "./app-bar";
import { DrawScreen, HISTORY, RUN_MAX } from "./draw/draw-screen";
import { useFeed } from "@/lib/feed";

/** One market's screen: the app bar over Draw, both fed by the same live stream. */
export function Terminal({ market }: { market: Market }) {
  const me = useAccount();
  const [{ blurred }] = useSettings();
  /*
    One socket for the page.

    The app bar carries the market on a phone, where the row under it went to
    the chart, so the price has to reach both it and Draw. Opening the stream
    twice would be two connections to the same market saying the same thing.
  */
  const stream = useFeed(HISTORY + RUN_MAX, market.symbol);
  /* The live market, handed to Draw so its own header and the label on the
     chart are the same number. */
  const live = useMemo<Market>(() => {
    const price = stream?.bars.at(-1)?.c;
    const s = stream?.stats;
    return {
      ...market,
      price: price ?? 0,
      change: s && price ? (price * s.changePct) / 100 : 0,
      changePct: s?.changePct ?? 0,
      high24h: s?.high ?? 0,
      low24h: s?.low ?? 0,
      volume24h: s?.volume ?? 0,
    };
  }, [market, stream]);

  return (
    <div className="flex h-svh flex-col bg-background" data-blurred={blurred ? "" : undefined}>
      <AppBar />
      <main className="flex min-h-0 w-full flex-1 flex-col overflow-auto bg-muted/40">
        <DrawScreen key={me.address ?? "signed-out"} market={live} stream={stream} />
      </main>
    </div>
  );
}
