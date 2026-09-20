/**
 * The app's own backend: who someone is, and what they are worth.
 *
 * Small on purpose. The feed is its own service because it holds a socket,
 * and the trader is its own because it holds a key. This holds the database
 * and nothing else, so it can restart without anybody noticing.
 */

import { hasDb, migrate, rename, sql, userFor } from "./db";
import { CHAINS, Deposits, NATIVE, SEND_TO } from "./deposit";
import { Lighter } from "./lighter";

const PORT = Number(process.env.PORT ?? 3230);
/*
  Its own variable, deliberately not the trader's.

  LIGHTER_BASE_URL points the trader at testnet, which is right: it signs
  orders and should not touch real money until a round has been through
  testnet end to end. This service hands out a deposit address, and a testnet
  address shown as "send USDC here" is real money sent somewhere it can never
  be recovered from. The two must not share a switch.
*/
const LIGHTER = process.env.LIGHTER_API_URL ?? "https://mainnet.zklighter.elliot.ai";
const NETWORK = LIGHTER.includes("testnet") ? "testnet" : "mainnet";
const venue = new Lighter(LIGHTER);
const deposits = new Deposits(LIGHTER);

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
      return json({ ok: true, db, venue: LIGHTER, network: NETWORK });
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

    /*
      The one address that credits this wallet's Lighter account.

      The same on every chain Lighter watches, unchanging, and open to anyone:
      USDC sent from an exchange, another wallet or a friend all land the same
      way. This is the path that asks nothing of a new wallet.
    */
    if (url.pathname === "/deposit/address") {
      const at = address(url.searchParams.get("address"));
      if (!at) return json({ error: "address required" }, 400);
      const intent = await deposits.intentAddress(at).catch(() => null);
      if (!intent) return json({ error: "venue unreachable" }, 502);
      /*
        The network goes with the address, always. Everything about a deposit
        address looks the same on either network and only one of them is
        somewhere real money survives.
      */
      return json({ address: intent, chains: SEND_TO, asset: "USDC", minimum: 5, network: NETWORK });
    }

    /** Where money can come from. The app does not need to know these. */
    if (url.pathname === "/deposit/chains") {
      return json({ chains: CHAINS, native: NATIVE });
    }

    /*
      What a deposit would cost and what would land. Nothing is signed here;
      the steps go back to the wallet, which is the only thing that can sign
      them and the only thing that holds the money.
    */
    if (url.pathname === "/deposit/quote") {
      const at = address(url.searchParams.get("address"));
      const fromChain = Number(url.searchParams.get("fromChain") ?? 8453);
      const token = url.searchParams.get("token") ?? CHAINS[0].usdc;
      const amount = url.searchParams.get("amount") ?? "";
      if (!at) return json({ error: "address required" }, 400);
      if (!/^\d+$/.test(amount)) return json({ error: "amount must be in the token's smallest unit" }, 400);
      const quote = await deposits.quote({ address: at, fromChain, token, amount }).catch(() => null);
      if (!quote) return json({ error: "no route for that" }, 502);
      return json(quote);
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`api on :${PORT}, db ${hasDb ? "configured" : "off"}`);
