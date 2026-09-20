/**
 * Lighter's public stream.
 *
 * Reads need no credential of any kind: the socket carries trades, the book
 * and account state to anyone who asks. That is why this service exists
 * rather than a Builder account, whose only gift is a higher REST read limit
 * we would never reach.
 */

import { type Bar, Bars, type Trade } from "./bars";

export type Stats = {
  /** What the venue liquidates on. P&L is marked against this, not the last trade. */
  mark: number;
  index: number;
  mid: number;
  fundingRate: number;
  /** The day, as the venue reports it, so the header does not have to guess. */
  changePct: number;
  high: number;
  low: number;
  /** Quote volume over the day, in dollars. */
  volume: number;
  at: number;
};

const num = (v: unknown, fallback = 0) => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};

export type FeedOptions = {
  url: string;
  marketId: number;
  keep?: number;
  onBar?: (bar: Bar) => void;
  onStats?: (stats: Stats) => void;
};

/**
 * One socket, held open. Lighter sends a snapshot on subscribe and updates
 * after it, and drops the connection now and then; reconnect backs off to
 * thirty seconds so a venue having a bad minute is not made worse.
 */
export class LighterFeed {
  readonly bars: Bars;
  stats: Stats | null = null;
  private ws: WebSocket | null = null;
  private wait = 500;
  private shut = false;
  private clock: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: FeedOptions) {
    this.bars = new Bars(opts.keep ?? 600);
  }

  start() {
    this.shut = false;
    this.open();
    // A market with no prints still has to produce a bar a second.
    this.clock ??= setInterval(() => {
      const before = this.bars.open?.t;
      this.bars.tick();
      const head = this.bars.open;
      if (head && head.t !== before) this.opts.onBar?.(head);
    }, 1000);
  }

  stop() {
    this.shut = true;
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
    this.ws?.close();
    this.ws = null;
  }

  private open() {
    if (this.shut) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.wait = 500;
      ws.send(JSON.stringify({ type: "subscribe", channel: `trade/${this.opts.marketId}` }));
      ws.send(JSON.stringify({ type: "subscribe", channel: `market_stats/${this.opts.marketId}` }));
    });
    ws.addEventListener("message", (e) => this.take(String(e.data)));
    ws.addEventListener("close", () => this.again());
    ws.addEventListener("error", () => ws.close());
  }

  private again() {
    if (this.shut) return;
    const wait = this.wait;
    this.wait = Math.min(30_000, this.wait * 2);
    setTimeout(() => this.open(), wait);
  }

  private take(raw: string) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const channel = typeof m.channel === "string" ? m.channel : "";
    if (channel.startsWith("trade")) {
      const trades = Array.isArray(m.trades) ? (m.trades as Record<string, unknown>[]) : [];
      // Oldest first, so a snapshot of fifty builds the series in order.
      const sorted = trades
        .map<Trade>((t) => ({ price: num(t.price), size: num(t.size), at: num(t.timestamp) }))
        .filter((t) => t.price > 0 && t.at > 0)
        .sort((a, b) => a.at - b.at);
      const was = this.bars.open?.t;
      for (const t of sorted) this.bars.add(t);
      const head = this.bars.open;
      if (head && head.t !== was) this.opts.onBar?.(head);
      return;
    }
    if (channel.startsWith("market_stats")) {
      const s = (m.market_stats ?? {}) as Record<string, unknown>;
      const mark = num(s.mark_price);
      if (mark <= 0) return;
      this.stats = {
        mark,
        index: num(s.index_price, mark),
        mid: num(s.mid_price, mark),
        fundingRate: num(s.current_funding_rate),
        changePct: num(s.daily_price_change),
        high: num(s.daily_price_high, mark),
        low: num(s.daily_price_low, mark),
        volume: num(s.daily_quote_token_volume),
        at: Date.now(),
      };
      this.opts.onStats?.(this.stats);
    }
  }
}
