import type { SolanaConfig } from "../solana/config";
import type { SocialConfig } from "./indexer";
import type { Placement, Settlement } from "./store";
import type { Config } from "../config";
import type { Placed } from "../sequencer";
import type { Settled } from "../settler";

/** The social worker has its own event loop: queries never hold up a drawing. */
export class SocialBridge {
  private worker: Worker;
  constructor(cfg: Config | SocialConfig, log: (message: string) => void, port?: string) {
    const env: Record<string, string> = {};
    for (const key of ["SOCIAL_DATABASE_URL", "SOCIAL_ALLOWED_ORIGINS", "SOCIAL_PORT"]) if (process.env[key]) env[key] = process.env[key]!;
    if (port) env.SOCIAL_PORT = port;
    const bundledWorker = "kind" in cfg && cfg.kind === "solana" ? "../social/worker.js" : "./social/worker.js";
    this.worker = new Worker(new URL(import.meta.path.endsWith(".js") ? bundledWorker : "./worker.ts", import.meta.url).href, { env });
    this.worker.addEventListener("message", (event: MessageEvent) => {
      if (event.data?.log) log(`social: ${event.data.log}`);
    });
    this.worker.addEventListener("error", () => log("social worker stopped; the game continues. Restart the relayer to recover social indexing."));
    this.worker.postMessage({ type: "start", cfg: { kind: "kind" in cfg ? cfg.kind : "evm", program: "program" in cfg ? cfg.program : undefined, chainId: cfg.chainId, game: cfg.game, rpcUrl: cfg.rpcUrl, deployBlock: cfg.deployBlock?.toString() ?? null } });
  }
  static solana(cfg: SolanaConfig, log: (message: string) => void) {
    // A distinct port and schema let both chain workers use one Supabase project.
    return new SocialBridge({ kind: "solana", chainId: `solana-${cfg.net.cluster}`, game: cfg.deployment.game, program: cfg.deployment.program, rpcUrl: cfg.rpcUrl, deployBlock: null }, log, process.env.SOCIAL_SOLANA_PORT ?? "3106");
  }
  placed(placement: Placed | (Omit<Placement, "sections"> & { sections: { second: number; lo: bigint; hi: bigint; stake: bigint; rung: number }[] })) { this.worker.postMessage({ type: "placed", placement }); }
  settled(settlement: Settled | Settlement) { this.worker.postMessage({ type: "settled", settlement }); }
}
