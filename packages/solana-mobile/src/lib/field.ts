import { type Features, type Field, fieldJob, type Library, setDifficulty } from "@skech/core/dots";
import { INK_EDGE_CELLS } from "@skech/core/ink";

/**
 * The map of the odds, made a few milliseconds at a time. On the web it is made in a worker; a phone has no
 * workers, and made in one go it would take the JavaScript thread from the pen for a third of a second, every
 * second. So `fieldJob` lays the paths over the map in slices, a slice a frame, each under `SLICE_MS`, and the
 * map is ready well inside its second while the pen and the chart keep every frame.
 */

const SLICE_MS = 5;
/** Paths a slice starts with; tuned from how long the last slice took, so each takes about `SLICE_MS`. */
let perSlice = 400;

export type FieldAsk = { id: number; f: Features; at: number; step: number; cell: number; difficulty: number };

export class FieldMaker {
  private job: { ask: FieldAsk; run: (n: number) => boolean; result: () => Field } | null = null;
  private frame = 0;

  constructor(
    private readonly lib: Library,
    private readonly done: (id: number, field: Field) => void,
  ) {}

  /** Start on a map; one already under way is dropped for it. */
  ask(ask: FieldAsk) {
    setDifficulty(ask.difficulty);
    const j = fieldJob(this.lib, ask.f, ask.at, ask.step, ask.cell, INK_EDGE_CELLS);
    this.job = { ask, run: j.run, result: j.result };
    if (!this.frame) this.frame = requestAnimationFrame(this.slice);
  }

  get busy() {
    return this.job !== null;
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.job = null;
  }

  private slice = () => {
    this.frame = 0;
    const job = this.job;
    if (!job) return;
    const t0 = performance.now();
    let finished = false;
    while (!finished && performance.now() - t0 < SLICE_MS) {
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
    } else this.frame = requestAnimationFrame(this.slice);
  };
}
