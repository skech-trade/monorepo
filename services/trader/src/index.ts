/**
 * The trader.
 *
 * Holds the key, turns a drawn round into orders, and is the only thing that
 * books money. Rounds have to close themselves when the clock runs out even
 * if the tab is gone, which is why this is a server and not the browser.
 *
 * Today it proves the path rather than serving it: the round endpoint opens a
 * position, holds it for its seconds and flattens it. Compiling the drawn
 * shape into legs comes next, from the same code the browser uses, so the
 * client cannot lie about what it drew.
 */

import { Executor, type Quote } from "./executor";
import { Lighter, type MarketInfo } from "./lighter";
import { Keys } from "./keys";
import { RoundStore } from "./round-store";
import { Rounds, type RoundSpec } from "./rounds";
import { ACCOUNT, API_KEY_INDEX, BASE, CHAIN_ID, MARKET_ID, NETWORK, PRIVATE_KEY } from "./network";
import { Trader } from "./round";
import { Signer } from "./signer";
import { timing, timings } from "./timing";
import { VenueSocket } from "./venue-socket";

const PORT = Number(process.env.PORT ?? 3220);

const venue = new Lighter(BASE);
let trader: Trader | null = null;
let signerError: string | null = null;

try {
  const signer = Signer.open({
    url: BASE,
    privateKey: PRIVATE_KEY,
    chainId: CHAIN_ID,
    accountIndex: ACCOUNT,
    apiKeyIndex: API_KEY_INDEX,
  });
  trader = new Trader(venue, signer, ACCOUNT);
} catch (e) {
  // A service that cannot sign should say so on /health, not fail to start
  // and take its own logs with it.
  signerError = (e as Error).message;
}

/* The browser calls this service directly, so it needs the same headers the
   API sends. In production this is one origin, not a star. */
const cors = {
  "access-control-allow-origin": process.env.ALLOW_ORIGIN ?? "*",
  "access-control-allow-headers": "content-type, if-none-match",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

/*
  One socket to the execution venue, held for the life of the process.

  Prices for the worst-fill bound come from its ticker, positions and fills
  from each trading account's channels, and orders go out on it. The market's
  sizes and floors do not change, so they are read once; its price is kept
  current from the socket, because testnet's last trade can be hours old.
*/
const socket = new VenueSocket(`${BASE.replace(/^http/, "ws")}/stream`);
socket.start();
let market: MarketInfo | null = null;
for (let i = 0; i < 5 && !market; i++) {
  market = await venue.market(MARKET_ID).catch((e) => {
    console.error("market details:", (e as Error).message.slice(0, 120));
    return null;
  });
  if (!market) await Bun.sleep(1000);
}
let quote: Quote | null = null;
const num = (v: unknown) => Number.parseFloat(String(v ?? "")) || 0;
socket.subscribe(`ticker/${MARKET_ID}`, (m) => {
  const t = m.ticker as { a?: { price?: string }; b?: { price?: string } } | undefined;
  const ask = num(t?.a?.price);
  const bid = num(t?.b?.price);
  if (!ask || !bid) return;
  quote = { bid, ask, mark: quote?.mark || (ask + bid) / 2, at: Date.now() };
  if (market) market.last = (ask + bid) / 2;
});
socket.subscribe(`market_stats/${MARKET_ID}`, (m) => {
  const s = m.market_stats as Record<string, unknown> | undefined;
  const mark = num(s?.mark_price);
  if (!mark) return;
  quote = { bid: quote?.bid || num(s?.best_bid_price), ask: quote?.ask || num(s?.best_ask_price), mark, at: Date.now() };
  if (market && !quote.bid) market.last = mark;
});
const marketInfo = () => {
  if (!market) throw Error("Market details unavailable; the venue could not be reached at startup.");
  return market;
};

const store = new RoundStore(NETWORK);
let storeReady = false;
await store.ready().then(()=>{storeReady=true;}).catch(()=>console.error("trade history storage unavailable"));
const rounds = new Rounds(marketInfo, { save: (round) => store.save(round) });
if(storeReady) for(const round of await store.all()) rounds.restore(round);
const keys = new Keys(venue, CHAIN_ID, BASE);
await keys.ready().catch((e) => console.error("keys table:", (e as Error).message.slice(0, 120)));

/*
  Who a round trades as.

  Their own Lighter account, signed with a key they registered against it, so
  the balance that moves is the one on their screen. The shared key the
  service starts with is not a fallback for this: trading somebody else's
  account because we could not find theirs is the bug this replaces.
*/
const execs = new Map<string, Executor>();
async function execFor(address: string): Promise<Executor | null> {
  const at = address.toLowerCase();
  const known = execs.get(at);
  if (known) return known;
  const held = await keys.forAddress(at);
  if (!held) return null;
  const signer = Signer.open({ url: BASE, privateKey: held.privateKey, chainId: CHAIN_ID, accountIndex: held.accountIndex, apiKeyIndex: held.apiKeyIndex });
  const exec = new Executor({ socket, http: venue, signer, accountIndex: held.accountIndex, apiKeyIndex: held.apiKeyIndex, market: marketInfo, quote: () => quote });
  exec.start();
  execs.set(at, exec);
  return exec;
}

/*
  Rounds that were running when this process stopped, picked back up with
  their owner's key. Not awaited: the server answers while they reconnect.
*/
for (const round of rounds.all().filter((r) => r.status !== "done")) {
  void (async () => {
    const address = await venue.addressForAccount(round.accountIndex);
    const exec = await execFor(address);
    if (!exec) throw Error("no trading key");
    await rounds.resume(round, exec);
    console.log(`resumed round ${round.id} on account ${round.accountIndex}`);
  })().catch((e) => console.error(`round ${round.id} not resumed: ${(e as Error).message.slice(0, 120)}; it waits for a manual close`));
}

/** A number from the page, clamped to something a round can actually be. */
const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

Bun.serve({
  port: PORT,
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/health") {
      const market = await venue.market(MARKET_ID).catch(() => null);
      return json({
        ok: market !== null,
        signer: trader ? "ready" : (signerError ?? "not configured"),
        network: NETWORK,
        venue: BASE,
        /*
          Rounds trade the drawer's own account with their own key, so there
          is no one account to report any more. What is worth saying is
          whether those keys survive a restart.
        */
        keys: keys.persistent ? "postgres" : "memory only, lost on restart",
        socket: socket.connected ? "connected" : "reconnecting",
        quote: quote ? { ...quote, ageMs: Date.now() - quote.at } : null,
        market: market ? { id: market.id, symbol: market.symbol, last: market.last } : null,
      });
    }

    if (url.pathname === "/position") {
      return json({ position: await venue.positionIn(ACCOUNT, MARKET_ID) });
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
      if(!storeReady) return json({error:"Trade history storage unavailable. Try again once the database is connected."},503);
      const body = (await req.json().catch(() => ({}))) as Partial<RoundSpec> & { address?: string };
      const at = (body.address ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(at)) return json({ error: "address required" }, 400);
      /* A failure to build their signer is worth reporting: swallowing it
         answered "no trading key" to somebody who had just registered one. */
      let exec: Executor | null = null;
      try {
        exec = await execFor(at);
      } catch (e) {
        return json({ error: `could not sign for this wallet: ${(e as Error).message.slice(0, 120)}` }, 500);
      }
      if (!exec) return json({ error: "no trading key for this wallet", needsKey: true }, 409);
      const pts = Array.isArray(body.pts) ? body.pts.filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.price)).slice(0, 256) : [];
      if (pts.length < 2) return json({ error: "a line needs at least two points" }, 400);
      const spec: RoundSpec = {
        pts,
        stake: clamp(body.stake, 1, 100_000, 20),
        leverage: Math.round(clamp(body.leverage, 1, 50, 10)),
        seconds: clamp(body.seconds, 3, 900, 30),
        exits: {
          lose: body.exits?.lose == null ? null : clamp(body.exits.lose, 0, 100_000, 0),
          gain: body.exits?.gain == null ? null : clamp(body.exits.gain, 0, 1_000_000, 0),
        },
      };
      try {
        const round = await rounds.open(spec, exec);
        timing("http.open", Date.now() - received, { round: round.id });
        return json(round);
      } catch (e) {
        return json({ error: (e as Error).message.slice(0, 160) }, 400);
      }
    }

    /*
      Everything a trade needs, done while somebody is still drawing: their
      signer, their account's channels, the nonce, and the leverage. None of
      it is then on the clock when they press the button.
    */
    if (url.pathname === "/rounds/prepare" && req.method === "POST") {
      const started = Date.now();
      const body = (await req.json().catch(() => ({}))) as { address?: string; leverage?: number };
      const at = (body.address ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(at)) return json({ error: "address required" }, 400);
      try {
        const exec = await execFor(at);
        if (!exec) return json({ error: "no trading key for this wallet", needsKey: true }, 409);
        await rounds.prepare(exec, Math.round(clamp(body.leverage, 1, 50, 10)));
        timing("http.prepare", Date.now() - started, { account: exec.accountIndex });
        return json({ ready: true, position: exec.position(), latencyMs: Math.round(exec.latency()) });
      } catch (e) {
        return json({ error: (e as Error).message.slice(0, 160) }, 400);
      }
    }

    /** A new line for a running round; the past stays, the rest follows it. */
    const plan = url.pathname.match(/^\/rounds\/([^/]+)\/plan$/);
    if (plan && (req.method === "PUT" || req.method === "POST")) {
      const body = (await req.json().catch(() => ({}))) as { pts?: { t: number; price: number }[]; seconds?: number };
      const pts = Array.isArray(body.pts) ? body.pts.filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.price)).slice(0, 256) : [];
      if (pts.length < 2) return json({ error: "a line needs at least two points" }, 400);
      try {
        return json(await rounds.edit(plan[1], pts, body.seconds === undefined ? undefined : clamp(body.seconds, 3, 900, 30)));
      } catch (e) {
        return json({ error: (e as Error).message.slice(0, 160) }, 400);
      }
    }

    /** Cut one part of the line out, or put it back. */
    const segment = url.pathname.match(/^\/rounds\/([^/]+)\/segments\/([^/]+)$/);
    if (segment && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { skipped?: boolean };
      try {
        return json(await rounds.skip(segment[1], segment[2], body.skipped !== false));
      } catch (e) {
        return json({ error: (e as Error).message.slice(0, 160) }, 400);
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
      const body = (await req.json().catch(() => ({}))) as { address?: string };
      const at = (body.address ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(at)) return json({ error: "address required" }, 400);
      const held = await keys.forAddress(at).catch(() => null);
      if (held) return json({ already: true, accountIndex: held.accountIndex, apiKeyIndex: held.apiKeyIndex });
      try {
        const prep = await keys.prepare(at);
        return json({ accountIndex: prep.accountIndex, apiKeyIndex: prep.apiKeyIndex, messageToSign: prep.messageToSign });
      } catch (e) {
        return json({ error: (e as Error).message.slice(0, 160) }, 400);
      }
    }

    if (url.pathname === "/keys/register" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { address?: string; signature?: string };
      const at = (body.address ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(at)) return json({ error: "address required" }, 400);
      if (!/^0x[0-9a-fA-F]{130}$/.test(body.signature ?? "")) return json({ error: "a wallet signature is required" }, 400);
      try {
        const held = await keys.register(at, body.signature as string);
        execs.get(at)?.stop();
        execs.delete(at);
        return json({ ok: true, accountIndex: held.accountIndex, apiKeyIndex: held.apiKeyIndex });
      } catch (e) {
        return json({ error: (e as Error).message.slice(0, 200) }, 400);
      }
    }

    /** Whether this wallet can trade its own account yet. */
    if (url.pathname.startsWith("/keys/") && req.method === "GET") {
      const at = url.pathname.slice("/keys/".length).toLowerCase();
      const held = await keys.forAddress(at).catch(() => null);
      return json({ registered: held !== null, accountIndex: held?.accountIndex ?? null });
    }

    if(url.pathname === "/positions/close" && req.method === "POST") {
      const body=(await req.json().catch(()=>({}))) as {address?:string};
      if(!/^0x[0-9a-fA-F]{40}$/.test(body.address??""))return json({error:"Address required"},400);
      try {const exec=await execFor(body.address!);if(!exec)return json({error:"No trading key"},409);return json(await rounds.closeExisting(exec));}
      catch(error){return json({error:(error as Error).message},400);}
    }

    const events = url.pathname.match(/^\/rounds\/([^/]+)\/events$/);
    if(events && req.method === "GET") {
      if(!rounds.get(events[1]))return json({error:"Round not found"},404);
      let dispose=()=>{};
      const body=new ReadableStream<Uint8Array>({
        start(controller){
          const encoder=new TextEncoder();let ended=false;
          let unsubscribe=()=>{};let heartbeat:ReturnType<typeof setInterval>|undefined;
          const abort=()=>dispose();
          dispose=()=>{if(ended)return;ended=true;unsubscribe();clearInterval(heartbeat);req.signal.removeEventListener("abort",abort);try{controller.close();}catch{}};
          const send=(event:string,data:unknown)=>{
            if(ended)return;
            // A slow browser reconnects for a snapshot instead of growing an unbounded queue.
            if((controller.desiredSize??0)<0){dispose();return;}
            try{controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));}catch{dispose();}
          };
          unsubscribe=rounds.subscribe(events[1],round=>send("round",round));
          heartbeat=setInterval(()=>send("heartbeat",{}),10000);
          req.signal.addEventListener("abort",abort,{once:true});
          if(req.signal.aborted)dispose();
        },cancel(){dispose();},
      });
      return new Response(body,{headers:{...cors,"content-type":"text/event-stream","cache-control":"no-cache, no-transform","x-accel-buffering":"no"}});
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
      if(held && held.status!=="done") {
        const account = await venue.addressForAccount(held.accountIndex).catch(() => null);
        const exec = account ? await execFor(account) : null;
        if(exec) rounds.attach(id,exec);
      }
      try {
        const round = await rounds.close(id);
        return round ? json(round) : json({ error: "no such round" }, 404);
      } catch (e) {
        return json({ error: (e as Error).message.slice(0, 160) }, 400);
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

console.log(`trader on :${PORT}, ${BASE}, account ${ACCOUNT}, market ${MARKET_ID}, signer ${trader ? "ready" : signerError}`);
