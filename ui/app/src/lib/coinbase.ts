"use client";

import { useEffect, useState } from "react";
import type { Bar } from "@skech/core/dots";

/**
 * Bitcoin as the game is priced and judged on: Coinbase BTC-USD, trade by trade.
 *
 * The chances are measured on Coinbase's own trades, folded into one-second
 * bars (`packages/core/scripts/fetch-coinbase.ts`), so the game is played on
 * the same market, folded the same way: the last ten minutes of trades to
 * start, then every trade into the bar of its second.
 *
 * Direct from the browser: Coinbase's public feed and REST API both allow it.
 * The feed sends a heartbeat every second, so a stream that goes quiet
 * without closing is caught and reopened rather than left showing a stale
 * price.
 */

const REST = "https://api.exchange.coinbase.com/products";
const STREAM = "wss://ws-feed.exchange.coinbase.com";
const KEEP_BARS = 660;
const KEEP_TICKS = 4000;
const SEED_MS = 600_000;
/** No message at all for this long (heartbeats included) and the socket is reopened. */
const SILENT_MS = 5000;

export type Tick = { t: number; p: number };
export type Market = {
  /** One-second bars, oldest first; the last is still forming. Times in ms, Coinbase's clock. */
  bars: Bar[];
  /** Every trade of the last minute or so, for drawing the line smoothly. */
  ticks: Tick[];
  /** Coinbase's clock minus this one's. */
  skew: number;
  connected: boolean;
  /** Bumped on every trade batch, so a page can react without copying arrays. */
  version: number;
};

type Trade = { trade_id: number; price: string; time: string };
type Message = { type?: string; trade_id?: number; price?: string; time?: string };

export function useCoinbase(product = "BTC-USD"): Market {
  const [version, setVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  // One mutable store for the life of the page: trades arrive faster than React should re-render, and arrays this long are not copied per trade.
  const [m] = useState<Market>(() => ({ bars: [], ticks: [], skew: 0, connected: false, version: 0 }));

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let late: ReturnType<typeof setTimeout> | undefined;
    let backoff = 500;
    let heard = 0;
    /** The newest trade folded in, so a reconnect's replayed trade is not counted twice. */
    let lastId = 0;
    /*
      Tell the page on the next frame, at most twenty times a second (every
      50 ms), so the price shown moves with each trade as it lands. A browser
      stops giving frames to a hidden or covered window, so if no frame comes
      within a quarter second a timer tells it instead; the chart itself reads
      the trades straight from this store, so it moves every frame regardless.
    */
    let told = 0;
    const bump = () => {
      if (frame || late) return;
      const tell = () => {
        cancelAnimationFrame(frame);
        clearTimeout(late);
        frame = 0;
        late = undefined;
        told = performance.now();
        m.version++;
        setVersion(m.version);
      };
      const wait = Math.max(0, 50 - (performance.now() - told));
      if (wait > 0) late = setTimeout(tell, wait);
      else {
        frame = requestAnimationFrame(tell);
        late = setTimeout(tell, 250);
      }
    };
    const fold = (t: number, p: number) => {
      const sec = Math.floor(t / 1000) * 1000;
      const last = m.bars[m.bars.length - 1];
      // A trade that arrives after its second was closed by the clock still belongs to it.
      const own = last && sec <= last.t ? m.bars.findLast((b) => b.t === sec) : undefined;
      if (own) {
        own.h = Math.max(own.h, p);
        own.l = Math.min(own.l, p);
        if (own === last) own.c = p;
      } else if (!last || sec > last.t) {
        // Seconds with no trade still pass: carry the price through them, so a gap is flat rather than missing.
        if (last) for (let s = last.t + 1000; s < sec; s += 1000) m.bars.push({ t: s, h: last.c, l: last.c, c: last.c });
        m.bars.push({ t: sec, h: p, l: p, c: p });
        if (m.bars.length > KEEP_BARS) m.bars.splice(0, m.bars.length - KEEP_BARS);
      }
      m.ticks.push({ t, p });
      if (m.ticks.length > KEEP_TICKS) m.ticks.splice(0, m.ticks.length - KEEP_TICKS);
    };

    /*
      The last ten minutes, from the public trades, a thousand at a time
      going back. Folded oldest first into bars before any live trade, and
      only the part older than the first live trade, so nothing is counted twice.
    */
    const seed = async () => {
      const trades: Trade[] = [];
      let after: number | undefined;
      for (let pageNo = 0; pageNo < 12 && !stopped; pageNo++) {
        const res = await fetch(`${REST}/${product}/trades?limit=1000${after ? `&after=${after}` : ""}`).catch(() => null);
        if (!res?.ok) break;
        const page = (await res.json()) as Trade[];
        if (!page.length) break;
        trades.push(...page);
        after = page[page.length - 1].trade_id;
        if (Date.now() - Date.parse(page[page.length - 1].time) > SEED_MS) break;
      }
      if (stopped || !trades.length) return;
      const firstLive = m.ticks[0]?.t ?? Number.POSITIVE_INFINITY;
      const live = { bars: m.bars, ticks: m.ticks };
      m.bars = [];
      m.ticks = [];
      for (const x of trades.reverse()) {
        const t = Date.parse(x.time);
        if (t < firstLive && t > Date.now() - SEED_MS) fold(t, Number(x.price));
      }
      // The live trades go back on top, in order.
      const seeded = m.bars;
      const from = live.bars[0]?.t ?? Number.POSITIVE_INFINITY;
      const joined = [...seeded.filter((b) => b.t < from), ...live.bars];
      // Seconds with no trade between the history and the first live trade still passed.
      const bars: Bar[] = [];
      for (const b of joined) {
        const prev = bars[bars.length - 1];
        if (prev) for (let s = prev.t + 1000; s < b.t; s += 1000) bars.push({ t: s, h: prev.c, l: prev.c, c: prev.c });
        bars.push(b);
      }
      m.bars = bars.slice(-KEEP_BARS);
      m.ticks = [...m.ticks, ...live.ticks].slice(-KEEP_TICKS);
      bump();
    };

    const connect = () => {
      if (stopped) return;
      const sock = new WebSocket(STREAM);
      ws = sock;
      heard = Date.now();
      sock.onopen = () => {
        sock.send(JSON.stringify({ type: "subscribe", product_ids: [product], channels: ["matches", "heartbeat"] }));
        backoff = 500;
        m.connected = true;
        setConnected(true);
        if (!m.bars.length) void seed();
      };
      sock.onmessage = (e) => {
        heard = Date.now();
        let msg: Message;
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (msg.type !== "match" && msg.type !== "last_match") return;
        const id = Number(msg.trade_id);
        if (id && id <= lastId) return;
        const t = Date.parse(String(msg.time));
        const p = Number(msg.price);
        if (!Number.isFinite(t) || !(p > 0)) return;
        if (id) lastId = id;
        // A trade has just happened: Coinbase's clock is its time, give or take the trip here.
        const sample = t + 40 - Date.now();
        m.skew = m.skew === 0 ? sample : m.skew * 0.98 + sample * 0.02;
        fold(t, p);
        bump();
      };
      sock.onclose = () => {
        if (ws === sock) {
          m.connected = false;
          setConnected(false);
        }
        if (stopped || ws !== sock) return;
        retry = setTimeout(connect, backoff);
        backoff = Math.min(10_000, backoff * 2);
      };
      sock.onerror = () => sock.close();
    };
    connect();
    /*
      A second with no trade in it still passes, and ink whose window ended in
      one is still missed. Once a second is 600 ms old with nothing in it, it
      is closed at the last price, so a quiet market judges on time. The
      margin is for trades that arrive late: they still land in their own second.
    */
    const clock = setInterval(() => {
      // Silent without closing: reopen, rather than show a price that has stopped.
      if (ws && ws.readyState === WebSocket.OPEN && Date.now() - heard > SILENT_MS) {
        const dead = ws;
        ws = null;
        dead.onclose = null;
        dead.close();
        m.connected = false;
        setConnected(false);
        connect();
      }
      const last = m.bars[m.bars.length - 1];
      if (!last || !m.connected) return;
      const now = Date.now() + m.skew;
      let added = false;
      for (let s = last.t + 1000; s + 600 <= now; s += 1000) {
        m.bars.push({ t: s, h: last.c, l: last.c, c: last.c });
        added = true;
      }
      if (added) {
        if (m.bars.length > KEEP_BARS) m.bars.splice(0, m.bars.length - KEEP_BARS);
        bump();
      }
    }, 200);
    return () => {
      clearInterval(clock);
      stopped = true;
      clearTimeout(retry);
      clearTimeout(late);
      cancelAnimationFrame(frame);
      // Closing a socket still connecting logs a warning; it closes as soon as it opens instead.
      if (ws?.readyState === WebSocket.CONNECTING) {
        const opening = ws;
        opening.onopen = () => opening.close();
        opening.onmessage = null;
        opening.onclose = null;
      } else ws?.close();
    };
  }, [product, m]);

  return { bars: m.bars, ticks: m.ticks, skew: m.skew, connected, version };
}
