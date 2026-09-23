import { expect, test } from "bun:test";
import { isDrawing, levelOf, scorePrediction, usernameOf } from "./social-rules";

test("usernames normalize and reject reserved or malformed claims", () => {
  expect(usernameOf(" Alice_7 ")).toBe("alice_7");
  for (const x of ["admin", "API", "ab", "7alice", "a b", "x".repeat(21), null]) expect(usernameOf(x)).toBeNull();
});

test("levels are deterministic at their boundaries", () => {
  expect(levelOf(99)).toEqual({ level: 1, nextLevelAt: 100 });
  expect(levelOf(100)).toEqual({ level: 2, nextLevelAt: 250 });
});

test("points use server candles, with no stake or leverage multiplier", () => {
  const up = [{ t: 0, price: 100 }, { t: 1, price: 110 }];
  expect(scorePrediction(up, 100, [{ t: 1, o: 100, c: 105 }, { t: 1.5, o: 105, c: 110 }])).toEqual({ accuracy: 1, points: 30 });
  expect(scorePrediction(up, 100, [{ t: 1, o: 100, c: 95 }])).toEqual({ accuracy: 0, points: 20 });
  expect(scorePrediction(up, 100, [{ t: 1, o: 100, c: 100 }])).toEqual({ accuracy: 0, points: 20 });
});

test("a drawing runs start to end, forward in time, at real prices", () => {
  const p = (t: number, price = 100) => ({ t, price });
  expect(isDrawing([p(0), p(1)])).toBe(true);
  expect(isDrawing([p(0), p(0.4, 90), p(1, 120)])).toBe(true);
  expect(isDrawing(Array.from({ length: 256 }, (_, i) => p(i / 255)))).toBe(true);
  for (const bad of [
    undefined,
    "pts",
    [p(0)],
    Array.from({ length: 257 }, (_, i) => p(i / 256)),
    [p(0.1), p(1)],
    [p(0), p(0.9)],
    [p(0), p(0.5), p(0.5), p(1)],
    [p(0), p(0.6), p(0.4), p(1)],
    [p(0), p(0.5, 0), p(1)],
    [p(0), p(0.5, Number.NaN), p(1)],
    [p(0), { t: 0.5, price: "100" }, p(1)],
    [p(0), null, p(1)],
    [null, p(1)],
  ]) {
    expect(isDrawing(bad)).toBe(false);
  }
});
