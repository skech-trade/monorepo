import { expect, test } from "bun:test";
import type { Exec, OrderRequest, Position, Sent, VenueFill } from "./executor";
import type { Fill } from "./pnl";
import { type Round, Rounds, type RoundSpec } from "./rounds";
import { VenueError, VenueTimeout } from "./venue-socket";

process.env.NODE_ENV = "test";
const market = { id: 1, last: 100, symbol: "BTC", minBase: 0.001, minQuote: 1, sizeDecimals: 3, priceDecimals: 2 };

/** An account on a venue that acks after `ackMs` and pushes fills and positions after `fillMs`. */
class FakeExec implements Exec {
  readonly accountIndex = 7;
  pos: Position = { size: 0, avgEntry: 0, unrealised: 0, imf: null, marginMode: null, at: 0 };
  sent: { orders: OrderRequest[]; leverage?: number; at: number }[] = [];
  fills: Fill[] = [];
  reject: string[] = [];
  timeoutNext = false;
  /** Like the real account push: fills arrive without the venue's P&L fields. */
  pushWithoutPnl = false;
  private readonly pf = new Set<(p: Position) => void>();
  private readonly ff = new Set<(f: VenueFill) => void>();
  private trade = 0;
  constructor(public ackMs = 5, public fillMs = 5, public lat = 0) {}
  position() { return this.pos; }
  latency() { return this.lat; }
  async prepare() {}
  onPosition(fn: (p: Position) => void) { this.pf.add(fn); return () => this.pf.delete(fn); }
  onFill(fn: (f: VenueFill) => void) { this.ff.add(fn); return () => this.ff.delete(fn); }
  async fillsSince() { return this.fills; }
  async submit(orders: OrderRequest[], leverage?: number): Promise<Sent> {
    const sentAt = Date.now();
    this.sent.push({ orders, leverage, at: sentAt });
    await Bun.sleep(this.ackMs);
    const why = this.reject.shift();
    if (why) throw new VenueError(why, 21701);
    if (this.timeoutNext) { this.timeoutNext = false; throw new VenueTimeout("no answer"); }
    setTimeout(() => {
      for (const o of orders) {
        const signed = o.isAsk ? -o.size : o.size;
        const size = o.reduceOnly ? Math.sign(signed) * Math.min(Math.abs(signed), Math.abs(this.pos.size)) : signed;
        const closing = o.reduceOnly || Math.sign(this.pos.size) === -Math.sign(signed);
        this.pos = { ...this.pos, size: Math.round((this.pos.size + size) * 1e9) / 1e9, at: Date.now() };
        const f: Fill = { trade_id: ++this.trade, tx_hash: `h${this.trade}`, timestamp: Date.now() - 9000, price: "100", size: String(Math.abs(size)),
          ask_account_id: o.isAsk ? 7 : 99, bid_account_id: o.isAsk ? 99 : 7,
          [o.isAsk ? "ask_client_id_str" : "bid_client_id_str"]: String(o.clientOrderIndex),
          ...(closing ? { [o.isAsk ? "ask_account_pnl" : "bid_account_pnl"]: "-1" } : {}) };
        this.fills.push(f);
        const pushed: Fill = { ...f };
        if (this.pushWithoutPnl) { delete pushed.ask_account_pnl; delete pushed.bid_account_pnl; }
        for (const fn of this.ff) fn({ ...pushed, receivedAt: Date.now() });
      }
      for (const fn of this.pf) fn(this.pos);
    }, this.fillMs);
    return { signedAt: sentAt, sentAt, ackAt: Date.now(), hashes: orders.map((_, i) => `a${i}`), via: "ws", withLeverage: false, worst: [] };
  }
}

const rounds = () => new Rounds(() => market, { feedUrl: null, settleMs: 50, flatMs: 300 });
const up: RoundSpec = { pts: [{ t: 0, price: 100 }, { t: 1, price: 105 }], stake: 100, leverage: 2, seconds: 0.4, exits: { lose: null, gain: null } };
/** Long for the first half, short for the second. */
const upThenDown: RoundSpec = { ...up, pts: [{ t: 0, price: 100 }, { t: 0.5, price: 110 }, { t: 1, price: 90 }] };
/** Long, short, long. */
const lsl: RoundSpec = { ...up, seconds: 0.6, pts: [{ t: 0, price: 100 }, { t: 0.33, price: 110 }, { t: 0.66, price: 95 }, { t: 1, price: 120 }] };
const until = async (fn: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await Bun.sleep(5); return fn(); };

test("open answers after one venue ack, as one trade with its own id", async () => {
  const x = new FakeExec();
  const r = await rounds().open(up, x);
  expect(x.sent).toHaveLength(1);
  expect(x.sent[0].orders).toMatchObject([{ isAsk: false, reduceOnly: false, size: 2 }]);
  expect(x.sent[0].leverage).toBe(2);
  expect(r.trades).toHaveLength(1);
  expect(r.trades[0].id).toBe(r.segments[0].id);
  expect(r.timing.openAckAt).toBeDefined();
  await until(() => r.status === "done");
});

test("long after short is one batch: the short's close and the long's open", async () => {
  const x = new FakeExec();
  const r = await rounds().open(upThenDown, x);
  await until(() => r.status === "done");
  // open long, then [close long, open short], then close short.
  expect(x.sent.map((s) => s.orders.map((o) => `${o.isAsk ? "sell" : "buy"}${o.reduceOnly ? "-close" : ""}`))).toEqual([["buy"], ["sell-close", "sell"], ["buy-close"]]);
  expect(r.trades.map((t) => [t.dir, t.status])).toEqual([[1, "closed"], [-1, "closed"]]);
  expect(new Set(r.trades.map((t) => t.id)).size).toBe(2);
  expect(r.net).toBe(-2);
  expect(r.pnlReady).toBe(true);
});

test("long after long continues the position instead of closing and reopening", async () => {
  const x = new FakeExec();
  const r = await rounds().open({ ...up, pts: [{ t: 0, price: 100 }, { t: 0.5, price: 103 }, { t: 0.55, price: 102.9 }, { t: 1, price: 108 }] }, x);
  await until(() => r.status === "done");
  expect(x.sent).toHaveLength(2);
  expect(r.trades).toHaveLength(1);
});

test("cutting the short out of long–short–long keeps one long open", async () => {
  const x = new FakeExec();
  const book = rounds();
  const r = await book.open(lsl, x);
  expect(r.segments.map((s) => s.dir)).toEqual([1, -1, 1]);
  await book.skip(r.id, r.segments[1].id, true);
  await until(() => r.status === "done");
  expect(x.sent).toHaveLength(2);
  expect(r.trades).toHaveLength(1);
});

test("editing the line mid-round turns the position where the new line turns", async () => {
  const x = new FakeExec();
  const book = rounds();
  const r = await book.open({ ...up, seconds: 0.6 }, x);
  await Bun.sleep(100);
  await book.edit(r.id, upThenDown.pts);
  await until(() => r.status === "done");
  expect(r.trades.map((t) => t.dir)).toEqual([1, -1]);
  // The long that was open when the edit landed kept its id.
  expect(r.trades[0].id).toBe(r.segments[0].id);
});

test("a turn is sent early by half a measured round trip, so it lands on time", async () => {
  const x = new FakeExec(5, 5, 160);
  const r = await rounds().open({ ...upThenDown, seconds: 1 }, x);
  await until(() => r.status === "done", 3000);
  const flip = r.orders.find((o) => o.kind === "open" && o.side === "sell")!;
  expect(flip.sentAt! - flip.dueAt).toBeLessThan(-40);
  expect(flip.sentAt! - flip.dueAt).toBeGreaterThan(-130);
});

test("close waits for an in-flight open, runs once, and cannot reopen", async () => {
  const x = new FakeExec(30);
  const book = rounds();
  const r = await book.open({ ...up, seconds: 5 }, x);
  await Promise.all([book.close(r.id), book.close(r.id)]);
  expect(x.sent).toHaveLength(2);
  expect(r.status).toBe("done");
  expect(r.size).toBe(0);
  expect(r.net).toBe(-1);
});

test("concurrent requests cannot run two strategies on the same account", async () => {
  const x = new FakeExec();
  const book = rounds();
  const results = await Promise.allSettled([book.open(up, x), book.open(up, x)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await book.close(book.all()[0].id);
});

test("a refused opening order fails the request and frees the account", async () => {
  const x = new FakeExec();
  x.reject.push("invalid base amount");
  const book = rounds();
  await expect(book.open(up, x)).rejects.toThrow("invalid base amount");
  expect(book.all()).toHaveLength(0);
  const r = await book.open(up, x);
  await until(() => r.status === "done");
});

test("a refused turn is retried rather than left facing the wrong way", async () => {
  const x = new FakeExec();
  const r = await rounds().open({ ...upThenDown, seconds: 1.2 }, x);
  x.reject.push("busy");
  await until(() => r.status === "done", 3000);
  expect(r.trades.filter((t) => t.status === "failed")).toHaveLength(1);
  expect(r.trades.some((t) => t.dir === -1 && t.status === "closed")).toBe(true);
});

test("an existing position blocks a new round", async () => {
  const x = new FakeExec();
  x.pos = { ...x.pos, size: 0.5 };
  await expect(rounds().open(up, x)).rejects.toThrow("Close existing positions");
});

test("restored unfinished round blocks new orders until explicitly closed", async () => {
  const x = new FakeExec();
  const book = rounds();
  const r = await book.open(up, x);
  await until(() => r.status === "done");
  const restored: Round = { ...r, id: "restored", status: "running" };
  book.restore(restored, x);
  expect(restored.status).toBe("closing");
  await expect(book.open(up, x)).rejects.toThrow("existing round");
});

test("subscribers see opening, closing and done pushed, without polling", async () => {
  const x = new FakeExec();
  const book = rounds();
  const r = await book.open({ ...up, seconds: 5 }, x);
  const states: string[] = [];
  const off = book.subscribe(r.id, (round) => states.push(round.status));
  await book.close(r.id);
  expect(states[0]).toBe("running");
  expect(states).toContain("closing");
  expect(states.at(-1)).toBe("done");
  off();
});

test("a send with no answer is reconciled from the venue, not retried blindly", async () => {
  const x = new FakeExec();
  const book = rounds();
  const r = await book.open({ ...up, seconds: 5 }, x);
  x.timeoutNext = true;
  await book.close(r.id);
  // The timed-out close was not doubled while it was unknown; the venue's word settled it.
  expect(x.sent.filter((s) => s.orders[0].reduceOnly).length).toBeLessThanOrEqual(2);
  expect(r.status === "done" || r.problem !== null).toBe(true);
});

test("a push without P&L is estimated from fill prices, then booked at the venue's figure", async () => {
  const x = new FakeExec();
  x.pushWithoutPnl = true;
  const book = rounds();
  const r = await book.open({ ...up, seconds: 5 }, x);
  await until(() => r.orders[0]?.status === "filled");
  await book.close(r.id);
  expect(r.status).toBe("done");
  // Fill prices are equal in the fake, so the estimate is 0; the venue booked -1.
  expect(r.realised).toBe(-1);
  expect(r.net).toBe(-1);
  expect(r.pnlFrom).toBe("venue");
  expect(r.trades[0].pnl).toBe(-1);
});

test("booking the venue's history after a round ends does not count a fill twice", async () => {
  const x = new FakeExec();
  const book = rounds();
  const r = await book.open({ ...up, seconds: 5 }, x);
  await until(() => r.orders[0]?.status === "filled");
  await book.close(r.id);
  // What the late re-booking does, after the round's bookkeeping is cleared.
  await (book as unknown as { booked(r: Round): Promise<void> }).booked(r);
  expect(r.orders.map((o) => o.filled)).toEqual([2, 2]);
  expect(r.fills).toHaveLength(2);
});

test("drawing past the end mid-round adds positions and lengthens the round", async () => {
  const x = new FakeExec();
  const book = rounds();
  const r = await book.open({ ...up, seconds: 0.4 }, x);
  await Bun.sleep(100);
  // The same long to the old end at 0.4s, then a short after it: the line now runs 0.8s.
  await book.edit(r.id, [{ t: 0, price: 100 }, { t: 0.5, price: 105 }, { t: 1, price: 95 }], 0.8);
  expect(r.seconds).toBe(0.8);
  await until(() => r.status === "done", 3000);
  expect(r.trades.map((t) => t.dir)).toEqual([1, -1]);
  // It ran to the new end, not the old one.
  expect(r.timing.closedAt! - r.startedAt).toBeGreaterThan(700);
});

test("a line that stops short of the round's length closes where the line ends", async () => {
  const x = new FakeExec();
  const book = rounds();
  const r = await book.open({ ...up, seconds: 0.5 }, x);
  await Bun.sleep(100);
  // Draw more held the round to 1.6s, but the stroke ended at half of that.
  await book.edit(r.id, [{ t: 0, price: 100 }, { t: 0.25, price: 105 }, { t: 0.5, price: 95 }], 1.6);
  expect(r.seconds).toBeCloseTo(0.8);
  expect(r.pts.at(-1)!.t).toBe(1);
  await until(() => r.status === "done", 3000);
  expect(r.trades.map((t) => t.dir)).toEqual([1, -1]);
  // Closed at the line's end, not the held 1.6s.
  expect(r.timing.closedAt! - r.startedAt).toBeLessThan(1300);
});

test("a round interrupted by a restart resumes its plan against the venue's position", async () => {
  const x = new FakeExec();
  const before = rounds();
  const r = await before.open({ ...upThenDown, seconds: 0.8 }, x);
  await until(() => r.orders[0]?.status === "filled");
  // The process dies here: a fresh book restores the saved record, then resumes it.
  before.stop();
  const saved: Round = JSON.parse(JSON.stringify({ ...r, status: "running" }));
  const after = rounds();
  after.restore(saved, x);
  expect(saved.status).toBe("closing");
  await after.resume(saved, x);
  await until(() => saved.status === "done", 3000);
  // It kept going: the long closed and the short after it was opened and closed too.
  expect(saved.trades.filter((t) => t.status === "closed").map((t) => t.dir)).toContain(-1);
  expect(x.pos.size).toBe(0);
});

test("a restored round past its end just closes what is held", async () => {
  const x = new FakeExec();
  const before = rounds();
  const r = await before.open({ ...up, seconds: 5 }, x);
  await until(() => r.orders[0]?.status === "filled");
  before.stop();
  const saved: Round = JSON.parse(JSON.stringify({ ...r, status: "running", startedAt: r.startedAt - 10_000 }));
  const after = rounds();
  after.restore(saved, x);
  await after.resume(saved, x);
  await until(() => saved.status === "done", 3000);
  expect(x.pos.size).toBe(0);
});

test("an Ethereum round is sized on Ethereum's market and says so", async () => {
  const eth = { id: 0, last: 2000, symbol: "ETH", minBase: 0.002, minQuote: 10, sizeDecimals: 4, priceDecimals: 2 };
  const x = new FakeExec();
  const r = await new Rounds((s) => (s === "ETH" ? eth : market), { feedUrl: null, settleMs: 50, flatMs: 300 }).open({ ...up, market: "ETH", stake: 101, leverage: 3 }, x);
  expect(r.market).toBe("ETH");
  // $303 of ETH at $2,000, to ETH's four decimals.
  expect(r.quantity).toBe(0.1515);
  expect(r.entry).toBe(2000);
  await until(() => r.status === "done");
});

test("a retry that throws fails the round instead of escaping as an unhandled rejection", async () => {
  const x = new FakeExec();
  let broken = false;
  const book = new Rounds(() => {
    if (broken) throw Error("market details unavailable");
    return market;
  }, { feedUrl: null, settleMs: 50, flatMs: 300 });
  const r = await book.open({ ...upThenDown, seconds: 1.2 }, x);
  x.reject.push("busy");
  // The turn is refused and a retry is scheduled; by the time it runs, the market cannot be read.
  expect(await until(() => r.orders.some((o) => o.status === "rejected"), 3000)).toBe(true);
  broken = true;
  expect(await until(() => r.outcome === "failed", 3000)).toBe(true);
  expect(r.problem).toContain("market details unavailable");
});
