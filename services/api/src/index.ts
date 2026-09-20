/**
 * The app's own backend: who someone is, and what they are worth.
 *
 * Small on purpose. The feed is its own service because it holds a socket,
 * and the trader is its own because it holds a key. This holds the database
 * and nothing else, so it can restart without anybody noticing.
 */

import { hasDb, migrate, rename, sql, userFor } from "./db";
import { Lighter } from "./lighter";

const PORT = Number(process.env.PORT ?? 3230);
const venue = new Lighter(process.env.LIGHTER_BASE_URL ?? "https://mainnet.zklighter.elliot.ai");

await migrate().catch((e) => console.error("migrate failed:", (e as Error).message));

const cors = {
  "access-control-allow-origin": process.env.ALLOW_ORIGIN ?? "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

/** An address, or nothing. Anything that is not one is not worth a query. */
const address = (v: string | null) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/health") {
      let db = "not configured";
      if (hasDb && sql) db = await sql`SELECT 1`.then(() => "ok").catch((e) => `down: ${(e as Error).message.slice(0, 80)}`);
      return json({ ok: true, db });
    }

    /*
      Who this wallet is. Called the moment someone signs in, so it doubles as
      the row being made: the wallet is the identity and the name is optional.
    */
    if (url.pathname === "/me") {
      const at = address(url.searchParams.get("address"));
      if (!at) return json({ error: "address required" }, 400);
      const user = await userFor(at).catch(() => null);
      return json({ address: at, name: user?.name ?? null });
    }

    /** What they want to be called. */
    if (url.pathname === "/me/name" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { address?: string; name?: string };
      const at = address(body.address ?? null);
      const name = (body.name ?? "").trim().slice(0, 24);
      if (!at) return json({ error: "address required" }, 400);
      if (name.length < 2) return json({ error: "a name is at least two characters" }, 400);
      await userFor(at).catch(() => null);
      const user = await rename(at, name).catch(() => null);
      return json({ address: at, name: user?.name ?? name });
    }

    /*
      What the wallet is worth on the venue. Collateral is what can be traded
      with; equity adds what anything open has made. Both come from Lighter,
      not from us, so there is one answer and it is theirs.
    */
    if (url.pathname === "/balance") {
      const at = address(url.searchParams.get("address"));
      if (!at) return json({ error: "address required" }, 400);
      const balance = await venue.balanceForAddress(at).catch(() => null);
      if (!balance) return json({ error: "venue unreachable" }, 502);
      return json(balance);
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`api on :${PORT}, db ${hasDb ? "configured" : "off"}`);
