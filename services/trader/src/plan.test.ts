import { describe, expect, test } from "bun:test";
import { desiredAt, nextChange, replan, runsOf, type Segment, segmentsFrom, setSkipped } from "./plan";

let n = 0;
const id = () => `x${n++}`;
// Four legs over a 31-second round: long, short, long, short. Sample i lands at i seconds.
const shape = { legs: [{ from: 0, to: 8, dir: 1 as const }, { from: 8, to: 16, dir: -1 as const }, { from: 16, to: 24, dir: 1 as const }, { from: 24, to: 31, dir: -1 as const }] };
const lsls = () => segmentsFrom(shape, 0, 31, id);

describe("a drawing becomes segments with their own ids", () => {
  test("one segment per leg, on the round's clock", () => {
    const s = lsls();
    expect(s.map((x) => [x.dir, x.startAt, x.endAt])).toEqual([[1, 0, 8000], [-1, 8000, 16000], [1, 16000, 24000], [-1, 24000, 31000]]);
    expect(new Set(s.map((x) => x.id)).size).toBe(4);
  });

  test("long after long is one position, not a close and a reopen", () => {
    const s = segmentsFrom({ legs: [{ from: 0, to: 10, dir: 1 }, { from: 10, to: 31, dir: 1 }] }, 0, 31, id);
    expect(s).toHaveLength(1);
    expect(runsOf(s)).toHaveLength(1);
  });
});

describe("cutting a segment", () => {
  test("cutting the short in long–short–long keeps one long running", () => {
    const s = lsls();
    const cut = setSkipped(s, s[1].id, true, -1);
    const runs = runsOf(cut);
    expect(runs.map((r) => [r.dir, r.startAt, r.endAt])).toEqual([[1, 0, 24000], [-1, 24000, 31000]]);
    // The long keeps the id of the segment it started as.
    expect(runs[0].id).toBe(s[0].id);
    expect(desiredAt(cut, 12000).dir).toBe(1);
  });

  test("a segment that has started cannot be cut", () => {
    const s = lsls();
    expect(() => setSkipped(s, s[1].id, true, 9000)).toThrow("already started");
  });

  test("cutting the first segment holds nothing until the next one", () => {
    const s = lsls();
    const runs = runsOf(setSkipped(s, s[0].id, true, -1));
    expect(runs[0]).toMatchObject({ dir: 0, id: null, startAt: 0, endAt: 8000 });
  });
});

describe("what to hold, and when it changes", () => {
  test("desired position follows the runs and is flat outside them", () => {
    const s = lsls();
    expect([desiredAt(s, 0).dir, desiredAt(s, 7999).dir, desiredAt(s, 8000).dir, desiredAt(s, 31000).dir]).toEqual([1, 1, -1, 0]);
  });

  test("the next change is the next turn, then the end of the round", () => {
    const s = lsls();
    expect(nextChange(s, 0)).toBe(8000);
    expect(nextChange(s, 25000)).toBe(31000);
    expect(nextChange(s, 31000)).toBeNull();
  });
});

describe("editing a running round", () => {
  const redraw = (legs: { from: number; to: number; dir: 1 | -1 }[]) => segmentsFrom({ legs }, 0, 31, id);

  test("the past is untouched and the open trade keeps its id", () => {
    const s = lsls();
    // At 10s the drawer turns everything after 12s into one long.
    const next = replan(s, redraw([{ from: 0, to: 12, dir: -1 }, { from: 12, to: 31, dir: 1 }]), 12000, id);
    expect(next.slice(0, 2).map((x) => x.id)).toEqual([s[0].id, s[1].id]);
    expect(next.map((x) => [x.dir, x.startAt, x.endAt])).toEqual([[1, 0, 8000], [-1, 8000, 12000], [1, 12000, 31000]]);
  });

  test("changing short to long mid-round continues rather than duplicating", () => {
    const s = lsls();
    const next = replan(s, redraw([{ from: 0, to: 31, dir: 1 }]), 4000, id);
    expect(runsOf(next)).toHaveLength(1);
    expect(runsOf(next)[0].id).toBe(s[0].id);
  });

  test("a cut survives an edit elsewhere", () => {
    const s = lsls();
    const cut = setSkipped(s, s[2].id, true, -1);
    const next = replan(cut, redraw([{ from: 0, to: 8, dir: 1 }, { from: 8, to: 16, dir: -1 }, { from: 16, to: 24, dir: 1 }, { from: 24, to: 31, dir: -1 }]), 1000, id);
    expect(next.find((x) => x.id === cut[2].id)?.skipped).toBe(true);
  });

  test("segments stay ordered and contiguous", () => {
    const next: Segment[] = replan(lsls(), redraw([{ from: 0, to: 20, dir: -1 }, { from: 20, to: 31, dir: 1 }]), 5000, id);
    for (let i = 1; i < next.length; i++) expect(next[i].startAt).toBe(next[i - 1].endAt);
  });
});
