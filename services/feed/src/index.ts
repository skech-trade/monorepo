/**
 * The feed: real Bitcoin, a bar a second.
 *
 * Lighter's smallest candle is a minute and Draw runs on seconds, so this
 * holds one socket to the venue, builds the bars itself, and hands them to
 * browsers over server-sent events. The app used to walk a random number
 * generator; every figure it was teaching you was read off a market nobody
 * had ever traded.
 *
 * One socket to Lighter however many people are watching, because the venue
 * counts connections per IP and there is no reason for more than one.
 */

import type { Bar } from "./bars";
import { LighterFeed, type Stats } from "./lighter";

const PORT = Number(process.env.PORT ?? 3210);
const URL_LIGHTER = process.env.LIGHTER_WS ?? "wss://mainnet.zklighter.elliot.ai/stream";
const MARKET_ID = Number(process.env.LIGHTER_MARKET_ID ?? 1);
/** Ten minutes of seconds: more than any round, and small enough to keep in memory. */
const KEEP = 600;

type Client = { send: (event: string, data: unknown) => void; close: () => void };
const clients = new Set<Client>();

function broadcast(event: string, data: unknown) {
  for (const c of clients) {
    try {
      c.send(event, data);
    } catch {
      clients.delete(c);
    }
  }
}

const feed = new LighterFeed({
  url: URL_LIGHTER,
  marketId: MARKET_ID,
  keep: KEEP,
  onBar: (bar: Bar) => broadcast("bar", bar),
  onStats: (stats: Stats) => broadcast("stats", stats),
});
feed.start();

/** The browser's origin, so the app can read this in development. */
const cors = {
  "access-control-allow-origin": process.env.ALLOW_ORIGIN ?? "*",
  "access-control-allow-headers": "content-type",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/health") {
      const head = feed.bars.open;
      return json({
        ok: head !== undefined,
        bars: feed.bars.all().length,
        newest: head?.t ?? null,
        mark: feed.stats?.mark ?? null,
        watching: clients.size,
        market: MARKET_ID,
      });
    }

    // The seed the chart opens on, plus where the venue marks it.
    if (url.pathname === "/bars") {
      const n = Math.min(KEEP, Math.max(1, Number(url.searchParams.get("n") ?? 90)));
      return json({ bars: feed.bars.last(n), stats: feed.stats });
    }

    /*
      Server-sent events rather than a socket. The browser only listens, the
      stream is one way, and EventSource reconnects on its own, which is a
      reconnect loop nobody has to write.
    */
    if (url.pathname === "/stream") {
      let client: Client;
      const body = new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder();
          const write = (s: string) => {
            try {
              ctrl.enqueue(enc.encode(s));
            } catch {
              clients.delete(client);
            }
          };
          client = {
            send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            close: () => ctrl.close(),
          };
          clients.add(client);
          // Open on what is already known, so a late joiner draws a full chart.
          client.send("seed", { bars: feed.bars.last(90), stats: feed.stats });
          // A comment every twenty seconds, so proxies do not call it idle.
          const beat = setInterval(() => write(": beat\n\n"), 20_000);
          req.signal.addEventListener("abort", () => {
            clearInterval(beat);
            clients.delete(client);
            try {
              ctrl.close();
            } catch {
              // Already gone.
            }
          });
        },
        cancel() {
          clients.delete(client);
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...cors },
      });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`feed on :${PORT}, market ${MARKET_ID}, from ${URL_LIGHTER}`);
