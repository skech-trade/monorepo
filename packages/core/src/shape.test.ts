import { describe, expect, test } from "bun:test";
import { legsFrom, resample, SAMPLES, shapeOf } from "./shape";

/**
 * The drawing is the order, so these are the tests that matter most: the
 * browser and the trader both read a line through this code, and if they
 * disagree about what a line means, one of them is trading something nobody
 * drew.
 */

const line = (...prices: number[]) => prices.map((price, i) => ({ t: i / (prices.length - 1), price }));

describe("what a line means", () => {
  test("a rising line is one long leg", () => {
    const s = shapeOf(line(100, 110), 100);
    expect(s?.legs.length).toBe(1);
    expect(s?.legs[0].dir).toBe(1);
    expect(s?.long).toBe(true);
  });

  test("a falling line is one short leg", () => {
    const s = shapeOf(line(100, 90), 100);
    expect(s?.legs.length).toBe(1);
    expect(s?.legs[0].dir).toBe(-1);
    expect(s?.long).toBe(false);
  });

  test("a V turns once, down then up", () => {
    const s = shapeOf(line(100, 90, 112), 100);
    expect(s?.legs.map((l) => l.dir)).toEqual([-1, 1]);
  });

  test("a zigzag turns at every corner", () => {
    const s = shapeOf(line(100, 88, 115, 95), 100);
    expect(s?.legs.map((l) => l.dir)).toEqual([-1, 1, -1]);
  });

  test("the legs cover the line end to end, without gaps or overlaps", () => {
    const s = shapeOf(line(100, 88, 115, 95), 100);
    const legs = s?.legs ?? [];
    expect(legs[0].from).toBe(0);
    expect(legs.at(-1)?.to).toBe(SAMPLES - 1);
    for (let i = 1; i < legs.length; i++) expect(legs[i].from).toBe(legs[i - 1].to);
  });

  test("a wobble is not a turn", () => {
    // A hand does not draw a straight line. One part in ten thousand of a
    // dip must not become a reversal, because a reversal is two orders.
    const s = shapeOf(line(100, 110, 109.99, 120), 100);
    expect(s?.legs.map((l) => l.dir)).toEqual([1]);
  });

  test("a flat line says nothing to trade", () => {
    expect(shapeOf(line(100, 100), 100)?.flat).toBe(true);
  });

  test("one point is not a line", () => {
    expect(shapeOf([{ t: 0, price: 100 }], 100)).toBe(null);
  });

  test("the line starts where the market is, whatever was drawn", () => {
    // The entry is the mark when the round opens, not the price under the
    // hand when it was drawn, so the first sample is pinned to it.
    expect(resample(line(90, 120), 100)[0]).toBe(100);
  });

  test("legs of an empty move are no legs at all", () => {
    expect(legsFrom(new Array(SAMPLES).fill(100))).toEqual([]);
  });
});
