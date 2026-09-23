import { directionAt } from "@skech/core/shape";
import { describe, expect, test } from "bun:test";
import type { Candle } from "./market";
import { type Pt, quote, SAMPLES, settle, shapeOf } from "./sketch";
import { liquidationPrice, MAINNET, MARGIN, roundSize, TESTNET, tradeable, wipeoutMove } from "./venue";

/**
 * The file that decides money, pinned by the properties that have to hold
 * whatever the model becomes. Not snapshots of today's figures: the model is
 * going to change to one net position per round, and a snapshot would only
 * record the old answer.
 */

const ENTRY = 64_000;

test("500ms candles preserve the simulated fill delay in real seconds", () => {
  const shape = shapeOf(line(ENTRY * 1.004), ENTRY);
  expect(shape).not.toBeNull();
  const seconds = settle(walk(ENTRY, ENTRY * 1.004, 60), shape!, ENTRY, 100, 10, 60);
  const halves = settle(walk(ENTRY, ENTRY * 1.004, 120), shape!, ENTRY, 100, 10, 120, undefined, 0.5);
  expect(halves.net).toBeCloseTo(seconds.net, 8);
});

/** A line from the entry through these prices, evenly spaced across the round. */
const line = (...prices: number[]): Pt[] => [{ t: 0, price: ENTRY }, ...prices.map((price, i) => ({ t: (i + 1) / prices.length, price }))];

/** Candles that walk straight from `from` to `to` over `n` of them, with no wick. */
function walk(from: number, to: number, n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = from + ((to - from) * i) / n;
    const c = from + ((to - from) * (i + 1)) / n;
    out.push({ t: i, o, c, h: Math.max(o, c), l: Math.min(o, c), v: 1 });
  }
  return out;
}

describe("a loss never exceeds the stake", () => {
  for (const leverage of [1, 5, 20, 50]) {
    test(`at ${leverage}x, however far it runs the wrong way`, () => {
      const shape = shapeOf(line(ENTRY * 1.02), ENTRY);
      expect(shape).not.toBeNull();
      // Straight down, hard: ten percent against a long.
      const book = settle(walk(ENTRY, ENTRY * 0.9, 60), shape as never, ENTRY, 100, leverage, 60);
      expect(book.net).toBeGreaterThanOrEqual(-100);
    });
  }
});

describe("the quote agrees with the settlement", () => {
  test("when the market traces the line exactly", () => {
    const pts = line(ENTRY * 1.004);
    const shape = shapeOf(pts, ENTRY);
    expect(shape).not.toBeNull();
    const q = quote(shape as never, ENTRY, 100, 10);
    const book = settle(walk(ENTRY, ENTRY * 1.004, 60), shape as never, ENTRY, 100, 10, 60);
    // Fills land half a candle late, so they are close rather than equal.
    expect(Math.abs(book.net - q.ifWorks)).toBeLessThan(Math.abs(q.ifWorks) * 0.2 + 0.5);
  });

  test("a stop you set becomes the most you can lose", () => {
    const shape = shapeOf(line(ENTRY * 1.01), ENTRY);
    expect(quote(shape as never, ENTRY, 100, 50, { lose: 25, gain: null }).mostLose).toBe(25);
    // And it never claims a stop protects more than the stake does.
    expect(quote(shape as never, ENTRY, 100, 50, { lose: 500, gain: null }).mostLose).toBe(100);
  });

  test("a target you set caps what it says you can make", () => {
    const shape = shapeOf(line(ENTRY * 1.05), ENTRY);
    const open = quote(shape as never, ENTRY, 100, 50).ifWorks;
    expect(quote(shape as never, ENTRY, 100, 50, { lose: null, gain: 10 }).ifWorks).toBe(10);
    expect(open).toBeGreaterThan(10);
  });

  test("and the most you can lose is the stake, at every leverage", () => {
    const shape = shapeOf(line(ENTRY * 1.01), ENTRY);
    for (const leverage of [1, 10, 50]) {
      expect(quote(shape as never, ENTRY, 100, leverage).mostLose).toBe(100);
    }
  });
});

describe("the liquidation price is where equity reaches maintenance margin", () => {
  for (const leverage of [2, 10, 50]) {
    test(`at ${leverage}x, long and short`, () => {
      const stake = 100;
      for (const dir of [1, -1] as const) {
        const liq = liquidationPrice(ENTRY, stake, leverage, dir);
        const q = (stake * leverage) / ENTRY;
        // Equity at that price, against what the venue must still hold.
        const equity = stake + dir * q * (liq - ENTRY);
        expect(equity).toBeCloseTo(MARGIN.maintenance * q * liq, 6);
      }
    });
  }

  test("and it sits the right side of the entry", () => {
    expect(liquidationPrice(ENTRY, 100, 10, 1)).toBeLessThan(ENTRY);
    expect(liquidationPrice(ENTRY, 100, 10, -1)).toBeGreaterThan(ENTRY);
  });

  test("and more leverage brings it closer", () => {
    const near = ENTRY - liquidationPrice(ENTRY, 100, 50, 1);
    const far = ENTRY - liquidationPrice(ENTRY, 100, 2, 1);
    expect(near).toBeLessThan(far);
  });
});

describe("the exits are honoured", () => {
  const shape = shapeOf(line(ENTRY * 1.02), ENTRY);

  test("a stop caps the loss at what was asked for", () => {
    const book = settle(walk(ENTRY, ENTRY * 0.95, 60), shape as never, ENTRY, 100, 10, 60, { lose: 25, gain: null });
    expect(book.done).toBe("stop");
    expect(book.net).toBeCloseTo(-25, 6);
  });

  test("a target banks the gain that was asked for", () => {
    const book = settle(walk(ENTRY, ENTRY * 1.05, 60), shape as never, ENTRY, 100, 10, 60, { lose: null, gain: 40 });
    expect(book.done).toBe("target");
    expect(book.net).toBeCloseTo(40, 6);
  });

  test("and without them the round runs to the clock", () => {
    const book = settle(walk(ENTRY, ENTRY * 1.001, 60), shape as never, ENTRY, 100, 10, 60);
    expect(book.done).toBeNull();
  });

  test("a stop the market never reaches changes nothing", () => {
    const calm = walk(ENTRY, ENTRY * 1.001, 60);
    const withStop = settle(calm, shape as never, ENTRY, 100, 10, 60, { lose: 90, gain: null });
    const without = settle(calm, shape as never, ENTRY, 100, 10, 60);
    expect(withStop.net).toBeCloseTo(without.net, 6);
  });
});

describe("sizes the venue would actually accept", () => {
  test("round down to the step, never up", () => {
    expect(roundSize(0.123456789)).toBe(0.12345);
    expect(roundSize(0.000069)).toBe(0.00006);
  });

  test("both floors are enforced, not just the size", () => {
    for (const m of [MAINNET, TESTNET]) {
      expect(tradeable(20 / ENTRY, ENTRY, m)).toBe(true);
      expect(tradeable(9 / ENTRY, ENTRY, m)).toBe(false);
      expect(tradeable(m.minBase / 2, ENTRY, m)).toBe(false);
    }
  });

  test("asking for exactly the minimum notional is rejected, because rounding down loses it", () => {
    // $10 at $64k is 0.00015625 BTC, which rounds down to 0.00015, which is
    // $9.60. Anything sized off the venue's own floor has to ask for a little
    // more than the floor or it will be turned away.
    expect(tradeable(MAINNET.minQuote / ENTRY, ENTRY, MAINNET)).toBe(false);
    expect(roundSize(MAINNET.minQuote / ENTRY, MAINNET) * ENTRY).toBeLessThan(MAINNET.minQuote);
  });

  test("testnet is a different market with a different floor", () => {
    // Found the hard way: an order sized for mainnet is rejected on testnet
    // and the error says nothing useful about why.
    expect(TESTNET.id).not.toBe(MAINNET.id);
    expect(TESTNET.minBase).toBeGreaterThan(MAINNET.minBase);
    // 0.00017 BTC is $10.88, over the notional floor both share, but under
    // testnet's size floor of 0.0002 and over mainnet's of 0.00007.
    expect(tradeable(0.00017, ENTRY, MAINNET)).toBe(true);
    expect(tradeable(0.00017, ENTRY, TESTNET)).toBe(false);
  });
});

describe("the shape reads the line the way the bar describes it", () => {
  test("a line that ends above the entry is a long", () => {
    expect(shapeOf(line(ENTRY * 0.99, ENTRY * 1.02), ENTRY)?.long).toBe(true);
  });

  test("and one that ends below it is a short", () => {
    expect(shapeOf(line(ENTRY * 1.01, ENTRY * 0.98), ENTRY)?.long).toBe(false);
  });

  test("a single point is not a line", () => {
    expect(shapeOf([{ t: 0, price: ENTRY }], ENTRY)).toBeNull();
  });
});

describe("the round is one position, not one per leg", () => {
  /** Up, down, up: three legs, so three positions under the old model. */
  const zigzag = () => shapeOf(line(ENTRY * 1.01, ENTRY * 0.99, ENTRY * 1.015), ENTRY);

  test("a zigzag still cannot lose more than the stake", () => {
    const shape = zigzag();
    expect(shape?.legs.length).toBeGreaterThan(1);
    const book = settle(walk(ENTRY, ENTRY * 0.9, 60), shape as never, ENTRY, 100, 50, 60);
    expect(book.net).toBeGreaterThanOrEqual(-100);
  });

  test("and a stop on a zigzag still caps the loss where it was set", () => {
    const book = settle(walk(ENTRY, ENTRY * 0.94, 60), zigzag() as never, ENTRY, 100, 20, 60, { lose: 30, gain: null });
    expect(book.done).toBe("stop");
    expect(book.net).toBeCloseTo(-30, 6);
  });

  test("liquidation happens where the venue would do it, not before", () => {
    const shape = shapeOf(line(ENTRY * 1.02), ENTRY);
    /*
      At fifty times, initial margin is 2% and maintenance is 1.2%, so the
      position is gone on a move of about 0.81% against it. Bitcoin does that
      several times on an ordinary day.
    */
    const survives = settle(walk(ENTRY, ENTRY * 0.995, 60), shape as never, ENTRY, 100, 50, 60);
    expect(survives.done).not.toBe("liquidated");
    const wiped = settle(walk(ENTRY, ENTRY * 0.99, 60), shape as never, ENTRY, 100, 50, 60);
    expect(wiped.done).toBe("liquidated");
    expect(wiped.net).toBe(-100);
  });

  test("and lower leverage really does buy room", () => {
    const shape = shapeOf(line(ENTRY * 1.02), ENTRY);
    // The same 1% move that wipes a 50x position leaves a 5x one alive.
    expect(settle(walk(ENTRY, ENTRY * 0.99, 60), shape as never, ENTRY, 100, 5, 60).done).not.toBe("liquidated");
  });

  test("a flat market books roughly nothing, at any leverage", () => {
    const flat = walk(ENTRY, ENTRY, 60);
    for (const leverage of [1, 10, 50]) {
      expect(Math.abs(settle(flat, zigzag() as never, ENTRY, 100, leverage, 60).net)).toBeLessThan(0.01);
    }
  });
});

describe("the move that wipes you out", () => {
  test("agrees with the liquidation price at every leverage", () => {
    for (const leverage of [2, 5, 10, 20, 50]) {
      const fromPrice = 1 - liquidationPrice(ENTRY, 100, leverage, 1) / ENTRY;
      expect(wipeoutMove(leverage)).toBeCloseTo(fromPrice, 9);
    }
  });

  test("and more leverage always leaves less room", () => {
    expect(wipeoutMove(50)).toBeLessThan(wipeoutMove(10));
    expect(wipeoutMove(10)).toBeLessThan(wipeoutMove(2));
  });

  test("the number the screen shows people", () => {
    expect(wipeoutMove(50) * 100).toBeCloseTo(0.81, 2);
    expect(wipeoutMove(10) * 100).toBeCloseTo(8.91, 2);
  });
});


test("every drawn turn trades, and the page reads each one the way execution does", () => {
  const entry = 86159;
  // A $6 rise, a $26 dip, then up: every reversal is well over 8% of the line's own height.
  const shape = shapeOf([
    { t: 0, price: entry }, { t: 0.355, price: 86165 },
    { t: 0.712, price: 86139 }, { t: 0.86, price: 86167 },
    { t: 1, price: 86185 },
  ], entry)!;
  expect(shape.legs.map((l) => l.dir)).toEqual([1, -1, 1]);
  // The candle a turn lands on belongs to the leg the venue is in at that moment.
  const bars = 114;
  for (const leg of shape.legs) {
    const at = Math.round((leg.from / (SAMPLES - 1)) * bars);
    expect(directionAt(shape.legs, at, bars)).toBe(leg.dir);
  }
});

test("a line drawn long–short–long–short on a quiet chart is four trades, not one", () => {
  // The round that traded as one long: turns of $7 to $16 on an $86k market.
  const pts = [[0, 86451.2], [0.149, 86462.4], [0.241, 86455.3], [0.339, 86471.8], [0.507, 86461.2], [0.547, 86477.2], [0.78, 86465.4], [1, 86489.1]].map(([t, price]) => ({ t, price }));
  expect(shapeOf(pts, 86451.25)!.legs.map((l) => l.dir)).toEqual([1, -1, 1, -1, 1, -1, 1]);
});

test("jitter on a nearly flat line is still not a turn", () => {
  const pts = Array.from({ length: 40 }, (_, i) => ({ t: i / 39, price: 86000 + (i % 2 ? 0.3 : -0.3) }));
  const shape = shapeOf(pts, 86000);
  expect(shape === null || shape.flat).toBe(true);
});

test("a small dip between two rises is a turn, and it trades where it was drawn", () => {
  // The round that lost two flips: an $18 dip read as $12 by a 32-sample reading, under the wobble filter.
  const pts = [[0, 85772], [0.22, 85831], [0.294, 85814], [0.396, 85854], [0.5, 85836], [0.572, 85876], [0.7, 85858], [0.783, 85887], [0.906, 85867], [1, 85925]].map(([t, price]) => ({ t, price }));
  const shape = shapeOf(pts, 85772)!;
  expect(shape.legs.map((l) => l.dir)).toEqual([1, -1, 1, -1, 1, -1, 1, -1, 1]);
  // Each turn within half a percent of the round of where it was drawn.
  const drawn = [0.22, 0.294, 0.396, 0.5, 0.572, 0.7, 0.783, 0.906];
  shape.legs.slice(1).forEach((l, i) => expect(Math.abs(l.from / (SAMPLES - 1) - drawn[i])).toBeLessThan(0.005));
});
