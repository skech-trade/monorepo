import { expect, test } from "bun:test";
import { marketOf, perMarket, SYMBOLS } from "./markets";

test("a request names a listed market, or none and gets Bitcoin", () => {
  expect(marketOf(null)).toBe("BTC");
  expect(marketOf("BTC")).toBe("BTC");
  expect(marketOf("ETH")).toBe("ETH");
});

test("anything else is refused, including what every object inherits", () => {
  for (const v of ["", "btc", "SOL", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
    expect(marketOf(v)).toBeNull();
  }
});

test("one of something per listed market", () => {
  expect(Object.keys(perMarket((m) => m.toLowerCase()))).toEqual(SYMBOLS);
  expect(perMarket((m) => m.toLowerCase()).ETH).toBe("eth");
});
