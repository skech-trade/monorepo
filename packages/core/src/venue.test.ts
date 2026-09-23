import { expect, test } from "bun:test";
import { isSymbol, SYMBOLS, tradeable, MAINNET } from "./venue";

test("only listed markets are symbols, whatever an object inherits", () => {
  for (const s of SYMBOLS) expect(isSymbol(s)).toBe(true);
  for (const s of ["btc", "SOL", "", "toString", "constructor", "__proto__", "hasOwnProperty", 1, null, undefined]) {
    expect(isSymbol(s)).toBe(false);
  }
});

test("an order has to clear both floors after rounding", () => {
  // 0.000079 rounds down to 0.00007, the floor, and is worth $7 at $100k: under $10.
  expect(tradeable(0.000079, 100_000, MAINNET)).toBe(false);
  expect(tradeable(0.0001, 100_000, MAINNET)).toBe(true);
  // Worth $10 before rounding, $9.90 after.
  expect(tradeable(0.000999, 10_000, MAINNET)).toBe(false);
});
