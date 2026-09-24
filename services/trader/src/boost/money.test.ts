import { describe, expect, test } from "bun:test";
import { micro, settle, settleAt, share } from "./money";

const S = micro(10);
const B = micro(50);

test("a win: 70% of the profit to the user, 30% and the boost to skech", () => {
  const s = settle(S, B, micro(63), 0.3, 0.01);
  expect(s.pnl).toBe(micro(3));
  expect(s.cut).toBe(micro(0.9));
  expect(s.user).toBe(micro(12.1));
  expect(s.skech).toBe(micro(50.9));
  expect(s.fee).toBe(0n);
});

test("a small loss: the user carries it and pays 1% of the stake", () => {
  const s = settle(S, B, micro(57), 0.3, 0.01);
  expect(s.user).toBe(micro(6.9));
  expect(s.fee).toBe(micro(0.1));
  expect(s.skech).toBe(micro(50.1));
  expect(s.gap).toBe(0n);
});

test("closed at 80%: two dollars left, less the fee", () => {
  const s = settle(S, B, micro(52), 0.3, 0.01);
  expect(s.user).toBe(micro(1.9));
  expect(s.skech).toBe(micro(50.1));
});

test("past the stake: the user loses exactly the stake, skech the rest, and no fee is invented", () => {
  const s = settle(S, B, micro(46.5), 0.3, 0.01);
  expect(s.user).toBe(0n);
  expect(s.fee).toBe(0n);
  expect(s.gap).toBe(micro(3.5));
  expect(s.skech).toBe(micro(46.5));
});

test("an empty lane: nothing back to anybody", () => {
  const s = settle(S, B, 0n, 0.3, 0.01);
  expect(s.user).toBe(0n);
  expect(s.skech).toBe(0n);
  expect(s.gap).toBe(B);
});

test("every equity splits into exactly what the lane held, never below zero", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < 20000; i++) {
    const stake = micro(10 + Math.floor(rand() * 90));
    const boost = stake * 5n;
    const equity = BigInt(Math.floor(rand() * Number(stake + boost) * 1.6));
    const s = settle(stake, boost, equity, 0.3, 0.01);
    expect(s.user + s.skech).toBe(equity);
    expect(s.user >= 0n && s.skech >= 0n).toBe(true);
    expect(s.user <= stake + (s.pnl > 0n ? s.pnl : 0n)).toBe(true);
  }
});

test("shares are exact in basis points", () => {
  expect(share(micro(3), 0.3)).toBe(micro(0.9));
  expect(share(micro(10), 0.01)).toBe(micro(0.1));
});

describe("settling on the chart's result, as testnet does", () => {
  test("a flat line pays the stake back less nothing, whatever the spread cost skech", () => {
    // The chart says flat; the venue's fills lost $12.78 to testnet's spread.
    const s = settleAt(micro(10), micro(50), micro(47.22), 0n, 0.3, 0.01);
    expect(s.user).toBe(micro(10));
    expect(s.user + s.skech).toBe(s.equity);
    expect(s.pnl).toBe(micro(-12.78));
  });

  test("a loss on the chart is the user's first, and the round's stop is $8 of it", () => {
    const s = settleAt(micro(10), micro(50), micro(40), micro(-8), 0.3, 0.01);
    expect(s.user).toBe(micro(1.9));
    expect(s.fee).toBe(micro(0.1));
    expect(s.user + s.skech).toBe(micro(40));
  });

  test("a win on the chart pays 70% of it even when the venue booked less", () => {
    const s = settleAt(micro(10), micro(50), micro(58), micro(20), 0.3, 0.01);
    expect(s.user).toBe(micro(24));
    expect(s.cut).toBe(micro(6));
    // skech pays the user more than the lane made: its share goes below its boost.
    expect(s.skech).toBe(micro(34));
    expect(s.user + s.skech).toBe(micro(58));
  });

  test("always adds up to the lane, over many random rounds", () => {
    for (let i = 0; i < 5000; i++) {
      const stake = micro(10 + Math.floor(Math.random() * 16));
      const boost = stake * 5n;
      const equity = micro(Math.random() * 200);
      const reference = micro(Math.random() * 60) - micro(30);
      const s = settleAt(stake, boost, equity, reference, 0.3, 0.01);
      expect(s.user + s.skech).toBe(s.equity);
      expect(s.user >= 0n && s.user <= stake + micro(30)).toBe(true);
    }
  });
});
