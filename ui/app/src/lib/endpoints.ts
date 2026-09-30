import { networkOf } from "@skech/core/network";

/**
 * The servers the app talks to, from the build's settings (next.config.ts): the engine's price feed, the
 * relayer, and the chain's RPC. The code that connects reads them here, and so does the page's
 * Content-Security-Policy (src/proxy.ts), so the policy never leaves out a server the app uses.
 */
export const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL || "ws://localhost:3102/ws";
export const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || "ws://localhost:3103/ws";
export const RPC_URL = process.env.NEXT_PUBLIC_MONAD_RPC_URL || (networkOf(Number(process.env.NEXT_PUBLIC_SKECH_CHAIN_ID ?? 0))?.rpc ?? "http://127.0.0.1:8545");

/**
 * Reopening a dropped socket: half the wait and a random share of the other half, so a relayer that restarts
 * does not get every player back in the same instant; and the wait starts short again only once a connection
 * has stayed up, so one that opens and drops at once backs off instead of hammering.
 */
export const jitter = (ms: number) => ms / 2 + (Math.random() * ms) / 2;
export const STEADY_MS = 10_000;
