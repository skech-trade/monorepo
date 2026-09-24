/**
 * The trader.
 *
 * Holds the key, turns a drawn round into orders, and is the only thing that
 * books money. Rounds have to close themselves when the clock runs out even
 * if the tab is gone, which is why this is a server and not the browser.
 *
 * A round trades the drawer's own Lighter account, with a key they registered
 * (see `execs`), and its line is compiled into positions here, by the same
 * code the browser uses, so the client cannot lie about what it drew.
 */

import type { Pt } from "@skech/core/shape";
import { Accounts, Executor, type Quote } from "./executor";
import { asNum, brief, Lighter, type MarketInfo } from "./lighter";
import { Keys } from "./keys";
import { RoundStore } from "./round-store";
import { Rounds, type RoundSpec } from "./rounds";
import { ACCOUNT, API_KEY_INDEX, BASE, CHAIN_ID, isSymbol, MARKET_IDS, NETWORK, PRIVATE_KEY, SYMBOLS, type Symbol } from "./network";
import { Signer } from "./signer";
import { timing, timings } from "./timing";
import { VenueSocket } from "./venue-socket";

const PORT = Number(process.env.PORT ?? 3220);

const venue = new Lighter(BASE);

/*
  The service's own key. Rounds no longer trade with it (see `execs`), but
  /health still says whether it loads, because a key that does not is the
  first thing to know about a misconfigured deploy.
*/
let signerReady = false;
let signerError: string | null = null;
/*
  A service that cannot sign should say so on /health, not fail to start and
  take its own logs with it. Opening the signer asks the venue for its keys,
  so while the venue is down it is tried again every half minute rather than
  given up on until a restart.
*/
const openSigner = () => {
  try {
    Signer.open({ url: BASE, privateKey: PRIVATE_KEY, chainId: CHAIN_ID, accountIndex: ACCOUNT, apiKeyIndex: API_KEY_INDEX });
    if (signerError) console.log("signer ready");
    signerReady = true;
    signerError = null;
  } catch (e) {
    signerError = brief((e as Error).message);
    setTimeout(openSigner, 30_000);
  }
};
openSigner();

/* The browser calls this service directly, so it needs the same headers the
   API sends. In production this is one origin, not a star. */
const cors = {
  "access-control-allow-origin": process.env.ALLOW_ORIGIN ?? "*",
  "access-control-allow-headers": "content-type, if-none-match",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });
/** A thrown error as the page sees it, cut short so a venue's stack of text never reaches it whole. */
const failed = (e: unknown, max = 160, status = 400) => json({ error: (e as Error).message.slice(0, max) }, status);

/** A request's JSON body, or an empty one when it has none or it is not an object. */
async function bodyOf<T extends object>(req: Request): Promise<Partial<T>> {
  const body: unknown = await req.json().catch(() => null);
  return body !== null && typeof body === "object" ? (body as Partial<T>) : {};
}

/** A wallet address from the page, lowercased, or null when it is not one. */
const addressOf = (v: unknown) => {
  const at = typeof v === "string" ? v.toLowerCase() : "";
  return /^0x[0-9a-f]{40}$/.test(at) ? at : null;
};

/** The points of a drawn line, dropping any that are not numbers. */
const pointsOf = (v: unknown): Pt[] =>
  Array.isArray(v) ? v.filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.price)).slice(0, 256) : [];

/** A number from the page, clamped to something a round can actually be. */
const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const leverageOf = (v: unknown) => Math.round(clamp(v, 1, 50, 10));
const secondsOf = (v: unknown) => clamp(v, 3, 900, 30);

/*
  One socket to the execution venue, held for the life of the process.

  Prices for the worst-fill bound come from its ticker, positions and fills
  from each trading account's channels, and orders go out on it. Each
  market's sizes and floors do not change, so they are read once; prices are
  kept current from the socket, because testnet's last trade can be hours old.
*/
const socket = new VenueSocket(`${BASE.replace(/^http/, "ws")}/stream`);
socket.start();
const markets = new Map<Symbol, MarketInfo>();
/*
  The markets' details, a few quick tries at startup and then every fifteen
  seconds until the venue answers: an outage at boot no longer leaves the
  service without its markets until somebody restarts it.
*/
let marketsSaid = "";
const loadMarkets = async () => {
  const listed = await venue.markets().catch((e) => {
    const said = brief((e as Error).message);
    // The same failure once, not on every try.
    if (said !== marketsSaid) console.error("market details:", said);
    marketsSaid = said;
    return [];
  });
  for (const symbol of SYMBOLS) {
    const m = listed.find((x) => x.id === MARKET_IDS[symbol]);
    if (m) markets.set(symbol, m);
  }
  if (markets.size === SYMBOLS.length && marketsSaid) console.log("market details: loaded");
  return markets.size === SYMBOLS.length;
};
for (let i = 0; i < 5 && !(await loadMarkets()); i++) await Bun.sleep(1000);
if (markets.size < SYMBOLS.length) {
  const again = setInterval(() => void loadMarkets().then((done) => done && clearInterval(again)), 15_000);
}
const quotes = new Map<Symbol, Quote>();
for (const symbol of SYMBOLS) {
  socket.subscribe(`ticker/${MARKET_IDS[symbol]}`, (m) => {
    const t = m.ticker as { a?: { price?: string }; b?: { price?: string } } | undefined;
    const ask = asNum(t?.a?.price);
    const bid = asNum(t?.b?.price);
    if (!ask || !bid) return;
    quotes.set(symbol, { bid, ask, mark: quotes.get(symbol)?.mark || (ask + bid) / 2, at: Date.now() });
    const market = markets.get(symbol);
    if (market) market.last = (ask + bid) / 2;
  });
  socket.subscribe(`market_stats/${MARKET_IDS[symbol]}`, (m) => {
    const s = m.market_stats as Record<string, unknown> | undefined;
    const mark = asNum(s?.mark_price);
    if (!mark) return;
    const was = quotes.get(symbol);
    const quote = { bid: was?.bid || asNum(s?.best_bid_price), ask: was?.ask || asNum(s?.best_ask_price), mark, at: Date.now() };
    quotes.set(symbol, quote);
    const market = markets.get(symbol);
    if (market && !quote.bid) market.last = mark;
  });
}
const marketInfo = (symbol: string) => {
  const market = isSymbol(symbol) ? markets.get(symbol) : undefined;
  if (!market) throw Error(isSymbol(symbol) ? `${symbol} market details unavailable: the venue has not answered yet, and it is being tried again.` : `skech does not list ${symbol}.`);
  return market;
};
/** A market from the page: one skech lists, or Bitcoin when the page predates the choice. */
const marketOf = (v: unknown): Symbol | null => (v === undefined || v === null ? "BTC" : isSymbol(v) ? v : null);
/** An account on one market: the scheduler's view of it. Rounds recorded before a second market are Bitcoin. */
const on = (exec: Executor, market?: string | null) => {
  const symbol = market ?? "BTC";
  return exec.on(() => marketInfo(symbol), () => quotes.get(symbol as Symbol) ?? null);
};

const store = new RoundStore(NETWORK);
let storeReady = false;
try {
  await store.ready();
  storeReady = true;
} catch {
  console.error("trade history storage unavailable");
}
const rounds = new Rounds(marketInfo, { save: (round) => store.save(round) });
if (storeReady) for (const round of await store.all()) rounds.restore(round);
const keys = new Keys(venue, CHAIN_ID, BASE);
await keys.ready().catch((e) => console.error("keys table:", (e as Error).message.slice(0, 120)));

/*
  Who a round trades as.

  Their own Lighter account, signed with a key they registered against it, so
  the balance that moves is the one on their screen. The shared key the
  service starts with is not a fallback for this: trading somebody else's
  account because we could not find theirs is the bug this replaces.
*/
const execs = new Accounts(async (at) => {
  const held = await keys.forAddress(at);
  if (!held) return null;
  const signer = Signer.open({ url: BASE, privateKey: held.privateKey, chainId: CHAIN_ID, accountIndex: held.accountIndex, apiKeyIndex: held.apiKeyIndex });
  const exec = new Executor({ socket, http: venue, signer, accountIndex: held.accountIndex, apiKeyIndex: held.apiKeyIndex });
  exec.start();
  return exec;
});
const execFor = (address: string) => execs.get(address);
/** The account a recorded round traded, if its owner's key can still be had. */
const execForAccount = async (accountIndex: number) => execFor(await venue.addressForAccount(accountIndex));

/*
  Rounds that were running when this process stopped, picked back up with
  their owner's key. Not awaited: the server answers while they reconnect.
*/
for (const round of rounds.all().filter((r) => r.status !== "done")) {
  void (async () => {
    const exec = await execForAccount(round.accountIndex);
    if (!exec) throw Error("no trading key");
    await rounds.resume(round, on(exec, round.market));
    console.log(`resumed round ${round.id} on account ${round.accountIndex}`);
  })().catch((e) => console.error(`round ${round.id} not resumed: ${(e as Error).message.slice(0, 120)}; it waits for a manual close`));
}

/*
  A round's live record as server-sent events: a snapshot on every change,
  and a heartbeat so proxies keep the connection open.
*/
function roundEvents(req: Request, id: string) {
  const encoder = new TextEncoder();
  let ended = false;
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const abort = () => dispose();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  function dispose() {
    if (ended) return;
    ended = true;
    unsubscribe();
    clearInterval(heartbeat);
    req.signal.removeEventListener("abort", abort);
    try {
      controller.close();
    } catch {
      /* Already closed by the other side. */
    }
  }
  const send = (event: string, data: unknown) => {
    if (ended) return;
    // A slow browser reconnects for a snapshot instead of growing an unbounded queue.
    if ((controller.desiredSize ?? 0) < 0) return dispose();
    try {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      dispose();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      unsubscribe = rounds.subscribe(id, (round) => send("round", round));
      heartbeat = setInterval(() => send("heartbeat", {}), 10000);
      req.signal.addEventListener("abort", abort, { once: true });
      if (req.signal.aborted) dispose();
    },
    cancel: dispose,
  });
  return new Response(body, { headers: { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}

Bun.serve({
  port: PORT,
  idleTimeout: 30,
  // Anything a route did not catch, as JSON the page can read rather than a bare 500 without CORS.
  error: (e) => failed(e, 160, 500),
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/health") {
      return json({
        ok: markets.size === SYMBOLS.length,
        signer: signerReady ? "ready" : (signerError ?? "not configured"),
        network: NETWORK,
        venue: BASE,
        /*
          Rounds trade the drawer's own account with their own key, so there
          is no one account to report any more. What is worth saying is
          whether those keys survive a restart.
        */
        keys: keys.persistent ? "postgres" : "memory only, lost on restart",
        socket: socket.connected ? "connected" : "reconnecting",
        markets: SYMBOLS.map((symbol) => {
          const m = markets.get(symbol);
          const q = quotes.get(symbol);
          return { symbol, id: MARKET_IDS[symbol], ready: !!m, last: m?.last ?? null, quote: q ? { ...q, ageMs: Date.now() - q.at } : null };
        }),
      });
    }

    if (url.pathname === "/position") {
      const market = marketOf(url.searchParams.get("market") ?? undefined);
      if (!market) return json({ error: "unknown market" }, 400);
      return json({ position: await venue.positionIn(ACCOUNT, MARKET_IDS[market]) });
    }

    /*
      A drawn round.

      The page sends the points it drew, the stake, the boost and how long it
      runs. Everything else is worked out here: what the line means, which way
      the position faces at each moment, and what size that is. It answers as
      soon as the round is open rather than when it ends, because a round
      outlives the tab that drew it.
    */
    if (url.pathname === "/rounds" && req.method === "POST") {
      const received = Date.now();
      if (!storeReady) return json({ error: "Trade history storage unavailable. Try again once the database is connected." }, 503);
      const body = await bodyOf<RoundSpec & { address: string }>(req);
      const at = addressOf(body.address);
      if (!at) return json({ error: "address required" }, 400);
      const market = marketOf(body.market);
      if (!market) return json({ error: "skech lists Bitcoin and Ethereum only" }, 400);
      /* A failure to build their signer is worth reporting: swallowing it
         answered "no trading key" to somebody who had just registered one. */
      let exec: Executor | null = null;
      try {
        exec = await execFor(at);
      } catch (e) {
        return json({ error: `could not sign for this wallet: ${(e as Error).message.slice(0, 120)}` }, 500);
      }
      if (!exec) return json({ error: "no trading key for this wallet", needsKey: true }, 409);
      const pts = pointsOf(body.pts);
      if (pts.length < 2) return json({ error: "a line needs at least two points" }, 400);
      const spec: RoundSpec = {
        market,
        pts,
        stake: clamp(body.stake, 1, 100_000, 20),
        leverage: leverageOf(body.leverage),
        seconds: secondsOf(body.seconds),
        exits: {
          lose: body.exits?.lose == null ? null : clamp(body.exits.lose, 0, 100_000, 0),
          gain: body.exits?.gain == null ? null : clamp(body.exits.gain, 0, 1_000_000, 0),
        },
      };
      try {
        const round = await rounds.open(spec, on(exec, market));
        timing("http.open", Date.now() - received, { round: round.id });
        return json(round);
      } catch (e) {
        return failed(e);
      }
    }

    /*
      Everything a trade needs, done while somebody is still drawing: their
      signer, their account's channels, the nonce, and the leverage. None of
      it is then on the clock when they press the button.
    */
    if (url.pathname === "/rounds/prepare" && req.method === "POST") {
      const started = Date.now();
      const body = await bodyOf<{ address: string; leverage: number; market: string }>(req);
      const at = addressOf(body.address);
      if (!at) return json({ error: "address required" }, 400);
      const market = marketOf(body.market);
      if (!market) return json({ error: "skech lists Bitcoin and Ethereum only" }, 400);
      try {
        const exec = await execFor(at);
        if (!exec) return json({ error: "no trading key for this wallet", needsKey: true }, 409);
        const view = on(exec, market);
        await rounds.prepare(view, leverageOf(body.leverage));
        timing("http.prepare", Date.now() - started, { account: exec.accountIndex, market });
        return json({ ready: true, market, position: view.position(), latencyMs: Math.round(exec.latency()) });
      } catch (e) {
        return failed(e);
      }
    }

    /** A new line for a running round; the past stays, the rest follows it. */
    const plan = url.pathname.match(/^\/rounds\/([^/]+)\/plan$/);
    if (plan && (req.method === "PUT" || req.method === "POST")) {
      const body = await bodyOf<{ pts: Pt[]; seconds: number }>(req);
      const pts = pointsOf(body.pts);
      if (pts.length < 2) return json({ error: "a line needs at least two points" }, 400);
      try {
        return json(await rounds.edit(plan[1], pts, body.seconds === undefined ? undefined : secondsOf(body.seconds)));
      } catch (e) {
        return failed(e);
      }
    }

    /** Cut one part of the line out, or put it back. */
    const segment = url.pathname.match(/^\/rounds\/([^/]+)\/segments\/([^/]+)$/);
    if (segment && req.method === "POST") {
      const body = await bodyOf<{ skipped: boolean }>(req);
      try {
        return json(await rounds.skip(segment[1], segment[2], body.skipped !== false));
      } catch (e) {
        return failed(e);
      }
    }

    /** Percentiles for every measured stage. See `timing.ts`. */
    if (url.pathname === "/metrics/timings") return json(timings());

    /*
      A trading key for a wallet.

      Two steps, because the middle one is not ours: we make a key and sign
      its registration, the wallet's owner signs the message that says they
      agree, and only then does it reach the venue. Without their signature
      the key registers against nothing.
    */
    if (url.pathname === "/keys/prepare" && req.method === "POST") {
      const at = addressOf((await bodyOf<{ address: string }>(req)).address);
      if (!at) return json({ error: "address required" }, 400);
      const held = await keys.forAddress(at).catch(() => null);
      if (held) return json({ already: true, accountIndex: held.accountIndex, apiKeyIndex: held.apiKeyIndex });
      try {
        const prep = await keys.prepare(at);
        return json({ accountIndex: prep.accountIndex, apiKeyIndex: prep.apiKeyIndex, messageToSign: prep.messageToSign });
      } catch (e) {
        return failed(e);
      }
    }

    if (url.pathname === "/keys/register" && req.method === "POST") {
      const body = await bodyOf<{ address: string; signature: string }>(req);
      const at = addressOf(body.address);
      if (!at) return json({ error: "address required" }, 400);
      const signature = typeof body.signature === "string" ? body.signature : "";
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return json({ error: "a wallet signature is required" }, 400);
      try {
        const held = await keys.register(at, signature);
        // The executor it had, if any, signs with the key this replaces.
        execs.forget(at);
        return json({ ok: true, accountIndex: held.accountIndex, apiKeyIndex: held.apiKeyIndex });
      } catch (e) {
        return failed(e, 200);
      }
    }

    /** Whether this wallet can trade its own account yet. */
    if (url.pathname.startsWith("/keys/") && req.method === "GET") {
      const at = url.pathname.slice("/keys/".length).toLowerCase();
      const held = await keys.forAddress(at).catch(() => null);
      return json({ registered: held !== null, accountIndex: held?.accountIndex ?? null });
    }

    /** Close whatever this wallet holds, with or without a round to show for it. */
    if (url.pathname === "/positions/close" && req.method === "POST") {
      const body = await bodyOf<{ address: string; market: string }>(req);
      const at = addressOf(body.address);
      if (!at) return json({ error: "Address required" }, 400);
      const market = marketOf(body.market);
      if (!market) return json({ error: "unknown market" }, 400);
      try {
        const exec = await execFor(at);
        if (!exec) return json({ error: "No trading key" }, 409);
        // The page asks from the market it is on; the position may be on the other one.
        const held = [market, ...SYMBOLS.filter((s) => s !== market)].find((s) => Math.abs(on(exec, s).position()?.size ?? 0) > 1e-12) ?? market;
        return json(await rounds.closeExisting(exec.accountIndex, (m) => on(exec, m), held));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    const events = url.pathname.match(/^\/rounds\/([^/]+)\/events$/);
    if (events && req.method === "GET") {
      if (!rounds.get(events[1])) return json({ error: "Round not found" }, 404);
      return roundEvents(req, events[1]);
    }

    /** How a round is going, and how it went. Polled by the page while it runs. */
    if (url.pathname.startsWith("/rounds/") && req.method === "GET") {
      const round = rounds.get(url.pathname.slice("/rounds/".length));
      return round ? json(round) : json({ error: "no such round" }, 404);
    }

    /** Out now, at the market. The header's "Close trade". */
    if (url.pathname.endsWith("/close") && req.method === "POST") {
      const id = url.pathname.slice("/rounds/".length, -"/close".length);
      const held = rounds.get(id);
      if (held && held.status !== "done") {
        // Without a key the close below says so; it is not this route's to fail on.
        const exec = await execForAccount(held.accountIndex).catch(() => null);
        if (exec) rounds.attach(id, on(exec, held.market));
      }
      try {
        const round = await rounds.close(id);
        return round ? json(round) : json({ error: "no such round" }, 404);
      } catch (e) {
        return failed(e);
      }
    }

    /*
      Round history. One account's, newest first, at most `limit`. It used to
      send every account's rounds with their replays, 400KB, to every tab
      every two seconds; now an unchanged list is a 304 with no body.
    */
    if (url.pathname === "/rounds" && req.method === "GET") {
      const account = url.searchParams.has("account") ? Number(url.searchParams.get("account")) : null;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
      const records = new Map((storeReady ? await store.all() : []).map((r) => [r.id, r]));
      for (const r of rounds.all()) records.set(r.id, r);
      const list = [...records.values()]
        .filter((r) => account === null || r.accountIndex === account)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit);
      const body = JSON.stringify({ rounds: list });
      const etag = `W/"${Bun.hash(body).toString(36)}"`;
      const headers = { ...cors, "content-type": "application/json", etag, "cache-control": "no-cache", "access-control-expose-headers": "etag" };
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
      // Rounds carry their candle replays, which compress about tenfold.
      if (/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) return new Response(Bun.gzipSync(body), { headers: { ...headers, "content-encoding": "gzip", vary: "accept-encoding" } });
      return new Response(body, { headers });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`trader on :${PORT}, ${BASE}, account ${ACCOUNT}, markets ${SYMBOLS.map((s) => `${s} ${MARKET_IDS[s]}`).join(", ")}, signer ${signerReady ? "ready" : signerError}`);
