"use client";

import { useEffect, useMemo, useState } from "react";
import type { Candle } from "./market";

/**
 * The real market, when there is one to reach.
 *
 * `services/feed` holds a socket to Lighter and builds 500ms bars from
 * the trade stream, because Lighter's smallest candle is a minute and a round
 * here is sixty seconds. Point `NEXT_PUBLIC_FEED_URL` at it and Draw runs on
 * the venue; when unconfigured or unavailable, the UI waits for real data.
 *
 * WebSockets carry snapshots and incremental bars. Reconnects reseed history;
 * updates are batched once per browser frame, without delaying publication.
 */

export const CANDLE_MS = 500;
export const CANDLE_SECONDS = CANDLE_MS / 1000;

const URL_FEED = process.env.NEXT_PUBLIC_FEED_URL ?? "";

/** Whether this build has a market to connect to at all. */
export const hasFeed = URL_FEED !== "";

type Wire = { t: number; o: number; h: number; l: number; c: number; v: number };

/** The service counts seconds; the app's candles carry milliseconds. */
const toCandle = (b: Wire): Candle => ({ t: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });

/** The day, as Lighter reports it. */
export type FeedStats = { mark: number; changePct: number; high: number; low: number; volume: number };

export type FeedQuote = { bid: number; ask: number; mid: number; at: number };

export type Feed = {
  /** Oldest first. Empty until the seed lands. */
  bars: Candle[];
  /** The newest bar, including updates while its second is still forming. */
  latest: Candle | null;
  /** What the venue liquidates on, which is what P&L should be marked against. */
  stats: FeedStats | null;
  connected: boolean;
  /** Best bid and ask, which move between trades. The live price line follows its middle. */
  quote: FeedQuote | null;
  priceSource?: "trades" | "mark";
  network?: "mainnet" | "testnet";
};

/**
 * Null when no feed is configured. The app must not invent market data.
 */
export function useFeed(keep = 1200): Feed | null {
  const [bars, setBars] = useState<Candle[]>([]);
  const [stats, setStats] = useState<FeedStats | null>(null);
  const [connected, setConnected] = useState(false);
  const [quote, setQuote] = useState<FeedQuote | null>(null);
  const [network, setNetwork] = useState<"mainnet" | "testnet" | undefined>();
  const [priceSource, setPriceSource] = useState<"trades" | "mark">("trades");
  useEffect(() => {
    if (!hasFeed) return;
    const url = new URL(`${URL_FEED.replace(/\/$/, "")}/ws`);
    url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
    let socket: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let backoff = 500;
    let frame = 0;
    let pending = new Map<number, Candle>();
    let pendingQuote: FeedQuote | null = null;
    let heard = Date.now();
    const flush = () => {
      frame = 0;
      if (pendingQuote) {
        setQuote(pendingQuote);
        pendingQuote = null;
      }
      if (!pending.size) return;
      const updates = pending;
      pending = new Map();
      setBars((all) => {
        const merged = new Map(all.map((bar) => [bar.t, bar]));
        for (const [time, bar] of updates) merged.set(time, bar);
        return [...merged.values()].sort((a, b) => a.t - b.t).slice(-keep);
      });
    };
    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(url);
      socket = ws;
      heard = Date.now();
      heartbeat = setInterval(() => {
        if (Date.now() - heard > 35_000) {
          setConnected(false);
          ws.close();
        } else if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 5000);
      ws.addEventListener("message", (event) => {
        if (stopped || socket !== ws) return;
        let message: { event: string; data: unknown };
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message || typeof message.data !== "object" || message.data === null) return;
        heard = Date.now();
        if (message.event === "seed") {
          const data = message.data as { bars: Wire[]; stats: FeedStats | null; intervalMs: number; network?: "mainnet" | "testnet"; priceSource?: "trades" | "mark"; connected: boolean };
          if (!Array.isArray(data.bars)) return;
          if (data.intervalMs !== CANDLE_MS) { setConnected(false); ws.close(); return; }
          cancelAnimationFrame(frame);
          frame = 0;
          pending.clear();
          setBars(data.bars.map(toCandle).slice(-keep));
          setStats(data.stats);
          setNetwork(data.network);
          setPriceSource(data.priceSource === "mark" ? "mark" : "trades");
          setConnected(data.connected === true);
          const q = (data as { quote?: FeedQuote | null }).quote;
          if (q && Number.isFinite(q.mid)) setQuote(q);
          backoff = 500;
        } else if (message.event === "bar") {
          const bar = toCandle(message.data as Wire);
          if (![bar.t, bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite)) return;
          pending.set(bar.t, bar);
          // Background tabs may suspend animation frames for hours.
          if (pending.size > keep) {
            const oldest = Math.min(...pending.keys());
            pending.delete(oldest);
          }
          if (!frame) frame = requestAnimationFrame(flush);
        } else if (message.event === "quote") {
          const q = message.data as FeedQuote;
          if (!Number.isFinite(q.mid) || q.mid <= 0) return;
          pendingQuote = q;
          if (!frame) frame = requestAnimationFrame(flush);
        } else if (message.event === "stats") {
          setStats(message.data as FeedStats);
        } else if (message.event === "pong") {
          setConnected((message.data as { connected: boolean }).connected === true);
        }
      });
      ws.addEventListener("error", () => ws.close());
      ws.addEventListener("close", () => {
        if (stopped || socket !== ws) return;
        clearInterval(heartbeat);
        cancelAnimationFrame(frame);
        frame = 0;
        pending.clear();
        setConnected(false);
        retry = setTimeout(connect, backoff + Math.random() * 250);
        backoff = Math.min(15_000, backoff * 2);
      });
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      cancelAnimationFrame(frame);
      socket?.close();
    };
  }, [keep]);

  return useMemo(() => hasFeed
    ? { bars, latest: bars[bars.length - 1] ?? null, stats, connected, quote, priceSource, network }
    : null, [bars, stats, connected, quote, priceSource, network]);
}
