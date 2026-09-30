/**
 * The conformance cases: one game, played the same way on Monad (evm/) and Solana (solana/), step by step.
 * `generate.ts` runs each through the reference model (`reference.ts`, on `@skech/core`'s ladder) and writes what
 * must come out of every step to `vectors.json`; `evm/test/Conformance.t.sol` and `solana/tests/src/conformance.rs`
 * replay the same file against the real contracts and check every number.
 *
 * Chain-neutral on purpose: a band is `lo` and `width` in grid units (Solana's own encoding; the EVM runner
 * multiplies by `unit`), stakes in USDC e6, prices in e8, seconds after the piece opens. Timing offsets are ms
 * from the opening second.
 */

export type SectionIn = { second: number; lo: number; width: number; stake: number; chance: number };
export type PlaceStep = {
  place: {
    id: string;
    player?: "a" | "b";
    perDot?: number;
    difficulty?: number;
    momentum?: number;
    sections: SectionIn[];
    /** When the oracle received it, ms from the opening second (default -400). */
    received?: number;
    /** How old the price the player saw was when received, ms (default 100). */
    priceAge?: number;
  };
};
export type BarStep = { bar: { second: number; prevClose: number; high: number; low: number; close: number; settle: string[] } };
/** The admin sets the market's difficulty: pieces from then on must be signed at it. */
export type DifficultyStep = { difficulty: number };
export type Step = PlaceStep | BarStep | DifficultyStep;
export type Case = {
  name: string;
  /** What each player has in the game, and what their session may stake. */
  players: { a: { deposit: number; allowance: number }; b?: { deposit: number; allowance: number } };
  difficulty: number;
  feeBps: number;
  profitFeeBps: number;
  /** The market: its price (e8) on the opening second, the grid (e8). */
  price: number;
  unit: number;
  steps: Step[];
};

/** $83,000.00 on a $0.20 grid: the band at the price starts at 415,000 units. */
const PRICE = 8_300_000_000_000;
const UNIT = 20_000_000;
const AT = 415_000;
const e8 = (usd: number) => Math.round(usd * 1e8);
const at = (units: number) => (AT + units) * UNIT;
const flat = (second: number, price: number, high = price, low = price) => ({ second, prevClose: price, high, low, close: price });

const std = { players: { a: { deposit: 10_000_000, allowance: 5_000_000 } }, difficulty: 51, feeBps: 200, profitFeeBps: 1000, price: PRICE, unit: UNIT };

export const CASES: Case[] = [
  {
    ...std,
    name: "a hit, then a miss, and the bet is done",
    steps: [
      { place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }, { second: 2, lo: AT + 1000, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { bar: { second: 1, prevClose: PRICE, high: PRICE + e8(0.5), low: PRICE - e8(0.2), close: PRICE + e8(0.1), settle: ["p"] } },
      { bar: { second: 2, prevClose: PRICE + e8(0.1), high: PRICE + e8(0.2), low: PRICE - e8(1), close: PRICE, settle: ["p"] } },
    ],
  },
  {
    ...std,
    name: "the ladder across chances, at the least difficulty",
    difficulty: 50,
    steps: [
      {
        place: {
          id: "p",
          difficulty: 50,
          perDot: 1_000_000,
          sections: [
            { second: 1, lo: AT, width: 5, stake: 10_000, chance: 1_000_000_000 },
            { second: 2, lo: AT, width: 5, stake: 10_000, chance: 900_000_000 },
            { second: 3, lo: AT, width: 5, stake: 10_000, chance: 333_333_333 },
            { second: 4, lo: AT, width: 5, stake: 10_000, chance: 50_000_000 },
            { second: 5, lo: AT, width: 5, stake: 10_000, chance: 7_812_500 },
            { second: 6, lo: AT, width: 5, stake: 10_000, chance: 1_000_000 },
          ],
        },
      },
    ],
  },
  {
    ...std,
    name: "near-certain ink pays its fair multiple, to the hundredth, never under 1x",
    players: { a: { deposit: 10_000_000, allowance: 5_000_000 }, b: { deposit: 30_000_000, allowance: 25_000_000 } },
    steps: [
      // Someone else's miss first, so the pool can pay every hit in full.
      { place: { id: "loser", player: "b", perDot: 1_000_000, sections: [{ second: 1, lo: AT + 5000, width: 5, stake: 5_000_000, chance: 500_000_000 }] } },
      {
        place: {
          id: "p",
          perDot: 1_000_000,
          sections: [
            { second: 1, lo: AT, width: 5, stake: 1_000_000, chance: 1_000_000_000 },
            { second: 1, lo: AT + 5, width: 5, stake: 1_000_000, chance: 990_000_000 },
            { second: 1, lo: AT - 5, width: 5, stake: 1_000_000, chance: 950_000_000 },
            { second: 1, lo: AT + 10, width: 5, stake: 1_000_000, chance: 906_000_000 },
            { second: 1, lo: AT - 10, width: 5, stake: 1_000_000, chance: 900_000_000 },
          ],
        },
      },
      // The price runs from nine units up to six down: every band is reached, so all five are hit.
      { bar: { ...flat(1, PRICE, at(9), at(-6)), settle: ["loser", "p"] } },
    ],
  },
  {
    ...std,
    name: "difficulty 100: the floor eases to 1x",
    difficulty: 100,
    steps: [{ place: { id: "p", difficulty: 100, sections: [{ second: 1, lo: AT, width: 5, stake: 20_000, chance: 950_000_000 }, { second: 2, lo: AT, width: 5, stake: 20_000, chance: 20_000_000 }] } }],
  },
  {
    ...std,
    name: "momentum takes its margin off the side the price moved toward only",
    steps: [
      {
        place: {
          id: "p",
          momentum: 1_500_000,
          sections: [
            { second: 3, lo: AT + 40, width: 5, stake: 20_000, chance: 123_700_000 },
            { second: 3, lo: AT - 45, width: 5, stake: 20_000, chance: 123_700_000 },
          ],
        },
      },
      { place: { id: "q", momentum: -3_000_000, sections: [{ second: 3, lo: AT - 45, width: 5, stake: 20_000, chance: 123_700_000 }, { second: 3, lo: AT + 40, width: 5, stake: 20_000, chance: 123_700_000 }] } },
    ],
  },
  {
    ...std,
    name: "a big band stakes only what 256 dots pay for; the rest is refunded",
    steps: [{ place: { id: "p", perDot: 10_000, sections: [{ second: 1, lo: AT, width: 5, stake: 4_000_000, chance: 10_000_000 }] } }],
  },
  {
    ...std,
    name: "a band with no chance is not offered; the rest goes in",
    steps: [
      { place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 0 }, { second: 2, lo: AT, width: 5, stake: 50_000, chance: 400_000_000 }] } },
      { place: { id: "q", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 0 }] } },
    ],
  },
  {
    ...std,
    name: "a band whose second is already posted is not offered",
    steps: [
      { bar: { ...flat(1, PRICE), settle: [] } },
      { place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }, { second: 2, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
    ],
  },
  {
    ...std,
    name: "bands are judged one unit wider each way, inclusive",
    steps: [
      {
        place: {
          id: "p",
          sections: [
            { second: 1, lo: AT + 10, width: 5, stake: 30_000, chance: 200_000_000 },
            { second: 1, lo: AT + 12, width: 5, stake: 30_000, chance: 200_000_000 },
            { second: 1, lo: AT - 15, width: 5, stake: 30_000, chance: 200_000_000 },
            { second: 1, lo: AT - 17, width: 5, stake: 30_000, chance: 200_000_000 },
          ],
        },
      },
      // The second runs from $83,000 up to exactly one unit under AT+10, and down to one unit over AT-15+5.
      { bar: { second: 1, prevClose: PRICE, high: at(9), low: at(-9), close: PRICE, settle: ["p"] } },
    ],
  },
  {
    ...std,
    name: "the previous close counts: a jump across the ink crosses it",
    steps: [
      { place: { id: "p", sections: [{ second: 2, lo: AT + 20, width: 5, stake: 40_000, chance: 150_000_000 }] } },
      { bar: { ...flat(1, at(30)), settle: [] } },
      { bar: { second: 2, prevClose: at(30), high: at(-5), low: at(-10), close: at(-10), settle: ["p"] } },
    ],
  },
  {
    name: "a win the pool cannot pay is owed, and so is the house's cut",
    players: { a: { deposit: 10_000_000, allowance: 5_000_000 } },
    difficulty: 51,
    feeBps: 200,
    profitFeeBps: 1000,
    price: PRICE,
    unit: UNIT,
    steps: [
      { place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 10_000_000 }] } },
      { bar: { second: 1, prevClose: PRICE, high: PRICE + e8(0.5), low: PRICE, close: PRICE, settle: ["p"] } },
    ],
  },
  {
    name: "another player's losses are what pays a winner",
    players: { a: { deposit: 10_000_000, allowance: 5_000_000 }, b: { deposit: 30_000_000, allowance: 25_000_000 } },
    difficulty: 51,
    feeBps: 200,
    profitFeeBps: 1000,
    price: PRICE,
    unit: UNIT,
    steps: [
      { place: { id: "loser", player: "b", perDot: 1_000_000, sections: [{ second: 1, lo: AT + 5000, width: 5, stake: 20_000_000, chance: 900_000_000 }] } },
      { place: { id: "winner", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 10_000_000 }] } },
      { bar: { second: 1, prevClose: PRICE, high: PRICE + e8(0.5), low: PRICE, close: PRICE, settle: ["loser", "winner"] } },
    ],
  },
  {
    ...std,
    name: "fees round up, so dust stakes and small profits still pay them",
    players: { a: { deposit: 10_000_000, allowance: 5_000_000 }, b: { deposit: 30_000_000, allowance: 25_000_000 } },
    steps: [
      { place: { id: "loser", player: "b", perDot: 1_000_000, sections: [{ second: 1, lo: AT + 5000, width: 5, stake: 1_000_000, chance: 500_000_000 }] } },
      // A stake of 49 at 2%: 0.98 of a fee, taken as 1. Hit at 1.5x, 73 back: a profit of 24 at 10%, 2.4, taken as 3.
      { place: { id: "dust", sections: [{ second: 1, lo: AT, width: 5, stake: 49, chance: 500_000_000 }] } },
      { bar: { second: 1, prevClose: PRICE, high: PRICE + e8(0.3), low: PRICE, close: PRICE, settle: ["loser", "dust"] } },
    ],
  },
  {
    ...std,
    name: "fees at their bounds",
    feeBps: 2000,
    profitFeeBps: 5000,
    steps: [
      { place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 99_999, chance: 250_000_000 }] } },
      { bar: { second: 1, prevClose: PRICE, high: PRICE + e8(0.3), low: PRICE, close: PRICE, settle: ["p"] } },
    ],
  },
  {
    ...std,
    name: "refusals, and nothing moves for them",
    steps: [
      { place: { id: "difficulty", difficulty: 60, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "late", received: 201, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "stale", priceAge: 15_001, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "horizon", sections: [{ second: 31, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "perdot", perDot: 5_000, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "allowance", perDot: 1_000_000, sections: [{ second: 1, lo: AT, width: 5, stake: 5_000_001, chance: 500_000_000 }] } },
      { place: { id: "ok", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
      { place: { id: "ok", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
    ],
  },
  {
    ...std,
    name: "a difficulty under 50 is refused, and pieces keep to the one set",
    steps: [
      { difficulty: 49 },
      { difficulty: 0 },
      { difficulty: 101 },
      { place: { id: "at49", difficulty: 49, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 1_000_000_000 }] } },
      { difficulty: 50 },
      { place: { id: "at50", difficulty: 50, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 1_000_000_000 }] } },
      { place: { id: "at51", difficulty: 51, sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } },
    ],
  },
  {
    name: "more than the balance is refused",
    players: { a: { deposit: 40_000, allowance: 5_000_000 } },
    difficulty: 51,
    feeBps: 200,
    profitFeeBps: 1000,
    price: PRICE,
    unit: UNIT,
    steps: [{ place: { id: "p", sections: [{ second: 1, lo: AT, width: 5, stake: 50_000, chance: 500_000_000 }] } }],
  },
];
