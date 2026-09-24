import { type Pt, shapeOf } from "@skech/core/shape";
import type { Exec, OrderRequest, Position, Sent, StopRequest, VenueFill } from "./executor";
import type { MarketInfo } from "./lighter";
import { desiredAt, nextChange, replan, type Run, type Segment, segmentsFrom, setSkipped } from "./plan";
import { clientIdOf, type Fill, fillId, sideOf } from "./pnl";
import { sizeStep, tradeable } from "./round";
import { timing } from "./timing";
import { VenueTimeout } from "./venue-socket";

/**
 * A drawn round, run against the venue.
 *
 * The line becomes a timeline of segments (see `plan.ts`), and the timeline
 * becomes trades: each position held between two turns is one trade with its
 * own id, opened by one order and closed by another. Long after long is one
 * trade that continues. Long after short is the short's close and the long's
 * open, sent together in one batch so they land in one round trip.
 *
 * The scheduler does not replay a list of orders. At each moment it asks what
 * the timeline wants held, compares that with what is held, and sends the
 * difference, a little early so it lands on time. That one question covers a
 * turn on schedule, a late wake, an edit to the line mid-round and a segment
 * cut out of it, without special cases for any of them.
 *
 * Confirmation is pushed: fills and positions arrive on the account's own
 * channels, so nothing polls the venue while a round runs.
 */

/**
 * `venueStop` puts the loss exit on the venue as well as in this process: a
 * resting reduce-only stop at the price where the round's loss reaches
 * `exits.lose`, moved with every trade. Boosted rounds need it, because what
 * stands between skech's money and the market cannot depend on this process
 * being up.
 */
export type RoundSpec = { market?: string; pts: Pt[]; stake: number; leverage: number; seconds: number; exits: { lose: number | null; gain: number | null }; venueStop?: boolean };
/**
 * A boosted round's terms and, once it is over, how it was shared out. In
 * dollars, for the page; the ledger keeps the exact figures. `owner` and
 * `accountIndex` are the user's own, because the round trades a lane.
 */
export type BoostTag = {
  id: string;
  owner: string;
  accountIndex: number;
  stake: number;
  boost: number;
  /** The loss, in dollars, at which the round closes: 80% of the stake. */
  closeAt: number;
  cut: number;
  lossFee: number;
  status: "running" | "settling" | "done" | "refunded";
  settlement?: { equity: number; back: number; fee: number; cut: number; gap: number };
  problem?: string | null;
};
/** The stop resting on the venue for the trade that is open. `fired` once the venue says it went. */
export type Guard = { orderId: string; tradeId: string; dir: 1 | -1; size: number; trigger: number; worst: number; placedAt: number; status: "placing" | "resting" | "fired" | "cancelled" | "failed"; error?: string };
export type Outcome = "time" | "stop" | "target" | "failed";

export type Order = {
  /** The client order index sent to the venue, as a string. Fills are matched on it. */
  id: string;
  tradeId: string;
  kind: "open" | "close";
  side: "buy" | "sell";
  size: number;
  reduceOnly: boolean;
  /** When the plan wanted this order to take effect. */
  dueAt: number;
  requestedAt: number;
  sentAt?: number;
  ackAt?: number;
  /** The chart's price when the venue took it. What testnet's exits are judged on; see `chartNet`. */
  chartAt?: number;
  /** When its first fill was pushed back, on this server's clock. */
  filledAt?: number;
  filled: number;
  avgPrice?: number;
  /** Profit on this order's fills. Only closing fills book any. */
  pnl: number;
  /**
   * Where `pnl` came from. The account's fill push arrives without the
   * venue's P&L fields, so a close is first estimated from its fill prices
   * against the trade's entry, then replaced by the venue's own figure from
   * its fill history. Lighter Standard charges no fees, so the two agree to
   * the cent unless a fill was missed.
   */
  pnlFrom?: "estimate" | "venue";
  status: "sending" | "acked" | "partial" | "filled" | "rejected" | "uncertain";
  via?: "ws" | "http";
  hash?: string;
  error?: string;
};

export type Trade = {
  id: string;
  dir: 1 | -1;
  size: number;
  status: "opening" | "open" | "closing" | "closed" | "failed";
  openOrderId?: string;
  closeOrderId?: string;
  entry?: number;
  exit?: number;
  pnl: number;
  openedAt?: number;
  closedAt?: number;
};

export type Round = {
  id: string;
  status: "running" | "closing" | "done";
  outcome: Outcome | null;
  /** The execution market's price when the round opened. */
  entry: number;
  /** The reference chart's price the line was drawn from. */
  chartEntry?: number;
  stake: number;
  leverage: number;
  seconds: number;
  startedAt: number;
  accountIndex: number;
  /** The market's symbol. Rounds recorded before a second market have none, and are Bitcoin. */
  market?: string;
  /** Base units (BTC, ETH) each trade in this round opens. */
  quantity: number;
  /** What the venue shows held, and its mark-to-market. */
  size: number;
  unrealised: number;
  realised: number;
  /** Booked plus open. Null until every order sent has been accounted for. */
  net: number | null;
  pnlReady: boolean;
  /** Whether `realised` is the venue's booked figure yet, or still estimated from fill prices. */
  pnlFrom?: "estimate" | "venue";
  pts: Pt[];
  segments: Segment[];
  trades: Trade[];
  orders: Order[];
  fills: { id: string; orderId: string; at: number; venueAt: number; buy: boolean; price: number; size: number }[];
  exit?: number;
  untracked?: boolean;
  bars?: { t: number; o: number; h: number; l: number; c: number; v: number }[];
  /** The drawer's stop and target, kept on the record so a restart can resume watching them. */
  exits?: RoundSpec["exits"];
  /** Whether the loss exit also rests on the venue (see `RoundSpec`), and the stop that does it. */
  venueStop?: boolean;
  guard?: Guard | null;
  /** Set when skech's money is in this round. */
  boost?: BoostTag;
  timing: { requestedAt: number; readyAt?: number; openAckAt?: number; openFilledAt?: number; closeRequestedAt?: number; closeAckAt?: number; closedAt?: number };
  problem: string | null;
};

type Options = {
  save?: (round: Round) => Promise<void>;
  /** How long an order may go without a fill before the position push is trusted over it. */
  settleMs?: number;
  /** How long a close may take to show flat before the round says it is still confirming. */
  flatMs?: number;
  /** The earliest an edit can take effect, beyond the send lead. */
  guardMs?: number;
  /** Where finished rounds fetch their replay from. Null skips it. */
  feedUrl?: string | null;
  /**
   * The chart's live price, when the venue trades somewhere else. Testnet's
   * book is a quote that barely moves, a spread about $100 wide on Bitcoin,
   * so its P&L is that spread and nothing else: every turn at fifty times
   * cost about $7 whichever way the price went, and a $16 stop fired on the
   * third turn of a line the chart said was winning. With this set, a round's
   * stop and target are judged on the P&L the page shows, priced on the chart.
   */
  chartPrice?: (market: string) => number | null;
  now?: () => number;
};

const EPS = 1e-9;

/** A trade the venue may still hold some of. */
const holding = (t: Trade) => t.status === "opening" || t.status === "open" || t.status === "closing";

/** An order as the venue receives it. */
const request = (o: Order): OrderRequest => ({ clientOrderIndex: BigInt(o.id), size: o.size, isAsk: o.side === "sell", reduceOnly: o.reduceOnly });

export class Rounds {
  private readonly live = new Map<string, Round>();
  private readonly execs = new Map<string, Exec>();
  /** The account a finished round traded, for booking its venue P&L late. */
  private readonly lastExec = new Map<string, Exec>();
  private readonly accounts = new Set<number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly wires = new Map<string, (() => void)[]>();
  private readonly listeners = new Map<string, Set<(round: Round) => void>>();
  private readonly failures = new Map<string, number>();
  /** Opens the venue took and then cancelled, per round. Not reset by a later ack, unlike `failures`. */
  private readonly unfilled = new Map<string, number>();
  private readonly seenFills = new Map<string, Set<string>>();
  /** The exits each running round watches. Memory only: `resume` rebuilds it from the record. */
  private readonly spec = new Map<string, RoundSpec>();
  private sequence = 0;

  constructor(
    private readonly markets: (symbol: string) => MarketInfo,
    private readonly options: Options = {},
  ) {}

  private market(round: { market?: string }) {
    return this.markets(round.market ?? "BTC");
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  get(id: string) {
    return this.live.get(id) ?? null;
  }

  /** Change something on a round's record that is not the scheduler's, such as its Boost terms, and tell whoever is watching. */
  note(id: string, patch: Partial<Pick<Round, "boost" | "problem">>) {
    const round = this.live.get(id);
    if (!round) return;
    Object.assign(round, patch);
    void this.save(round);
  }

  /** Stop scheduling anything, as a process does when it exits. Rounds stay as recorded. */
  stop() {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
    for (const id of [...this.wires.keys()]) this.detach(id);
    for (const r of this.live.values()) if (r.status === "running") r.status = "closing";
  }

  all() {
    return [...this.live.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  subscribe(id: string, listener: (round: Round) => void) {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    const round = this.get(id);
    if (round) listener(round);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  private publish(round: Round) {
    for (const listener of this.listeners.get(round.id) ?? []) listener(round);
  }

  private save(round: Round) {
    this.publish(round);
    return (this.options.save?.(round) ?? Promise.resolve()).catch((e) => console.error("round save:", (e as Error).message));
  }

  /** A client order index nobody else has used: milliseconds, then a counter. */
  private orderId() {
    return BigInt(this.now()) * 100n + BigInt(this.sequence++ % 100);
  }

  /** How early to send so an order lands when the plan wants it: half a measured round trip. */
  private lead(exec: Exec) {
    return Math.min(250, Math.max(0, exec.latency() / 2));
  }

  /** The earliest a change to the plan can take effect: past the send lead, plus a guard. */
  private frozenUntil(exec: Exec) {
    return this.now() + this.lead(exec) + (this.options.guardMs ?? 150);
  }

  /** Run the scheduler from a timer or a push. Whatever it throws fails the round, not the process. */
  private kick(round: Round) {
    void this.step(round).catch((e) => this.fail(round, e));
  }

  /** A market order for one trade: an open faces the trade's way, a close the other way and reduce-only. */
  private order(tradeId: string, kind: Order["kind"], dir: number, size: number, dueAt: number, requestedAt: number): Order {
    const buy = kind === "open" ? dir > 0 : !(dir > 0);
    return { id: String(this.orderId()), tradeId, kind, side: buy ? "buy" : "sell", size, reduceOnly: kind === "close", dueAt, requestedAt, filled: 0, pnl: 0, status: "sending" };
  }

  /** The venue took it. A fill pushed before the ack has already moved it past "sending". */
  private acked(round: Round, o: Order, sent: Sent, hash: string | undefined) {
    o.sentAt = sent.sentAt;
    o.ackAt = sent.ackAt;
    o.chartAt = this.options.chartPrice?.(round.market ?? "BTC") ?? undefined;
    o.via = sent.via;
    o.hash = hash;
    if (o.status === "sending") o.status = "acked";
  }

  /** The trade whose position is still out there: the open one, or failing that the last one closing. */
  private heldTrade(round: Round) {
    return this.openTrade(round) ?? round.trades.findLast((t) => t.status === "closing") ?? null;
  }

  /** A round recorded before a restart. Unfinished ones never resume on their own. */
  restore(round: Round, exec?: Exec) {
    round.segments ??= [];
    round.trades ??= [];
    round.orders ??= [];
    round.fills ??= [];
    round.timing ??= { requestedAt: round.startedAt };
    // Records saved before a finished round's net stopped counting a stale open mark.
    if (round.status === "done") {
      round.unrealised = 0;
      if (round.pnlReady) round.net = round.realised;
    }
    this.live.set(round.id, round);
    if (exec) this.attach(round.id, exec);
    if (round.status !== "done") {
      round.status = "closing";
      round.problem = "Service restarted. Close the remaining position to reconcile this round.";
      this.accounts.add(round.accountIndex);
    }
  }

  /**
   * Pick a restored round back up with its account's key.
   *
   * A restart used to leave the round halted and its position open until
   * somebody pressed Close, and in development every saved file restarts the
   * trader. Now the venue's position is believed over the record, the trades
   * are made to agree with it, and the scheduler carries on: the same "what
   * should be held now" question closes, flips or keeps whatever is there,
   * and a round whose end has passed simply closes.
   */
  async resume(round: Round, exec: Exec) {
    if (round.status === "done") return;
    this.attach(round.id, exec);
    this.accounts.add(round.accountIndex);
    await exec.prepare(round.leverage || 1);
    const held = exec.position()?.size ?? 0;
    // Anything that was on its way when the process died has an unknown fate; the position says.
    for (const o of round.orders) if (o.status === "sending" || o.status === "acked") o.status = "uncertain";
    const open = this.heldTrade(round);
    for (const t of round.trades) if (t !== open && holding(t)) t.status = "closed";
    if (Math.abs(held) < EPS) {
      if (open) open.status = "closed";
    } else if (open && Math.sign(held) === open.dir) {
      open.status = "open";
      open.size = Math.abs(held);
    } else {
      if (open) open.status = "closed";
      round.trades.push({ id: `t${this.now().toString(36)}`, dir: held > 0 ? 1 : -1, size: Math.abs(held), status: "open", pnl: 0 });
    }
    if (round.exits) this.spec.set(round.id, { market: round.market, pts: round.pts, stake: round.stake, leverage: round.leverage, seconds: round.seconds, exits: round.exits, venueStop: round.venueStop });
    // Whatever stop rested before the restart may or may not still be there: the batch that places a new one cancels it first.
    if (round.guard && round.guard.status !== "fired") round.guard.status = "cancelled";
    round.problem = null;
    round.status = round.untracked || !round.segments.length ? "closing" : "running";
    this.publish(round);
    if (round.status === "running") {
      await this.step(round);
      await this.arm(round);
    } else await this.finish(round);
    void this.save(round);
  }

  /** Give a round the account it trades, so its pushes reach it. */
  attach(id: string, exec: Exec) {
    const round = this.live.get(id);
    if (!round || this.execs.get(id) === exec) return;
    for (const off of this.wires.get(id) ?? []) off();
    this.execs.set(id, exec);
    this.wires.set(id, [exec.onPosition((p) => this.onPosition(round, p)), exec.onFill((f) => this.onFill(round, f))]);
  }

  private detach(id: string) {
    const exec = this.execs.get(id);
    if (exec) this.lastExec.set(id, exec);
    for (const off of this.wires.get(id) ?? []) off();
    this.wires.delete(id);
  }

  /** Warm everything a trade needs, while somebody is still drawing. */
  prepare(exec: Exec, leverage: number) {
    return exec.prepare(leverage);
  }

  async open(spec: RoundSpec, exec: Exec): Promise<Round> {
    const requestedAt = this.now();
    // Reserve synchronously: two requests must not both find the account free.
    if (this.accounts.has(exec.accountIndex)) throw Error("Finish the existing round before starting another.");
    this.accounts.add(exec.accountIndex);
    let round: Round | null = null;
    try {
      if (!exec.position()) await exec.prepare(spec.leverage);
      const held = exec.position();
      if (!held) throw Error("Account data unavailable; try again in a moment.");
      if (Math.abs(held.size) > EPS) throw Error("Close existing positions before starting a Skech round.");
      const chartEntry = spec.pts[0]?.price;
      const shape = shapeOf(spec.pts, chartEntry);
      if (!shape || shape.flat) throw Error("Draw a clear prediction before trading.");
      const market = this.market(spec);
      const quantity = sizeStep(market, (spec.stake * spec.leverage) / market.last);
      if (!tradeable(market, quantity, market.last)) throw Error(`That stake is below the venue minimum of $${market.minQuote}.`);
      const startedAt = this.now();
      round = {
        id: crypto.randomUUID(),
        status: "running",
        outcome: null,
        entry: market.last,
        chartEntry,
        stake: spec.stake,
        leverage: spec.leverage,
        seconds: spec.seconds,
        startedAt,
        accountIndex: exec.accountIndex,
        market: spec.market ?? "BTC",
        quantity,
        size: 0,
        unrealised: 0,
        realised: 0,
        net: null,
        pnlReady: false,
        pts: spec.pts,
        segments: segmentsFrom(shape, startedAt, spec.seconds),
        trades: [],
        orders: [],
        fills: [],
        exits: spec.exits,
        venueStop: spec.venueStop ?? false,
        guard: null,
        timing: { requestedAt, readyAt: startedAt },
        problem: null,
      };
      this.spec.set(round.id, spec);
      this.live.set(round.id, round);
      this.attach(round.id, exec);
      timing("open.accept", startedAt - requestedAt, { round: round.id });
      // The first trade goes out now, with leverage in the same batch if it still needs setting.
      await this.step(round);
      const first = round.orders[0];
      if (!first || first.status === "rejected") throw Error(first?.error ?? round.problem ?? "The venue did not accept the opening order.");
      void this.save(round);
      return round;
    } catch (error) {
      if (round) {
        this.clearTimer(round.id);
        this.detach(round.id);
        this.live.delete(round.id);
      }
      this.accounts.delete(exec.accountIndex);
      throw error;
    }
  }

  /**
   * A new line for a running round. What has happened stays; the rest follows
   * the new drawing. `seconds` lets the line grow past its old end, which is
   * how somebody adds positions to a round that is already trading. The
   * points arrive as shares of the new length.
   */
  async edit(id: string, pts: Pt[], seconds = this.live.get(id)?.seconds ?? 0): Promise<Round> {
    const round = this.running(id);
    const exec = this.execs.get(id)!;
    // The round ends where the line ends. A line that stops short of its length (a Draw more hold
    // replaced by a shorter stroke, a removed last point) would otherwise hold the last position past it.
    const end = pts.at(-1)?.t ?? 1;
    if (end > 0 && end < 1) {
      seconds *= end;
      pts = pts.map((p) => ({ ...p, t: p.t / end }));
    }
    const shape = shapeOf(pts, round.chartEntry ?? pts[0]?.price);
    if (!shape || shape.flat) throw Error("Draw a clear prediction before trading.");
    const frozen = this.frozenUntil(exec);
    // A round can grow or shrink, but never end before the edit could take effect.
    const length = Math.max(seconds, (frozen - round.startedAt) / 1000);
    round.segments = replan(round.segments, segmentsFrom(shape, round.startedAt, length), frozen);
    round.seconds = length;
    round.pts = pts;
    await this.step(round);
    void this.save(round);
    return round;
  }

  /** Cut one segment out, or put it back. A cut short between two longs keeps the long open. */
  async skip(id: string, segmentId: string, skipped: boolean): Promise<Round> {
    const round = this.running(id);
    round.segments = setSkipped(round.segments, segmentId, skipped, this.frozenUntil(this.execs.get(id)!));
    await this.step(round);
    void this.save(round);
    return round;
  }

  private running(id: string) {
    const round = this.live.get(id);
    if (!round) throw Error("Round not found.");
    if (round.status !== "running" || !this.execs.get(id)) throw Error("That round is no longer running.");
    return round;
  }

  async close(id: string) {
    const round = this.live.get(id);
    if (!round || round.status === "done") return round ?? null;
    if (!this.execs.get(id)) throw Error("Trading key unavailable; cannot close this round.");
    round.timing.closeRequestedAt ??= this.now();
    await this.finish(round);
    return round;
  }

  /** Explicit recovery for a position whose round was lost. */
  async closeExisting(accountIndex: number, on: (market: string) => Exec, market = "BTC") {
    const existing = this.all().find((r) => r.accountIndex === accountIndex && r.status !== "done");
    if (existing) {
      this.attach(existing.id, on(existing.market ?? "BTC"));
      return this.close(existing.id);
    }
    const exec = on(market);
    if (!exec.position()) await exec.prepare(1).catch(() => undefined);
    const held = exec.position();
    if (!held || Math.abs(held.size) < EPS) throw Error("No open position to close.");
    const now = this.now();
    const tradeId = `t-${now.toString(36)}`;
    const round: Round = {
      id: crypto.randomUUID(),
      status: "running",
      outcome: null,
      entry: held.avgEntry,
      stake: 0,
      leverage: 0,
      seconds: 0,
      startedAt: now,
      accountIndex: exec.accountIndex,
      market,
      quantity: Math.abs(held.size),
      size: held.size,
      unrealised: held.unrealised,
      realised: 0,
      net: null,
      pnlReady: false,
      pts: [],
      segments: [],
      trades: [{ id: tradeId, dir: held.size > 0 ? 1 : -1, size: Math.abs(held.size), status: "open", pnl: 0, entry: held.avgEntry }],
      orders: [],
      fills: [],
      untracked: true,
      timing: { requestedAt: now, closeRequestedAt: now },
      problem: null,
    };
    this.accounts.add(exec.accountIndex);
    this.live.set(round.id, round);
    this.attach(round.id, exec);
    await this.finish(round);
    return round;
  }

  // --- the scheduler ------------------------------------------------------

  private clearTimer(id: string) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private openTrade(round: Round) {
    return round.trades.find((t) => t.status === "opening" || t.status === "open") ?? null;
  }

  /**
   * Make what is held match what the line wants now, then sleep until it next
   * wants something different. Safe to call at any time and as often as you
   * like; it does nothing while an order is on its way.
   */
  private async step(round: Round): Promise<void> {
    if (round.status !== "running") return;
    const exec = this.execs.get(round.id);
    if (!exec) return;
    if (this.inflight.has(round.id)) return this.inflight.get(round.id);
    this.clearTimer(round.id);
    const now = this.now();
    const lead = this.lead(exec);
    const end = round.startedAt + round.seconds * 1000;
    const t = now + lead;
    const want: Run = t >= end ? { id: null, dir: 0, startAt: end, endAt: end, segmentIds: [] } : desiredAt(round.segments, t);
    const cur = this.openTrade(round);
    if ((cur?.dir ?? 0) !== want.dir) {
      let again = false;
      const task = this.dispatch(round, exec, cur, want, lead)
        .then((accepted) => {
          again = accepted;
        })
        .finally(() => this.inflight.delete(round.id));
      this.inflight.set(round.id, task);
      await task;
      // The open's fill often lands while its batch is still in flight, when arming is held back.
      void this.arm(round);
      // The plan may have moved while that order was on its way. A refusal waits for its retry timer.
      if (again) return this.step(round);
      return;
    }
    if (t >= end) {
      if (!cur) void this.finish(round);
      return;
    }
    const change = nextChange(round.segments, t) ?? end;
    const wake = Math.max(0, Math.min(change, end) - lead - this.now());
    this.timers.set(round.id, setTimeout(() => this.kick(round), wake));
  }

  /** Close what is held, open what is wanted, as one batch. */
  private async dispatch(round: Round, exec: Exec, cur: Trade | null, want: Run, lead: number): Promise<boolean> {
    const requestedAt = this.now();
    const dueAt = Math.max(want.startAt, round.startedAt);
    const orders: Order[] = [];
    const market = this.market(round);
    let opened: Trade | null = null;
    if (cur) {
      const size = this.closeSize(round, exec, cur);
      cur.status = "closing";
      if (size > EPS) {
        const order = this.order(cur.id, "close", cur.dir, size, dueAt, requestedAt);
        cur.closeOrderId = order.id;
        orders.push(order);
      } else {
        cur.status = "closed";
        cur.closedAt = requestedAt;
      }
    }
    if (want.dir !== 0) {
      const base = want.id ?? `t${requestedAt.toString(36)}`;
      const id = round.trades.some((t) => t.id === base) ? `${base}-${round.trades.filter((t) => t.id.startsWith(base)).length}` : base;
      opened = { id, dir: want.dir, size: round.quantity, status: "opening", pnl: 0 };
      const order = this.order(id, "open", want.dir, sizeStep(market, round.quantity), dueAt, requestedAt);
      opened.openOrderId = order.id;
      round.trades.push(opened);
      orders.push(order);
    }
    if (!orders.length) return true;
    round.orders.push(...orders);
    this.publish(round);
    const guarded = this.resting(round);
    try {
      const sent = await exec.submit(orders.map(request), round.leverage, { cancelAll: guarded });
      if (guarded && round.guard) round.guard.status = "cancelled";
      orders.forEach((o, i) => {
        // A leverage update signed into the same batch takes the first hash.
        this.acked(round, o, sent, sent.hashes[i + (sent.before ?? (sent.withLeverage ? 1 : 0))] ?? sent.hashes[i]);
        timing("order.ack", sent.ackAt - sent.sentAt, { round: round.id, trade: o.tradeId, kind: o.kind, via: sent.via, leverage: sent.withLeverage });
        // Against the moment it could first have gone: an opening order cannot leave before the click.
        timing("order.late", sent.sentAt - Math.max(o.requestedAt, o.dueAt - lead), { round: round.id, kind: o.kind });
      });
      if (opened && opened.status === "opening") opened.status = "open";
      if (opened?.openOrderId) this.watchOpen(round, exec, opened, opened.openOrderId);
      if (!round.timing.openAckAt && opened) {
        round.timing.openAckAt = sent.ackAt;
        timing("open.ack", sent.ackAt - round.timing.requestedAt, { round: round.id, via: sent.via, leverage: sent.withLeverage });
      }
      this.failures.delete(round.id);
    } catch (e) {
      const unknown = e instanceof VenueTimeout;
      const message = (e as Error).message.slice(0, 160);
      for (const o of orders) {
        o.status = unknown ? "uncertain" : "rejected";
        o.error = message;
      }
      if (!unknown) {
        // Nothing happened on the venue: put the books back as they were.
        if (cur) cur.status = "open";
        if (opened) opened.status = "failed";
        round.problem = `Order not accepted: ${message}`;
        const n = (this.failures.get(round.id) ?? 0) + 1;
        this.failures.set(round.id, n);
        if (round.orders.filter((o) => o.status !== "rejected").length > 0 && n < 3) {
          // Try again shortly rather than sit the wrong way round until the next turn.
          this.clearTimer(round.id);
          this.timers.set(round.id, setTimeout(() => this.kick(round), 400));
        } else if (round.orders.some((o) => o.status !== "rejected")) {
          round.outcome = "failed";
          void this.finish(round);
        }
      } else {
        round.problem = "The venue did not answer in time; checking what it booked.";
      }
    }
    this.publish(round);
    void this.save(round);
    return orders.every((o) => o.status !== "rejected");
  }

  /**
   * How much to close. The venue's own figure when every order has settled,
   * otherwise what the trade was opened at. Reduce-only either way, so a
   * figure that is too large can never flip the position.
   */
  private closeSize(round: Round, exec: Exec, trade: Trade) {
    const held = exec.position();
    if (held && this.settled(round)) return Math.abs(held.size);
    const open = round.orders.find((o) => o.id === trade.openOrderId);
    return open && open.filled > EPS ? open.filled : trade.size;
  }

  /** Every order has either filled, been refused, or had long enough that the position push is the truth. */
  /**
   * An open the venue took and then cancelled: margin, a price band, an empty
   * book. Lighter says so on no channel the engine listens to, so the only
   * sign is that nothing filled and nothing is held once the settle window
   * has passed. Believe that, and let the plan open it again, three times at
   * most, rather than run a round with nothing on.
   */
  private watchOpen(round: Round, exec: Exec, trade: Trade, orderId: string) {
    const wait = (this.options.settleMs ?? 2000) + 100;
    setTimeout(async () => {
      const order = round.orders.find((o) => o.id === orderId);
      if (round.status !== "running" || !order || order.status !== "acked" || order.filled > 0) return;
      if (Math.abs(exec.position()?.size ?? 0) > EPS || this.inflight.has(round.id)) return;
      // The pushes say nothing happened; so would pushes that had stopped. Ask the venue before believing it.
      const held = await exec.heldNow().catch(() => null);
      if (round.status !== "running" || order.status !== "acked" || order.filled > 0) return;
      if (held === null || Math.abs(held) > EPS) {
        // It did fill, or the venue cannot say: read what it booked, and let the end of the round close whatever is there.
        round.problem = "Checking the fill with Lighter.";
        void this.booked(round);
        return;
      }
      order.status = "rejected";
      order.error = "Lighter did not fill it.";
      if (trade.status === "open" || trade.status === "opening") trade.status = "failed";
      const n = (this.unfilled.get(round.id) ?? 0) + 1;
      this.unfilled.set(round.id, n);
      this.tally(round);
      if (n < 3) {
        round.problem = "An order did not fill; retrying at the market.";
        this.publish(round);
        this.kick(round);
      } else {
        round.problem = round.fills.length ? "Lighter stopped filling this trade, so it ended early." : "Lighter did not fill this trade. Nothing was spent.";
        round.outcome = "failed";
        void this.finish(round);
      }
    }, wait);
  }

  private settled(round: Round) {
    const now = this.now();
    const wait = this.options.settleMs ?? 2000;
    return round.orders.every((o) => o.status === "filled" || o.status === "rejected" || (o.status !== "sending" && now - (o.ackAt ?? o.requestedAt) > wait));
  }

  /** `pushed` is false for fills read back from the venue's history: they are not timed, being late by design. */
  private onFill(round: Round, f: VenueFill, pushed = true) {
    // Rebuilt from the round's own record, so a late re-booking after the round
    // ends cannot count a fill it has already counted.
    const seen = this.seenFills.get(round.id) ?? new Set<string>(round.fills.map((f) => f.id));
    this.seenFills.set(round.id, seen);
    const id = fillId(f);
    if (seen.has(id)) return;
    const side = sideOf(f, round.accountIndex);
    if (!side) return;
    const clientId = clientIdOf(f, side);
    // The resting stop filling: the venue closed this trade for us. Booked as its close, and the round ends.
    const g = round.guard;
    let stopped = false;
    if (g && clientId === g.orderId && !round.orders.some((o) => o.id === g.orderId)) {
      round.orders.push({ id: g.orderId, tradeId: g.tradeId, kind: "close", side: g.dir > 0 ? "sell" : "buy", size: g.size, reduceOnly: true, dueAt: g.placedAt, requestedAt: g.placedAt, sentAt: g.placedAt, ackAt: g.placedAt, filled: 0, pnl: 0, status: "acked", via: "ws" });
      const guarded = round.trades.find((t) => t.id === g.tradeId);
      if (guarded && holding(guarded)) {
        guarded.status = "closing";
        guarded.closeOrderId = g.orderId;
      }
      g.status = "fired";
      round.outcome = "stop";
      stopped = true;
    }
    const order = round.orders.find((o) => o.id === clientId || (o.hash && o.hash === f.tx_hash));
    if (!order) return;
    seen.add(id);
    const size = Number(f.size ?? 0);
    const price = Number(f.price ?? 0);
    order.avgPrice = ((order.avgPrice ?? 0) * order.filled + price * size) / (order.filled + size || 1);
    order.filled += size;
    const trade = round.trades.find((t) => t.id === order.tradeId);
    const booked = f[`${side}_account_pnl`];
    if (booked !== undefined) {
      order.pnl += Number(booked) || 0;
      order.pnlFrom ??= "venue";
    } else if (order.kind === "close" && trade?.entry) {
      order.pnl += trade.dir * (price - trade.entry) * size;
      order.pnlFrom = "estimate";
    }
    const first = order.filledAt === undefined;
    order.filledAt ??= f.receivedAt;
    order.status = order.filled >= order.size - 1e-8 ? "filled" : "partial";
    round.fills.push({ id, orderId: order.id, at: f.receivedAt, venueAt: f.timestamp, buy: side === "bid", price, size });
    if (first && pushed && order.sentAt) timing("order.fill", f.receivedAt - order.sentAt, { round: round.id, kind: order.kind });
    if (trade && order.kind === "open" && order.status === "filled" && pushed) queueMicrotask(() => void this.arm(round));
    if (trade && order.kind === "open") {
      trade.entry = order.avgPrice;
      trade.openedAt ??= order.filledAt;
      if (trade.status === "opening") trade.status = "open";
      if (!round.timing.openFilledAt && pushed) {
        round.timing.openFilledAt = f.receivedAt;
        timing("open.fill", f.receivedAt - round.timing.requestedAt, { round: round.id });
      }
    }
    if (trade && order.kind === "close") {
      trade.exit = order.avgPrice;
      trade.pnl = order.pnl;
      if (order.status === "filled") {
        trade.status = "closed";
        trade.closedAt = order.filledAt;
        // Replace the estimate with the venue's booked figure, off the trading path.
        if (order.pnlFrom !== "venue") setTimeout(() => void this.booked(round), 400);
      }
      round.exit = order.avgPrice;
    }
    this.tally(round);
    this.publish(round);
    if (stopped && round.status === "running") void this.finish(round);
  }

  private onPosition(round: Round, p: Position) {
    round.size = p.size;
    round.unrealised = p.unrealised;
    this.tally(round);
    if (round.status === "running") {
      const spec = this.spec.get(round.id);
      // A position past twice the round's size is not this round doing what it was asked.
      if (Math.abs(p.size) > round.quantity * 2 + this.market(round).minBase) return this.fail(round, Error("Position exceeds this round’s target size."));
      this.checkExits(round);
      const cur = this.openTrade(round);
      // Flat under a resting stop, with nothing of ours on its way: the stop went. Never reopen after it.
      const g = round.guard;
      if (round.status === "running" && cur && g && g.status === "resting" && g.tradeId === cur.id && cur.status === "open" && this.settled(round) && !this.inflight.has(round.id) && Math.abs(p.size) < EPS) {
        g.status = "fired";
        round.outcome = "stop";
        void this.finish(round);
      }
      // An open that never filled: once settled, believe the venue and let the plan open it again.
      if (round.status === "running" && cur && this.settled(round) && !this.inflight.has(round.id) && Math.abs(p.size) < EPS) {
        cur.status = "failed";
        round.problem = "An order did not fill; retrying at the market.";
        this.kick(round);
      }
    }
    this.publish(round);
  }

  /** Whether a chart price judges this round's exits rather than the venue's P&L. A boosted round risks skech's money at the venue's prices, so it never is. */
  private onChartPrices(round: Round) {
    return !!this.options.chartPrice && !(this.spec.get(round.id)?.venueStop ?? round.venueStop);
  }

  /**
   * What the round has made at the chart's prices, the way the page counts
   * it: each trade from the chart's price when its open was taken to the
   * chart's price when its close was, the open one marked at the chart now.
   * Null until every trade has a chart price to be read at.
   */
  chartNet(round: Round): number | null {
    const now = this.options.chartPrice?.(round.market ?? "BTC") ?? null;
    let net = 0;
    for (const t of round.trades) {
      if (t.status === "failed") continue;
      const open = round.orders.find((o) => o.tradeId === t.id && o.kind === "open" && o.status !== "rejected");
      if (!open || open.status === "sending") continue;
      const close = round.orders.find((o) => o.tradeId === t.id && o.kind === "close" && o.status !== "rejected" && o.status !== "sending");
      const entry = open.chartAt;
      const exit = close ? close.chartAt : now;
      if (entry === undefined || exit === undefined || exit === null) return null;
      net += t.dir * (exit - entry) * (open.filled || t.size);
    }
    return net;
  }

  /** The drawer's stop and target, on the figure they are shown. */
  private checkExits(round: Round) {
    const spec = this.spec.get(round.id);
    if (round.status !== "running" || !spec) return;
    const net = this.onChartPrices(round) ? this.chartNet(round) : round.net;
    if (net === null) return;
    if (spec.exits.lose !== null && net <= -Math.abs(spec.exits.lose)) {
      round.outcome = "stop";
      void this.finish(round);
    } else if (spec.exits.gain !== null && net >= Math.abs(spec.exits.gain)) {
      round.outcome = "target";
      void this.finish(round);
    }
  }

  /** The chart moved: every running round on that market checks its exits. Testnet's position pushes are too rare to wait for. */
  onChart(market: string) {
    for (const round of this.live.values()) if (round.status === "running" && (round.market ?? "BTC") === market) this.checkExits(round);
  }

  /** Booked from fills, open from the venue's mark. Ready once every accepted order has filled. */
  private tally(round: Round) {
    round.realised = round.orders.reduce((sum, o) => sum + (o.pnl ?? 0), 0);
    const accepted = round.orders.filter((o) => o.status !== "rejected");
    round.pnlReady = !round.untracked && accepted.every((o) => o.status === "filled");
    round.pnlFrom = round.orders.some((o) => o.kind === "close" && o.pnlFrom === "estimate") ? "estimate" : "venue";
    // Flat once done: the last mark the venue pushed is not open P&L any more. Adding it back put
    // a finished round $5.38 below what its own fills booked.
    round.net = !round.pnlReady ? null : round.status === "done" ? round.realised : round.realised + round.unrealised;
  }

  private fail(round: Round, error: unknown) {
    if (round.status === "done") return;
    round.problem = (error as Error).message.slice(0, 160);
    round.outcome = "failed";
    void this.finish(round);
  }

  // --- the stop on the venue ----------------------------------------------

  private readonly arming = new Set<string>();

  /** Whether a stop of ours may be resting on the venue right now. */
  private resting(round: Round) {
    const s = round.guard?.status;
    return s === "resting" || s === "placing";
  }

  /**
   * Put the loss exit on the venue for the trade that is open.
   *
   * What is left to lose is the round's allowance less what its closed trades
   * already lost, and the stop sits where the open trade would lose exactly
   * that. Its worst fill is far past the trigger on purpose: Lighter cancels a
   * stop that would fill beyond its limit, and a cancelled stop is no stop.
   * Placing it cancels whatever rested before in the same batch.
   */
  private async arm(round: Round) {
    const spec = this.spec.get(round.id);
    if (round.status !== "running" || !(spec?.venueStop ?? round.venueStop) || spec?.exits.lose == null) return;
    const exec = this.execs.get(round.id);
    const trade = this.openTrade(round);
    if (!exec || !trade || trade.status !== "open" || !trade.entry || this.inflight.has(round.id) || this.arming.has(round.id)) return;
    if (round.guard?.tradeId === trade.id && this.resting(round)) return;
    const open = round.orders.find((o) => o.id === trade.openOrderId);
    const size = open && open.filled > EPS ? open.filled : trade.size;
    const left = Math.abs(spec.exits.lose) + round.realised;
    if (left <= 0) {
      round.outcome = "stop";
      return void this.finish(round);
    }
    const market = this.market(round);
    const trigger = trade.entry - (trade.dir * left) / size;
    if (!(trigger > 0)) return;
    const worst = trigger * (1 - trade.dir * 0.03);
    const stop: StopRequest = { clientOrderIndex: this.orderId(), size: sizeStep(market, size), isAsk: trade.dir > 0, trigger, worst };
    const replacing = this.resting(round) || round.guard?.status === "cancelled";
    round.guard = { orderId: String(stop.clientOrderIndex), tradeId: trade.id, dir: trade.dir, size: stop.size, trigger, worst, placedAt: this.now(), status: "placing" };
    this.arming.add(round.id);
    try {
      await exec.submit([], undefined, { cancelAll: replacing, stops: [stop] });
      if (round.guard?.orderId === String(stop.clientOrderIndex) && round.guard.status === "placing") round.guard.status = "resting";
    } catch (e) {
      if (round.guard?.orderId === String(stop.clientOrderIndex)) {
        round.guard.status = e instanceof VenueTimeout ? "resting" : "failed";
        round.guard.error = (e as Error).message.slice(0, 160);
        if (round.guard.status === "failed") round.problem = "The stop could not be placed on Lighter; the trader is watching the loss instead.";
      }
    } finally {
      this.arming.delete(round.id);
    }
    this.publish(round);
    void this.save(round);
  }

  // --- the end --------------------------------------------------------------

  private finish(round: Round): Promise<void> {
    const existing = this.closing.get(round.id);
    if (existing) return existing;
    if (round.status === "done") return Promise.resolve();
    // Stop the scheduler before anything awaits.
    round.status = "closing";
    this.clearTimer(round.id);
    this.publish(round);
    const task = this.complete(round).finally(() => this.closing.delete(round.id));
    this.closing.set(round.id, task);
    return task;
  }

  private async complete(round: Round) {
    const exec = this.execs.get(round.id);
    if (!exec) return;
    // The round's own fills netting to nothing is flat as surely as the venue's position push, and it arrives first: on testnet the push trailed the fill by a second.
    const own = () => round.orders.reduce((sum, o) => sum + (o.side === "buy" ? o.filled : -o.filled), 0);
    const flat = () => Math.abs(exec.position()?.size ?? 0) < EPS || (round.fills.length > 0 && Math.abs(own()) < EPS);
    const window = this.options.settleMs ?? 2000;
    // An open that filled nothing and is past the settle window was cancelled by the venue: nothing to wait for.
    const dead = (o: Order) => o.kind === "open" && o.filled === 0 && o.status === "acked" && this.now() - (o.ackAt ?? o.requestedAt) > window;
    const settled = () => flat() && round.orders.every((o) => o.status === "filled" || o.status === "rejected" || dead(o));
    const flatMs = this.options.flatMs ?? 6000;
    try {
      await this.inflight.get(round.id)?.catch(() => undefined);
      // The venue's stop closed it: its fill can land before the position push says flat. Wait for that, not a second close.
      if (round.guard?.status === "fired") await this.until(exec, flat, 2000);
      // A close already on its way is waited for, not doubled.
      if (!this.closePending(round)) await this.sendClose(round, exec);
      if (!(await this.until(exec, settled, flatMs)) && !flat()) {
        // Still holding after the wait: close what the venue says is left, once.
        await this.sendClose(round, exec);
        await this.until(exec, settled, flatMs);
      }
      // A stop still resting on a flat account guards nothing; take it off before the account is reused.
      /*
        An order whose answer never came, or one acked that filled nothing:
        the pushes that would have said otherwise may be the thing that
        failed. Before calling the round flat, ask the venue, and close
        whatever it says is there. On testnet the socket went quiet mid-round
        and a filled open was taken for a cancelled one.
      */
      let venueSays: boolean | null = null;
      const doubt = round.orders.some((o) => o.status === "uncertain" || (o.status === "acked" && o.filled === 0));
      if (flat() && doubt) venueSays = await this.confirmFlat(round, exec, flatMs);
      const isFlat = () => venueSays ?? flat();
      // The close's own batch cancelled it; only a cancel that went unconfirmed leaves one resting.
      if (isFlat() && this.resting(round)) {
        await exec.submit([], undefined, { cancelAll: true }).then(
          () => {
            if (round.guard && round.guard.status !== "fired") round.guard.status = "cancelled";
          },
          (e) => console.error(`round ${round.id}: stop not cancelled: ${(e as Error).message.slice(0, 100)}`),
        );
      }
      // The venue's own fill history is the figure the round is booked at, pushed or not.
      if (isFlat()) await this.reconcile(round, exec);
      if (isFlat()) {
        for (const t of round.trades) if (holding(t)) t.status = "closed";
        round.status = "done";
        round.unrealised = 0;
        round.timing.closedAt = this.now();
        round.outcome ??= "time";
        // A round that never traded keeps saying why.
        if (round.outcome !== "failed") round.problem = null;
        if (round.timing.closeRequestedAt) timing("close.flat", round.timing.closedAt - round.timing.closeRequestedAt, { round: round.id });
        this.tally(round);
        round.net = round.pnlReady ? round.realised : null;
      } else {
        round.problem = "Still confirming the close with Lighter. Retry Close trade; no new round can start yet.";
      }
    } catch (error) {
      round.problem = `Close not confirmed: ${(error as Error).message.slice(0, 140)}`;
    }
    if (round.status === "done" && round.pnlFrom === "estimate") {
      // Still waiting on the venue's figure: book it when its history catches up.
      setTimeout(() => void this.booked(round).then(() => this.save(round)), 5000);
    }
    if (round.status === "done" && !round.untracked && this.options.feedUrl !== null) await this.replay(round);
    await this.save(round);
    if (round.status === "done") {
      this.accounts.delete(round.accountIndex);
      this.detach(round.id);
      this.spec.delete(round.id);
      this.seenFills.delete(round.id);
      this.failures.delete(round.id);
      this.unfilled.delete(round.id);
    }
  }

  /** Flat by the venue's own account, not a push: closes what it says is held, then waits for it to say nothing is. */
  private async confirmFlat(round: Round, exec: Exec, ms: number): Promise<boolean> {
    const end = this.now() + ms;
    let closed = false;
    while (true) {
      const held = await exec.heldNow().catch(() => null);
      if (held !== null && Math.abs(held) < EPS) return true;
      if (held !== null && !closed) {
        await this.sendClose(round, exec, held).catch(() => undefined);
        closed = true;
      }
      if (this.now() > end) return false;
      await Bun.sleep(300);
    }
  }

  /**
   * Close whatever the venue says an account holds in a market, whatever any
   * round thinks. For an account whose round is over and still holds
   * something: the Wild desk calls it rather than settle a lane that is not flat.
   */
  async flatten(exec: Exec, market: string): Promise<number> {
    const held = await exec.heldNow();
    if (Math.abs(held) < EPS) return 0;
    const m = this.market({ market });
    await exec.submit([{ clientOrderIndex: this.orderId(), size: sizeStep(m, Math.abs(held)), isAsk: held > 0, reduceOnly: true }], undefined, { cancelAll: true });
    return held;
  }

  private closePending(round: Round) {
    return round.orders.some((o) => o.kind === "close" && (o.status === "sending" || o.status === "acked" || o.status === "partial" || o.status === "uncertain"));
  }

  /** Reduce-only, for whatever is held. Nothing held, nothing sent. */
  private async sendClose(round: Round, exec: Exec, venue?: number) {
    const cur = this.heldTrade(round);
    // What the venue said over HTTP beats any push.
    const held = venue === undefined ? exec.position() : { size: venue };
    const size = venue !== undefined ? Math.abs(venue) : held && this.settled(round) ? Math.abs(held.size) : Math.max(held ? Math.abs(held.size) : 0, cur ? this.closeSize(round, exec, cur) : 0);
    if (size < EPS) return;
    const requestedAt = this.now();
    round.timing.closeRequestedAt ??= requestedAt;
    const dir = held && Math.abs(held.size) > EPS ? (held.size > 0 ? 1 : -1) : (cur?.dir ?? 1);
    const tradeId = cur?.id ?? `t${requestedAt.toString(36)}`;
    const order = this.order(tradeId, "close", dir, sizeStep(this.market(round), size), requestedAt, requestedAt);
    if (cur) {
      cur.status = "closing";
      cur.closeOrderId = order.id;
    }
    round.orders.push(order);
    this.publish(round);
    const guarded = this.resting(round);
    try {
      const sent = await exec.submit([request(order)], undefined, { cancelAll: guarded });
      if (guarded && round.guard) round.guard.status = "cancelled";
      this.acked(round, order, sent, sent.hashes[sent.before ?? 0]);
      round.timing.closeAckAt = sent.ackAt;
      timing("order.ack", sent.ackAt - sent.sentAt, { round: round.id, kind: "close", via: sent.via });
      timing("close.ack", sent.ackAt - round.timing.closeRequestedAt, { round: round.id });
    } catch (e) {
      order.status = e instanceof VenueTimeout ? "uncertain" : "rejected";
      order.error = (e as Error).message.slice(0, 160);
      if (!(e instanceof VenueTimeout)) throw e;
    }
  }

  /** Resolve when `done()` holds, re-checked on every push for this account. */
  private until(exec: Exec, done: () => boolean, ms: number) {
    if (done()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const check = () => {
        if (!done()) return;
        finish(true);
      };
      const offs = [exec.onPosition(() => queueMicrotask(check)), exec.onFill(() => queueMicrotask(check))];
      const timer = setTimeout(() => finish(done()), ms);
      // Some conditions turn true with time alone, with no push to say so.
      const poll = setInterval(check, 250);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        clearInterval(poll);
        for (const off of offs) off();
        resolve(ok);
      };
    });
  }

  /** Read the venue's fill history once, in the background, and book what it says. */
  private async booked(round: Round) {
    const exec = this.execs.get(round.id) ?? this.lastExec.get(round.id);
    if (!exec) return;
    try {
      await this.readVenueFills(round, exec);
      this.publish(round);
    } catch {
      /* The end of the round reads it again. */
    }
  }

  /**
   * The venue's fill history, applied: any fill the push missed is added, and
   * every order's profit is replaced by the venue's own booked figure.
   */
  private async readVenueFills(round: Round, exec: Exec) {
    const fills: Fill[] = await exec.fillsSince(round.startedAt - 60_000);
    const now = this.now();
    for (const f of fills) this.onFill(round, { ...f, receivedAt: now }, false);
    const byOrder = new Map<string, number>();
    const seen = new Set<string>();
    for (const f of fills) {
      const side = sideOf(f, round.accountIndex);
      if (!side) continue;
      const id = fillId(f);
      if (seen.has(id)) continue;
      seen.add(id);
      const client = clientIdOf(f, side);
      if (!round.orders.some((o) => o.id === client)) continue;
      byOrder.set(client, (byOrder.get(client) ?? 0) + (Number(f[`${side}_account_pnl`] ?? 0) || 0));
    }
    for (const o of round.orders) {
      if (!byOrder.has(o.id)) continue;
      o.pnl = byOrder.get(o.id)!;
      o.pnlFrom = "venue";
      const trade = round.trades.find((t) => t.id === o.tradeId);
      if (trade && o.kind === "close") trade.pnl = o.pnl;
    }
    this.tally(round);
  }

  /** The cold read at the end of a round. Exact, because it is the venue's own list. */
  private async reconcile(round: Round, exec: Exec) {
    const dead = () => {
      // Flat and still unfilled: the venue never executed it. A reduce-only close sent after a stop has nothing left to reduce; an open it cancelled never opened.
      for (const o of round.orders) if ((o.status === "uncertain" || o.status === "acked") && o.filled === 0) o.status = "rejected";
    };
    dead();
    this.tally(round);
    // Every order filled, by push: the round can end now. The venue's own figure, where a push only let it be estimated, is read after and replaces it, off the close's path. Testnet's history took 1.4 to 3 seconds to answer.
    if (round.pnlReady) {
      if (round.pnlFrom !== "venue") setTimeout(() => void this.booked(round).then(() => this.save(round)), 1500);
      return;
    }
    // The venue's history can trail a fill by a few seconds.
    for (let i = 0; i < 6; i++) {
      try {
        await this.readVenueFills(round, exec);
        dead();
        this.tally(round);
        if (round.pnlReady && round.pnlFrom === "venue") return;
      } catch {
        /* try again */
      }
      await Bun.sleep(500);
    }
  }

  private async replay(round: Round) {
    try {
      const response = await fetch(`${this.options.feedUrl ?? process.env.TRADE_FEED_URL ?? "http://localhost:3210"}/bars?n=1200&market=${round.market ?? "BTC"}`, { signal: AbortSignal.timeout(3000) });
      const data = (await response.json()) as { intervalMs: number; bars: { t: number; o: number; h: number; l: number; c: number; v: number }[] };
      if (response.ok && data.intervalMs === 500 && Array.isArray(data.bars)) {
        round.bars = data.bars.filter((b) => b.t * 1000 >= round.startedAt - 500 && b.t * 1000 <= this.now()).map((b) => ({ ...b, t: b.t * 1000 }));
      }
    } catch {
      /* A missing replay must never become a generated chart. */
    }
  }
}
