/**
 * The feed: real Bitcoin and Ethereum, a bar every half second.
 *
 * Lighter's smallest candle is a minute and Draw runs on seconds, so this
 * holds one socket to the venue per market, builds the bars itself, and hands
 * them to browsers over WebSockets (with SSE retained for older clients). The
 * app used to walk a random number generator; every figure it was teaching you
 * was read off a market nobody had ever traded.
 *
 * One socket to Lighter per market however many people are watching, because
 * the venue counts connections per IP and there is no reason for more.
 */

import type { ServerWebSocket } from "bun";
import { type Bar, CANDLE_MS } from "./bars";
import { LighterFeed, type Quote, type Stats } from "./lighter";
import { MARKETS, marketOf, perMarket, SYMBOLS, type Symbol } from "./markets";

const PORT = Number(process.env.PORT ?? 3210);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN;
// Public chart data is independent of the wallet’s execution network.
const NETWORK = "mainnet";
const URL_LIGHTER = `wss://${NETWORK}.zklighter.elliot.ai/stream?readonly=true`;
/** Ten minutes of seconds: more than any round, and small enough to keep in memory. */
const KEEP = 1200;
const PRICE_SOURCE = "trades";
/** How far a socket may fall behind before it is told to reconnect for a fresh snapshot. */
const BACKPRESSURE = 256 * 1024;

/** An SSE listener, handed frames already written out. */
type Client = { write: (frame: string) => void };
type Watch = { market: Symbol };
/** Who watches which market, so a bar of Ethereum never reaches a Bitcoin chart. */
const clients = perMarket(() => new Set<Client>());
const sockets = perMarket(() => new Set<ServerWebSocket<Watch>>());

const sse = (event: string, json: string) => `event: ${event}\ndata: ${json}\n\n`;

function broadcast(market: Symbol, event: string, data: unknown) {
  // Serialised once for everyone: this runs on every trade message, for every watcher.
  const json = JSON.stringify(data);
  const payload = `{"event":${JSON.stringify(event)},"data":${json}}`;
  for (const ws of sockets[market]) {
    if (ws.getBufferedAmount() > BACKPRESSURE) {
      ws.close(1013, "Reconnect for a fresh snapshot");
      sockets[market].delete(ws);
    } else ws.send(payload);
  }
  if (clients[market].size === 0) return;
  const frame = sse(event, json);
  for (const c of clients[market]) c.write(frame);
}

/** One upstream socket per market: each has its own trades, book and silence to watch. */
function feedFor(market: Symbol) {
  let latestQuote: Quote | null = null;
  let quoteTimer: ReturnType<typeof setTimeout> | null = null;
  const feed = new LighterFeed({
    url: URL_LIGHTER,
    marketId: MARKETS[market],
    keep: KEEP,
    priceSource: PRICE_SOURCE,
    onBar: (bar: Bar) => broadcast(market, "bar", bar),
    onStats: (stats: Stats) => broadcast(market, "stats", stats),
    onQuote: (quote: Quote) => {
      // The book moves more often than anyone can see; twenty a second is plenty.
      latestQuote = quote;
      if (quoteTimer) return;
      quoteTimer = setTimeout(() => {
        quoteTimer = null;
        if (latestQuote) broadcast(market, "quote", latestQuote);
      }, 50);
    },
  });
  feed.start();
  return feed;
}
const feeds = perMarket(feedFor);

/** The last `n` bars and the day's figures: what `/bars` answers and what a seed opens with. */
const snapshot = (market: Symbol, n: number) => {
  const feed = feeds[market];
  return { market, bars: feed.bars.last(n), stats: feed.stats, network: NETWORK, priceSource: PRICE_SOURCE, intervalMs: CANDLE_MS };
};
const seed = (market: Symbol) => {
  const feed = feeds[market];
  return { ...snapshot(market, 180), connected: feed.connected, quote: feed.quote };
};

/** The browser's origin, so the app can read this in development. */
const cors = {
  "access-control-allow-origin": ALLOW_ORIGIN ?? "*",
  "access-control-allow-headers": "content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

const encoder = new TextEncoder();

Bun.serve<Watch>({
  port: PORT,
  idleTimeout: 0,
  websocket: {
    idleTimeout: 60,
    maxPayloadLength: 1024,
    backpressureLimit: BACKPRESSURE,
    closeOnBackpressureLimit: true,
    open(ws) {
      sockets[ws.data.market].add(ws);
      ws.send(JSON.stringify({ event: "seed", data: seed(ws.data.market) }));
    },
    message(ws, message) {
      const feed = feeds[ws.data.market];
      if (String(message) !== "ping") return;
      ws.send(JSON.stringify({ event: "pong", data: { connected: feed.connected, quote: feed.quote } }));
    },
    close(ws) {
      sockets[ws.data.market].delete(ws);
    },
  },
  fetch(req, server) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const market = marketOf(url.searchParams.get("market"));
    if (!market) return json({ error: "skech lists BTC and ETH" }, 400);
    const feed = feeds[market];

    if (url.pathname === "/ws") {
      const origin = req.headers.get("origin");
      if (ALLOW_ORIGIN && ALLOW_ORIGIN !== "*" && origin && origin !== ALLOW_ORIGIN) return json({ error: "origin not allowed" }, 403);
      if (server.upgrade(req, { data: { market } })) return;
      return json({ error: "WebSocket upgrade required" }, 426);
    }

    if (url.pathname === "/health") {
      const head = feed.bars.open;
      return json({
        ok: head !== undefined,
        bars: feed.bars.all().length,
        newest: head?.t ?? null,
        mark: feed.stats?.mark ?? null,
        watching: clients[market].size + sockets[market].size,
        websocketClients: sockets[market].size,
        upstreamConnected: feed.connected,
        market,
        marketId: MARKETS[market],
        markets: perMarket((m) => ({ connected: feeds[m].connected, mark: feeds[m].stats?.mark ?? null })),
        network: NETWORK,
        priceSource: PRICE_SOURCE,
        intervalMs: CANDLE_MS,
      });
    }

    // The seed the chart opens on, plus where the venue marks it.
    if (url.pathname === "/bars") {
      const n = Math.min(KEEP, Math.max(1, Number(url.searchParams.get("n") ?? 180)));
      return json(snapshot(market, n));
    }

    /*
      Server-sent events rather than a socket. The browser only listens, the
      stream is one way, and EventSource reconnects on its own, which is a
      reconnect loop nobody has to write.
    */
    if (url.pathname === "/stream") {
      let client: Client;
      let beat: ReturnType<typeof setInterval> | undefined;
      // Either end can go first; both have to let go of the listener and its heartbeat.
      const leave = () => {
        clearInterval(beat);
        clients[market].delete(client);
      };
      const body = new ReadableStream({
        start(ctrl) {
          client = {
            write: (frame) => {
              try {
                ctrl.enqueue(encoder.encode(frame));
              } catch {
                leave();
              }
            },
          };
          clients[market].add(client);
          // Open on what is already known, so a late joiner draws a full chart.
          client.write(sse("seed", JSON.stringify(seed(market))));
          // A comment every twenty seconds, so proxies do not call it idle.
          beat = setInterval(() => client.write(": beat\n\n"), 20_000);
          req.signal.addEventListener("abort", () => {
            leave();
            try {
              ctrl.close();
            } catch {
              // Already gone.
            }
          });
        },
        cancel: leave,
      });
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
          connection: "keep-alive",
          ...cors,
        },
      });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`feed on :${PORT}, markets ${SYMBOLS.map((s) => `${s} ${MARKETS[s]}`).join(", ")}, from ${URL_LIGHTER}`);
