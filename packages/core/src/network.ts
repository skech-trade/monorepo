/**
 * The two networks skech runs on, and everything that differs between them.
 *
 * One switch, `SKECH_NETWORK` in the repo's `.env.local`, picks the row. The
 * engine, the relayer, the deploy script and the app all read this table, so
 * nothing is left pointing at the other chain after a switch. The game's own
 * addresses are not here: each network's live in
 * `packages/evm-contracts/deployments/<chainId>.json`, written by the deploy.
 */
import type { Address } from "viem";

export type NetworkName = "testnet" | "mainnet";

export type Network = {
  name: NetworkName;
  chainId: number;
  /** What a player is told the network is called. */
  label: string;
  /** Monad's public RPC. A private one goes in MONAD_<NAME>_RPC_URL, server side. */
  rpc: string;
  explorer: string;
  /** Circle's USDC, version 2: EIP-2612 permits and EIP-3009 authorizations. */
  usdc: Address;
  /** Where free test USDC comes from; mainnet has none. */
  faucet: string | null;
};

export const NETWORKS: Record<NetworkName, Network> = {
  testnet: {
    name: "testnet",
    chainId: 10143,
    label: "Monad testnet",
    rpc: "https://testnet-rpc.monad.xyz",
    explorer: "https://testnet.monadvision.com",
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    faucet: "https://faucet.circle.com/",
  },
  mainnet: {
    name: "mainnet",
    chainId: 143,
    label: "Monad",
    rpc: "https://rpc.monad.xyz",
    explorer: "https://monadvision.com",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    faucet: null,
  },
};

/** `SKECH_NETWORK`'s value to a network. Blank is testnet; anything else unknown is an error, never a silent default. */
export function network(value: string | undefined): Network {
  const name = value?.trim().toLowerCase() || "testnet";
  if (name !== "testnet" && name !== "mainnet") throw new Error(`SKECH_NETWORK is "${value}": it must be testnet or mainnet`);
  return NETWORKS[name];
}

/** The network a chain id belongs to, if it is one of ours. Anvil (31337) is neither. */
export const networkOf = (chainId: number): Network | null => Object.values(NETWORKS).find((n) => n.chainId === chainId) ?? null;

/**
 * The chain everything server side talks to. `ENGINE_CHAIN_ID` still wins, for a local anvil run, but it
 * may not name the other network: a leftover testnet id under `SKECH_NETWORK=mainnet` is exactly the
 * mistake this switch exists to prevent.
 */
export function chainIdFor(env: Record<string, string | undefined>): number {
  const net = network(env.SKECH_NETWORK);
  const explicit = env.ENGINE_CHAIN_ID?.trim();
  if (!explicit) return net.chainId;
  const id = Number(explicit);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`ENGINE_CHAIN_ID is "${explicit}", not a chain id`);
  const other = networkOf(id);
  if (other && other.name !== net.name) throw new Error(`ENGINE_CHAIN_ID is ${id} (${other.name}) but SKECH_NETWORK is ${net.name}: remove ENGINE_CHAIN_ID, the network picks the chain`);
  return id;
}

/** The server-side RPC: MONAD_RPC_URL for a one-off, then the network's own private endpoint, then Monad's public one. */
export function rpcFor(env: Record<string, string | undefined>, chainId: number): string {
  const own = networkOf(chainId);
  const pick = (name: string) => env[name]?.trim() || undefined;
  return pick("MONAD_RPC_URL") ?? (own ? (pick(`MONAD_${own.name.toUpperCase()}_RPC_URL`) ?? own.rpc) : "http://127.0.0.1:8545");
}
