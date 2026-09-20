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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

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

    // Open, hold, flatten. The shape compiler goes here next.
    if (url.pathname === "/rounds" && req.method === "POST") {
      if (!trader) return json({ error: signerError ?? "no signer" }, 503);
      const { stake = 20, leverage = 10, seconds = 10 } = (await req.json().catch(() => ({}))) as {
        stake?: number;
        leverage?: number;
        seconds?: number;
      };
      const market = await venue.market(MARKET_ID);
      const opened = await trader.goTo(market, trader.sizeFor({ stake, leverage, marketId: MARKET_ID }, market.last));
      if (!opened) return json({ error: "under the venue's minimum" }, 400);
      await Bun.sleep(Math.min(120, Math.max(1, seconds)) * 1000);
      const held = await venue.positionIn(ACCOUNT, MARKET_ID);
      const closed = await trader.flatten(market);
      return json({ open: opened.hash, held, close: closed?.hash ?? null });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`trader on :${PORT}, ${BASE}, account ${ACCOUNT}, market ${MARKET_ID}, signer ${trader ? "ready" : signerError}`);
