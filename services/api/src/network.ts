/**
 * Which Lighter everything talks to, from one switch.
 *
 * `SKECH_NETWORK=testnet` is the safe default and it is what to develop
 * against: orders are signed for real and settled for real, with money that
 * is not. Two things cannot follow it there, and both are honest rather than
 * faked:
 *
 *   **The chart stays on mainnet.** Testnet has a mark price and a day's
 *   volume but no live trades at all: ten seconds of its stream returns
 *   nothing. A chart built from that is a flat line, which teaches nobody
 *   anything and hides every bug the real tape would find. Reading mainnet
 *   prices risks nothing, so it does.
 *
 *   **Deposits do not exist there.** `createIntentAddress` answers "internal
 *   server error" on testnet, because testnet money comes from a faucet
 *   rather than from Circle. So the deposit path is switched off rather than
 *   shown with an address that cannot work.
 *
 * One variable rather than a URL per service, because a URL per service is
 * how the API came to hand out a testnet deposit address under the words
 * "send USDC here".
 */

export type Network = "mainnet" | "testnet";

export const NETWORK: Network = process.env.SKECH_NETWORK === "mainnet" ? "mainnet" : "testnet";

/** Market ids and order floors live in `@skech/core/venue`; this is only where to call. */
export const VENUE = {
  mainnet: { url: "https://mainnet.zklighter.elliot.ai" },
  testnet: { url: "https://testnet.zklighter.elliot.ai" },
} as const;

/** Where this process reads from. An explicit URL still wins, for a one-off. */
export const LIGHTER = process.env.LIGHTER_API_URL ?? VENUE[NETWORK].url;

/** Whether money can actually be put in. Not on testnet, whatever the UI wants. */
export const CAN_DEPOSIT = NETWORK === "mainnet";
