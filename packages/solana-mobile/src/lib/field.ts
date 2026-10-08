import { type Features, type Field, fieldJob, type Library, setDifficulty } from "@skech/core/dots";
import { INK_EDGE_CELLS } from "@skech/core/ink";

/**
 * The map of the odds, made a few milliseconds at a time. On the web it is made in a worker; a phone has no
 * workers, and made in one go it would take the JavaScript thread from the pen for a third of a second, every
 * second. So `fieldJob` lays the paths over the map in slices, a slice a frame, each under `SLICE_MS`, and the
 * map is ready well inside its second while the pen and the chart keep every frame.
 */

const SLICE_MS = 5;
/** How far ahead the phone's map reaches: the screen shows 15s, and a piece opens a second or two after it is drawn. */
const PHONE_SECONDS = 20;
/** A map that has taken this long gets longer slices: on a slow phone at a few milliseconds a frame it would never
 *  finish before the next second's map, and no tiles would ever show. */
const BEHIND_MS = 600;
const BEHIND_SLICE_MS = 12;
/** Paths a slice starts with; tuned from how long the last slice took, so each takes about `SLICE_MS`. */
let perSlice = 400;

export type FieldAsk = { id: number; f: Features; at: number; step: number; cell: number; difficulty: number };

export class FieldMaker {
  private job: { ask: FieldAsk; run: (n: number) => boolean; result: () => Field; began: number } | null = null;
  /** The newest map asked for while one was being made: made next. Older ones in between are skipped. */
  private next: FieldAsk | null = null;
  private frame = 0;

  constructor(
    private readonly lib: Library,
    private readonly done: (id: number, field: Field) => void,
  ) {}

  /**
   * A map to make. One already under way is finished first, then the newest asked for: dropping it for each new
   * ask, as this did, meant that on a phone slower than a map a second no map was ever finished.
   */
  ask(ask: FieldAsk) {
    if (this.job) {
      this.next = ask;
      return;
    }
    this.start(ask);
  }

  private start(ask: FieldAsk) {
    setDifficulty(ask.difficulty);
    // Only what the phone prices with: bands (no per-row chances), as far ahead as the screen reaches.
    const j = fieldJob(this.lib, ask.f, ask.at, ask.step, ask.cell, INK_EDGE_CELLS, { perRow: false, seconds: PHONE_SECONDS });
    this.job = { ask, run: j.run, result: j.result, began: performance.now() };
    if (!this.frame) this.frame = requestAnimationFrame(this.slice);
  }

  get busy() {
    return this.job !== null;
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.job = null;
    this.next = null;
  }

  private slice = () => {
    this.frame = 0;
    const job = this.job;
    if (!job) return;
    const t0 = performance.now();
    const budget = t0 - job.began > BEHIND_MS ? BEHIND_SLICE_MS : SLICE_MS;
    let finished = false;
    while (!finished && performance.now() - t0 < budget) {
      const s = performance.now();
      finished = job.run(perSlice);
      const took = performance.now() - s;
      if (took > 0) perSlice = Math.max(50, Math.min(4000, Math.round((perSlice * (SLICE_MS / 2)) / took)));
    }
    if (finished) {
      this.job = null;
      // The difficulty the paths were laid for, as the web's worker keeps its own.
      setDifficulty(job.ask.difficulty);
      this.done(job.ask.id, job.result());
      const next = this.next;
      this.next = null;
      if (next) this.start(next);
    } else this.frame = requestAnimationFrame(this.slice);
  };
}
