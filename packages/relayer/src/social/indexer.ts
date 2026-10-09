import { betIdOf } from "@skech/core/chain";
import { createPublicClient, decodeFunctionData, http, parseEventLogs, type Address, type Hex } from "viem";
import gameAbi from "@skech/contracts/evm/abi/SkechGame.json";
import type { Abi } from "viem";
import type { Placement, Settlement, SocialStore } from "./store";
import type { PublicDrawing } from "@skech/core/social";

export type SocialConfig = { kind?: "evm" | "solana"; chainId: number | string; game: string; program?: string; rpcUrl: string; deployBlock: string | null };
const abi = gameAbi as Abi;

/** Rebuilds social records from receipts, including drawings submitted outside this relayer. */
export async function indexChain(cfg: SocialConfig, store: SocialStore, changed: (drawing: PublicDrawing | null, kind: "placed" | "settled", event: string) => void, status: (counting: boolean, progress: number) => void, log: (message: string) => void) {
  const client = createPublicClient({ transport: http(cfg.rpcUrl, { timeout: 10_000 }) });
  const initial = cfg.deployBlock ? BigInt(cfg.deployBlock) : await client.getBlockNumber();
  const saved = await store.meta("block");
  let from = saved ? BigInt(saved) + 1n : initial;
  let span = 99n;
  for (;;) {
    try {
      const latest = await client.getBlockNumber();
      const head = latest > 2n ? latest - 2n : 0n;
      if (from > head) { status(false, 1); await Bun.sleep(500); continue; }
      const to = from + span < head ? from + span : head;
      const events = parseEventLogs({ abi, logs: await client.getLogs({ address: cfg.game as Address, fromBlock: from, toBlock: to }), strict: false });
      const transactions = new Map<Hex, Map<string, { drawing: string; stroke: string }>>();
      const times = new Map<bigint, number>();
      for (const ev of events) {
        if (!ev.transactionHash || !ev.blockNumber || !["Placed", "Settled"].includes(ev.eventName)) continue;
        const args = ev.args as Record<string, unknown>;
        if (ev.eventName === "Placed") {
          let drawings = transactions.get(ev.transactionHash);
          if (!drawings) {
            drawings = new Map();
            const tx = await client.getTransaction({ hash: ev.transactionHash });
            const decoded = decodeFunctionData({ abi, data: tx.input });
            if (decoded.functionName === "place") {
              const placements = decoded.args?.[0] as { piece: { player: Address; drawing: bigint; index: number }; stroke: string }[];
              for (const p of placements) drawings.set(betIdOf(p.piece.player, p.piece.drawing, p.piece.index), { drawing: p.piece.drawing.toString(), stroke: p.stroke });
            }
            transactions.set(ev.transactionHash, drawings);
          }
          const id = args.betId as string;
          const meta = drawings.get(id);
          // Never invent a drawing group when transaction input has not been decoded.
          if (!meta) throw new Error("Could not recover the drawing identity from placement transaction");
          const sections = (args.sections as bigint[]).map(word => ({ second: Number(word & 255n), lo: ((word >> 8n) & 0xffffffffffffffffn).toString(), hi: ((word >> 72n) & 0xffffffffffffffffn).toString(), stake: ((word >> 136n) & 0xffffffffffffffffn).toString(), rung: Number((word >> 200n) & 65535n) }));
          const p: Placement = { betId: id, player: args.player as string, drawing: meta.drawing, openAt: args.openAt as bigint, staked: args.staked as bigint, unit: args.unit as bigint, stroke: meta.stroke, sections, tx: ev.transactionHash };
          const d = await store.place(p);
          if (Number(p.openAt) > Date.now() - 120_000) changed(d, "placed", `${p.tx}:${p.betId}`);
        } else {
          let at = times.get(ev.blockNumber);
          if (!at) { at = Number((await client.getBlock({ blockNumber: ev.blockNumber })).timestamp) * 1000; times.set(ev.blockNumber, at); }
          const s: Settlement = { betId: args.betId as string, player: args.player as string, hitMask: Number(args.hitMask), missMask: Number(args.missMask), paid: args.paid as bigint, owed: args.owed as bigint, tx: ev.transactionHash, at };
          const d = await store.settle(s);
          if (at > Date.now() - 120_000) changed(d, "settled", `${s.tx}:${s.betId}:${s.hitMask}:${s.missMask}`);
        }
      }
      await store.setMeta("block", to.toString());
      from = to + 1n;
      const total = head - initial + 1n;
      status(head - to > 20n, total > 0n ? Math.max(0, Math.min(1, Number((to - initial + 1n) * 1000n / total) / 1000)) : 1);
      await Bun.sleep(to === head ? 500 : 100);
    } catch (error) {
      const message = String((error as Error).message).split("\n")[0];
      if (/range|limit|too many/i.test(message) && span > 1n) span /= 2n;
      log(`indexer retry: ${message.replace(/https?:\/\/\S+/g, "[RPC]")}`);
      await Bun.sleep(3000);
    }
  }
}
