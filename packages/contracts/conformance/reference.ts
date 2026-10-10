/**
 * The game's rules as both contracts state them, written a third time, plainly, on `@skech/core`'s ladder (the
 * integers the app prices with): what each step of a case must do. `SkechGame.sol` and `programs/skech` are held
 * to what this says, number for number.
 */
import { crosses, grossE6, MAX_SECTION_WIDTH, maxStakeE6, MIN_DIFFICULTY, rungE2, withinFee, withMomentum } from "@skech/core/chain";
import type { Case, Step } from "./cases";

export const HORIZON = 30;
export const MAX_SECTIONS = 32;
export const LATE_MS = 200;
export const MAX_PRICE_AGE_MS = 15_000;
export const MIN_PER_DOT = 10_000;
export const MAX_PER_DOT = 10_000_000;
export const MAX_PIECE_STAKE = 1_000_000_000;
export const DEFAULT_PER_DOT = 100_000;
const BPS = 10_000n;
/** The house's share, rounded up: a stake or profit split small never slips under the fee. */
const feeOf = (amount: bigint, bps: number) => (amount * BigInt(bps) + BPS - 1n) / BPS;

/* ---- SKT (Solana only): the holders' share of the fees, and what a new net loss mints (programs/skech/src/skt.rs) ---- */

const SKT_PER_USDC = 100n;
const ACC_SCALE = 10n ** 18n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** The holders' part of a fee taken at `feeBps` on `amount`: their bps of it, rounded down. */
export const holderPart = (amount: bigint, holderBps: number, feeBps: number) => (amount * BigInt(Math.min(holderBps, feeBps))) / BPS;
/**
 * SKT e6 a basis mints from tracked gain `from`: the integral of `100 · S² / (S + g)²` from `from` to `from + basis`,
 * `100 · S² · (1/(S+from) − 1/(S+from+basis))`, the first term rounded down and the second up.
 */
export function mintAmount(scale: bigint, from: bigint, basis: bigint): bigint {
  if (basis <= 0n || scale <= 0n) return 0n;
  const k = SKT_PER_USDC * scale * scale;
  const d = k / (scale + from) - ceilDiv(k, scale + from + basis);
  return d > 0n ? d : 0n;
}
const CHANCE_ONE = 1_000_000_000n;
/** What a band that missed counts toward SKT: `stake · (1 − p·m) / (1 − p)`, rounded down. */
export function missBasis(stake: bigint, chanceE9: number, rungE2: number): bigint {
  const p = BigInt(chanceE9);
  if (p >= CHANCE_ONE) return 0n;
  const edge = 100n * CHANCE_ONE - p * BigInt(rungE2);
  return edge > 0n ? (stake * edge) / (100n * (CHANCE_ONE - p)) : 0n;
}
/** What each SKT holder has, in a case's state. */
export type HolderState = { skt: string; basis: number; claimable: number };
export type SktState = { supply: string; acc: string; holderFunds: number; gain: number; holders: Record<string, HolderState> };

export type Band = { second: number; lo: number; hi: number; stake: number; rung: number };
export type PlaceOut = { ok: true; sections: Band[]; staked: number; fee: number; refunded: number } | { ok: false; refused: string };
export type Settled = { id: string; hitMask: number; missMask: number; paid: number; owed: number };
export type State = { balance: Record<string, number>; allowance: Record<string, number>; pool: number; fees: number; owed: Record<string, number>; houseOwed: number; skt?: SktState };
export type StepOut = { place?: PlaceOut; settled?: Settled[]; difficulty?: { ok: true } | { ok: false; refused: string }; claimed?: number; state: State };

type Bet = { player: string; unit: number; sections: Band[]; chances: number[]; live: number; hit: number };

/** Which chain's rules: Solana does not offer ink that returns more than the stake fee leaves (`withinFee`), nor a
 * band taller than the widest pen (`MAX_SECTION_WIDTH`); the EVM game, retired, does. */
export type Chain = "evm" | "solana";

export function run(c: Case, chain: Chain = "evm"): StepOut[] {
  const players = Object.keys(c.players);
  const balance: Record<string, bigint> = {};
  const allowance: Record<string, bigint> = {};
  const owed: Record<string, bigint> = {};
  for (const p of players) {
    const cfg = c.players[p as "a" | "b"]!;
    balance[p] = BigInt(cfg.deposit);
    allowance[p] = BigInt(cfg.allowance);
    owed[p] = 0n;
  }
  let pool = 0n;
  let fees = 0n;
  let houseOwed = 0n;
  let marketDifficulty = c.difficulty;
  const posted = new Map<number, { prevClose: bigint; high: bigint; low: bigint; close: bigint }>();
  const bets = new Map<string, Bet>();
  // SKT, in a case that has it.
  const skt = c.skt;
  let supply = 0n;
  let acc = 0n;
  let holderFunds = 0n;
  let gain = 0n;
  const holders: Record<string, { skt: bigint; accAt: bigint; unclaimed: bigint; basis: bigint }> = {};
  for (const p of players) holders[p] = { skt: 0n, accAt: 0n, unclaimed: 0n, basis: 0n };
  const earned = (h: (typeof holders)[string]) => (acc > h.accAt && h.skt > 0n ? (h.skt * (acc - h.accAt)) / ACC_SCALE : 0n);
  const settleRewards = (h: (typeof holders)[string]) => {
    h.unclaimed += earned(h);
    h.accAt = acc;
  };
  const owing = () => Object.values(owed).some((x) => x > 0n) || houseOwed > 0n;
  const accrue = (amount: bigint) => {
    acc += (amount * ACC_SCALE) / supply;
    holderFunds += amount;
  };
  /** The holders' share of a stake's fee: to the pool while anything is owed, the treasury while there is no SKT. */
  const shareStakeFee = (amount: bigint) => {
    if (!amount) return;
    if (owing()) pool += amount;
    else if (supply === 0n) fees += amount;
    else accrue(amount);
  };
  /** The holders' share of a profit's fee: out of what the pool has left, or left in it while anything is owed. */
  const shareProfitFee = (amount: bigint) => {
    const taken = amount < pool ? amount : pool;
    if (!taken || owing()) return;
    pool -= taken;
    if (supply === 0n) fees += taken;
    else accrue(taken);
  };
  /** A settlement's basis mints, from the tracked gain on (from 0 while anything was owed), and moves the gain on. */
  const mint = (who: string, basis: bigint, ious: boolean) => {
    if (!basis) return;
    const h = holders[who];
    const minted = mintAmount(BigInt(skt!.mintScale), ious ? 0n : gain, basis);
    gain += basis;
    settleRewards(h);
    h.skt += minted;
    h.basis += basis;
    supply += minted;
  };
  const state = (): State => ({
    balance: Object.fromEntries(players.map((p) => [p, Number(balance[p])])),
    allowance: Object.fromEntries(players.map((p) => [p, Number(allowance[p])])),
    pool: Number(pool),
    fees: Number(fees),
    owed: Object.fromEntries(players.map((p) => [p, Number(owed[p])])),
    houseOwed: Number(houseOwed),
    ...(skt
      ? {
          skt: {
            supply: String(supply),
            acc: String(acc),
            holderFunds: Number(holderFunds),
            gain: Number(gain),
            holders: Object.fromEntries(players.map((p) => [p, { skt: String(holders[p].skt), basis: Number(holders[p].basis), claimable: Number(holders[p].unclaimed + earned(holders[p])) }])),
          },
        }
      : {}),
  });
  /** In USDC as far as the pool goes, the rest owed. */
  const pay = (who: string, due: bigint) => {
    const paid = due < pool ? due : pool;
    pool -= paid;
    const left = due - paid;
    balance[who] += paid;
    owed[who] += left;
    return { paid, owed: left };
  };
  /** The house's cut, after the player, from what the pool has left: never owed. */
  const cut = (fee: bigint) => {
    const taken = fee < pool ? fee : pool;
    pool -= taken;
    fees += taken;
  };

  const out: StepOut[] = [];
  for (const step of c.steps as Step[]) {
    if ("claim" in step) {
      // What the player's SKT earned, into their balance.
      const h = holders[step.claim];
      settleRewards(h);
      const amount = h.unclaimed;
      h.unclaimed = 0n;
      holderFunds -= amount;
      balance[step.claim] += amount;
      out.push({ claimed: Number(amount), state: state() });
    } else if ("difficulty" in step) {
      // The least is 50: under it, ink exactly on a rung returns more than a dollar.
      const ok = step.difficulty >= MIN_DIFFICULTY && step.difficulty <= 100;
      if (ok) marketDifficulty = step.difficulty;
      out.push({ difficulty: ok ? { ok } : { ok, refused: "BadDifficulty" }, state: state() });
    } else if ("place" in step) {
      const s = step.place;
      const who = s.player ?? "a";
      const refuse = (why: string): StepOut => ({ place: { ok: false, refused: why }, state: state() });
      const difficulty = s.difficulty ?? c.difficulty;
      const perDot = s.perDot ?? DEFAULT_PER_DOT;
      const received = s.received ?? -400;
      const priceAge = s.priceAge ?? 100;
      // In the contracts' order of checks.
      if (bets.has(s.id)) {
        out.push(refuse("Replay"));
        continue;
      }
      if (difficulty !== marketDifficulty) {
        out.push(refuse("Difficulty"));
        continue;
      }
      if (received > LATE_MS) {
        out.push(refuse("Late"));
        continue;
      }
      if (priceAge > MAX_PRICE_AGE_MS) {
        out.push(refuse("StalePrice"));
        continue;
      }
      if (perDot < MIN_PER_DOT || perDot > MAX_PER_DOT) {
        out.push(refuse("PerDot"));
        continue;
      }
      const total = s.sections.reduce((n, x) => n + x.stake, 0);
      if (!s.sections.length || s.sections.length > MAX_SECTIONS || s.sections.some((x) => x.second < 1 || x.second > HORIZON || x.width < 1 || (chain === "solana" && x.width > MAX_SECTION_WIDTH) || x.stake < 1) || total > MAX_PIECE_STAKE) {
        out.push(refuse("Sections"));
        continue;
      }
      const momentum = s.momentum ?? 0;
      const bands: Band[] = [];
      const chances: number[] = [];
      for (const x of s.sections) {
        const lo = x.lo * c.unit;
        const hi = (x.lo + x.width) * c.unit;
        if (posted.has(x.second)) continue;
        const rung = rungE2(x.chance, difficulty, withMomentum(BigInt(lo), BigInt(hi), BigInt(c.price), momentum), momentum);
        if (!rung || (chain === "solana" && !withinFee(x.chance, rung, c.feeBps))) continue;
        const most = Number(maxStakeE6(BigInt(perDot), rung));
        bands.push({ second: x.second, lo, hi, stake: Math.min(x.stake, most), rung });
        chances.push(x.chance);
      }
      const kept = BigInt(bands.reduce((n, b) => n + b.stake, 0));
      if (kept === 0n) {
        out.push(refuse("NotOffered"));
        continue;
      }
      if (allowance[who] < kept) {
        out.push(refuse("Allowance"));
        continue;
      }
      if (balance[who] < kept) {
        out.push(refuse("Balance"));
        continue;
      }
      const fee = feeOf(kept, c.feeBps);
      const toHolders = skt ? holderPart(kept, skt.holderFeeBps, c.feeBps) : 0n;
      balance[who] -= kept;
      allowance[who] -= kept;
      pool += kept - fee;
      fees += fee - toHolders;
      shareStakeFee(toHolders);
      bets.set(s.id, { player: who, unit: c.unit, sections: bands, chances, live: (1 << bands.length) - 1, hit: 0 });
      out.push({ place: { ok: true, sections: bands, staked: Number(kept), fee: Number(fee), refunded: total - Number(kept) }, state: state() });
    } else {
      const b = step.bar;
      posted.set(b.second, { prevClose: BigInt(b.prevClose), high: BigInt(b.high), low: BigInt(b.low), close: BigInt(b.close) });
      const settled: Settled[] = [];
      for (const id of b.settle) {
        const bet = bets.get(id);
        if (!bet) continue;
        let hits = 0;
        let decided = 0;
        let gross = 0n;
        let stakeHit = 0n;
        let basis = 0n;
        bet.sections.forEach((x, i) => {
          const bit = 1 << i;
          if (!(bet.live & bit)) return;
          const bar = posted.get(x.second);
          if (!bar) return;
          decided |= bit;
          if (crosses(bar, BigInt(x.lo), BigInt(x.hi), BigInt(bet.unit))) {
            hits |= bit;
            stakeHit += BigInt(x.stake);
            gross += grossE6(BigInt(x.stake), x.rung);
          } else basis += missBasis(BigInt(x.stake), bet.chances[i], x.rung);
        });
        if (!decided) continue;
        bet.live &= ~decided;
        bet.hit |= hits;
        const ious = owing();
        let paid = 0n;
        let left = 0n;
        if (gross > 0n) {
          const profitFee = feeOf(gross - stakeHit, c.profitFeeBps);
          ({ paid, owed: left } = pay(bet.player, gross - profitFee));
          const toHolders = skt ? holderPart(gross - stakeHit, skt.holderProfitFeeBps, c.profitFeeBps) : 0n;
          cut(profitFee - toHolders);
          shareProfitFee(toHolders);
        }
        if (skt) mint(bet.player, basis, ious);
        settled.push({ id, hitMask: hits, missMask: decided & ~hits, paid: Number(paid), owed: Number(left) });
      }
      out.push({ settled, state: state() });
    }
  }
  return out;
}
