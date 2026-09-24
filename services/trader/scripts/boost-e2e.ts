/**
 * Boost end to end, on testnet, against a running trader.
 *
 *   TRADER=http://localhost:3220 bun run --filter @skech/trader boost:e2e
 *
 * A throwaway user wallet gets test money from the faucet, registers a
 * trading key, adds money to Boost, runs one boosted round, takes money out,
 * and the treasury's books are checked against the venue. Every step is the
 * same HTTP call the app makes, and every wallet signature is made here the
 * way the app's wallet makes it. Testnet only: it refuses anything else.
 */

import { generatePrivateKey } from "viem/accounts";
import { addressOfKey, signL1 } from "../src/l1";
import { Lighter } from "../src/lighter";
import { BASE, NETWORK } from "../src/network";

const TRADER = (process.env.TRADER ?? "http://localhost:3220").replace(/\/$/, "");
const ADMIN = process.env.BOOST_ADMIN_TOKEN ?? "";
const STAKE = Number(process.env.E2E_STAKE ?? 10);
const venue = new Lighter(BASE);
let last = performance.now();
/** Each line says how long its step took, since the line before. */
const say = (s: string) => {
  const now = performance.now();
  console.log(`e2e: ${s}  (+${Math.round(now - last)}ms)`);
  last = now;
};

async function call<T = Record<string, unknown>>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${TRADER}${path}`, body === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok || out.error) throw Error(`${path}: ${res.status} ${out.error ?? ""}`);
  return out;
}
const until = async <T>(what: string, fn: () => Promise<T | null | false>, ms = 90_000, every = 1000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(every);
  }
  throw Error(`timed out waiting for ${what}`);
};

async function main() {
  if (NETWORK !== "testnet") throw Error("boost-e2e runs on testnet only");
  const health = await call<{ boost: string }>("/health");
  if (health.boost !== "ready") throw Error(`the trader at ${TRADER} has no Boost: ${health.boost}`);

  const key = process.env.E2E_WALLET_KEY || generatePrivateKey();
  const address = addressOfKey(key);
  say(`user ${address}`);
  if (!(await venue.accountForAddress(address))) {
    const res = await fetch(`${BASE}/api/v1/faucet?l1_address=${address}`, { signal: AbortSignal.timeout(30_000) });
    const body = (await res.json()) as { code?: number; message?: string };
    if (body.code !== 200) throw Error(`faucet: ${body.message}`);
    await until("the user's account", () => venue.accountForAddress(address));
  }
  const account = (await venue.accountForAddress(address))!;
  say(`user account ${account}, ${(await venue.balance(account)).collateral.toFixed(2)} USDC`);

  // Enable trading: the trader makes a key, the wallet signs its registration.
  const prep = await call<{ messageToSign?: string; already?: boolean }>("/keys/prepare", { address });
  if (prep.messageToSign) await call("/keys/register", { address, signature: await signL1(key, prep.messageToSign) });
  say("trading key registered");

  const before = await call<{ balance: number; enabled: boolean; why: string | null; rules: { stakeMin: number } }>(`/boost/status?address=${address}&market=BTC`);
  say(`boost status: enabled ${before.enabled}${before.why ? ` (${before.why})` : ""}, balance ${before.balance}`);

  // Add money: signed with the user's trading key and the user's wallet.
  const add = 30;
  const dep = await call<{ id: string; fee: number; messageToSign: string }>("/boost/deposit/prepare", { address, amount: add });
  say(`deposit prepared: ${add} USDC, Lighter's fee ${dep.fee}`);
  const credited = await call<{ balance: number }>("/boost/deposit/confirm", { address, id: dep.id, signature: await signL1(key, dep.messageToSign) });
  say(`deposit confirmed: Boost balance ${credited.balance}`);
  if (Math.abs(credited.balance - (before.balance + add)) > 1e-6) throw Error("the Boost balance did not rise by the deposit");

  // A boosted round: a line up over forty seconds.
  const q = (await call<{ markets: { symbol: string; last: number }[] }>("/health")).markets.find((m) => m.symbol === "BTC")!;
  const pts = [{ t: 0, price: q.last }, { t: 1, price: q.last * 1.002 }];
  const round = await call<{ id: string; accountIndex: number; stake: number; leverage: number; boost?: { stake: number; boost: number } }>("/boost/rounds", { address, market: "BTC", pts, stake: STAKE, seconds: 40 });
  say(`round ${round.id} open on lane ${round.accountIndex}: position stake ${round.stake.toFixed(2)} at ${round.leverage}x, boost ${round.boost?.boost}`);
  let flatAt = 0;
  const done = await until("the round to settle", async () => {
    const r = await call<{ status: string; outcome: string; net: number | null; guard?: { status: string; trigger: number }; boost?: { status: string; settlement?: { equity: number; back: number; fee: number; cut: number; gap: number } } }>(`/rounds/${round.id}`);
    if (r.guard) process.stdout.write(`\r  ${r.status} · stop ${r.guard.status} at ${r.guard.trigger.toFixed(1)} · net ${r.net?.toFixed(2) ?? "…"}      `);
    if (r.status === "done" && !flatAt) {
      console.log("");
      say(`round done on the venue (${r.outcome})`);
      flatAt = performance.now();
    }
    return r.boost?.status === "done" ? r : null;
  }, 180_000, 200);
  console.log("");
  const s = done.boost!.settlement!;
  say(`settled (${done.outcome}): lane ended at ${s.equity.toFixed(2)}, back to user ${s.back.toFixed(2)}, fee ${s.fee.toFixed(2)}, cut ${s.cut.toFixed(2)}, gap ${s.gap.toFixed(2)}`);
  const after = await call<{ balance: number }>(`/boost/status?address=${address}&market=BTC`);
  const expected = credited.balance - STAKE + s.back;
  say(`Boost balance ${after.balance} (expected ${expected.toFixed(6)})`);
  if (Math.abs(after.balance - expected) > 1e-6) throw Error("the Boost balance does not match the settlement");

  // Money out, back to the user's own account.
  // Money home, the way leaving Wild sends it: all of it, back to the user's own account.
  const out = await call<{ sent: number; fee: number; balance: number }>("/boost/withdraw", { address, all: true });
  say(`sent home: ${out.sent} arrived after Lighter's ${out.fee} fee; left on skech's side ${out.balance}`);
  if (out.balance !== 0) throw Error("sending everything home left money behind");

  if (ADMIN) {
    const books = await call<{ drift: number; books: { total: number }; venue: { total: number }; outstanding: number }>("/boost/admin", undefined, { authorization: `Bearer ${ADMIN}` });
    say(`books ${books.books.total.toFixed(6)} vs venue ${books.venue.total.toFixed(6)}: drift ${books.drift.toFixed(6)}, outstanding ${books.outstanding}`);
    if (Math.abs(books.drift) > 0.01) throw Error("the books and the venue disagree");
  }
  say("passed");
}

main().catch((e) => {
  console.error(`\ne2e failed: ${(e as Error).message}`);
  process.exit(1);
});
