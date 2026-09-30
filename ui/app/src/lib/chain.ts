"use client";

import { type Address, createPublicClient, http } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { network, networkOf } from "@skech/core/network";
import { RPC_URL as RPC } from "./endpoints";

/**
 * Where the game is on chain, for the app. SKECH_NETWORK in the repo's
 * `.env.local` picks testnet or mainnet, and next.config.ts turns it into the
 * NEXT_PUBLIC_ values below, with the game from that network's deployment
 * file. With no game deployed there, the app plays for practice money.
 */

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_SKECH_CHAIN_ID ?? 0);
export const GAME = (process.env.NEXT_PUBLIC_SKECH_GAME || undefined) as Address | undefined;
export const USDC = (process.env.NEXT_PUBLIC_SKECH_USDC || undefined) as Address | undefined;
/** Testnet or mainnet, and what differs: the label players see, the explorer, the faucet. */
export const NETWORK = networkOf(CHAIN_ID) ?? network(process.env.NEXT_PUBLIC_SKECH_NETWORK);
export const testnet = NETWORK.name === "testnet";

/** Whether this build plays for real: a game on a chain, and USDC to put in it. */
export const onChain = Boolean(GAME && USDC && CHAIN_ID > 0);

export const chain = CHAIN_ID === 143 ? monad : CHAIN_ID === 10143 ? monadTestnet : { id: CHAIN_ID, name: `chain ${CHAIN_ID}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
export const explorer = networkOf(CHAIN_ID)?.explorer ?? null;

/** The EIP-712 domain everything the player signs is under: the game's, the same the engine signs prices under. */
export const domain = GAME ? { name: "skech", version: "1", chainId: CHAIN_ID, verifyingContract: GAME } : null;

export const publicClient = createPublicClient({ chain, transport: http(RPC, { batch: true }) });

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/** The player's USDC in their wallet, not yet in the game. */
export const usdcBalance = (player: Address) => publicClient.readContract({ address: USDC!, abi: ERC20_ABI, functionName: "balanceOf", args: [player] });

/** USDC's own EIP-712 domain, which an EIP-3009 authorization is signed under. Read once. */
let usdcDomainOnce: Promise<{ name: string; version: string; chainId: number; verifyingContract: Address }> | null = null;
export function usdcDomain() {
  usdcDomainOnce ??= Promise.all([
    publicClient.readContract({ address: USDC!, abi: ERC20_ABI, functionName: "name" }),
    publicClient.readContract({ address: USDC!, abi: ERC20_ABI, functionName: "version" }).catch(() => "1"),
  ]).then(([name, version]) => ({ name, version, chainId: CHAIN_ID, verifyingContract: USDC! }));
  usdcDomainOnce.catch(() => (usdcDomainOnce = null));
  return usdcDomainOnce;
}

/** The one call the app makes on the game itself, so only it, not the game's whole ABI (60 KB), is in the page. */
const GAME_ABI = [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

/** The player's next nonce on the game, for a session or a withdrawal. */
export const gameNonce = (player: Address) => publicClient.readContract({ address: GAME!, abi: GAME_ABI, functionName: "nonces", args: [player] });
