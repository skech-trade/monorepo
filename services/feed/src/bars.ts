/**
 * Trades into candles.
 *
 * Lighter's smallest candle is a minute and Draw runs on seconds, so the bars
 * are built here from the trade stream rather than asked for. Pure, so it can
 * be tested without a socket.
 */

export type Trade = { price: number; size: number; at: number };

export type Bar = {
  /** Seconds since the epoch: the second this bar covers. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base volume, in BTC. */
  v: number;
};

/** The second a moment falls in. */
export const secondOf = (ms: number) => Math.floor(ms / 1000);

/**
 * A rolling window of one-second bars.
 *
 * Seconds with no trades still get a bar, flat at the last close, because a
 * gap in the series would draw as a jump and the chart counts bars to place
 * the drawn line against them. A market that has not printed is a market that
 * has not moved, which is what a flat bar says.
 */
export class Bars {
  private readonly keep: number;
  private bars: Bar[] = [];

  constructor(keep = 600) {
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
    const t = secondOf(trade.at);
    const head = this.open;
    if (head && t < head.t) {
      const back = this.bars.find((b) => b.t === t);
      if (back) {
        back.h = Math.max(back.h, trade.price);
        back.l = Math.min(back.l, trade.price);
        back.v += trade.size;
      }
      return;
    }
    if (!head || t > head.t) {
      this.fillTo(t, head?.c ?? trade.price);
      this.bars.push({ t, o: head?.c ?? trade.price, h: trade.price, l: trade.price, c: trade.price, v: trade.size });
    } else {
      head.h = Math.max(head.h, trade.price);
      head.l = Math.min(head.l, trade.price);
      head.c = trade.price;
      head.v += trade.size;
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
    for (let s = head.t + 1; s < t; s++) this.bars.push({ t: s, o: close, h: close, l: close, c: close, v: 0 });
    this.trim();
  }

  /** Bring the series to this second, opening a flat bar if none has traded. */
  tick(now = Date.now()) {
    const t = secondOf(now);
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
