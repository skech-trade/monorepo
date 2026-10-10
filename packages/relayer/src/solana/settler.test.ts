import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Signature } from "@solana/kit";
import type { Engine } from "../engine";
import type { SolanaChain, SolanaEvent } from "./chain";
import type { SolanaConfig } from "./config";
import { type Settled, SolanaSettler } from "./settler";

const A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as Address;
const B = "2k9WY5YR357AGVVoBW6ouFHijEypTj8953fzSdD7HfRV" as Address;
const settled = (bet: string, player: Address, missMask: number) => ({ name: "Settled", data: { bet, player, hitMask: 0, missMask, expiredMask: 0, paid: 0n, owed: 0n, closed: true } }) as SolanaEvent;
const minted = (player: Address, skt: bigint) => ({ name: "Minted", data: { player, skt, rate: 0n, basis: 0n } }) as SolanaEvent;

/** The settler's word to the apps on one settlement's events. */
async function told(events: SolanaEvent[]) {
  const dir = mkdtempSync(join(tmpdir(), "settler-"));
  const out: Settled[] = [];
  const accounts: Address[] = [];
  const chain = { events: async () => events } as unknown as SolanaChain;
  const s = new SolanaSettler({} as SolanaConfig, {} as Engine, chain, { settled: (x) => out.push(x), owed: () => {}, account: (p) => accounts.push(p) }, () => {}, join(dir, "state.json"));
  await (s as unknown as { tell: (sig: Signature) => Promise<void> }).tell("sig" as Signature);
  rmSync(dir, { recursive: true, force: true });
  return { out, accounts };
}

describe("what a settlement minted", () => {
  test("goes with the bet whose misses minted it, the Minted just before its Settled", async () => {
    const { out, accounts } = await told([minted(A, 120_000_000n), settled("bet1", A, 1), settled("bet2", B, 0), minted(A, 5n), settled("bet3", A, 1)]);
    expect(out.map((s) => [String(s.betId), s.minted])).toEqual([
      ["bet1", 120_000_000n],
      ["bet2", 0n],
      ["bet3", 5n],
    ]);
    // Their SKT changed: their account is sent again.
    expect(accounts).toContain(A);
  });

  test("is nothing for a bet that hit", async () => {
    const { out } = await told([settled("bet1", A, 0)]);
    expect(out[0].minted).toBe(0n);
  });
});
