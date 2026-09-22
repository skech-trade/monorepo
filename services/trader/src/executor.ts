import type { Fill } from "./pnl";
import { type Lighter, type MarketInfo, TX } from "./lighter";
import { priceUnits, sizeUnits } from "./round";
import type { Signer } from "./signer";
import { hashesOf, VenueError, type VenueSocket, VenueTimeout } from "./venue-socket";

/**
 * Everything one account needs to trade in a single round trip.
 *
 * The REST path read the position and the market before every order, then
 * signed with nonce -1, which makes Lighter's signer fetch the nonce itself,
 * synchronously, inside the FFI call. Three round trips of about 330ms each
 * from a laptop, one after another, and the event loop frozen for one of them.
 *
 * Here the position arrives by push, the nonce is read once and counted, the
 * price comes from the ticker the socket already holds, and leverage is set
 * while somebody is still drawing. What is left at the moment of trading is
 * signing (local, under a millisecond) and one send.
 */

export type Position = { size: number; avgEntry: number; unrealised: number; imf: number | null; marginMode: number | null; at: number };
export type VenueFill = Fill & { receivedAt: number };
export type OrderRequest = { clientOrderIndex: bigint; size: number; isAsk: boolean; reduceOnly: boolean };
export type Sent = { signedAt: number; sentAt: number; ackAt: number; hashes: string[]; via: "ws" | "http"; withLeverage: boolean; worst: number[] };
export type Quote = { bid: number; ask: number; mark: number; at: number };

/** What the scheduler needs from an account. The tests implement it without a venue. */
export interface Exec {
  readonly accountIndex: number;
  position(): Position | null;
  prepare(leverage: number): Promise<void>;
  submit(orders: OrderRequest[], leverage?: number): Promise<Sent>;
  onPosition(fn: (p: Position) => void): () => void;
  onFill(fn: (f: VenueFill) => void): () => void;
  /** Cold read of this account's fills, for the final tally or when the push was missed. */
  fillsSince(since: number): Promise<Fill[]>;
  /** How long an ack takes, smoothed. The scheduler sends this much early. */
  latency(): number;
}

const num = (v: unknown) => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};

export class Executor implements Exec {
  private held: Position | null = null;
  private nonce: bigint | null = null;
  /** Leverage the account is on, as far as we know: pushed, or what we last set. */
  private leverage: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly positionFns = new Set<(p: Position) => void>();
  private readonly fillFns = new Set<(f: VenueFill) => void>();
  private unsubscribe: (() => void)[] = [];
  private ewma = 350;

  constructor(
    private readonly o: {
      socket: VenueSocket;
      http: Lighter;
      signer: Signer;
      accountIndex: number;
      apiKeyIndex: number;
      market: () => MarketInfo;
      quote: () => Quote | null;
      slippage?: number;
    },
  ) {}

  get accountIndex() {
    return this.o.accountIndex;
  }

  position() {
    return this.held;
  }

  latency() {
    return this.ewma;
  }

  onPosition(fn: (p: Position) => void) {
    this.positionFns.add(fn);
    return () => this.positionFns.delete(fn);
  }

  onFill(fn: (f: VenueFill) => void) {
    this.fillFns.add(fn);
    return () => this.fillFns.delete(fn);
  }

  /** Subscribe to this account's pushes. Idempotent. */
  start() {
    if (this.unsubscribe.length) return;
    const id = this.o.accountIndex;
    this.unsubscribe.push(
      this.o.socket.subscribe(`account_all_positions/${id}`, (m) => {
        const all = (m.positions ?? {}) as Record<string, Record<string, unknown>>;
        const p = all[String(this.o.market().id)];
        const now = Date.now();
        this.held = p
          ? {
              size: num(p.position) * (Number(p.sign) < 0 ? -1 : 1),
              avgEntry: num(p.avg_entry_price),
              unrealised: num(p.unrealized_pnl),
              imf: p.initial_margin_fraction === undefined ? null : num(p.initial_margin_fraction),
              marginMode: p.margin_mode === undefined ? null : Number(p.margin_mode),
              at: now,
            }
          : { size: 0, avgEntry: 0, unrealised: 0, imf: this.held?.imf ?? null, marginMode: this.held?.marginMode ?? null, at: now };
        // The venue reports initial margin in percent: 3.33 is 30x. Isolated is mode 1.
        if (this.held.imf && this.held.marginMode === 1) this.leverage = Math.round(100 / this.held.imf);
        for (const fn of this.positionFns) fn(this.held);
      }),
      this.o.socket.subscribe(`account_all_trades/${id}`, (m) => {
        const byMarket = (m.trades ?? {}) as Record<string, Fill[]>;
        const now = Date.now();
        for (const f of byMarket[String(this.o.market().id)] ?? []) for (const fn of this.fillFns) fn({ ...f, receivedAt: now });
      }),
    );
  }

  stop() {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
  }

  /**
   * Everything that can happen before the trade: subscribe, read the nonce,
   * and put the account on this leverage. Called while somebody draws, so
   * none of it is on the clock when they press the button.
   */
  async prepare(leverage: number) {
    this.start();
    await this.serial(async () => {
      if (this.nonce === null) this.nonce = await this.o.http.nextNonce(this.o.accountIndex, this.o.apiKeyIndex);
    });
    if (this.leverage !== leverage) await this.submit([], leverage);
  }

  /**
   * Sign and send, as one batch. Serialised per account, because nonces are.
   * A nonce the venue did not expect means nothing executed, so it is read
   * again and the batch re-signed once. A send with no answer is not retried:
   * the venue may have it, and the position push will say.
   */
  submit(orders: OrderRequest[], leverage?: number): Promise<Sent> {
    return this.serial(async () => {
      try {
        return await this.send(orders, leverage);
      } catch (e) {
        if (!(e instanceof VenueError && e.badNonce) && (e as { code?: number }).code !== 21104) throw e;
        this.nonce = await this.o.http.nextNonce(this.o.accountIndex, this.o.apiKeyIndex);
        return this.send(orders, leverage);
      }
    });
  }

  private async send(orders: OrderRequest[], leverage?: number): Promise<Sent> {
    if (this.nonce === null) this.nonce = await this.o.http.nextNonce(this.o.accountIndex, this.o.apiKeyIndex);
    const m = this.o.market();
    const q = this.o.quote();
    if (orders.length && !q) throw Error("No live venue price yet; not trading blind.");
    const slip = this.o.slippage ?? 0.01;
    const withLeverage = leverage !== undefined && this.leverage !== leverage;
    const types: number[] = [];
    const infos: string[] = [];
    const worst: number[] = [];
    let nonce = this.nonce;
    if (withLeverage) {
      types.push(TX.updateLeverage);
      infos.push(this.o.signer.updateLeverage(m.id, leverage, 1, nonce++).txInfo);
    }
    for (const o of orders) {
      // The worst price this order accepts: the far side of the book, plus slippage.
      const ref = o.isAsk ? q!.bid || q!.mark : q!.ask || q!.mark;
      const price = ref * (o.isAsk ? 1 - slip : 1 + slip);
      worst.push(price);
      types.push(TX.createOrder);
      infos.push(this.o.signer.createOrder({ marketIndex: m.id, clientOrderIndex: o.clientOrderIndex, baseAmount: sizeUnits(m, o.size), price: priceUnits(m, price), isAsk: o.isAsk, reduceOnly: o.reduceOnly, nonce: nonce++ }).txInfo);
    }
    if (!types.length) return { signedAt: Date.now(), sentAt: Date.now(), ackAt: Date.now(), hashes: [], via: "ws", withLeverage: false, worst };
    const signedAt = Date.now();
    let via: Sent["via"] = "ws";
    let hashes: string[];
    const sentAt = Date.now();
    try {
      if (await this.o.socket.ready(0)) {
        const answer = types.length === 1 ? await this.o.socket.sendTx(types[0], infos[0]) : await this.o.socket.sendBatch(types, infos);
        hashes = hashesOf(answer);
      } else {
        via = "http";
        hashes = types.length === 1 ? [(await this.o.http.send(types[0], infos[0])).hash] : (await this.o.http.sendBatch(types, infos)).hashes;
      }
    } catch (e) {
      // Rejected outright: nothing was used. Unknown: read the nonce again before the next send.
      if (e instanceof VenueTimeout) this.nonce = null;
      throw e;
    }
    const ackAt = Date.now();
    this.nonce = nonce;
    if (withLeverage) this.leverage = leverage;
    this.ewma = this.ewma * 0.7 + (ackAt - sentAt) * 0.3;
    return { signedAt, sentAt, ackAt, hashes, via, withLeverage, worst };
  }

  fillsSince(since: number) {
    const token = this.o.signer.authToken(BigInt(Math.floor(Date.now() / 1000) + 600));
    return this.o.http.fills(this.o.accountIndex, this.o.market().id, token, since);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
