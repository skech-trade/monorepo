/// <reference lib="webworker" />
import { type Features, field, type Library, readLibrary } from "@skech/core/dots";

/**
 * The map of the odds, off the page's thread. Measuring every cell ahead on
 * sixteen thousand real paths takes 50 to 150 ms; done on the page four
 * times a second, the chart and the pen stuttered for a fifth to half of
 * every second. Here it takes as long as it takes, and the page only draws.
 */

let lib: Library | null = null;

type Ask = { kind: "lib"; bytes: ArrayBuffer } | { kind: "field"; id: number; f: Features; at: number; step: number };

self.onmessage = (e: MessageEvent<Ask>) => {
  const m = e.data;
  if (m.kind === "lib") {
    lib = readLibrary(new Uint8Array(m.bytes));
    return;
  }
  if (!lib) return;
  const fl = field(lib, m.f, m.at, m.step);
  (self as unknown as Worker).postMessage({ id: m.id, field: fl }, [fl.chance.buffer]);
};
