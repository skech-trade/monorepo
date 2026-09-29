import { expect, test } from "bun:test";
import { BarBook } from "./bars";

test("trades fold into their second, gaps carry the last price, late trades land in their own second", () => {
  const book = new BarBook();
  book.fold(1000, 10);
  book.fold(1500, 12);
  book.fold(1900, 9);
  expect(book.bars).toEqual([{ t: 1000, h: 12, l: 9, c: 9 }]);
  book.fold(4200, 11);
  expect(book.bars.map((b) => b.t)).toEqual([1000, 2000, 3000, 4000]);
  expect(book.bars[1]).toEqual({ t: 2000, h: 9, l: 9, c: 9 });
  // A late trade for second 1 widens it but does not change its close.
  book.fold(1950, 14);
  expect(book.bars[0]).toEqual({ t: 1000, h: 14, l: 9, c: 9 });
  expect(book.at(3000)).toEqual({ t: 3000, h: 9, l: 9, c: 9 });
  expect(book.at(2500)).toBeUndefined();
});

test("quiet seconds close at the last price once they are old enough", () => {
  const book = new BarBook();
  book.fold(1000, 10);
  expect(book.closeQuiet(2599)).toBe(false);
  expect(book.closeQuiet(2600)).toBe(true);
  expect(book.bars).toEqual([{ t: 1000, h: 10, l: 10, c: 10 }, { t: 2000, h: 10, l: 10, c: 10 }]);
  expect(book.closed(1000, 2599)).toBe(false);
  expect(book.closed(1000, 2600)).toBe(true);
});
