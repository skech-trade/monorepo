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

import { Lighter } from "./lighter";
import { Rounds, type RoundSpec } from "./rounds";
import { ACCOUNT, API_KEY_INDEX, BASE, CHAIN_ID, MARKET_ID, NETWORK, PRIVATE_KEY } from "./network";
import { Trader } from "./round";
import { Signer } from "./signer";

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
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

const rounds = trader ? new Rounds(venue, trader, ACCOUNT, MARKET_ID) : null;

/** A number from the page, clamped to something a round can actually be. */
const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/health") {
      const market = await venue.market(MARKET_ID).catch(() => null);
      return json({
        ok: trader !== null && market !== null,
        signer: trader ? "ready" : (signerError ?? "not configured"),
        network: NETWORK,
        venue: BASE,
        account: ACCOUNT,
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
      if (!rounds) return json({ error: signerError ?? "no signer" }, 503);
      const body = (await req.json().catch(() => ({}))) as Partial<RoundSpec>;
      const pts = Array.isArray(body.pts) ? body.pts.filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.price)).slice(0, 256) : [];
      if (pts.length < 2) return json({ error: "a line needs at least two points" }, 400);
      const spec: RoundSpec = {
        pts,
        stake: clamp(body.stake, 1, 100_000, 20),
        leverage: Math.round(clamp(body.leverage, 1, 50, 10)),
        seconds: Math.round(clamp(body.seconds, 3, 900, 30)),
        exits: {
          lose: body.exits?.lose == null ? null : clamp(body.exits.lose, 0, 100_000, 0),
          gain: body.exits?.gain == null ? null : clamp(body.exits.gain, 0, 1_000_000, 0),
        },
      };
      try {
        return json(await rounds.open(spec));
      } catch (e) {
        return json({ error: (e as Error).message.slice(0, 160) }, 400);
      }
    }

    /** How a round is going, and how it went. Polled by the page while it runs. */
    if (url.pathname.startsWith("/rounds/") && req.method === "GET") {
      const round = rounds?.get(url.pathname.slice("/rounds/".length));
      return round ? json(round) : json({ error: "no such round" }, 404);
    }

    /** Out now, at the market. The header's "Close trade". */
    if (url.pathname.endsWith("/close") && req.method === "POST") {
      const id = url.pathname.slice("/rounds/".length, -"/close".length);
      const round = await rounds?.close(id);
      return round ? json(round) : json({ error: "no such round" }, 404);
    }

    if (url.pathname === "/rounds" && req.method === "GET") {
      return json({ rounds: rounds?.all() ?? [] });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`trader on :${PORT}, ${BASE}, account ${ACCOUNT}, market ${MARKET_ID}, signer ${trader ? "ready" : signerError}`);
