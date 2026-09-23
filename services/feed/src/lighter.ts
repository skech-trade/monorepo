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

/** How long a market this busy can plausibly go quiet before the socket is the problem. */
const SILENCE_MS = 30_000;
/** How often the venue is pinged, so it does not call a quiet reader idle. */
const PING_MS = 30_000;
/** Trade ids remembered for replay, oldest forgotten first. A snapshot is fifty. */
const SEEN_TRADES = 10_000;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null;

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
export class LighterFeed {
  readonly bars: Bars;
  stats: Stats | null = null;
  quote: Quote | null = null;
  private ws: WebSocket | null = null;
  private wait = 500;
  private shut = false;
  private clock: ReturnType<typeof setInterval> | null = null;
  /** Bars changed since the last flush, by time, in the order they were touched. */
  private pending = new Map<number, Bar>();
  private pingAt = 0;
  /** When a price last arrived, from whichever source the chart is built on. */
  private priceAt = 0;
  private readonly seenTrades = new Set<string>();
  /** When the socket last said anything at all. */
  private heard = Date.now();

  constructor(private readonly opts: FeedOptions) {
    this.bars = new Bars(opts.keep ?? 1200);
  }

  /** Open, talking, and carrying prices: a socket that only says hello is not a feed. */
  get connected() {
    const now = Date.now();
    return (
      this.ws?.readyState === WebSocket.OPEN &&
      now - this.heard < SILENCE_MS &&
      this.priceAt > 0 &&
      now - this.priceAt < SILENCE_MS
    );
  }

  /**
   * Queue every bar from second `from` on for the next flush; with no `from`,
   * every bar held. Bars are in time order, so this walks back from the front
   * only as far as it has to rather than across the whole window on every
   * message, then queues forward so listeners still hear them oldest first.
   */
  private touch(from: number | undefined) {
    const bars = this.bars.all();
    let i = bars.length;
    if (from === undefined) i = 0;
    else while (i > 0 && bars[i - 1].t >= from) i--;
    for (; i < bars.length; i++) this.pending.set(bars[i].t, bars[i]);
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
      if (this.connected) this.bars.tick();
      const head = this.bars.open;
      if (head && head.t !== before) this.touch(before);
      this.flush();
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.pingAt >= PING_MS) {
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
      for (const channel of ["trade", "market_stats", "ticker"]) {
        ws.send(JSON.stringify({ type: "subscribe", channel: `${channel}/${this.opts.marketId}` }));
      }
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

  /**
   * Whether a trade is new. The venue replays recent trades on every
   * subscribe, so a reconnect would otherwise count them twice. A trade with
   * no id cannot be matched and is taken as it is.
   */
  private fresh(t: Json) {
    const id = String(t.trade_id_str ?? t.trade_id ?? "");
    if (!id) return true;
    if (this.seenTrades.has(id)) return false;
    this.seenTrades.add(id);
    // A Set iterates in insertion order, so the first value is the oldest.
    if (this.seenTrades.size > SEEN_TRADES) this.seenTrades.delete(this.seenTrades.values().next().value!);
    return true;
  }

  private take(raw: string) {
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    // Valid JSON is not always an object, and a throw here would skip the flush.
    if (!isObject(m)) return;
    if (m.type === "ping") {
      this.ws?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    const channel = typeof m.channel === "string" ? m.channel : "";
    if (channel.startsWith("trade")) this.takeTrades(m);
    else if (channel.startsWith("ticker")) this.takeTicker(m);
    else if (channel.startsWith("market_stats")) this.takeStats(m);
  }

  private takeTrades(m: Json) {
    if (this.opts.priceSource === "mark") return;
    const raw = Array.isArray(m.trades) ? m.trades.filter(isObject) : [];
    // Oldest first, so a snapshot of fifty builds the series in order.
    const trades = raw
      .filter((t) => this.fresh(t))
      .map<Trade>((t) => ({ price: num(t.price), size: num(t.size), at: num(t.timestamp) }))
      .filter((t) => t.price > 0 && t.at > 0)
      .sort((a, b) => a.at - b.at);
    if (trades.length) this.priceAt = Date.now();
    const was = this.bars.open?.t;
    for (const t of trades) this.bars.add(t);
    // A late print can repair bars behind the front, so they go out again too.
    const firstTouched = trades.length ? secondOf(trades[0].at) : Infinity;
    this.touch(was === undefined ? undefined : Math.min(was, firstTouched));
  }

  private takeTicker(m: Json) {
    const t = (m.ticker ?? {}) as { a?: { price?: unknown }; b?: { price?: unknown } };
    const ask = num(t.a?.price);
    const bid = num(t.b?.price);
    if (ask > 0 && bid > 0 && ask >= bid) {
      this.quote = { bid, ask, mid: (bid + ask) / 2, at: Date.now() };
      this.opts.onQuote?.(this.quote);
    }
  }

  private takeStats(m: Json) {
    const s = isObject(m.market_stats) ? m.market_stats : {};
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
      this.touch(before);
    }
    this.opts.onStats?.(this.stats);
  }
}
