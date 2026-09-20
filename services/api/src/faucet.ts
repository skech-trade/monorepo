import { NETWORK, VENUE } from "./network";

/**
 * Test money, without sending anybody anywhere.
 *
 * Lighter's testnet has a faucet, and it turns out to be one unauthenticated
 * GET: no wallet to connect, no signature, no captcha. It funds the address
 * with 10,000 test USDC and makes the Lighter account if there is not one,
 * which takes about eight seconds to show up.
 *
 * That matters because the wallet we make people is an embedded one. It has
 * no browser extension and speaks no WalletConnect, so "go to Lighter's site
 * and connect your wallet" is a wall for exactly the people testnet is for.
 * Calling the faucet ourselves turns that into one button.
 *
 * It refuses once the account is worth $100 or more, which is the rate limit
 * and a sane one: it means somebody who lost it all can always come back.
 */

export const CAN_FAUCET = NETWORK === "testnet";

export type Faucet = { ok: true; amount: number } | { ok: false; reason: string };

/** How much it hands out, measured rather than assumed. */
export const FAUCET_AMOUNT = 10_000;

export async function askFaucet(address: string): Promise<Faucet> {
  const res = await fetch(`${VENUE.testnet.url}/api/v1/faucet?l1_address=${address}`, { signal: AbortSignal.timeout(25_000) }).catch(() => null);
  if (!res) return { ok: false, reason: "The faucet did not answer. Try again in a moment." };
  const body = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
  if (body?.code === 200) return { ok: true, amount: FAUCET_AMOUNT };
  // Its own words are better than ours: it says exactly why, and the usual
  // reason is that the account is still holding enough to trade with.
  return { ok: false, reason: (body?.message ?? "").trim() || "The faucet turned that down." };
}
