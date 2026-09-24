import type { Fill } from "./pnl";
import { asNum, type Lighter, type MarketInfo, TX } from "./lighter";
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
/** A reduce-only stop the venue holds and fires on its mark: `trigger` is where, `worst` the least it may fill at. */
export type StopRequest = { clientOrderIndex: bigint; size: number; isAsk: boolean; trigger: number; worst: number };
/**
 * What else goes in the same batch. `cancelAll` comes first, so a resting stop
 * is gone before the order that replaces it; `stops` come after the orders, so
 * a stop is only ever placed behind the position it guards.
 */
export type Extra = { cancelAll?: boolean; stops?: StopRequest[] };
/** `before` is how many transactions went ahead of the orders in the batch (a leverage update, a cancel), so `hashes[before + i]` is order i's. */
export type Sent = { signedAt: number; sentAt: number; ackAt: number; hashes: string[]; via: "ws" | "http"; withLeverage: boolean; worst: number[]; before?: number };
export type Quote = { bid: number; ask: number; mark: number; at: number };

/** What the scheduler needs from an account. The tests implement it without a venue. */
export interface Exec {
  readonly accountIndex: number;
  position(): Position | null;
  prepare(leverage: number): Promise<void>;
  submit(orders: OrderRequest[], leverage?: number, extra?: Extra): Promise<Sent>;
  onPosition(fn: (p: Position) => void): () => void;
  onFill(fn: (f: VenueFill) => void): () => void;
  /** Cold read of this account's fills, for the final tally or when the push was missed. */
  fillsSince(since: number): Promise<Fill[]>;
  /** How long an ack takes, smoothed. The scheduler sends this much early. */
  latency(): number;
  /** What the venue says is held, signed, asked over HTTP: for when the pushes may have stopped. */
  heldNow(): Promise<number>;
}

/** Nothing held, keeping the margin settings the venue last reported. */
const flat = (at: number, was?: Position): Position => ({ size: 0, avgEntry: 0, unrealised: 0, imf: was?.imf ?? null, marginMode: was?.marginMode ?? null, at });

type Pushes = { position: Position; fill: VenueFill };
type Listeners = { [K in keyof Pushes]: Map<number, Set<(x: Pushes[K]) => void>> };

/** One market as the scheduler sees it: the account's shared nonce and socket, this market's position, fills and leverage. */
export class MarketExec implements Exec {
  constructor(
    private readonly account: Executor,
    readonly market: () => MarketInfo,
    readonly quote: () => Quote | null,
  ) {}
  get accountIndex() { return this.account.accountIndex; }
  get marketId() { return this.market().id; }
  position() { return this.account.positionIn(this.marketId); }
  latency() { return this.account.latency(); }
  onPosition(fn: (p: Position) => void) { return this.account.listen("position", this.marketId, fn); }
  onFill(fn: (f: VenueFill) => void) { return this.account.listen("fill", this.marketId, fn); }
  prepare(leverage: number) { return this.account.prepare(this, leverage); }
  submit(orders: OrderRequest[], leverage?: number, extra?: Extra) { return this.account.submit(this, orders, leverage, extra); }
  fillsSince(since: number) { return this.account.fillsSince(this.marketId, since); }
  heldNow() { return this.account.heldNow(this.marketId); }
}

/**
 * One account. Nonces are per account, so every market it trades signs
 * through the same counter and the same queue; positions, fills and
 * leverage are per market, which is how the venue keeps them.
 */
export class Executor {
  private readonly held = new Map<number, Position>();
  /** When the account's first position push arrived. After it, a market it did not list is flat. */
  private syncedAt = 0;
  private nonce: bigint | null = null;
  /** Leverage each market is on, as far as we know: pushed, or what we last set. */
  private readonly leverage = new Map<number, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners: Listeners = { position: new Map(), fill: new Map() };
  private readonly views = new Map<number, MarketExec>();
  private unsubscribe: (() => void)[] = [];
  private ewma = 350;

  constructor(
    private readonly o: {
      socket: VenueSocket;
      http: Lighter;
      signer: Signer;
      accountIndex: number;
      apiKeyIndex: number;
      slippage?: number;
    },
  ) {}

  get accountIndex() {
    return this.o.accountIndex;
  }

  /** This account on one market. The same view each time, so the scheduler can tell it is attached. */
  on(market: () => MarketInfo, quote: () => Quote | null): MarketExec {
    const id = market().id;
    let view = this.views.get(id);
    if (!view) this.views.set(id, (view = new MarketExec(this, market, quote)));
    return view;
  }

  positionIn(marketId: number): Position | null {
    return this.held.get(marketId) ?? (this.syncedAt ? flat(this.syncedAt) : null);
  }

  latency() {
    return this.ewma;
  }

  listen<K extends keyof Pushes>(kind: K, marketId: number, fn: (x: Pushes[K]) => void): () => void {
    const all: Map<number, Set<(x: Pushes[K]) => void>> = this.listeners[kind];
    let set = all.get(marketId);
    if (!set) all.set(marketId, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Subscribe to this account's pushes. Idempotent. */
  start() {
    if (this.unsubscribe.length) return;
    const id = this.o.accountIndex;
    this.unsubscribe.push(
      this.o.socket.subscribe(`account_all_positions/${id}`, (m) => {
        const all = (m.positions ?? {}) as Record<string, Record<string, unknown>>;
        const now = Date.now();
        this.syncedAt ||= now;
        // Every market this account is watched on: one missing from the push is flat.
        const markets = new Set([...this.views.keys(), ...Object.keys(all).map(Number)]);
        for (const market of markets) {
          const p = all[String(market)];
          const was = this.held.get(market);
          const held: Position = p
            ? {
                size: asNum(p.position) * (Number(p.sign) < 0 ? -1 : 1),
                avgEntry: asNum(p.avg_entry_price),
                unrealised: asNum(p.unrealized_pnl),
                imf: p.initial_margin_fraction === undefined ? null : asNum(p.initial_margin_fraction),
                marginMode: p.margin_mode === undefined ? null : Number(p.margin_mode),
                at: now,
              }
            : flat(now, was);
          this.held.set(market, held);
          // The venue reports initial margin in percent: 3.33 is 30x. Isolated is mode 1.
          if (held.imf && held.marginMode === 1) this.leverage.set(market, Math.round(100 / held.imf));
          for (const fn of this.listeners.position.get(market) ?? []) fn(held);
        }
      }),
      this.o.socket.subscribe(`account_all_trades/${id}`, (m) => {
        const byMarket = (m.trades ?? {}) as Record<string, Fill[]>;
        const now = Date.now();
        for (const [market, fills] of Object.entries(byMarket)) {
          const fns = this.listeners.fill.get(Number(market));
          if (!fns) continue;
          for (const f of fills) {
            // One stamped copy per fill, shared by every listener: none of them writes to it.
            const fill = { ...f, receivedAt: now };
            for (const fn of fns) fn(fill);
          }
        }
      }),
    );
  }

  stop() {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
  }

  /**
   * Everything that can happen before the trade: subscribe, read the nonce,
   * and put the market on this leverage. Called while somebody draws, so
   * none of it is on the clock when they press the button.
   */
  async prepare(view: MarketExec, leverage: number) {
    this.start();
    await this.serial(async () => {
      if (this.nonce === null) this.nonce = await this.o.http.nextNonce(this.o.accountIndex, this.o.apiKeyIndex);
    });
    if (this.leverage.get(view.marketId) !== leverage) await this.submit(view, [], leverage);
  }

  /**
   * Sign and send, as one batch. Serialised per account, because nonces are.
   * A nonce the venue did not expect means nothing executed, so it is read
   * again and the batch re-signed once. A send with no answer is not retried:
   * the venue may have it, and the position push will say.
   */
  heldNow(marketId: number) {
    return this.o.http.positionOf(this.o.accountIndex, marketId);
  }

  /** Something else signed on this account, a transfer: read the nonce again now rather than fail the next order on it. */
  resync(): Promise<void> {
    return this.serial(async () => {
      this.nonce = await this.o.http.nextNonce(this.o.accountIndex, this.o.apiKeyIndex);
    });
  }

  submit(view: MarketExec, orders: OrderRequest[], leverage?: number, extra: Extra = {}): Promise<Sent> {
    return this.serial(async () => {
      try {
        return await this.send(view, orders, leverage, extra);
      } catch (e) {
        if (!(e instanceof VenueError && e.badNonce) && (e as { code?: number }).code !== 21104) throw e;
        this.nonce = await this.o.http.nextNonce(this.o.accountIndex, this.o.apiKeyIndex);
        return this.send(view, orders, leverage, extra);
      }
    });
  }

  private async send(view: MarketExec, orders: OrderRequest[], leverage?: number, extra: Extra = {}): Promise<Sent> {
    if (this.nonce === null) this.nonce = await this.o.http.nextNonce(this.o.accountIndex, this.o.apiKeyIndex);
    const m = view.market();
    const q = view.quote();
    if (orders.length && !q) throw Error("No live venue price yet; not trading blind.");
    const slip = this.o.slippage ?? 0.01;
    const withLeverage = leverage !== undefined && this.leverage.get(m.id) !== leverage;
    const types: number[] = [];
    const infos: string[] = [];
    const worst: number[] = [];
    let nonce = this.nonce;
    if (withLeverage) {
      types.push(TX.updateLeverage);
      infos.push(this.o.signer.updateLeverage(m.id, leverage, 1, nonce++).txInfo);
    }
    if (extra.cancelAll) {
      types.push(TX.cancelAllOrders);
      infos.push(this.o.signer.cancelAll(m.id, 0, 0n, nonce++).txInfo);
    }
    for (const o of orders) {
      // The worst price this order accepts: the far side of the book, plus slippage.
      const ref = o.isAsk ? q!.bid || q!.mark : q!.ask || q!.mark;
      const price = ref * (o.isAsk ? 1 - slip : 1 + slip);
      worst.push(price);
      types.push(TX.createOrder);
      infos.push(this.o.signer.createOrder({ marketIndex: m.id, clientOrderIndex: o.clientOrderIndex, baseAmount: sizeUnits(m, o.size), price: priceUnits(m, price), isAsk: o.isAsk, reduceOnly: o.reduceOnly, nonce: nonce++ }).txInfo);
    }
    for (const st of extra.stops ?? []) {
      types.push(TX.createOrder);
      infos.push(this.o.signer.stopLoss({ marketIndex: m.id, clientOrderIndex: st.clientOrderIndex, baseAmount: sizeUnits(m, st.size), triggerPrice: priceUnits(m, st.trigger), price: priceUnits(m, st.worst), isAsk: st.isAsk, nonce: nonce++ }).txInfo);
    }
    if (!types.length) {
      const now = Date.now();
      return { signedAt: now, sentAt: now, ackAt: now, hashes: [], via: "ws", withLeverage: false, worst, before: 0 };
    }
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
    if (withLeverage) this.leverage.set(m.id, leverage);
    this.ewma = this.ewma * 0.7 + (ackAt - sentAt) * 0.3;
    return { signedAt, sentAt, ackAt, hashes, via, withLeverage, worst, before: (withLeverage ? 1 : 0) + (extra.cancelAll ? 1 : 0) };
  }

  fillsSince(marketId: number, since: number) {
    const token = this.o.signer.authToken(BigInt(Math.floor(Date.now() / 1000) + 600));
    return this.o.http.fills(this.o.accountIndex, marketId, token, since);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

/**
 * One executor per wallet, opened at most once.
 *
 * Opening one reads the wallet's key and loads its signer, which is long
 * enough for a second request to arrive in the meantime: the open right behind
 * a prepare, or the page's close while a restarted round is being resumed.
 * Each used to open its own, and two executors on one account count its nonce
 * separately and both subscribe to its pushes. So the opening is what is
 * shared. A wallet with no key, or one whose signer failed, is not remembered,
 * so the next request tries again.
 */
export class Accounts<T extends { stop(): void }> {
  private readonly opened = new Map<string, Promise<T | null>>();

  constructor(private readonly open: (address: string) => Promise<T | null>) {}

  get(address: string): Promise<T | null> {
    const at = address.toLowerCase();
    const known = this.opened.get(at);
    if (known) return known;
    const drop = () => {
      if (this.opened.get(at) === opening) this.opened.delete(at);
    };
    const opening = this.open(at).then(
      (exec) => {
        if (!exec) drop();
        return exec;
      },
      (e) => {
        drop();
        throw e;
      },
    );
    this.opened.set(at, opening);
    return opening;
  }

  /** Stop a wallet's executor and let the next `get` open one with its current key. */
  forget(address: string) {
    const at = address.toLowerCase();
    const was = this.opened.get(at);
    this.opened.delete(at);
    void was?.then(
      (exec) => exec?.stop(),
      () => undefined,
    );
  }
}
