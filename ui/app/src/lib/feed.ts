"use client";

import { useEffect, useState } from "react";
import type { Candle } from "./market";

/**
 * The real market, when there is one to reach.
 *
 * `services/feed` holds a socket to Lighter and builds one-second bars from
 * the trade stream, because Lighter's smallest candle is a minute and a round
 * here is sixty seconds. Point `NEXT_PUBLIC_FEED_URL` at it and Draw runs on
 * Bitcoin; leave it unset and Draw runs on the simulation, which is what
 * every screenshot and every test still uses.
 *
 * Server-sent events rather than a socket: the browser only listens, and
 * EventSource reconnects on its own.
 */

const URL_FEED = process.env.NEXT_PUBLIC_FEED_URL ?? "";

/** Whether this build has a market to connect to at all. */
export const hasFeed = URL_FEED !== "";

type Wire = { t: number; o: number; h: number; l: number; c: number; v: number };

/** The service counts seconds; the app's candles carry milliseconds. */
const toCandle = (b: Wire): Candle => ({ t: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });

/** The day, as Lighter reports it. */
export type FeedStats = { mark: number; changePct: number; high: number; low: number; volume: number };

export type Feed = {
  /** Oldest first. Empty until the seed lands. */
  bars: Candle[];
  /** The newest bar, or null before the seed. Identity changes only when a new second closes. */
  latest: Candle | null;
  /** What the venue liquidates on, which is what P&L should be marked against. */
  stats: FeedStats | null;
  connected: boolean;
};

/**
 * Null when this build has no feed configured, so a caller can fall back to
 * the simulation without asking twice.
 */
export function useFeed(keep = 600): Feed | null {
  const [bars, setBars] = useState<Candle[]>([]);
  const [stats, setStats] = useState<FeedStats | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!hasFeed) return;
    const room = keep;
    const source = new EventSource(`${URL_FEED.replace(/\/$/, "")}/stream`);
    const onSeed = (e: MessageEvent) => {
      const { bars: seed, stats: s } = JSON.parse(e.data) as { bars: Wire[]; stats: FeedStats | null };
      setBars(seed.map(toCandle));
      if (s) setStats(s);
      setConnected(true);
    };
    const onBar = (e: MessageEvent) => {
      const bar = toCandle(JSON.parse(e.data) as Wire);
      setBars((all) => {
        // The service can resend the open bar as it fills in; replace rather
        // than append, so a second never appears twice.
        const at = all.findIndex((b) => b.t === bar.t);
        const next = at === -1 ? [...all, bar] : [...all.slice(0, at), bar, ...all.slice(at + 1)];
        return next.length > room ? next.slice(-room) : next;
      });
    };
    const onStats = (e: MessageEvent) => setStats(JSON.parse(e.data) as FeedStats);
    source.addEventListener("seed", onSeed);
    source.addEventListener("bar", onBar);
    source.addEventListener("stats", onStats);
    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));
    return () => source.close();
  }, [keep]);

  if (!hasFeed) return null;
  return { bars, latest: bars[bars.length - 1] ?? null, stats, connected };
}
