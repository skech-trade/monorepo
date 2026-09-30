/**
 * What the Solana relayer needs to know: the cluster (SKECH_SOLANA_CLUSTER), its keypair, and the game's addresses
 * from `packages/contracts/deployments/solana-<cluster>.json`, written by `bun run deploy:solana`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deploymentFile, type SolanaDeployment, solanaNetwork, solanaRpc } from "@skech/contracts/solana/sdk";
import { root } from "../env";

const env = (name: string) => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};
const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

const net = solanaNetwork(process.env);
const deploymentPath = join(root, deploymentFile(net.cluster));
if (!existsSync(deploymentPath)) throw new Error(`${deploymentPath} does not exist: bun run deploy:solana first (SKECH_SOLANA_CLUSTER=${net.cluster})`);
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as SolanaDeployment;

/** The relayer's keypair: a file (SOLANA_RELAYER_KEYPAIR), or its 64 bytes as JSON (SOLANA_RELAYER_SECRET_KEY, for a server's env file). */
function keyBytes(): Uint8Array {
  const inline = env("SOLANA_RELAYER_SECRET_KEY");
  if (inline) return Uint8Array.from(JSON.parse(inline) as number[]);
  const path = expand(env("SOLANA_RELAYER_KEYPAIR") ?? (net.cluster === "localnet" ? "~/.config/solana/id.json" : ""));
  if (!path || !existsSync(path)) throw new Error("SOLANA_RELAYER_KEYPAIR (a keypair file) or SOLANA_RELAYER_SECRET_KEY must be set: the relayer pays every fee and signs as the oracle");
  return Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
}

const rpcUrl = solanaRpc(process.env, net);
const engineSigner = env("RELAYER_ENGINE_SIGNER");
if (engineSigner && !/^0x[0-9a-fA-F]{40}$/.test(engineSigner)) throw new Error(`RELAYER_ENGINE_SIGNER is not an address: ${engineSigner}`);
const compute = JSON.parse(readFileSync(join(root, "packages/contracts/solana/snapshots/compute.json"), "utf8")) as Record<string, number>;

export const scfg = {
  port: Number(env("RELAYER_SOLANA_PORT") ?? 3104),
  /** Where to listen: this machine only, behind Caddy. 0.0.0.0 to be reached from elsewhere (a phone on the same network). */
  host: env("RELAYER_HOST") ?? "127.0.0.1",
  engineUrl: env("NEXT_PUBLIC_ENGINE_URL") ?? "ws://localhost:3102/ws",
  /** The engine's signing address, if known: an engine that signs as anyone else is not listened to. */
  engineSigner: engineSigner as `0x${string}` | undefined,
  net,
  rpcUrl,
  wsUrl: env(`SOLANA_${net.cluster.toUpperCase().replace("-", "_")}_WS_URL`) ?? (rpcUrl === net.rpc ? net.ws : rpcUrl.replace(/^http/, "ws")),
  keyBytes: keyBytes(),
  deployment,
  libPath: env("SKECH_LIB") ?? join(root, "packages", "core", "src", "dots-lib.bin"),
  market: 0,
  marketName: "BTC-USD",
  /** A piece opens on a second; it is priced this long after that second starts, once late trades are in. */
  openAfterMs: 350,
  /** How late after its opening second a piece may still arrive: the game's `late_ms`, read at start. */
  lateMs: 200,
  /** How far ahead of now a piece's opening second may be. */
  aheadMs: 1500,
  /** Sweep IOUs, deposits and fees this often. */
  sweepEveryMs: 15_000,
  collectAboveE6: 1_000_000n,
  /** The least a deposit or withdrawal the relayer pays for may move, USDC e6 (a withdrawal of the whole balance always goes): the app's least deposit. */
  minMoveE6: 1_000_000n,
  /** Compute units each instruction takes, measured in LiteSVM (`bun run solana:snapshot`). */
  compute,
  /** Priority fee, micro-lamports per compute unit: a fixed one, or what recent blocks paid to write the pool, capped. */
  priorityFixed: env("SOLANA_PRIORITY_MICROLAMPORTS") ? Number(env("SOLANA_PRIORITY_MICROLAMPORTS")) : null,
  priorityMax: Number(env("SOLANA_PRIORITY_MAX_MICROLAMPORTS") ?? (net.cluster === "mainnet-beta" ? 2_000_000 : 50_000)),
  /** Bets settled in one transaction: two accounts each, 32 bytes a key, in 1232 bytes. */
  betsPerSettle: 12,
};
export type SolanaConfig = typeof scfg;
