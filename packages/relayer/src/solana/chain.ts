/**
 * The relayer's hand on Solana: one keypair that pays every fee and rent and signs as the oracle; a blockhash and a
 * priority fee kept fresh in the background, so sending never waits for either; v0 transactions through the lookup
 * table; and a send loop that rebroadcasts until the transaction lands or its blockhash runs out, since an RPC
 * forwards a transaction once and a busy leader can drop it.
 */
import {
  type Address,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  type KeyPairSigner,
  partiallySignTransactionMessageWithSigners,
  pipe,
  type Rpc,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import { fetchAddressLookupTable } from "@solana-program/address-lookup-table";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import {
  fetchGame,
  fetchMarket,
  fetchMaybePlayer,
  fetchPool,
  type Game,
  getBarPostedEventDecoder,
  getDepositedEventDecoder,
  getOwedEventDecoder,
  getPlacedEventDecoder,
  getRedeemedEventDecoder,
  getSettledEventDecoder,
  type Player,
  type Pool,
  BAR_POSTED_EVENT_DISCRIMINATOR,
  DEPOSITED_EVENT_DISCRIMINATOR,
  OWED_EVENT_DISCRIMINATOR,
  PLACED_EVENT_DISCRIMINATOR,
  REDEEMED_EVENT_DISCRIMINATOR,
  SETTLED_EVENT_DISCRIMINATOR,
  playerAddress,
} from "@skech/contracts/solana/sdk";
import type { SolanaConfig } from "./config";

type Blockhash = { blockhash: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0]["blockhash"]; lastValidBlockHeight: bigint };
export type Sent = { signature: Signature; slot: bigint; err: unknown | null };

const EVENTS = [
  ["Placed", PLACED_EVENT_DISCRIMINATOR, getPlacedEventDecoder()],
  ["Settled", SETTLED_EVENT_DISCRIMINATOR, getSettledEventDecoder()],
  ["Owed", OWED_EVENT_DISCRIMINATOR, getOwedEventDecoder()],
  ["Redeemed", REDEEMED_EVENT_DISCRIMINATOR, getRedeemedEventDecoder()],
  ["Deposited", DEPOSITED_EVENT_DISCRIMINATOR, getDepositedEventDecoder()],
  ["BarPosted", BAR_POSTED_EVENT_DISCRIMINATOR, getBarPostedEventDecoder()],
] as const;
export type SolanaEvent = { name: (typeof EVENTS)[number][0]; data: Record<string, unknown> };

const b64 = getBase64Encoder();
const same = (a: Uint8Array | { readonly [i: number]: number; length: number }, b: { readonly [i: number]: number; length: number }) => a.length === b.length && Array.from({ length: a.length }).every((_, i) => a[i] === b[i]);

/** The program's custom error code in a transaction error, if it is one. */
export function customCode(err: unknown): number | null {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  const c = (ie?.[1] as { Custom?: number | bigint } | undefined)?.Custom;
  return c === undefined ? null : Number(c);
}

export class SolanaChain {
  readonly rpc: Rpc<SolanaRpcApi>;
  signer!: KeyPairSigner;
  private table: Record<Address, Address[]> = {};
  private hash: Blockhash | null = null;
  private height = 0n;
  /** Micro-lamports per compute unit, from what recent blocks paid to write the pool. */
  priority = 0;
  /** Built transactions awaiting a wallet's signature: their message, so only what we built is ever co-signed. */
  private built = new Map<string, { message: Uint8Array; at: number; kind: string; player: Address }>();
  inflight = 0;
  stats = { sent: 0, landed: 0, failed: 0, expired: 0, rebroadcasts: 0 };

  constructor(readonly cfg: SolanaConfig, private readonly log: (s: string) => void) {
    this.rpc = createSolanaRpc(cfg.rpcUrl);
  }

  async start() {
    this.signer = await createKeyPairSignerFromBytes(this.cfg.keyBytes);
    const t = await fetchAddressLookupTable(this.rpc, this.cfg.deployment.lookupTable);
    this.table = { [this.cfg.deployment.lookupTable]: [...t.data.addresses] };
    await Promise.all([this.refreshHash(), this.refreshPriority()]);
    setInterval(() => void this.refreshHash().catch((e) => this.log(`blockhash: ${String(e).split("\n")[0]}`)), 2_000);
    setInterval(() => void this.refreshPriority().catch(() => {}), 5_000);
  }

  private async refreshHash() {
    const [{ value }, height] = await Promise.all([this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send(), this.rpc.getBlockHeight({ commitment: "confirmed" }).send()]);
    this.hash = value;
    this.height = height;
  }

  private async refreshPriority() {
    if (this.cfg.priorityFixed !== null) {
      this.priority = this.cfg.priorityFixed;
      return;
    }
    const fees = await this.rpc.getRecentPrioritizationFees([this.cfg.deployment.pool]).send();
    const paid = fees.map((f) => Number(f.prioritizationFee)).sort((a, b) => a - b);
    // What three quarters of recent blocks paid to write the pool, and a floor so a quiet chain still lands quickly.
    const p75 = paid.length ? paid[Math.floor(paid.length * 0.75)] : 0;
    this.priority = Math.min(this.cfg.priorityMax, Math.max(1_000, p75));
  }

  private message(instructions: Instruction[], computeUnits: number) {
    if (!this.hash) throw new Error("no blockhash yet");
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(this.hash!, m),
      (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: computeUnits }), getSetComputeUnitPriceInstruction({ microLamports: BigInt(this.priority) }), ...instructions], m),
    );
    return compressTransactionMessageUsingAddressLookupTables(msg, this.table);
  }

  /** Send and wait for it to land (confirmed), rebroadcasting meanwhile. The error, if it failed on chain. */
  async send(label: string, instructions: Instruction[], computeUnits: number): Promise<Sent> {
    const tx = await partiallySignTransactionMessageWithSigners(this.message(instructions, computeUnits));
    return this.broadcast(label, getBase64EncodedWireTransaction(tx), getSignatureFromTransaction(tx), this.hash!.lastValidBlockHeight);
  }

  private async broadcast(label: string, wire: Base64EncodedWireTransaction, signature: Signature, lastValid: bigint): Promise<Sent> {
    this.inflight++;
    this.stats.sent++;
    const push = () => this.rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true, maxRetries: 0n }).send().catch(() => undefined);
    try {
      await push();
      for (let i = 0; ; i++) {
        await Bun.sleep(i < 10 ? 200 : 400);
        const { value } = await this.rpc.getSignatureStatuses([signature]).send();
        const s = value[0];
        if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
          if (s.err) this.stats.failed++;
          else this.stats.landed++;
          return { signature, slot: s.slot, err: s.err };
        }
        if (this.height > lastValid) {
          this.stats.expired++;
          throw new Error(`${label}: expired unconfirmed (${signature})`);
        }
        // Rebroadcast every 800 ms until it lands: the RPC forwards once, and leaders drop under load.
        if (i % 4 === 3) {
          this.stats.rebroadcasts++;
          void push();
        }
      }
    } finally {
      this.inflight--;
    }
  }

  /** The program's events in a landed transaction, from its logs. */
  async events(signature: Signature): Promise<SolanaEvent[]> {
    for (let i = 0; i < 5; i++) {
      const tx = await this.rpc.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
      if (tx) {
        const out: SolanaEvent[] = [];
        for (const line of tx.meta?.logMessages ?? []) {
          if (!line.startsWith("Program data: ")) continue;
          const bytes = b64.encode(line.slice(14));
          for (const [name, disc, dec] of EVENTS) {
            if (same(bytes.subarray(0, 8), disc)) out.push({ name, data: dec.decode(bytes) as unknown as Record<string, unknown> });
          }
        }
        return out;
      }
      if (i < 4) await Bun.sleep(300);
    }
    return [];
  }

  /* ---- transactions a wallet signs, which the relayer pays for ---- */

  /**
   * A transaction for a player's wallet to sign (the relayer's own signature already on it, as fee payer): what it
   * is kept, so `submit` co-signs nothing but this.
   */
  async build(kind: string, player: Address, instructions: Instruction[], computeUnits: number): Promise<{ id: string; tx: string }> {
    const tx = await partiallySignTransactionMessageWithSigners(this.message(instructions, computeUnits));
    const id = crypto.randomUUID();
    this.built.set(id, { message: new Uint8Array(tx.messageBytes), at: Date.now(), kind, player });
    for (const [k, v] of this.built) if (Date.now() - v.at > 120_000) this.built.delete(k);
    return { id, tx: getBase64EncodedWireTransaction(tx) };
  }

  /** The same transaction back, signed by the wallet: sent if it is exactly what was built. */
  async submit(id: string, signed: string): Promise<{ kind: string; player: Address; sent: Sent }> {
    const b = this.built.get(id);
    if (!b) throw new Error("Unknown or expired transaction: build it again");
    const tx = getTransactionDecoder().decode(b64.encode(signed));
    if (!same(new Uint8Array(tx.messageBytes), b.message)) throw new Error("Not the transaction that was built");
    if (Object.values(tx.signatures).some((s) => !s)) throw new Error("Not signed by every signer");
    this.built.delete(id);
    const wire = getBase64Decoder().decode(getTransactionEncoder().encode(tx)) as Base64EncodedWireTransaction;
    const signature = getSignatureFromTransaction(tx);
    const sent = await this.broadcast(b.kind, wire, signature, this.hash!.lastValidBlockHeight + 150n);
    return { kind: b.kind, player: b.player, sent };
  }

  /* ---- reading ---- */

  game(): Promise<Game> {
    return fetchGame(this.rpc, this.cfg.deployment.game).then((a) => a.data);
  }
  pool(): Promise<Pool> {
    return fetchPool(this.rpc, this.cfg.deployment.pool).then((a) => a.data);
  }
  difficulty(): Promise<number> {
    return fetchMarket(this.rpc, this.cfg.deployment.market).then((a) => a.data.difficulty);
  }
  async player(wallet: Address): Promise<Player | null> {
    const a = await fetchMaybePlayer(this.rpc, await playerAddress(wallet, this.cfg.deployment.program));
    return a.exists ? a.data : null;
  }
  async lamports(): Promise<bigint> {
    return (await this.rpc.getBalance(this.signer.address).send()).value;
  }
}
