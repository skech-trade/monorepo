import { SAMPLES, type Shape } from "@skech/core/shape";

/**
 * A drawn round as a timeline of positions.
 *
 * The line's legs become segments, each with its own id: long from here to
 * there, short after it. A segment can be skipped, which means "hold what you
 * had" rather than "go flat", so cutting the short out of long–short–long
 * keeps one long running across all three. Neighbours facing the same way are
 * one trade: long then long is a position that continues, not a close and a
 * reopen. Long then short is a close and an open.
 *
 * Everything here is pure, so the scheduler, the tests and the page can all
 * ask the same questions of the same timeline.
 */

export type Dir = 1 | -1;

export type Segment = {
  id: string;
  dir: Dir;
  /** Absolute milliseconds. */
  startAt: number;
  endAt: number;
  skipped: boolean;
};

/** A run of the timeline that holds one position. `id` is the first segment's, so it is stable across edits. */
export type Run = { id: string | null; dir: 0 | Dir; startAt: number; endAt: number; segmentIds: string[] };

let counter = 0;
export const newId = () => `s${Date.now().toString(36)}${(counter++ % 1296).toString(36).padStart(2, "0")}`;

/** Legs to segments, over the round's real clock. Adjacent legs facing the same way are merged. */
export function segmentsFrom(shape: Pick<Shape, "legs">, startedAt: number, seconds: number, id: () => string = newId): Segment[] {
  const at = (sample: number) => startedAt + (sample / (SAMPLES - 1)) * seconds * 1000;
  const end = startedAt + seconds * 1000;
  const out: Segment[] = [];
  shape.legs.forEach((leg, i) => {
    const startAt = i === 0 ? startedAt : at(leg.from);
    const endAt = shape.legs[i + 1] ? at(shape.legs[i + 1].from) : end;
    if (endAt <= startAt) return;
    const last = out.at(-1);
    if (last && last.dir === leg.dir) last.endAt = endAt;
    else out.push({ id: id(), dir: leg.dir, startAt, endAt, skipped: false });
  });
  return out;
}

/**
 * The positions the timeline actually asks for. A skipped segment holds the
 * previous position; skipped at the very start, it holds nothing.
 */
export function runsOf(segments: Segment[]): Run[] {
  const runs: Run[] = [];
  let held: 0 | Dir = 0;
  let heldId: string | null = null;
  for (const s of segments) {
    const dir: 0 | Dir = s.skipped ? held : s.dir;
    const id = s.skipped ? heldId : s.id;
    const last = runs.at(-1);
    if (last && last.dir === dir && last.endAt === s.startAt) {
      last.endAt = s.endAt;
      last.segmentIds.push(s.id);
    } else {
      runs.push({ id: dir === 0 ? null : id, dir, startAt: s.startAt, endAt: s.endAt, segmentIds: [s.id] });
    }
    held = dir;
    heldId = runs.at(-1)!.id;
  }
  return runs;
}

/** What the timeline wants held at this moment. Outside it, nothing. */
export function desiredAt(segments: Segment[], t: number): Run {
  const run = runsOf(segments).find((r) => t >= r.startAt && t < r.endAt);
  return run ?? { id: null, dir: 0, startAt: t, endAt: t, segmentIds: [] };
}

/** The next moment after `t` at which the wanted position changes, or null past the last one. */
export function nextChange(segments: Segment[], t: number): number | null {
  const runs = runsOf(segments);
  for (const r of runs) if (r.startAt > t) return r.startAt;
  const last = runs.at(-1);
  return last && last.endAt > t ? last.endAt : null;
}

/**
 * A new drawing, applied without rewriting what has happened.
 *
 * Everything before `frozenUntil` stays as it was; the new plan takes over
 * after it. Segments keep their ids where they still mean the same thing, so
 * a trade that is open stays the same trade when somebody edits the line
 * further along.
 */
export function replan(old: Segment[], fresh: Segment[], frozenUntil: number, id: () => string = newId): Segment[] {
  const kept = old.filter((s) => s.startAt < frozenUntil).map((s) => ({ ...s, endAt: Math.min(s.endAt, frozenUntil) }));
  const future = fresh
    .filter((s) => s.endAt > frozenUntil)
    .map((s) => ({ ...s, startAt: Math.max(s.startAt, frozenUntil) }))
    .filter((s) => s.endAt > s.startAt);
  // Reuse an old id for a future segment facing the same way over the same time.
  const used = new Set(kept.map((s) => s.id));
  for (const s of future) {
    const match = old.find((o) => !used.has(o.id) && o.dir === s.dir && o.startAt < s.endAt && o.endAt > s.startAt);
    s.id = match ? match.id : s.id || id();
    s.skipped = match ? match.skipped : false;
    used.add(s.id);
  }
  const out = [...kept];
  for (const s of future) {
    const last = out.at(-1);
    if (last && last.dir === s.dir && !last.skipped && !s.skipped && last.endAt === s.startAt) last.endAt = s.endAt;
    else out.push(s);
  }
  return out;
}

/** Skip or restore one segment. Only one that has not started can change. */
export function setSkipped(segments: Segment[], segmentId: string, skipped: boolean, now: number): Segment[] {
  const target = segments.find((s) => s.id === segmentId);
  if (!target) throw Error("No such segment.");
  if (target.startAt <= now) throw Error("That part of the trade has already started.");
  return segments.map((s) => (s.id === segmentId ? { ...s, skipped } : s));
}
