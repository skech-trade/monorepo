/**
 * Trades, folded into one-second bars: the same fold in the app, the relayer
 * and the engine's replay, so what one judges a second to be, all do.
 *
 * A trade goes into the bar of its second. A second with no trade is closed
 * at the last price once it is old enough that a late trade is unlikely.
 * Times are ms on the exchange's clock.
 */

import type { Bar } from "./dots";

export type Tick = { t: number; p: number };

/** How long after a second ends it is closed at the last price if nothing traded: for trades that arrive late. */
export const CLOSE_AFTER_MS = 600;

export class BarBook {
  readonly bars: Bar[] = [];
  readonly ticks: Tick[] = [];
  constructor(private readonly keepBars = 660, private readonly keepTicks = 4000) {}

  /** Fold one trade in. */
  fold(t: number, p: number) {
    if (!(p > 0) || !Number.isFinite(t)) return;
    const sec = Math.floor(t / 1000) * 1000;
    const last = this.bars[this.bars.length - 1];
    // A trade that arrives after its second was closed by the clock still belongs to it.
    const own = last && sec <= last.t ? this.bars.findLast((b) => b.t === sec) : undefined;
    if (own) {
      own.h = Math.max(own.h, p);
      own.l = Math.min(own.l, p);
      if (own === last) own.c = p;
    } else if (!last || sec > last.t) {
      // Seconds with no trade still pass: carry the price through them, so a gap is flat rather than missing.
      if (last) for (let s = last.t + 1000; s < sec; s += 1000) this.bars.push({ t: s, h: last.c, l: last.c, c: last.c });
      this.bars.push({ t: sec, h: p, l: p, c: p });
      if (this.bars.length > this.keepBars) this.bars.splice(0, this.bars.length - this.keepBars);
    }
    this.ticks.push({ t, p });
    if (this.ticks.length > this.keepTicks) this.ticks.splice(0, this.ticks.length - this.keepTicks);
  }

  /** Close every second that is over by more than the margin with nothing in it, at the last price. Returns whether any was. */
  closeQuiet(nowMs: number, margin = CLOSE_AFTER_MS): boolean {
    const last = this.bars[this.bars.length - 1];
    if (!last) return false;
    let added = false;
    for (let s = last.t + 1000; s + margin <= nowMs; s += 1000) {
      this.bars.push({ t: s, h: last.c, l: last.c, c: last.c });
      added = true;
    }
    if (added && this.bars.length > this.keepBars) this.bars.splice(0, this.bars.length - this.keepBars);
    return added;
  }

  /** The bar of a second, if it is here. */
  at(second: number): Bar | undefined {
    for (let i = this.bars.length - 1; i >= 0; i--) {
      if (this.bars[i].t === second) return this.bars[i];
      if (this.bars[i].t < second) return undefined;
    }
    return undefined;
  }

  /** Whether a second is over and past the late-trade margin, so its bar is what it will stay. */
  closed(second: number, nowMs: number, margin = CLOSE_AFTER_MS) {
    return second + 1000 + margin <= nowMs;
  }

  get last(): Bar | undefined {
    return this.bars[this.bars.length - 1];
  }
}
