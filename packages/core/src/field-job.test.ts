import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Features, field, fieldJob, readLibrary } from "./dots";

/** The phone makes the map a slice at a time: it must be the very map `field` makes, bit for bit. */
test("fieldJob, run in slices, is exactly field", () => {
  const lib = readLibrary(new Uint8Array(readFileSync(join(import.meta.dir, "dots-lib.bin"))));
  for (const [sigma, momentum, cell, edge] of [
    [0.00008, -1.5, 0, 0],
    [0.00015, 0.3, 0.7, 1],
    [0.0004, 2, 1, 2],
  ]) {
    const f = { price: 83_000, sigma, momentum, wick: 0.4, vol: 1 } as unknown as Features;
    const step = 0.2 * (cell || 1);
    const whole = field(lib, f, 1_790_000_000_000, step, cell, edge);
    const job = fieldJob(lib, f, 1_790_000_000_000, step, cell, edge);
    let slices = 0;
    while (!job.run(613)) slices++;
    const sliced = job.result();
    expect(slices).toBeGreaterThan(10);
    expect(Array.from(sliced.chance)).toEqual(Array.from(whole.chance));
    expect(Array.from(sliced.lowCdf!)).toEqual(Array.from(whole.lowCdf!));
    expect(Array.from(sliced.highCdf!)).toEqual(Array.from(whole.highCdf!));
    expect(sliced.paths).toBe(whole.paths);
  }
});
