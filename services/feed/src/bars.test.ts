import { describe, expect, test } from "bun:test";
import { Bars, secondOf } from "./bars";

const at = (s: number, ms = 0) => s * 1000 + ms;

describe("trades fold into one-second bars", () => {
  test("the first trade opens a bar at its own price", () => {
    const b = new Bars(600, 1000);
    b.add({ price: 80_000, size: 1, at: at(10) });
    expect(b.all()).toHaveLength(1);
    expect(b.open).toMatchObject({ t: 10, o: 80_000, h: 80_000, l: 80_000, c: 80_000, v: 1 });
  });

  test("more trades in the same second move the close and widen the range", () => {
    const b = new Bars(600, 1000);
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.add({ price: 80_050, size: 2, at: at(10, 400) });
    b.add({ price: 79_900, size: 1, at: at(10, 900) });
    expect(b.all()).toHaveLength(1);
    expect(b.open).toMatchObject({ o: 80_000, h: 80_050, l: 79_900, c: 79_900, v: 4 });
  });

  test("a new second opens at the last close, not at its own first trade", () => {
    const b = new Bars(600, 1000);
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.add({ price: 80_500, size: 1, at: at(11) });
    expect(b.all()).toHaveLength(2);
    expect(b.all()[1]).toMatchObject({ t: 11, o: 80_000, h: 80_500, l: 80_000, c: 80_500 });
  });

  test("a gap down still contains the open inside its high and low", () => {
    const b = new Bars(600, 1000);
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.add({ price: 79_500, size: 1, at: at(11) });
    expect(b.open).toMatchObject({ o: 80_000, h: 80_000, l: 79_500, c: 79_500 });
  });
});

describe("quiet seconds still get a bar", () => {
  test("a gap is filled flat, so the series has no holes", () => {
    const b = new Bars(600, 1000);
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.add({ price: 80_100, size: 1, at: at(15) });
    expect(b.all().map((x) => x.t)).toEqual([10, 11, 12, 13, 14, 15]);
    // The filled ones are flat at the close, and traded nothing.
    for (const bar of b.all().slice(1, 5)) {
      expect(bar).toMatchObject({ o: 80_000, h: 80_000, l: 80_000, c: 80_000, v: 0 });
    }
  });

  test("the clock carries the series when nothing prints at all", () => {
    const b = new Bars(600, 1000);
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.tick(at(13));
    expect(b.all().map((x) => x.t)).toEqual([10, 11, 12, 13]);
    expect(b.open).toMatchObject({ c: 80_000, v: 0 });
  });

  test("and the clock does nothing inside the second it is already on", () => {
    const b = new Bars(600, 1000);
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.tick(at(10, 800));
    expect(b.all()).toHaveLength(1);
  });
});

describe("trades that arrive late", () => {
  test("land in the bar they belong to, not at the front", () => {
    const b = new Bars(600, 1000);
    b.add({ price: 80_000, size: 1, at: at(10) });
    b.add({ price: 80_200, size: 1, at: at(12) });
    // One from second 11, arriving after 12 opened.
    b.add({ price: 81_000, size: 3, at: at(11) });
    expect(b.all()).toHaveLength(3);
    expect(b.all()[1]).toMatchObject({ t: 11, h: 81_000, v: 3 });
    expect(b.open?.t).toBe(12);
  });

  test("and one older than anything held is dropped rather than misplaced", () => {
    const b = new Bars(3, 1000);
    for (const s of [10, 11, 12, 13]) b.add({ price: 80_000 + s, size: 1, at: at(s) });
    expect(b.all().map((x) => x.t)).toEqual([11, 12, 13]);
    b.add({ price: 99_999, size: 1, at: at(5) });
    expect(b.all().map((x) => x.t)).toEqual([11, 12, 13]);
    expect(Math.max(...b.all().map((x) => x.h))).toBeLessThan(99_999);
  });
});

describe("the window stays bounded", () => {
  test("however long it runs", () => {
    const b = new Bars(50, 1000);
    for (let s = 0; s < 500; s++) b.add({ price: 80_000 + s, size: 1, at: at(s) });
    expect(b.all()).toHaveLength(50);
    expect(b.open?.t).toBe(499);
  });

  test("and `last` gives the most recent, oldest first", () => {
    const b = new Bars(600, 1000);
    for (let s = 0; s < 10; s++) b.add({ price: 80_000 + s, size: 1, at: at(s) });
    expect(b.last(3).map((x) => x.t)).toEqual([7, 8, 9]);
  });
});

test("a moment maps to the second it falls in", () => {
  expect(secondOf(1_789_908_684_036, 1000)).toBe(1_789_908_684);
  expect(secondOf(1_789_908_684_999, 1000)).toBe(1_789_908_684);
});


describe("500ms production candles", () => {
  test("trades straddling the half-second boundary create distinct candles", () => {
    const bars = new Bars();
    bars.add({ at: 10_000, price: 100, size: 1 });
    bars.add({ at: 10_499, price: 105, size: 2 });
    bars.add({ at: 10_500, price: 102, size: 3 });
    expect(bars.all()).toEqual([
      { t: 10, o: 100, h: 105, l: 100, c: 105, v: 3 },
      { t: 10.5, o: 105, h: 105, l: 102, c: 102, v: 3 },
    ]);
    expect(secondOf(10_999)).toBe(10.5);
  });
  test("quiet periods advance by 500ms and keep 90 seconds in 180 bars", () => {
    const bars = new Bars(180);
    bars.add({ at: 0, price: 100, size: 1 });
    bars.tick(90_000);
    expect(bars.all()).toHaveLength(180);
    expect(bars.all()[0].t).toBe(0.5);
    expect(bars.open?.t).toBe(90);
    for (let i = 1; i < bars.all().length; i++) expect(bars.all()[i].t - bars.all()[i - 1].t).toBe(0.5);
  });
});


describe("delayed prints keep the live price current", () => {
  test("a trade behind the clock repairs the close and all untraded candles", () => {
    const b = new Bars();
    b.add({ at: 10000, price: 100, size: 1 });
    b.tick(11500);
    b.add({ at: 10490, price: 110, size: 1 });
    expect(b.all().map(x => x.c)).toEqual([110, 110, 110, 110]);
    expect(b.open).toMatchObject({ t: 11.5, o: 110, h: 110, l: 110, c: 110, v: 0 });
    b.add({ at: 10200, price: 90, size: 1 });
    expect(b.all()[0]).toMatchObject({ l: 90, c: 110, v: 3 });
    expect(b.open?.c).toBe(110);
  });
  test("late history must not overwrite a more recent traded price", () => {
    const b = new Bars();
    b.add({ at: 10000, price: 100, size: 1 });
    b.add({ at: 11000, price: 120, size: 1 });
    b.tick(12000);
    b.add({ at: 10490, price: 110, size: 1 });
    expect(b.all().map(x => x.c)).toEqual([110, 110, 120, 120, 120]);
  });
  test("out-of-order trades in the forming candle cannot rewind its close", () => {
    const b = new Bars();
    b.add({ at: 10400, price: 110, size: 1 });
    b.add({ at: 10100, price: 90, size: 1 });
    expect(b.open).toMatchObject({ c: 110, l: 90, v: 2 });
  });
});
