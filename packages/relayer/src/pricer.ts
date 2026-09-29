/**
 * Every band's chance, measured on the paths, for a second: one map per grid
 * unit per second, made in a worker, read off for every piece that opens then.
 */
import { type Features, type Field, rangeChanceOf } from "@skech/core/dots";
import { INK_CELL, INK_EDGE_CELLS } from "@skech/core/ink";
import { chanceE9, fromE8, gridStep, type Section } from "@skech/core/chain";

export class Pricer {
  private worker: Worker;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (f: Field) => void; reject: (e: Error) => void }>();
  private cache = new Map<string, Promise<Field>>();
  ready: Promise<number>;

  constructor(libBytes: ArrayBuffer, private readonly log: (s: string) => void) {
    this.worker = new Worker(new URL("./field.worker.ts", import.meta.url));
    this.ready = new Promise((resolve) => {
      this.worker.onmessage = (e: MessageEvent<{ kind?: string; paths?: number; id?: number; field?: Field; ms?: number }>) => {
        if (e.data.kind === "ready") return resolve(e.data.paths!);
        const w = this.waiting.get(e.data.id!);
        if (!w) return;
        this.waiting.delete(e.data.id!);
        if (e.data.ms! > 400) this.log(`pricer: a map took ${Math.round(e.data.ms!)} ms`);
        w.resolve(e.data.field!);
      };
      this.worker.onerror = (e) => {
        this.log(`pricer: worker error ${e.message}`);
        for (const w of this.waiting.values()) w.reject(new Error(e.message));
        this.waiting.clear();
      };
    });
    this.worker.postMessage({ kind: "lib", bytes: libBytes });
  }

  /** The map for a second, on a grid, at a difficulty. Cached: many pieces open on one second. */
  fieldFor(f: Features, openAt: number, unit: number, difficulty: number): Promise<Field> {
    const key = `${openAt}:${unit}:${difficulty}`;
    let p = this.cache.get(key);
    if (!p) {
      const id = this.nextId++;
      p = new Promise<Field>((resolve, reject) => {
        this.waiting.set(id, { resolve, reject });
        // The map's rows are one grid unit tall: step * INK_CELL == unit.
        this.worker.postMessage({ kind: "field", id, f, at: openAt, step: gridStep(unit * 50) * INK_CELL, cell: INK_CELL, difficulty });
      });
      this.cache.set(key, p);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  /** Each band's chance on the map, in billionths: the band as the app drew it, judged one unit wider each way. */
  chances(fl: Field, sections: Section[], openAt: number): number[] {
    return sections.map((s) => chanceE9(rangeChanceOf(fl, openAt + s.second * 1000, fromE8(s.lo), fromE8(s.hi), INK_EDGE_CELLS, INK_CELL)));
  }
}
