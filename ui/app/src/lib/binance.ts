"use client";

import { useEffect, useState } from "react";
import type { Bar } from "@skech/core/dots";

/**
 * Bitcoin as Line is priced and judged on: Binance BTCUSDT, trade by trade.
 *
 * The board's chances were measured on Binance's one-second klines, so the
 * game is played on the same market: the last ten minutes of one-second bars
 * to start, then every trade folded into the bar of its second. A square is
 * hit when any trade inside its two seconds lands in its band, which is the
 * very thing the table counted. Lighter's own trades were tried and are too
 * sparse for it: over half its half-second bars had no trade in them.
 *
 * Direct from the browser, because Binance's public stream allows it. Some
 * countries cannot reach binance.com; before real money this goes through
 * the feed service instead.
 */

const REST = "https://api.binance.com/api/v3/klines";
const STREAM = "wss://stream.binance.com:9443/ws";
const KEEP_BARS = 660;
const KEEP_TICKS = 4000;

export type Tick = { t: number; p: number };
export type Market = {
  /** One-second bars, oldest first; the last is still forming. Times in ms, Binance's clock. */
  bars: Bar[];
  /** Every trade of the last minute or so, for drawing the line smoothly. */
  ticks: Tick[];
  /** Binance's clock minus this one's. */
  skew: number;
  connected: boolean;
  /** Bumped on every trade batch, so a page can react without copying arrays. */
  version: number;
};

type Kline = [number, string, string, string, string];

export function useBinance(symbol = "BTCUSDT"): Market {
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
    /*
      Tell the page on the next frame. A browser stops giving frames to a
      hidden or covered window, and the page would stop too: no new bars,
      nothing judged, a stale price. So if no frame comes within a quarter
      second, a timer tells it instead.
    */
    /*
      At most ten times a second. Every tell re-renders the page around the
      chart, and at one a frame that was most of a phone's time between
      frames; the chart itself reads the trades straight from this store, so
      it moves every frame whatever this does.
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
      const wait = Math.max(0, 100 - (performance.now() - told));
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
        // Seconds with no trade still pass: carry the price through them, as a kline does not, so a gap is flat rather than missing.
        if (last) for (let s = last.t + 1000; s < sec; s += 1000) m.bars.push({ t: s, h: last.c, l: last.c, c: last.c });
        m.bars.push({ t: sec, h: p, l: p, c: p });
        if (m.bars.length > KEEP_BARS) m.bars.splice(0, m.bars.length - KEEP_BARS);
      }
      m.ticks.push({ t, p });
      if (m.ticks.length > KEEP_TICKS) m.ticks.splice(0, m.ticks.length - KEEP_TICKS);
    };

    const seed = async () => {
      const res = await fetch(`${REST}?symbol=${symbol}&interval=1s&limit=${KEEP_BARS - 60}`).catch(() => null);
      const rows = res?.ok ? ((await res.json()) as Kline[]) : [];
      if (stopped || !rows.length) return;
      const seeded = rows.map(([t, , h, l, c]) => ({ t, h: +h, l: +l, c: +c }));
      // Trades that arrived while the seed was on its way stay; the seed only fills what came before them.
      const first = m.bars[0]?.t ?? Number.POSITIVE_INFINITY;
      m.bars = [...seeded.filter((b) => b.t < first), ...m.bars];
      bump();
    };

    const connect = () => {
      if (stopped) return;
      const sock = new WebSocket(`${STREAM}/${symbol.toLowerCase()}@aggTrade`);
      ws = sock;
      sock.onopen = () => {
        backoff = 500;
        m.connected = true;
        setConnected(true);
        void seed();
      };
      sock.onmessage = (e) => {
        let msg: { T?: number; p?: string };
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        const t = Number(msg.T);
        const p = Number(msg.p);
        if (!Number.isFinite(t) || !(p > 0)) return;
        // A trade has just happened: Binance's clock is its time, give or take the trip here.
        const sample = t + 80 - Date.now();
        m.skew = m.skew === 0 ? sample : m.skew * 0.98 + sample * 0.02;
        fold(t, p);
        bump();
      };
      sock.onclose = () => {
        m.connected = false;
        setConnected(false);
        if (stopped) return;
        retry = setTimeout(connect, backoff);
        backoff = Math.min(10_000, backoff * 2);
      };
      sock.onerror = () => sock.close();
    };
    connect();
    /*
      A second with no trade in it still passes, and a square whose window
      ended in one is still missed. Once a second is 600 ms old with nothing
      in it, it is closed at the last price, so a quiet market judges on time.
      The margin is for trades that arrive late: they still land in their own
      second, above.
    */
    const clock = setInterval(() => {
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
      ws?.close();
    };
  }, [symbol, m]);

  return { bars: m.bars, ticks: m.ticks, skew: m.skew, connected, version };
}
