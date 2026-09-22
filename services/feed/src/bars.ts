/**
 * Trades into candles.
 *
 * Lighter's smallest candle is a minute and Draw runs on seconds, so the bars
 * are built here from the trade stream rather than asked for. Pure, so it can
 * be tested without a socket.
 */

export type Trade = { price: number; size: number; at: number };

export type Bar = {
  /** Seconds since the epoch, including .5 for half-second boundaries. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base volume, in BTC. */
  v: number;
};

/** The second a moment falls in. */
export const CANDLE_MS = 500;
export const secondOf = (ms: number, intervalMs = CANDLE_MS) => Math.floor(ms / intervalMs) * intervalMs / 1000;

/**
 * A rolling window of 500ms bars.
 *
 * Seconds with no trades still get a bar, flat at the last close, because a
 * gap in the series would draw as a jump and the chart counts bars to place
 * the drawn line against them. A market that has not printed is a market that
 * has not moved, which is what a flat bar says.
 */
export class Bars {
  private readonly keep: number;
  private bars: Bar[] = [];
  private lastTradeAt = new WeakMap<Bar, number>();

  constructor(keep = 1200, private readonly intervalMs = CANDLE_MS) {
    this.keep = keep;
  }

  /** Every bar held, oldest first. */
  all(): Bar[] {
    return this.bars;
  }

  /** The most recent `n`, oldest first. */
  last(n: number): Bar[] {
    return this.bars.slice(-n);
  }

  get open(): Bar | undefined {
    return this.bars[this.bars.length - 1];
  }

  /**
   * Fold a trade in. Trades can arrive a little out of order, so one landing
   * in the second that is already closed updates that bar rather than opening
   * a new one behind the front.
   */
  add(trade: Trade) {
    const t = secondOf(trade.at, this.intervalMs);
    const head = this.open;
    if (!head || t > head.t) {
      this.fillTo(t, head?.c ?? trade.price);
      const open = head?.c ?? trade.price;
      const bar = { t, o: open, h: Math.max(open, trade.price), l: Math.min(open, trade.price), c: trade.price, v: trade.size };
      this.bars.push(bar);
      this.lastTradeAt.set(bar, trade.at);
    } else {
      const index = t === head.t ? this.bars.length - 1 : this.bars.findIndex((b) => b.t === t);
      const bar = this.bars[index];
      if (!bar) return;
      bar.h = Math.max(bar.h, trade.price);
      bar.l = Math.min(bar.l, trade.price);
      bar.v += trade.size;
      // A clock-created candle may already be ahead of the newest trade.
      // Correct its close, then carry that price through untraded candles.
      // Earlier prints can widen a wick, but cannot rewind the last price.
      if (trade.at >= (this.lastTradeAt.get(bar) ?? -Infinity)) {
        this.lastTradeAt.set(bar, trade.at);
        bar.c = trade.price;
        for (let i = index + 1; i < this.bars.length; i++) {
          const next = this.bars[i];
          if (this.lastTradeAt.has(next)) break;
          next.o = next.h = next.l = next.c = trade.price;
        }
      }
    }
    this.trim();
  }

  /**
   * Carry the series up to `t` with flat bars. Called on every trade and by
   * the clock, so a quiet market still produces a bar a second.
   */
  fillTo(t: number, price?: number) {
    const head = this.open;
    if (!head) return;
    const close = price ?? head.c;
    for (let s = head.t + this.intervalMs / 1000; s < t; s += this.intervalMs / 1000) this.bars.push({ t: s, o: close, h: close, l: close, c: close, v: 0 });
    this.trim();
  }

  /** Bring the series to this second, opening a flat bar if none has traded. */
  tick(now = Date.now()) {
    const t = secondOf(now, this.intervalMs);
    const head = this.open;
    if (!head || head.t >= t) return;
    this.fillTo(t);
    this.bars.push({ t, o: head.c, h: head.c, l: head.c, c: head.c, v: 0 });
    this.trim();
  }

  private trim() {
    if (this.bars.length > this.keep) this.bars = this.bars.slice(-this.keep);
  }
}
