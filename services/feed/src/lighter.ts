/**
 * Lighter's public stream.
 *
 * Reads need no credential of any kind: the socket carries trades, the book
 * and account state to anyone who asks. That is why this service exists
 * rather than a Builder account, whose only gift is a higher REST read limit
 * we would never reach.
 */

import { type Bar, Bars, CANDLE_MS, secondOf, type Trade } from "./bars";

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
  /** Mark observations are real venue prices, with no traded volume. */
  priceSource?: "trades" | "mark";
  onBar?: (bar: Bar) => void;
  onStats?: (stats: Stats) => void;
  /** The book's best bid and ask, which move many times between trades. */
  onQuote?: (quote: Quote) => void;
};

/** Best bid and ask. Shown as the live price; never folded into the trade candles. */
export type Quote = { bid: number; ask: number; mid: number; at: number };

/**
 * One socket, held open. Lighter sends a snapshot on subscribe and updates
 * after it, and drops the connection now and then; reconnect backs off to
 * thirty seconds so a venue having a bad minute is not made worse.
 *
 * Reconnecting on close is not enough. A socket can stop delivering without
 * ever closing, and this one does: it sat open and silent while Bitcoin moved
 * $167, and the clock below kept manufacturing a bar a second at the last
 * price it had heard. The chart went flat, then jumped when somebody
 * restarted the service. So silence is watched for as well as closure.
 */
/** How long a market this busy can plausibly go quiet before the socket is the problem. */
const SILENCE_MS = 30_000;

export class LighterFeed {
  readonly bars: Bars;
  stats: Stats | null = null;
  private ws: WebSocket | null = null;
  private wait = 500;
  private shut = false;
  private clock: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<number, Bar>();
  quote: Quote | null = null;
  private pingAt = 0;
  private priceAt = 0;
  private readonly seenTrades = new Set<string>();
  /** When the socket last said anything at all. */
  private heard = Date.now();

  constructor(private readonly opts: FeedOptions) {
    this.bars = new Bars(opts.keep ?? 1200);
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN && Date.now() - this.heard < SILENCE_MS && (this.priceAt > 0 && Date.now() - this.priceAt < SILENCE_MS);
  }

  private flush() {
    for (const bar of this.pending.values()) this.opts.onBar?.({ ...bar });
    this.pending.clear();
  }

  start() {
    this.shut = false;
    this.open();
    // A market with no prints still has to produce a bar a second.
    this.clock ??= setInterval(() => {
      const before = this.bars.open?.t;
      if(this.connected) this.bars.tick();
      const head = this.bars.open;
      if (head && head.t !== before) {
        for (const bar of this.bars.all()) {
          if (before === undefined || bar.t >= before) this.pending.set(bar.t, bar);
        }
      }
      this.flush();
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.pingAt >= 30_000) {
        this.ws.send(JSON.stringify({ type: "ping" }));
        this.pingAt = Date.now();
      }
      /*
        Bitcoin prints many times a second, so half a minute of silence is
        not a quiet market, it is a dead socket. Closing it makes the close
        handler reconnect, which is the path that already works.
      */
      if (Date.now() - this.heard > SILENCE_MS) {
        console.warn(`feed: nothing heard for ${Math.round((Date.now() - this.heard) / 1000)}s, reopening`);
        this.heard = Date.now();
        this.ws?.close();
      }
    }, CANDLE_MS);
  }

  stop() {
    this.shut = true;
    if (this.clock) clearInterval(this.clock);
    this.pending.clear();
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
      this.heard = Date.now();
      this.pingAt = Date.now();
      ws.send(JSON.stringify({ type: "subscribe", channel: `trade/${this.opts.marketId}` }));
      ws.send(JSON.stringify({ type: "subscribe", channel: `market_stats/${this.opts.marketId}` }));
      ws.send(JSON.stringify({ type: "subscribe", channel: `ticker/${this.opts.marketId}` }));
    });
    ws.addEventListener("message", (e) => {
      this.heard = Date.now();
      this.take(String(e.data));
      this.flush();
    });
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
    if(m.type === "ping") {this.ws?.send(JSON.stringify({type:"pong"}));return;}
    const channel = typeof m.channel === "string" ? m.channel : "";
    if (channel.startsWith("trade")) {
      if (this.opts.priceSource === "mark") return;
      const trades = Array.isArray(m.trades) ? (m.trades as Record<string, unknown>[]) : [];
      // Oldest first, so a snapshot of fifty builds the series in order.
      const sorted = trades
        .filter(t=>{
          const id=String(t.trade_id_str??t.trade_id??"");
          if(!id)return true;
          if(this.seenTrades.has(id))return false;
          this.seenTrades.add(id);
          if(this.seenTrades.size>10000)this.seenTrades.delete(this.seenTrades.values().next().value!);
          return true;
        })
        .map<Trade>((t) => ({ price: num(t.price), size: num(t.size), at: num(t.timestamp) }))
        .filter((t) => t.price > 0 && t.at > 0)
        .sort((a, b) => a.at - b.at);
      if (sorted.length) this.priceAt = Date.now();
      const was = this.bars.open?.t;
      for (const t of sorted) this.bars.add(t);
      const firstTouched = sorted.length ? secondOf(sorted[0].at) : Infinity;
      for (const bar of this.bars.all()) {
        if (was === undefined || bar.t >= Math.min(was, firstTouched)) this.pending.set(bar.t, bar);
      }
      return;
    }
    if (channel.startsWith("ticker")) {
      const t = (m.ticker ?? {}) as { a?: { price?: unknown }; b?: { price?: unknown } };
      const ask = num(t.a?.price);
      const bid = num(t.b?.price);
      if (ask > 0 && bid > 0 && ask >= bid) {
        this.quote = { bid, ask, mid: (bid + ask) / 2, at: Date.now() };
        this.opts.onQuote?.(this.quote);
      }
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
      if (this.opts.priceSource === "mark") {
        this.priceAt = this.stats.at;
        const before = this.bars.open?.t;
        this.bars.add({ price: mark, size: 0, at: this.priceAt });
        for (const bar of this.bars.all()) {
          if (before === undefined || bar.t >= before) this.pending.set(bar.t, bar);
        }
      }
      this.opts.onStats?.(this.stats);
    }
  }
}
