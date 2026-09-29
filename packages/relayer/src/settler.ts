/**
 * Every second the price is over, signed and posted, and every bet with ink
 * in it settled, in one transaction. Then the IOUs: whoever is owed is paid
 * off as the pool refills, and the house's fees are moved out.
 */
import { CLOSE_AFTER_MS } from "@skech/core/bars";
import { TYPES } from "@skech/core/chain";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import type { ChainClient } from "./chain";
import type { Config } from "./config";
import type { Engine } from "./engine";
import { type Band, type LiveBet, type PostedBar, predictSettle } from "./predict";

export type Settled = { betId: Hex; player: Address; hitMask: number; missMask: number; paid: bigint; owed: bigint; tx: Hex };
export type Notify = { settled: (s: Settled) => void; owed: (to: Address, value: bigint) => void; account: (player: Address) => void };

/** A bet still being settled: whose it is, its grid, and its bands not yet decided (null: not known, restored from an old state file). */
type Live = { player: Address; unit: bigint; bands: Band[] | null };
type BandJson = { second: number; lo: string; hi: string; stake: string; rung: number };
type State = {
  bets?: { betId: Hex; player: Address; unit: string; bands: BandJson[] }[];
  /** The old format: bets by second, bands unknown. */
  watch?: Record<string, { betId: Hex; player: Address }[]>;
  holders: Address[];
  posted: Record<string, string>;
};

export class Settler {
  /** Every bet with a band still to be decided. */
  private bets = new Map<Hex, Live>();
  /** Seconds with ink in them: the bets to settle once each is over. */
  private watching = new Map<number, Set<Hex>>();
  /** The close we posted for each second, so the next second follows on from it exactly. */
  private posted = new Map<number, bigint>();
  private holders = new Set<Address>();
  private running = false;
  private sweeping = false;
  private lastSweep = 0;
  /** The house's cut of profits, from the chain's config: what a hit is due depends on it. */
  profitFeeBps = 1000n;
  stats = { bars: 0, settled: 0, redeemed: 0n, collected: 0n };

  constructor(
    private readonly cfg: Config,
    private readonly engine: Engine,
    private readonly chain: ChainClient,
    private readonly notify: Notify,
    private readonly log: (s: string) => void,
    private readonly statePath: string,
  ) {
    if (cfg.revenue) this.holders.add(cfg.revenue);
    this.load();
  }

  watchers() {
    return this.watching.size;
  }

  /** A band of `betId`, as the chain placed it (its second in ms). */
  watch(betId: Hex, player: Address, unit: bigint, band: Band) {
    let bet = this.bets.get(betId);
    if (!bet) this.bets.set(betId, (bet = { player, unit, bands: [] }));
    bet.bands?.push(band);
    let at = this.watching.get(band.second);
    if (!at) this.watching.set(band.second, (at = new Set()));
    at.add(betId);
  }

  /** A second is posted: its bands are decided, whatever they did. */
  private forget(second: number) {
    for (const betId of this.watching.get(second) ?? []) {
      const bet = this.bets.get(betId);
      if (!bet) continue;
      if (bet.bands) bet.bands = bet.bands.filter((b) => b.second !== second);
      const stillWatched = [...this.watching].some(([s, ids]) => s !== second && ids.has(betId));
      if (!stillWatched) this.bets.delete(betId);
    }
    this.watching.delete(second);
  }

  owed(holder: Address) {
    this.holders.add(holder);
  }

  start() {
    setInterval(() => void this.tick(), 100);
    setInterval(() => this.save(), 5_000);
  }

  /** Post every second that is over and has ink in it, oldest first, a few at a time. */
  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.engine.now();
      const due = [...this.watching.keys()].filter((s) => s + 1000 + CLOSE_AFTER_MS <= now).sort((a, b) => a - b).slice(0, 8);
      if (due.length && this.engine.ready()) await this.post(due);
      if (Date.now() - this.lastSweep > this.cfg.sweepEveryMs) {
        this.lastSweep = Date.now();
        await this.sweep();
      }
    } catch (e) {
      this.log(`settle: ${String((e as Error).message ?? e).split("\n")[0]}`);
    } finally {
      this.running = false;
    }
  }

  private async post(seconds: number[]) {
    const bars: { market: number; second: bigint; prevClose: bigint; high: bigint; low: bigint; close: bigint }[] = [];
    const sigs: Hex[] = [];
    const bets = new Map<Hex, Address>();
    for (const second of seconds) {
      const b = this.engine.book.at(second);
      if (!b) {
        // Not in our book: the relayer came up after that second. Its bets stay live until the engine's history has it.
        if (this.engine.book.bars[0] && this.engine.book.bars[0].t > second) {
          this.log(`settle: no bar for ${second}; the second is before this relayer's history, dropping its watch`);
          this.forget(second);
        }
        continue;
      }
      // The second before's close, as the chain has it if we posted it; otherwise as our book has it now.
      let prevClose = this.posted.get(second - 1000);
      if (prevClose === undefined) {
        const onChain = await this.chain.barAt(this.cfg.market, BigInt(second - 1000)).then((r) => r[3]).catch(() => 0n);
        prevClose = onChain > 0n ? onChain : BigInt(Math.round((this.engine.book.at(second - 1000)?.c ?? b.c) * 1e8));
      }
      const bar = { market: this.cfg.market, second: BigInt(second), prevClose, high: BigInt(Math.round(b.h * 1e8)), low: BigInt(Math.round(b.l * 1e8)), close: BigInt(Math.round(b.c * 1e8)) };
      bars.push(bar);
      sigs.push(await this.chain.wallet.signTypedData({ domain: { name: "skech", version: "1", chainId: this.cfg.chainId, verifyingContract: this.cfg.game }, types: TYPES, primaryType: "Bar", message: bar }));
      for (const betId of this.watching.get(second) ?? []) bets.set(betId, this.bets.get(betId)?.player ?? ("0x" as Address));
    }
    if (!bars.length) return;
    const ids = [...bets.keys()];
    // What will happen, exactly: which bets pay, and which the pool cannot cover. The gas is for that.
    const posting = new Map<number, PostedBar>(bars.map((b) => [Number(b.second), { second: Number(b.second), prevClose: b.prevClose, high: b.high, low: b.low }]));
    const live: LiveBet[] = ids.map((betId) => {
      const bet = this.bets.get(betId);
      return { betId, unit: bet?.unit ?? 0n, bands: bet?.bands ?? null };
    });
    const ledger = this.chain.ledger;
    const will = predictSettle(live, posting, ledger.pool, this.profitFeeBps);
    const receipt = await this.chain.send(
      bars.length === 1 ? "postBarAndSettle" : "postBarsAndSettle",
      bars.length === 1 ? [bars[0], sigs[0], ids] : [bars, sigs, ids],
      `bar ${bars.map((b) => b.second).join(",")} + settle ${ids.length}`,
      { kind: "settle", bars: bars.length, bets: ids.length, liveSections: will.liveSections, hits: will.hits, ious: will.ious, coldFees: ledger.coldFees },
    );
    for (const bar of bars) {
      this.posted.set(Number(bar.second), bar.close);
      this.forget(Number(bar.second));
      this.stats.bars++;
    }
    if (this.posted.size > 4000) for (const k of [...this.posted.keys()].sort((a, b) => a - b).slice(0, 1000)) this.posted.delete(k);
    const touched = new Set<Address>();
    // The house's cut left the pool too, and no event carries it: take it off what the pool is thought to hold.
    let cuts = 0n;
    for (const ev of this.chain.events(receipt)) {
      if (ev.name === "Settled") {
        const a = ev.args as { betId: Hex; player: Address; hitMask: number; missMask: number; paid: bigint; owed: bigint };
        if (a.owed === 0n) cuts += will.due.get(a.betId)?.fee ?? 0n;
        this.stats.settled++;
        touched.add(a.player);
        this.notify.settled({ betId: a.betId, player: a.player, hitMask: Number(a.hitMask), missMask: Number(a.missMask), paid: a.paid, owed: a.owed, tx: receipt.transactionHash });
      } else if (ev.name === "Owed") {
        const a = ev.args as { to: Address; value: bigint };
        this.holders.add(a.to);
        this.notify.owed(a.to, a.value);
      }
    }
    ledger.charge(cuts);
    for (const p of touched) this.notify.account(p);
  }

  /** Pay off what is owed, as far as the pool goes, and move the fees out. */
  private async sweep() {
    if (this.sweeping || !this.cfg.iou) return;
    this.sweeping = true;
    try {
      let pool = await this.chain.pool();
      for (const holder of this.holders) {
        if (pool === 0n) break;
        const shares = await this.chain.iouBalance(holder).catch(() => 0n);
        if (shares === 0n) {
          if (holder !== this.cfg.revenue) this.holders.delete(holder);
          continue;
        }
        const value = await this.chain.iouAssets(holder).catch(() => 0n);
        // A partial redemption must be worth the chain's minimum; a full one always goes.
        if (value > pool && pool < 10_000n) continue;
        const receipt = await this.chain.send("redeem", [holder, shares], `redeem ${holder}`, { kind: "redeem" });
        for (const ev of this.chain.events(receipt)) if (ev.name === "Redeemed") this.stats.redeemed += (ev.args as { value: bigint }).value;
        this.notify.account(holder);
        pool = await this.chain.pool();
      }
      const fees = await this.chain.fees();
      if (fees >= this.cfg.collectAboveE6) {
        await this.chain.send("collectFees", [], `collect ${fees} fees`);
        this.stats.collected += fees;
      }
    } catch (e) {
      this.log(`sweep: ${String((e as Error).message ?? e).split("\n")[0]}`);
    } finally {
      this.sweeping = false;
    }
  }

  /* ---- what survives a restart: the seconds still to settle, who is owed, what we posted ---- */

  private load() {
    if (!existsSync(this.statePath)) return;
    try {
      const s = JSON.parse(readFileSync(this.statePath, "utf8")) as State;
      for (const b of s.bets ?? []) {
        for (const band of b.bands) this.watch(b.betId, b.player, BigInt(b.unit), { second: band.second, lo: BigInt(band.lo), hi: BigInt(band.hi), stake: BigInt(band.stake), rung: band.rung });
      }
      // The old format knew the seconds, not the bands: settle those assuming the worst.
      for (const [second, list] of Object.entries(s.watch ?? {})) {
        for (const w of list) {
          if (!this.bets.has(w.betId)) this.bets.set(w.betId, { player: w.player, unit: 0n, bands: null });
          let at = this.watching.get(Number(second));
          if (!at) this.watching.set(Number(second), (at = new Set()));
          at.add(w.betId);
        }
      }
      for (const h of s.holders) this.holders.add(h);
      for (const [second, close] of Object.entries(s.posted)) this.posted.set(Number(second), BigInt(close));
      this.log(`settle: restored ${this.watching.size} seconds to settle and ${this.holders.size} IOU holders`);
    } catch (e) {
      this.log(`settle: could not read ${this.statePath}: ${String(e)}`);
    }
  }

  private save() {
    const s: State = { bets: [], watch: {}, holders: [...this.holders], posted: {} };
    for (const [betId, bet] of this.bets) {
      if (bet.bands) s.bets!.push({ betId, player: bet.player, unit: bet.unit.toString(), bands: bet.bands.map((b) => ({ second: b.second, lo: b.lo.toString(), hi: b.hi.toString(), stake: b.stake.toString(), rung: b.rung })) });
    }
    for (const [second, ids] of this.watching) {
      const unknown = [...ids].filter((id) => this.bets.get(id)?.bands === null);
      if (unknown.length) s.watch![second] = unknown.map((betId) => ({ betId, player: this.bets.get(betId)!.player }));
    }
    for (const [second, close] of [...this.posted].slice(-600)) s.posted[second] = close.toString();
    try {
      writeFileSync(this.statePath, JSON.stringify(s));
    } catch (e) {
      this.log(`settle: could not write ${this.statePath}: ${String(e)}`);
    }
  }
}
