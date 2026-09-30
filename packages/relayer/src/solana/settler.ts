/**
 * Every second with ink in it, once it is over: its bar posted and every bet in it settled, in one transaction, or a
 * few when many bets have ink there (a transaction holds a dozen). Then, when nothing is about to be due: IOUs paid
 * off as the pool refills, USDC that landed in approving wallets swept in, and the fees moved to the treasury.
 */
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { fetchMaybeToken, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { CLOSE_AFTER_MS } from "@skech/core/bars";
import { fetchBars, getCollectFeesInstruction, getPostBarAndSettleInstruction, getRedeemHouseInstruction, getRedeemInstruction, getSettleInstruction, getSweepInstruction, playerAddress } from "@skech/contracts/solana/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Engine } from "../engine";
import { report } from "../sentry";
import type { SolanaChain } from "./chain";
import type { SolanaConfig } from "./config";
import type { Band } from "./sequencer";

export type Settled = { betId: Address; player: Address; hitMask: number; missMask: number; paid: bigint; owed: bigint; closed: boolean; tx: string };
export type Notify = { settled: (s: Settled) => void; owed: (to: Address, value: bigint) => void; account: (player: Address) => void };

type Live = { player: Address; unit: bigint; bands: Band[] };
type State = { bets: { bet: Address; player: Address; unit: string; bands: { second: number; lo: string; hi: string; stake: string; rung: number }[] }[]; holders: Address[]; approved: Address[]; posted: Record<string, string> };

/** Every share a holder has: redeem takes what the pool can pay of it. */
const ALL = (1n << 128n) - 1n;

export class SolanaSettler {
  private bets = new Map<Address, Live>();
  private watching = new Map<number, Set<Address>>();
  /** The close we posted for each second, so the next follows on from it exactly. */
  private closes = new Map<number, bigint>();
  private holders = new Set<Address>();
  /** Wallets that approved the game to sweep their USDC in. */
  private approved = new Set<Address>();
  private running = false;
  private sweeping = false;
  private lastSweep = 0;
  private told = new Map<Address, number>();
  stats = { bars: 0, settled: 0, redeemed: 0n, swept: 0n, collected: 0n };

  constructor(
    private readonly cfg: SolanaConfig,
    private readonly engine: Engine,
    private readonly chain: SolanaChain,
    private readonly notify: Notify,
    private readonly log: (s: string) => void,
    private readonly statePath: string,
  ) {
    this.load();
  }

  watchers() {
    return this.watching.size;
  }
  posted(second: number) {
    return this.closes.has(second);
  }
  owed(holder: Address) {
    this.holders.add(holder);
  }
  approve(wallet: Address) {
    this.approved.add(wallet);
  }

  watch(bet: Address, player: Address, unit: bigint, band: Band) {
    let b = this.bets.get(bet);
    if (!b) this.bets.set(bet, (b = { player, unit, bands: [] }));
    b.bands.push(band);
    let at = this.watching.get(band.second);
    if (!at) this.watching.set(band.second, (at = new Set()));
    at.add(bet);
  }

  private forget(second: number) {
    for (const bet of this.watching.get(second) ?? []) {
      const b = this.bets.get(bet);
      if (!b) continue;
      b.bands = b.bands.filter((x) => x.second !== second);
      if (!b.bands.length) this.bets.delete(bet);
    }
    this.watching.delete(second);
  }

  async start() {
    // The chain's own ring: what was posted before a restart, so the next bar follows on from it.
    const ring = await fetchBars(this.chain.rpc, this.cfg.deployment.bars).catch(() => null);
    for (const b of ring?.data.ring ?? []) if (b.second > 0n) this.closes.set(Number(b.second), b.close);
    setInterval(() => void this.tick(), 100);
    setInterval(() => this.save(), 5_000);
  }

  private computeFor(bets: number, bar: boolean) {
    const c = this.cfg.compute;
    const perBet = (c.post_and_settle_4_mixed - c.post_bar) / 4;
    return Math.ceil(((bar ? c.post_bar : 4_000) + perBet * bets) * 1.25) + 5_000;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.engine.now();
      const due = [...this.watching.keys()].filter((s) => s + 1000 + CLOSE_AFTER_MS <= now).sort((a, b) => a - b).slice(0, 4);
      for (const second of due) if (this.engine.ready()) await this.post(second);
      const soon = [...this.watching.keys()].some((s) => s + 1000 + CLOSE_AFTER_MS <= now + 1500);
      const since = Date.now() - this.lastSweep;
      if (since > this.cfg.sweepEveryMs && (!soon || since > 4 * this.cfg.sweepEveryMs)) {
        this.lastSweep = Date.now();
        void this.sweep();
      }
    } catch (e) {
      this.log(`settle: ${String((e as Error).message ?? e).split("\n")[0]}`);
      report("settle", e);
    } finally {
      this.running = false;
    }
  }

  private async pairs(bets: Address[]) {
    const out: { address: Address; role: AccountRole }[] = [];
    for (const bet of bets) {
      const b = this.bets.get(bet)!;
      out.push({ address: bet, role: AccountRole.WRITABLE }, { address: await playerAddress(b.player, this.cfg.deployment.program), role: AccountRole.WRITABLE });
    }
    return out;
  }

  private async post(second: number) {
    const b = this.engine.book.at(second);
    if (!b) {
      if (this.engine.book.bars[0] && this.engine.book.bars[0].t > second) {
        this.log(`settle: no bar for ${second}, before this relayer's history; dropping its watch`);
        this.forget(second);
      }
      return;
    }
    const prevClose = this.closes.get(second - 1000) ?? BigInt(Math.round((this.engine.book.at(second - 1000)?.c ?? b.c) * 1e8));
    const bar = { second: BigInt(second), prevClose, high: BigInt(Math.round(b.h * 1e8)), low: BigInt(Math.round(b.l * 1e8)), close: BigInt(Math.round(b.c * 1e8)) };
    const bets = [...(this.watching.get(second) ?? [])].filter((x) => this.bets.has(x));
    const d = this.cfg.deployment;
    const chunks: Address[][] = [];
    for (let i = 0; i < Math.max(1, bets.length); i += this.cfg.betsPerSettle) chunks.push(bets.slice(i, i + this.cfg.betsPerSettle));
    // The bar with the first dozen bets; the rest settle on it right after, in parallel: they meet only on the pool.
    const first = getPostBarAndSettleInstruction({ oracle: this.chain.signer, game: d.game, marketAccount: d.market, bars: d.bars, pool: d.pool, rentReceiver: this.chain.signer.address, market: this.cfg.market, bar });
    const withBets = (ix: Instruction, extra: { address: Address; role: AccountRole }[]): Instruction => ({ ...ix, accounts: [...(ix.accounts ?? []), ...extra] });
    const sent = await this.chain.send(`bar ${second} + ${chunks[0].length} bets`, [withBets(first, await this.pairs(chunks[0]))], this.computeFor(chunks[0].length, true));
    if (sent.err) throw new Error(`bar ${second}: ${JSON.stringify(sent.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    this.closes.set(second, bar.close);
    if (this.closes.size > 4000) for (const k of [...this.closes.keys()].sort((a, c) => a - c).slice(0, 1000)) this.closes.delete(k);
    this.stats.bars++;
    const rest = await Promise.all(
      chunks.slice(1).map(async (chunk) => {
        const ix = getSettleInstruction({ game: d.game, bars: d.bars, pool: d.pool, rentReceiver: this.chain.signer.address, market: this.cfg.market });
        return this.chain.send(`settle ${chunk.length} on ${second}`, [withBets(ix, await this.pairs(chunk))], this.computeFor(chunk.length, false));
      }),
    );
    this.forget(second);
    for (const s of [sent, ...rest]) if (!s.err) void this.tell(s.signature).catch((e) => this.log(`settle ${second}: ${String((e as Error).message ?? e).split("\n")[0]}`));
  }

  /** Tell each player what their bets did, from the settlement's events. */
  private async tell(signature: Parameters<SolanaChain["events"]>[0]) {
    const touched = new Set<Address>();
    for (const ev of await this.chain.events(signature)) {
      if (ev.name === "Settled") {
        const a = ev.data as { bet: Address; player: Address; hitMask: number; missMask: number; paid: bigint; owed: bigint; closed: boolean };
        this.stats.settled++;
        if (a.paid > 0n || a.owed > 0n || Date.now() - (this.told.get(a.player) ?? 0) > 5_000) touched.add(a.player);
        this.notify.settled({ betId: a.bet, player: a.player, hitMask: a.hitMask, missMask: a.missMask, paid: a.paid, owed: a.owed, closed: a.closed, tx: signature });
      } else if (ev.name === "Owed") {
        const a = ev.data as { to: Address; value: bigint };
        if (a.to !== "11111111111111111111111111111111") this.holders.add(a.to);
        this.notify.owed(a.to, a.value);
      }
    }
    for (const p of touched) {
      this.told.set(p, Date.now());
      this.notify.account(p);
    }
  }

  /** Pay off what is owed as far as the pool goes, the house behind the players; sweep deposits in; move fees out. */
  private async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    const d = this.cfg.deployment;
    try {
      let pool = await this.chain.pool();
      for (const holder of this.holders) {
        if (pool.pool === 0n) break;
        const p = await this.chain.player(holder);
        if (!p || p.iouShares === 0n) {
          this.holders.delete(holder);
          continue;
        }
        const ix = getRedeemInstruction({ caller: this.chain.signer, game: d.game, pool: d.pool, holder: await playerAddress(holder, d.program), shares: ALL });
        const s = await this.chain.send(`redeem ${holder}`, [ix], 30_000);
        if (!s.err) this.notify.account(holder);
        pool = await this.chain.pool();
      }
      if (pool.houseShares > 0n && pool.pool > 0n) await this.chain.send("redeem house", [getRedeemHouseInstruction({ game: d.game, pool: d.pool })], 30_000);
      for (const wallet of this.approved) await this.sweepIn(wallet);
      pool = await this.chain.pool();
      if (pool.fees >= this.cfg.collectAboveE6) {
        const ix = getCollectFeesInstruction({ game: d.game, pool: d.pool, vault: d.vault, treasury: d.treasury, usdcMint: d.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        const s = await this.chain.send(`collect ${pool.fees} fees`, [ix], 40_000);
        if (!s.err) this.stats.collected += pool.fees;
      }
    } catch (e) {
      this.log(`sweep: ${String((e as Error).message ?? e).split("\n")[0]}`);
      report("sweep", e);
    } finally {
      this.sweeping = false;
    }
  }

  /** Move what landed in `wallet` into its balance, on the approval it gave: from the sweep, or when its app asks. */
  async sweepIn(wallet: Address): Promise<bigint> {
    const d = this.cfg.deployment;
    const [ata] = await findAssociatedTokenPda({ mint: d.usdcMint, owner: wallet, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const t = await fetchMaybeToken(this.chain.rpc, ata);
    if (!t.exists || t.data.delegate.__option !== "Some" || t.data.delegate.value !== d.game) {
      this.approved.delete(wallet);
      return 0n;
    }
    this.approved.add(wallet);
    const amount = t.data.amount < t.data.delegatedAmount ? t.data.amount : t.data.delegatedAmount;
    if (amount === 0n) return 0n;
    const ix = getSweepInstruction({ game: d.game, player: await playerAddress(wallet, d.program), from: ata, vault: d.vault, usdcMint: d.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const s = await this.chain.send(`sweep ${amount} for ${wallet}`, [ix], 40_000);
    if (s.err) return 0n;
    this.stats.swept += amount;
    this.notify.account(wallet);
    return amount;
  }

  /* ---- what survives a restart ---- */

  private load() {
    if (!existsSync(this.statePath)) return;
    try {
      const s = JSON.parse(readFileSync(this.statePath, "utf8")) as State;
      for (const b of s.bets) for (const band of b.bands) this.watch(b.bet, b.player, BigInt(b.unit), { second: band.second, lo: BigInt(band.lo), hi: BigInt(band.hi), stake: BigInt(band.stake), rung: band.rung });
      for (const h of s.holders) this.holders.add(h);
      for (const a of s.approved ?? []) this.approved.add(a);
      for (const [second, close] of Object.entries(s.posted)) this.closes.set(Number(second), BigInt(close));
      this.log(`settle: restored ${this.watching.size} seconds to settle, ${this.holders.size} IOU holders, ${this.approved.size} approvals`);
    } catch (e) {
      this.log(`settle: could not read ${this.statePath}: ${String(e)}`);
      report("state-read", e);
    }
  }

  save() {
    const s: State = { bets: [], holders: [...this.holders], approved: [...this.approved], posted: {} };
    for (const [bet, b] of this.bets) s.bets.push({ bet, player: b.player, unit: b.unit.toString(), bands: b.bands.map((x) => ({ second: x.second, lo: x.lo.toString(), hi: x.hi.toString(), stake: x.stake.toString(), rung: x.rung })) });
    for (const [second, close] of [...this.closes].slice(-600)) s.posted[second] = close.toString();
    try {
      writeFileSync(this.statePath, JSON.stringify(s));
    } catch (e) {
      this.log(`settle: could not write ${this.statePath}: ${String(e)}`);
      report("state-write", e);
    }
  }
}
