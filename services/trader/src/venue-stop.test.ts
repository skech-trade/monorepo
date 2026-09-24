import { expect, test } from "bun:test";
import type { Exec, Extra, OrderRequest, Position, Sent, StopRequest, VenueFill } from "./executor";
import type { Fill } from "./pnl";
import { Rounds, type RoundSpec } from "./rounds";
import { VenueTimeout } from "./venue-socket";

/**
 * The loss exit resting on the venue.
 *
 * A fake account that also keeps the stops it is sent, and fires one on
 * demand the way Lighter would when its mark crosses the trigger: a
 * reduce-only fill carrying the stop's own client order index.
 */

process.env.NODE_ENV = "test";
const market = { id: 1, last: 100, symbol: "BTC", minBase: 0.001, minQuote: 1, sizeDecimals: 3, priceDecimals: 2 };

class StopExec implements Exec {
  readonly accountIndex = 7;
  pos: Position = { size: 0, avgEntry: 0, unrealised: 0, imf: null, marginMode: null, at: 0 };
  batches: { orders: OrderRequest[]; extra: Extra }[] = [];
  resting: StopRequest[] = [];
  fills: Fill[] = [];
  price = 100;
  /** Push the flat position before the stop's fill, as the venue sometimes does. */
  positionFirst = false;
  /** Or the fill first and the position some time after, as it did on testnet. */
  positionLag = 0;
  /** The socket gone quiet: orders execute, and no answer, fill or position comes back. */
  quiet = false;
  /** Every position push this late after its fills, as testnet did on closes. */
  pushLag = 0;
  /** Opens the venue takes and then cancels without a fill, as Lighter did for margin. */
  cancelOpens = 0;
  private readonly pf = new Set<(p: Position) => void>();
  private readonly ff = new Set<(f: VenueFill) => void>();
  private n = 0;
  position() { return this.pos; }
  latency() { return 0; }
  async prepare() {}
  onPosition(fn: (p: Position) => void) { this.pf.add(fn); return () => this.pf.delete(fn); }
  onFill(fn: (f: VenueFill) => void) { this.ff.add(fn); return () => this.ff.delete(fn); }
  async fillsSince() { return this.fills; }
  async heldNow() { return this.pos.size; }

  private fill(client: bigint, isAsk: boolean, want: number, reduceOnly: boolean, price: number) {
    const signed = isAsk ? -want : want;
    const size = reduceOnly ? Math.sign(signed) * Math.min(Math.abs(signed), Math.abs(this.pos.size)) : signed;
    const closing = reduceOnly || Math.sign(this.pos.size) === -Math.sign(signed);
    const was = this.pos.size;
    this.pos = { ...this.pos, size: Math.round((this.pos.size + size) * 1e9) / 1e9, avgEntry: price, at: Date.now() };
    const pnl = closing ? (Math.sign(was) * (price - 100) * Math.abs(size)).toFixed(4) : undefined;
    const f: Fill = { trade_id: ++this.n, tx_hash: `h${this.n}`, timestamp: Date.now(), price: String(price), size: String(Math.abs(size)),
      ask_account_id: isAsk ? 7 : 99, bid_account_id: isAsk ? 99 : 7,
      [isAsk ? "ask_client_id_str" : "bid_client_id_str"]: String(client),
      ...(pnl !== undefined ? { [isAsk ? "ask_account_pnl" : "bid_account_pnl"]: pnl } : {}) };
    this.fills.push(f);
    return f;
  }

  async submit(orders: OrderRequest[], _leverage?: number, extra: Extra = {}): Promise<Sent> {
    const sentAt = Date.now();
    this.batches.push({ orders, extra });
    if (extra.cancelAll) this.resting = [];
    this.resting.push(...(extra.stops ?? []));
    await Bun.sleep(3);
    if (this.quiet) {
      for (const o of orders) this.fill(o.clientOrderIndex, o.isAsk, o.size, o.reduceOnly, this.price);
      throw new VenueTimeout("no answer from the venue in 4000ms");
    }
    const cancelled = orders.length > 0 && !orders[0].reduceOnly && this.cancelOpens > 0;
    if (cancelled) this.cancelOpens--;
    setTimeout(() => {
      if (cancelled) return;
      const made = orders.map((o) => this.fill(o.clientOrderIndex, o.isAsk, o.size, o.reduceOnly, this.price));
      for (const f of made) for (const fn of this.ff) fn({ ...f, receivedAt: Date.now() });
      const pos = this.pos;
      if (orders.length) setTimeout(() => { for (const fn of this.pf) fn(pos); }, this.pushLag);
    }, 5);
    const before = extra.cancelAll ? 1 : 0;
    return { signedAt: sentAt, sentAt, ackAt: Date.now(), hashes: [...Array(before + orders.length + (extra.stops?.length ?? 0))].map((_, i) => `a${i}`), via: "ws", withLeverage: false, worst: [], before };
  }

  /** The venue's mark crossed the resting stop. */
  fire(price: number) {
    const stop = this.resting.shift();
    if (!stop) throw Error("no stop resting");
    this.price = price;
    const f = this.fill(stop.clientOrderIndex, stop.isAsk, stop.size, true, price);
    const pushPosition = () => { for (const fn of this.pf) fn(this.pos); };
    const pushFill = () => { for (const fn of this.ff) fn({ ...f, receivedAt: Date.now() }); };
    if (this.positionFirst) { pushPosition(); setTimeout(pushFill, 20); }
    else if (this.positionLag) { pushFill(); setTimeout(pushPosition, this.positionLag); }
    else { pushFill(); pushPosition(); }
  }
}

const rounds = () => new Rounds(() => market, { feedUrl: null, settleMs: 30, flatMs: 300 });
const until = async (fn: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await Bun.sleep(5); return fn(); };
/** Stake 10 at 10x: a position of 1 BTC at $100. Out once $8 is lost, which is $92 on a long. */
const long: RoundSpec = { pts: [{ t: 0, price: 100 }, { t: 1, price: 110 }], stake: 10, leverage: 10, seconds: 1.5, exits: { lose: 8, gain: null }, venueStop: true };

test("a filled open gets a stop on the venue where the loss reaches the allowance", async () => {
  const x = new StopExec();
  const r = await rounds().open(long, x);
  expect(await until(() => r.guard?.status === "resting")).toBe(true);
  const stop = x.resting[0];
  expect(stop.isAsk).toBe(true);
  expect(stop.size).toBe(1);
  expect(stop.trigger).toBeCloseTo(92, 6);
  // Far enough past the trigger that the venue never cancels it for slippage.
  expect(stop.worst).toBeLessThan(stop.trigger * 0.98);
  await until(() => r.status === "done");
});

test("the stop firing ends the round as a stop, books it, and never trades again", async () => {
  const x = new StopExec();
  const r = await rounds().open({ ...long, seconds: 3 }, x);
  await until(() => r.guard?.status === "resting");
  const batches = x.batches.length;
  x.fire(92);
  expect(await until(() => r.status === "done")).toBe(true);
  expect(r.outcome).toBe("stop");
  expect(r.guard?.status).toBe("fired");
  expect(x.pos.size).toBe(0);
  // Nothing opened after the stop: at most the clean-up cancel went out.
  const after = x.batches.slice(batches);
  expect(after.every((b) => b.orders.length === 0)).toBe(true);
  expect(r.net).toBeCloseTo(-8, 6);
});

test("a flat push that arrives before the stop's fill is not mistaken for an open that never filled", async () => {
  const x = new StopExec();
  x.positionFirst = true;
  const r = await rounds().open({ ...long, seconds: 3 }, x);
  await until(() => r.guard?.status === "resting");
  const batches = x.batches.length;
  x.fire(91.5);
  expect(await until(() => r.status === "done")).toBe(true);
  expect(r.outcome).toBe("stop");
  expect(x.batches.slice(batches).every((b) => b.orders.every((o) => o.reduceOnly))).toBe(true);
  expect(x.pos.size).toBe(0);
});

test("the round ending on time takes its stop off in the same batch as the close", async () => {
  const x = new StopExec();
  const r = await rounds().open({ ...long, seconds: 0.4 }, x);
  expect(await until(() => r.status === "done")).toBe(true);
  expect(r.outcome).toBe("time");
  const close = x.batches.find((b) => b.orders.some((o) => o.reduceOnly));
  expect(close?.extra.cancelAll).toBe(true);
  expect(x.resting).toHaveLength(0);
});

test("a turn cancels the old stop with the flip, and the new stop allows only what is left", async () => {
  const x = new StopExec();
  // Long for the first half, short for the second.
  const r = await rounds().open({ ...long, seconds: 1.2, pts: [{ t: 0, price: 100 }, { t: 0.5, price: 110 }, { t: 1, price: 90 }] }, x);
  await until(() => r.guard?.status === "resting");
  // The long closes $3 down at the turn.
  x.price = 97;
  expect(await until(() => r.trades.length === 2 && r.guard?.tradeId === r.trades[1].id && r.guard.status === "resting", 3000)).toBe(true);
  const flip = x.batches.find((b) => b.orders.length === 2);
  expect(flip?.extra.cancelAll).toBe(true);
  // $8 allowed, $3 gone: the short's stop is $5 above its $97 entry.
  expect(r.guard!.dir).toBe(-1);
  expect(x.resting[0].isAsk).toBe(false);
  expect(x.resting[0].trigger).toBeCloseTo(102, 6);
  await until(() => r.status === "done", 3000);
});

test("a stop's fill ahead of the flat push sends no second close, and the round's figure is final", async () => {
  const x = new StopExec();
  x.positionLag = 150;
  const r = await rounds().open({ ...long, seconds: 3 }, x);
  await until(() => r.guard?.status === "resting");
  const batches = x.batches.length;
  x.fire(92);
  expect(await until(() => r.status === "done")).toBe(true);
  expect(x.batches.slice(batches).some((b) => b.orders.length > 0)).toBe(false);
  expect(r.pnlReady).toBe(true);
  expect(r.net).toBeCloseTo(-8, 6);
});

test("an open the venue cancels is tried again, and the round trades once it fills", async () => {
  const x = new StopExec();
  x.cancelOpens = 1;
  const r = await rounds().open({ ...long, seconds: 3 }, x);
  expect(await until(() => x.pos.size === 1, 1500)).toBe(true);
  expect(r.orders.filter((o) => o.kind === "open").map((o) => o.status)).toEqual(["rejected", "filled"]);
  await until(() => r.status === "done", 5000);
  expect(r.outcome).toBe("time");
});

test("an open that never fills ends the round quickly, with nothing spent", async () => {
  const x = new StopExec();
  x.cancelOpens = 99;
  const started = Date.now();
  const r = await rounds().open({ ...long, seconds: 30 }, x);
  const ok = await until(() => r.status === "done", 3000);
  expect(ok).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(r.outcome).toBe("failed");
  expect(r.problem).toMatch(/did not fill/);
  expect(x.pos.size).toBe(0);
});

test("a round ends on its own fills, not on a position push that trails them", async () => {
  const x = new StopExec();
  x.pushLag = 3000;
  const r = await rounds().open({ ...long, venueStop: false, exits: { lose: null, gain: null }, seconds: 1 }, x);
  await until(() => r.status === "done", 6000);
  expect(r.status).toBe("done");
  expect(r.timing.closedAt! - (r.startedAt + 1000)).toBeLessThan(800);
});

test("an open that filled while the socket was quiet is found on the venue and closed", async () => {
  const x = new StopExec();
  x.quiet = true;
  const r = await rounds().open({ ...long, venueStop: false, exits: { lose: null, gain: null }, seconds: 0.5 }, x);
  // Filled on the venue; the round heard nothing.
  expect(x.pos.size).toBe(1);
  expect(await until(() => r.status === "done" || !!r.problem?.startsWith("Still"), 3000)).toBe(true);
  expect(x.pos.size).toBe(0);
  expect(r.status).toBe("done");
});
