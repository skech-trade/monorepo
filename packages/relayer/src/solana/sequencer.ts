/**
 * Pieces on Solana: checked as they arrive and answered at once, then, 350 ms into the second they open on, every
 * band priced on that second's map and each piece sent as its own transaction, all at once. One piece per
 * transaction is how Solana wants it: placements by different players write different accounts and run in
 * parallel, and the widest piece fills a transaction on its own.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { type Address, address, getAddressEncoder, getBase16Encoder } from "@solana/kit";
import { features, NICE, stepFor } from "@skech/core/dots";
import { CHANCE_ONE, momentumE6, rungE2, maxStakeE6, toE8, unitFor, withMomentum, type Section } from "@skech/core/chain";
import { betAddress, ed25519Instruction, getPlaceInstruction, getSkechErrorMessage, HORIZON, MAX_SECTIONS, pieceBytes, playerAddress, type SolanaPiece } from "@skech/contracts/solana/sdk";
import type { Engine } from "../engine";
import type { Pricer } from "../pricer";
import { report } from "../sentry";
import { verifyPrice } from "../verify";
import { customCode, type SolanaChain } from "./chain";
import type { SolanaConfig } from "./config";
import type { SolanaSettler } from "./settler";

export type SolanaPieceWire = {
  player: string;
  drawing: string;
  index: number;
  market: number;
  difficulty: number;
  openAt: string;
  perDot: number;
  unit: string;
  priceSeen: string;
  priceTime: string;
  strokeHash: string;
  sections: { second: number; lo: number; width: number; stake: number }[];
};
export type SolanaPieceMsg = { type: "piece"; piece: SolanaPieceWire; sessionSig: string; priceSig: `0x${string}`; stroke: string };

export type Band = { second: number; lo: bigint; hi: bigint; stake: bigint; rung: number };
export type Placed = { betId: Address; player: Address; drawing: string; index: number; openAt: bigint; staked: bigint; fee: bigint; refunded: bigint; sections: Band[]; tx: string };
export type Refused = { betId?: Address; player: Address; drawing: string; index: number; why: string; tx?: string };
export type Notify = { placed: (p: Placed) => void; refused: (r: Refused) => void };

type Pending = { piece: SolanaPiece; sig: Uint8Array; key: Uint8Array; receivedAt: number; bet: Address; bump: number; stake: bigint };

const hex = getBase16Encoder();
const bytesOf = (s: unknown, n?: number): Uint8Array | null => {
  if (typeof s !== "string" || !/^(0x)?([0-9a-fA-F]{2})*$/.test(s)) return null;
  const b = new Uint8Array(hex.encode(s.replace(/^0x/, "").toLowerCase()));
  return n === undefined || b.length === n ? b : null;
};
const big = (s: unknown) => (typeof s === "string" && /^\d{1,20}$/.test(s) ? BigInt(s) : null);
const u = (n: unknown, max: number) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;

export class SolanaSequencer {
  difficulty = 40;
  /** min/max per dot and the most a piece may stake, and the fee, from the game's config. */
  terms = { minPerDot: 10_000n, maxPerDot: 100_000_000n, maxPieceStake: 10_000_000_000n, maxPriceAgeMs: 15_000, feeBps: 400, profitFeeBps: 1000 };
  private buckets = new Map<number, Pending[]>();
  private seen = new Set<Address>();
  private players = new Map<Address, { at: number; balance: bigint; allowance: bigint; key: Uint8Array; validUntil: bigint }>();
  private pending = new Map<Address, bigint>();
  stats = { accepted: 0, placed: 0, refused: 0, turnedAway: {} as Record<string, number> };

  constructor(
    private readonly cfg: SolanaConfig,
    private readonly engine: Engine,
    private readonly pricer: Pricer,
    private readonly chain: SolanaChain,
    private readonly settler: SolanaSettler,
    private readonly notify: Notify,
    private readonly log: (s: string) => void,
    private readonly domain: Uint8Array,
  ) {}

  /** The grid units a piece may be on now, as on Monad: the market step's, or a round step near it. */
  units(): bigint[] | null {
    const f = features(this.engine.book.bars, Math.floor(this.engine.now() / 1000) * 1000);
    if (!f) return null;
    const want = stepFor(f.sigma, f.price);
    return NICE.filter((n) => n >= want / 2.5 && n <= want * 2.5).map((n) => toE8(unitFor(n)));
  }

  forget(player: Address) {
    this.players.delete(player);
  }
  credit(player: Address, paid: bigint) {
    const c = this.players.get(player);
    if (c && paid > 0n) c.balance += paid;
  }

  private async account(player: Address) {
    const c = this.players.get(player);
    if (c && Date.now() - c.at < 3_000) return c;
    const p = await this.chain.player(player);
    if (!p) return null;
    const v = { at: Date.now(), balance: p.balance, allowance: p.session.allowance, key: new Uint8Array(getAddressEncoder().encode(p.session.key)), validUntil: p.session.validUntil };
    this.players.set(player, v);
    return v;
  }

  async accept(msg: SolanaPieceMsg): Promise<{ ok: true; betId: Address } | { ok: false; why: string; betId?: Address }> {
    const now = Math.floor(this.engine.now());
    const bad = (why: string, betId?: Address) => {
      const k = why.replace(/\d+/g, "N");
      this.stats.turnedAway[k] = (this.stats.turnedAway[k] ?? 0) + 1;
      return { ok: false as const, why, betId };
    };
    const parsed = this.parse(msg);
    if (typeof parsed === "string") return bad(parsed);
    const { piece, sig, stroke } = parsed;
    const [bet, bump] = await betAddress(piece.player, piece.drawing, piece.index, this.cfg.deployment.program);
    if (this.seen.has(bet)) return bad("Already sent", bet);
    if (piece.market !== this.cfg.market) return bad("Unknown market", bet);
    if (piece.difficulty !== this.difficulty) return bad(`Difficulty is ${this.difficulty} now`, bet);
    if (!this.engine.ready() || !this.engine.signer || !this.engine.domain) return bad("Waiting for live prices", bet);
    const openAt = Number(piece.openAt);
    if (openAt % 1000 !== 0) return bad("Bad opening second", bet);
    if (now > openAt + this.cfg.lateMs) return bad("Too late for that second", bet);
    if (openAt > now + this.cfg.aheadMs) return bad("Your clock is ahead", bet);
    const t = this.terms;
    if (BigInt(piece.perDot) < t.minPerDot || BigInt(piece.perDot) > t.maxPerDot) return bad("Per dot out of range", bet);
    const units = this.units();
    if (!units) return bad("Waiting for live prices", bet);
    if (!units.includes(piece.unit)) return bad("Grid out of date", bet);
    const stake = piece.sections.reduce((n, s) => n + BigInt(s.stake), 0n);
    if (stake > t.maxPieceStake) return bad("Too much on one piece", bet);
    const priceTime = Number(piece.priceTime);
    if (priceTime > now + 2000 || now - priceTime > t.maxPriceAgeMs) return bad("Price seen is stale", bet);
    const receivedAt = Math.max(now, priceTime);
    if (receivedAt > openAt + this.cfg.lateMs) return bad("Too late for that second", bet);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(stroke)));
    if (!digest.every((b, i) => b === piece.strokeHash[i])) return bad("Stroke does not match", bet);
    const [priceOk, acct] = await Promise.all([
      verifyPrice(this.engine.domain, this.engine.signer, this.cfg.marketName, piece.priceSeen, piece.priceTime, msg.priceSig),
      this.account(piece.player).catch(() => null),
    ]);
    if (!priceOk) return bad("Price seen is not the engine's", bet);
    if (!acct || acct.validUntil * 1000n <= BigInt(now)) return bad("No session", bet);
    if (!ed25519.verify(sig, pieceBytes(piece), acct.key)) return bad("Not signed by your session", bet);
    const held = this.pending.get(piece.player) ?? 0n;
    if (acct.allowance < stake + held) return bad("Session allowance used up", bet);
    if (acct.balance < stake + held) return bad("Not enough in your balance", bet);

    this.seen.add(bet);
    if (this.seen.size > 50_000) this.seen.delete(this.seen.values().next().value!);
    this.pending.set(piece.player, held + stake);
    let bucket = this.buckets.get(openAt);
    if (!bucket) {
      this.buckets.set(openAt, (bucket = []));
      setTimeout(() => void this.flush(openAt), Math.max(0, openAt + this.cfg.openAfterMs - now));
    }
    bucket.push({ piece, sig, key: acct.key, receivedAt, bet, bump, stake });
    this.stats.accepted++;
    return { ok: true, betId: bet };
  }

  private parse(msg: SolanaPieceMsg): { piece: SolanaPiece; sig: Uint8Array; stroke: Uint8Array } | string {
    const w = msg.piece;
    if (!w || typeof w !== "object") return "No piece";
    let player: Address;
    try {
      player = address(w.player);
    } catch {
      return "Bad player";
    }
    const [drawing, openAt, unit, priceSeen, priceTime] = [big(w.drawing), big(w.openAt), big(w.unit), big(w.priceSeen), big(w.priceTime)];
    if (drawing === null || openAt === null || unit === null || unit === 0n || priceSeen === null || priceTime === null) return "Bad numbers";
    if (!u(w.index, 0xffffffff) || !u(w.market, 255) || !u(w.difficulty, 100) || !u(w.perDot, 0xffffffff)) return "Bad numbers";
    if (!Array.isArray(w.sections) || w.sections.length === 0 || w.sections.length > MAX_SECTIONS) return "Bad sections";
    for (const s of w.sections) {
      if (!u(s.second, HORIZON) || s.second < 1 || !u(s.lo, 0xffffffff) || !u(s.width, 0xffff) || s.width < 1 || !u(s.stake, 0xffffffff) || s.stake < 1) return "Bad section";
    }
    const strokeHash = bytesOf(w.strokeHash, 32);
    const sig = bytesOf(msg.sessionSig, 64);
    const stroke = bytesOf(msg.stroke);
    if (!strokeHash || !sig || !stroke || !bytesOf(msg.priceSig, 65)) return "Bad bytes";
    if (stroke.length > 33 + 2048 * 12) return "Stroke too long";
    const piece: SolanaPiece = {
      domain: this.domain,
      player,
      drawing,
      index: w.index,
      market: w.market,
      difficulty: w.difficulty,
      openAt,
      perDot: w.perDot,
      unit,
      priceSeen,
      priceTime,
      strokeHash,
      sections: w.sections.map((s) => ({ second: s.second, lo: s.lo, width: s.width, stake: s.stake })),
    };
    return { piece, sig, stroke };
  }

  /** A piece's bands as the chain takes them, in prices: for the pricer, and to say what was placed. */
  private bandsOf(p: SolanaPiece): Section[] {
    return p.sections.map((s) => ({ second: s.second, lo: BigInt(s.lo) * p.unit, hi: BigInt(s.lo + s.width) * p.unit, stake: BigInt(s.stake) }));
  }

  /** What placing `n` bands costs, and the program's search for the bet's bump, down from 255. */
  private computeFor(n: number, bump: number) {
    const c = this.cfg.compute;
    const at = c.place_1 + ((c.place_32 - c.place_1) * (n - 1)) / 31 + c.place_per_bump * (255 - bump);
    return Math.ceil(at * 1.2) + 2_000;
  }

  private async flush(openAt: number) {
    const bucket = this.buckets.get(openAt) ?? [];
    this.buckets.delete(openAt);
    if (!bucket.length) return;
    const release = (e: Pending) => {
      const left = (this.pending.get(e.piece.player) ?? 0n) - e.stake;
      if (left > 0n) this.pending.set(e.piece.player, left);
      else this.pending.delete(e.piece.player);
    };
    const f = features(this.engine.book.bars, openAt);
    if (!f) {
      for (const e of bucket) {
        release(e);
        this.refuse(e, "No price to open on");
      }
      return;
    }
    const price = toE8(f.price);
    const momentum = momentumE6(f.momentum);
    await Promise.all(
      bucket.map(async (e) => {
        const p = e.piece;
        try {
          const fl = await this.pricer.fieldFor(f, openAt, Number(p.unit) / 1e8, this.difficulty);
          const bands = this.bandsOf(p);
          const chances = this.pricer.chances(fl, bands, openAt);
          if (chances.some((c) => c < 0 || c > CHANCE_ONE)) throw new Error("a chance out of range");
          const bytes = pieceBytes(p);
          const place = getPlaceInstruction({
            // The piece first: its `player` and `market` are the wallet and the market id, which the accounts below replace.
            ...p,
            payer: this.chain.signer,
            oracle: this.chain.signer,
            game: this.cfg.deployment.game,
            market: this.cfg.deployment.market,
            bars: this.cfg.deployment.bars,
            pool: this.cfg.deployment.pool,
            player: await playerAddress(p.player, this.cfg.deployment.program),
            bet: e.bet,
            playerArg: p.player,
            marketArg: p.market,
            price,
            momentum: BigInt(momentum),
            receivedAt: BigInt(e.receivedAt),
            chances,
          });
          // The compute budget's two instructions come first: the signature check is third, the placement fourth.
          const sent = await this.chain.send(`place ${e.bet}`, [ed25519Instruction(e.key, e.sig, 3, bytes.length), place], this.computeFor(p.sections.length, e.bump));
          if (sent.err) {
            const code = customCode(sent.err);
            this.refuse(e, code !== null ? (getSkechErrorMessage(code as Parameters<typeof getSkechErrorMessage>[0]) ?? `Refused (${code})`) : "Not placed", sent.signature);
            return;
          }
          // What the chain placed: from its event, or worked out as the program works it out if the event is slow.
          const ev = (await this.chain.events(sent.signature)).find((x) => x.name === "Placed")?.data as { staked: bigint; fee: bigint; refunded: bigint; sections: Band[] } | undefined;
          const placed = ev ?? this.predict(p, bands, chances, price, momentum);
          this.stats.placed++;
          const c = this.players.get(p.player);
          if (c) {
            c.balance -= placed.staked;
            c.allowance -= placed.staked;
          }
          for (const s of placed.sections) this.settler.watch(e.bet, p.player, p.unit, { second: openAt + s.second * 1000, lo: s.lo, hi: s.hi, stake: s.stake, rung: s.rung });
          this.notify.placed({ betId: e.bet, player: p.player, drawing: String(p.drawing), index: p.index, openAt: BigInt(openAt), staked: placed.staked, fee: placed.fee, refunded: placed.refunded, sections: placed.sections, tx: sent.signature });
        } catch (err) {
          this.log(`place ${e.bet} at ${openAt}: ${String((err as Error).message ?? err).split("\n")[0]}`);
          report("place", err);
          this.refuse(e, "Could not reach the chain");
        } finally {
          release(e);
        }
      }),
    );
  }

  /** The bands the program keeps, and what it takes, worked out with the same ladder. */
  private predict(p: SolanaPiece, bands: Section[], chances: number[], price: bigint, momentum: number) {
    const sections: Band[] = [];
    let total = 0n;
    for (const [i, b] of bands.entries()) {
      total += b.stake;
      if (this.settler.posted(Number(p.openAt) + b.second * 1000)) continue;
      const rung = rungE2(chances[i], p.difficulty, withMomentum(b.lo, b.hi, price, momentum), momentum);
      if (!rung) continue;
      const most = maxStakeE6(BigInt(p.perDot), rung);
      sections.push({ second: b.second, lo: b.lo, hi: b.hi, stake: b.stake < most ? b.stake : most, rung });
    }
    const staked = sections.reduce((n, s) => n + s.stake, 0n);
    // The fee is rounded up, as the program takes it.
    return { staked, fee: (staked * BigInt(this.terms.feeBps) + 9_999n) / 10_000n, refunded: total - staked, sections };
  }

  private refuse(e: Pending, why: string, tx?: string) {
    this.stats.refused++;
    this.notify.refused({ betId: e.bet, player: e.piece.player, drawing: String(e.piece.drawing), index: e.piece.index, why, tx });
  }
}
