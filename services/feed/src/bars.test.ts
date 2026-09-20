import { describe, expect, test } from "bun:test";
import { Bars, secondOf } from "./bars";

const at = (s: number, ms = 0) => s * 1000 + ms;

describe("trades fold into one-second bars", () => {
  test("the first trade opens a bar at its own price", () => {
    const b = new Bars();
    b.add({ price: 80_000, size: 1, at: at(10) });
    expect(b.all()).toHaveLength(1);
    expect(b.open).toMatchObject({ t: 10, o: 80_000, h: 80_000, l: 80_000, c: 80_000, v: 1 });
  });

  test("more trades in the same second move the close and widen the range", () => {
    const b = new Bars();
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.add({ price: 80_050, size: 2, at: at(10, 400) });
    b.add({ price: 79_900, size: 1, at: at(10, 900) });
    expect(b.all()).toHaveLength(1);
    expect(b.open).toMatchObject({ o: 80_000, h: 80_050, l: 79_900, c: 79_900, v: 4 });
  });

  test("a new second opens at the last close, not at its own first trade", () => {
    const b = new Bars();
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.add({ price: 80_500, size: 1, at: at(11) });
    expect(b.all()).toHaveLength(2);
    expect(b.all()[1]).toMatchObject({ t: 11, o: 80_000, c: 80_500 });
  });
});

describe("quiet seconds still get a bar", () => {
  test("a gap is filled flat, so the series has no holes", () => {
    const b = new Bars();
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.add({ price: 80_100, size: 1, at: at(15) });
    expect(b.all().map((x) => x.t)).toEqual([10, 11, 12, 13, 14, 15]);
    // The filled ones are flat at the close, and traded nothing.
    for (const bar of b.all().slice(1, 5)) {
      expect(bar).toMatchObject({ o: 80_000, h: 80_000, l: 80_000, c: 80_000, v: 0 });
    }
  });

  test("the clock carries the series when nothing prints at all", () => {
    const b = new Bars();
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.tick(at(13));
    expect(b.all().map((x) => x.t)).toEqual([10, 11, 12, 13]);
    expect(b.open).toMatchObject({ c: 80_000, v: 0 });
  });

  test("and the clock does nothing inside the second it is already on", () => {
    const b = new Bars();
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.tick(at(10, 800));
    expect(b.all()).toHaveLength(1);
  });
});

describe("trades that arrive late", () => {
  test("land in the bar they belong to, not at the front", () => {
    const b = new Bars();
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.add({ price: 80_200, size: 1, at: at(12) });
    // One from second 11, arriving after 12 opened.
    b.add({ price: 81_000, size: 3, at: at(11) });
    expect(b.all()).toHaveLength(3);
    expect(b.all()[1]).toMatchObject({ t: 11, h: 81_000, v: 3 });
    expect(b.open?.t).toBe(12);
  });

  test("and one older than anything held is dropped rather than misplaced", () => {
    const b = new Bars(3);
    for (const s of [10, 11, 12, 13]) b.add({ price: 80_000 + s, size: 1, at: at(s) });
    expect(b.all().map((x) => x.t)).toEqual([11, 12, 13]);
    b.add({ price: 99_999, size: 1, at: at(5) });
    expect(b.all().map((x) => x.t)).toEqual([11, 12, 13]);
    expect(Math.max(...b.all().map((x) => x.h))).toBeLessThan(99_999);
  });
});

describe("the window stays bounded", () => {
  test("however long it runs", () => {
    const b = new Bars(50);
    for (let s = 0; s < 500; s++) b.add({ price: 80_000 + s, size: 1, at: at(s) });
    expect(b.all()).toHaveLength(50);
    expect(b.open?.t).toBe(499);
  });

  test("and `last` gives the most recent, oldest first", () => {
    const b = new Bars();
    for (let s = 0; s < 10; s++) b.add({ price: 80_000 + s, size: 1, at: at(s) });
    expect(b.last(3).map((x) => x.t)).toEqual([7, 8, 9]);
  });
});

test("a moment maps to the second it falls in", () => {
  expect(secondOf(1_789_908_684_036)).toBe(1_789_908_684);
  expect(secondOf(1_789_908_684_999)).toBe(1_789_908_684);
});
