import { getPlacedEventDecoder, getSettledEventDecoder, PLACED_EVENT_DISCRIMINATOR, SETTLED_EVENT_DISCRIMINATOR } from "@skech/contracts/solana/sdk";
import type { SocialConfig } from "./indexer";
import type { SocialStore } from "./store";
import type { PublicDrawing } from "@skech/core/social";

type SignatureRow = { signature: string; err: unknown; blockTime: number | null };
/** Solana stores the stroke hash on chain. Receipt recovery restores accounting; live ingestion retains geometry. */
export async function indexSolana(cfg: SocialConfig, store: SocialStore, changed: (drawing: PublicDrawing | null, kind: "placed" | "settled", event: string) => void, status: (counting: boolean, progress: number) => void, log: (message: string) => void) {
  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Solana RPC ${response.status}`);
    const result = await response.json() as { result: T; error?: { message: string } };
    if (result.error) throw new Error(result.error.message);
    return result.result;
  }
  async function ingest(row: SignatureRow) {
    if (row.err) return;
    const tx = await rpc<{ meta: { err: unknown; logMessages: string[] | null }; blockTime: number | null } | null>("getTransaction", [row.signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }]);
    if (!tx) throw new Error("A Solana receipt is unavailable; history recovery will retry");
    if (tx.meta.err) return;
    const stack: string[] = [];
    for (const line of tx.meta.logMessages ?? []) {
      const invoke = /^Program (\w+) invoke/.exec(line);
      if (invoke) { stack.push(invoke[1]); continue; }
      if (/^Program \w+ (success|failed)/.test(line)) { stack.pop(); continue; }
      if (!line.startsWith("Program data: ") || stack.at(-1) !== cfg.program) continue;
      const bytes = Buffer.from(line.slice(14), "base64");
      const at = (tx.blockTime ?? row.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
      if (bytes.subarray(0, 8).equals(Buffer.from(PLACED_EVENT_DISCRIMINATOR))) {
        const p = getPlacedEventDecoder().decode(bytes);
        const drawing = await store.place({ betId: p.bet, player: p.player, drawing: p.drawing.toString(), openAt: p.openAt, staked: p.staked, unit: p.unit, sections: p.sections.map(s => ({ ...s, lo: s.lo.toString(), hi: s.hi.toString(), stake: s.stake.toString() })), tx: row.signature });
        if (at > Date.now() - 120_000) changed(drawing, "placed", `${row.signature}:${p.bet}`);
      } else if (bytes.subarray(0, 8).equals(Buffer.from(SETTLED_EVENT_DISCRIMINATOR))) {
        const s = getSettledEventDecoder().decode(bytes);
        const drawing = await store.settle({ betId: s.bet, player: s.player, hitMask: s.hitMask, missMask: s.missMask, paid: s.paid, owed: s.owed, tx: row.signature, at });
        if (at > Date.now() - 120_000) changed(drawing, "settled", `${row.signature}:${s.bet}:${s.hitMask}:${s.missMask}`);
      }
    }
  }
  let head = await store.meta("solana_head");
  let before = await store.meta("solana_backfill");
  for (;;) {
    try {
      if (!head) {
        status(true, 0);
        const rows = await rpc<SignatureRow[]>("getSignaturesForAddress", [cfg.game, { limit: 100, ...(before ? { before } : {}), commitment: "confirmed" }]);
        if (!before && rows.length) await store.setMeta("solana_initial_head", rows[0].signature);
        for (const row of [...rows].reverse()) await ingest(row);
        if (rows.length < 100) { head = await store.meta("solana_initial_head"); if (head) await store.setMeta("solana_head", head); before = null; status(false, 1); }
        else { before = rows.at(-1)!.signature; await store.setMeta("solana_backfill", before); }
      } else {
        // Page until the saved head, so an outage never silently drops a busy interval.
        let cursor: string | undefined, newest: string | undefined;
        for (;;) {
          const rows = await rpc<SignatureRow[]>("getSignaturesForAddress", [cfg.game, { limit: 100, until: head, ...(cursor ? { before: cursor } : {}), commitment: "confirmed" }]);
          newest ??= rows[0]?.signature;
          for (const row of [...rows].reverse()) await ingest(row);
          if (rows.length < 100) break;
          cursor = rows.at(-1)!.signature;
        }
        if (newest) { head = newest; await store.setMeta("solana_head", head); }
        status(false, 1);
      }
      await Bun.sleep(head ? 1000 : 100);
    } catch (error) { log(`Solana history: ${String((error as Error).message).split("\n")[0]}`); await Bun.sleep(5000); }
  }
}
