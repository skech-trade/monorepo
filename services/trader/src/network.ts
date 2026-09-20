/**
 * Which Lighter this signs against, from the same switch as everything else.
 *
 * It used to read `LIGHTER_BASE_URL`, `LIGHTER_CHAIN_ID` and
 * `LIGHTER_MARKET_ID` directly, which meant `SKECH_NETWORK=mainnet` moved the
 * app, the balances and the deposit address to mainnet and left the thing
 * that signs orders on testnet, quietly. One variable per service is how the
 * API once came to hand out a testnet deposit address under the words "send
 * USDC here", so the trader reads the switch too.
 *
 * The network picks the key as well as the venue. A mainnet order signed with
 * a testnet account index is not a small mistake.
 */

export type Network = "mainnet" | "testnet";

export const NETWORK: Network = process.env.SKECH_NETWORK === "mainnet" ? "mainnet" : "testnet";

export const VENUE = {
  mainnet: { url: "https://mainnet.zklighter.elliot.ai", chainId: 304, btc: 1 },
  testnet: { url: "https://testnet.zklighter.elliot.ai", chainId: 300, btc: 4096 },
} as const;

/** The credential for whichever network is on. Mainnet's live under their own names. */
const pick = (name: string) => (NETWORK === "mainnet" ? process.env[`LIGHTER_MAINNET_${name}`] : process.env[`LIGHTER_${name}`]) ?? "";

export const BASE = process.env.LIGHTER_API_URL ?? VENUE[NETWORK].url;
export const CHAIN_ID = VENUE[NETWORK].chainId;
export const MARKET_ID = VENUE[NETWORK].btc;
export const ACCOUNT = Number(pick("ACCOUNT_INDEX") || 0);
export const API_KEY_INDEX = Number(pick("API_KEY_INDEX") || 0);
export const PRIVATE_KEY = pick("PRIVATE_KEY");
