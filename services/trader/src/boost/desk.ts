import type { Pt } from "@skech/core/shape";
import { Executor, type MarketExec, type Quote } from "../executor";
import type { Keys } from "../keys";
import type { Lighter } from "../lighter";
import { NETWORK, type Symbol } from "../network";
import { type BoostTag, type Round, type Rounds, type RoundSpec } from "../rounds";
import type { VenueSocket } from "../venue-socket";
import type { BoostConfig } from "./config";
import { micro, settle, settleAt, usd } from "./money";

/*
  Testnet's book is a thin quote that barely moves. A $3,000 Wild position
  lost about $4.50 to its spread each turn, so a flat line reached the $8 stop
  in two turns while the chart the user drew on said -$2. There the round is
  judged on the chart: its stop is the engine's, on chart prices, with none
  resting on Lighter to fire on testnet's own, and the user is paid on the
  chart's result, skech carrying the difference. Mainnet is the venue's
  prices throughout.
*/
const ON_CHART = NETWORK === "testnet";
import { type BoostRow, type BoostStore, userAccount } from "./store";
import type { Treasury } from "./treasury";

/**
 * Boost's front desk: a user's stake and skech's boost, one round, one lane.
 *
 *   reserve   the ledger holds stake and boost and leases a free lane, which
 *             already holds skech's float: nothing moves on the venue
 *   run       an ordinary round on the lane's account, drawn line and all,
 *             sized to stake plus boost, with the loss exit at 80% of the
 *             stake and a stop resting on the venue to enforce it
 *   settle    once flat: what the lane holds less the float it started with
 *             is the round's result; share it out and book it
 *   tend      afterwards, off the user's path: top the lane back up to its
 *             float, or sweep the excess, then free it
 *
 * Every step leaves the books able to say where the money is, and anything
 * interrupted is picked up again by `recover`, on boot and every half minute.
 */

type Deps = {
  config: BoostConfig;
  store: BoostStore;
  treasury: Treasury;
  venue: Lighter;
  socket: VenueSocket;
  rounds: Rounds;
  keys: Keys;
  /** A lane's executor, on one market, the way `index.ts` builds every other. */
  on: (exec: Executor, market: string) => MarketExec;
  quote: (market: Symbol) => Quote | null;
};

export type BoostOpen = { market: Symbol; pts: Pt[]; stake: number; seconds: number };

export class BoostDesk {
  private readonly execs = new Map<number, Executor>();
  private readonly settling = new Map<string, Promise<void>>();
  private readonly watched = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: Deps) {}

  get config() {
    return this.d.config;
  }

  async ready() {
    const { store, config, treasury } = this.d;
    await store.ready();
    await store.syncLanes(config.lanes);
    if (!(await store.seeded())) {
      // The first boot books what the treasury holds as skech's own money.
      let total = (await treasury.held(config.master)).collateral;
      for (const lane of config.lanes) total += (await treasury.held(lane)).collateral;
      await store.seed(total);
      console.log(`boost: treasury seeded with ${usd(total).toFixed(2)} USDC`);
    }
    await this.recover().catch((e) => console.error("boost recovery:", (e as Error).message));
    // Subscribed and at the round's leverage before anyone asks, so opening is one order and nothing else.
    for (const lane of config.lanes) for (const market of config.markets) void this.d.rounds.prepare(this.d.on(this.laneExec(lane), market), config.leverage).catch((e) => console.error(`boost: lane ${lane} not warmed: ${(e as Error).message}`));
    this.timer = setInterval(() => void this.recover().catch((e) => console.error("boost recovery:", (e as Error).message)), 30_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  isLane(account: number) {
    return this.d.config.lanes.includes(account);
  }

  /** The executor that trades a lane, with the treasury's key. One per lane, kept. */
  laneExec(lane: number): Executor {
    let exec = this.execs.get(lane);
    if (!exec) {
      exec = new Executor({ socket: this.d.socket, http: this.d.venue, signer: this.d.treasury.signer(lane), accountIndex: lane, apiKeyIndex: this.d.config.apiKeyIndex });
      exec.start();
      this.execs.set(lane, exec);
    }
    return exec;
  }

  /** Why no new boosted round can start right now, or null when one can. */
  async closedBecause(market: Symbol): Promise<string | null> {
    const { store, socket } = this.d;
    const kill = await store.killed();
    if (kill.killed) return kill.reason ?? "Boost is paused.";
    if (!this.d.config.markets.includes(market)) return `Boost runs on ${this.d.config.markets.join(" and ")} only.`;
    if (!socket.connected) return "Lighter is not answering right now.";
    const q = this.d.quote(market);
    if (!q || Date.now() - q.at > 5000) return "Waiting for a live price from Lighter.";
    return null;
  }

  /** The most boost that may be out at once: the cap, plus every fee earned so far. */
  private async cap() {
    return micro(this.d.config.reserveCap) + (await this.d.store.balance("fees"));
  }

  /** Everything the page needs to show Boost to this wallet. */
  async status(address: string, market: Symbol) {
    const { store, config } = this.d;
    const [balance, open, lanes, out, cap, closed, recent] = await Promise.all([
      store.balance(userAccount(address)),
      store.openFor(address),
      store.lanes(),
      store.outstanding(),
      this.cap(),
      this.closedBecause(market),
      store.recent(address, 10),
    ]);
    return {
      enabled: closed === null,
      why: closed,
      balance: usd(balance),
      open: open ? this.view(open) : null,
      recent: recent.filter((r) => r.status === "done" || r.status === "refunded").map((r) => this.view(r)),
      rules: { multiple: config.multiple, closeAt: config.closeAt, cut: config.cut, lossFee: config.lossFee, leverage: config.leverage, stakeMin: config.stakeMin, stakeMax: config.stakeMax, markets: config.markets, headroom: config.headroom },
      lanes: { free: lanes.filter((l) => !l.boostId && l.balance !== null).length, total: lanes.length },
      room: usd(cap - out),
    };
  }

  private view(r: BoostRow) {
    return {
      id: r.id,
      roundId: r.roundId,
      market: r.market,
      stake: usd(r.stake),
      boost: usd(r.boost),
      status: r.status,
      problem: r.problem,
      back: r.userOut === null ? null : usd(r.userOut),
      fee: r.fee === null ? null : usd(r.fee),
      cut: r.cut === null ? null : usd(r.cut),
      at: r.createdAt,
    };
  }

  private tag(row: BoostRow, status: BoostTag["status"], extra: Partial<BoostTag> = {}): BoostTag {
    const { config } = this.d;
    return { id: row.id, owner: row.address, accountIndex: row.accountIndex, stake: usd(row.stake), boost: usd(row.boost), closeAt: usd(row.stake) * config.closeAt, cut: config.cut, lossFee: config.lossFee, status, ...extra };
  }

  // --- a round ----------------------------------------------------------------

  async open(address: string, input: BoostOpen): Promise<Round> {
    const { config, store, treasury, venue, rounds } = this.d;
    const at = address.toLowerCase();
    const closed = await this.closedBecause(input.market);
    if (closed) throw Error(closed);
    if (!(input.stake >= config.stakeMin && input.stake <= config.stakeMax)) throw Error(`Boost takes $${config.stakeMin} to $${config.stakeMax}.`);
    const accountIndex = (await this.d.keys.forAddress(at))?.accountIndex ?? (await venue.accountForAddress(at));
    if (accountIndex === null) throw Error("This wallet has no Lighter account yet.");
    const id = crypto.randomUUID();
    const stake = micro(input.stake);
    const boost = stake * BigInt(config.multiple);
    const { lane } = await store.reserve({ id, address: at, accountIndex, market: input.market, stake, boost, cap: await this.cap() });
    const row = (await store.get(id))!;
    try {
      const view = this.d.on(this.laneExec(lane), input.market);
      const total = usd(stake + boost);
      const spec: RoundSpec = {
        market: input.market,
        pts: input.pts,
        stake: total * (1 - config.headroom),
        leverage: config.leverage,
        seconds: input.seconds,
        exits: { lose: input.stake * config.closeAt, gain: null },
        venueStop: !ON_CHART,
      };
      const round = await rounds.open(spec, view);
      rounds.note(round.id, { boost: this.tag(row, "running") });
      this.watch(id, round.id);
      await store.update(id, { status: "running", roundId: round.id });
      return round;
    } catch (error) {
      await this.unwind(id, lane, (error as Error).message.slice(0, 160));
      throw error;
    }
  }

  /**
   * A lane back to its float: the excess to the master, or the shortfall from
   * it, then free. Only on a flat lane whose round is booked. Serialized per
   * lane; recovery calls it again for any lane it could not finish.
   */
  private readonly tending = new Map<number, Promise<void>>();
  tend(lane: number): Promise<void> {
    const running = this.tending.get(lane);
    if (running) return running;
    const task = this.doTend(lane).finally(() => this.tending.delete(lane));
    this.tending.set(lane, task);
    return task;
  }

  private async doTend(lane: number) {
    const { treasury, config, store } = this.d;
    const float = micro(config.laneFloat);
    const held = await treasury.held(lane);
    if (held.positions > 0) throw Error(`lane ${lane} still holds a position`);
    const memo = `tend:${lane}:${Date.now().toString(36)}`;
    if (held.collateral > float) await treasury.moveWithin(lane, config.master, held.collateral - float, memo);
    else if (held.collateral < float) {
      await treasury.moveWithin(config.master, lane, float - held.collateral, memo);
      await treasury.until(lane, (c) => c >= float - 1n);
    }
    const now = (await treasury.held(lane)).collateral;
    // A transfer out of the lane used one of its nonces; the lane's executor must not find that out on the next order.
    if (held.collateral > float) await this.laneExec(lane).resync();
    await store.release(lane, now);
  }

  /**
   * A round that never started: nothing left the lane, so the stake goes back
   * on the books and the lane is tended. If the lane holds anything other
   * than what it started with, something did trade, and it is settled instead.
   */
  private async unwind(id: string, lane: number, problem: string) {
    const { store, treasury } = this.d;
    try {
      const { positions, collateral } = await treasury.held(lane);
      if (positions > 0) {
        await store.update(id, { problem: `Not refunded yet: lane ${lane} holds a position. ${problem}` });
        return;
      }
      const row = await store.get(id);
      if (row?.laneBefore !== null && row?.laneBefore !== undefined && collateral !== row.laneBefore) {
        await this.settle(id);
        return;
      }
      await store.refund(id, problem);
      void this.tend(lane).catch(() => undefined);
    } catch (e) {
      // Recovery tries again; nothing is refunded twice, and nothing is refunded that is still on the lane.
      await store.update(id, { problem: `Refund pending: ${(e as Error).message.slice(0, 120)}` }).catch(() => undefined);
    }
  }

  /** Settle a round once its engine says it is done. */
  private watch(id: string, roundId: string) {
    if (this.watched.has(id)) return;
    this.watched.add(id);
    const off = this.d.rounds.subscribe(roundId, (round) => {
      if (round.status !== "done") return;
      queueMicrotask(() => off());
      void this.settle(id);
    });
  }

  /** Once at a time per round, however many ways it is asked for. */
  settle(id: string): Promise<void> {
    const running = this.settling.get(id);
    if (running) return running;
    const task = this.doSettle(id).finally(() => this.settling.delete(id));
    this.settling.set(id, task);
    return task;
  }

  private async doSettle(id: string) {
    const { store, treasury, rounds, config } = this.d;
    const row = await store.get(id);
    if (!row || row.status === "done" || row.status === "refunded") return;
    await store.update(id, { status: "settling" });
    if (row.roundId) rounds.note(row.roundId, { boost: this.tag(row, "settling") });
    try {
      // Flat first: what the lane holds is only the round's result once nothing is open.
      let end = Date.now() + 5_000;
      let held = await treasury.held(row.lane);
      let flattened = false;
      while (held.positions > 0 && Date.now() < end) {
        await Bun.sleep(400);
        held = await treasury.held(row.lane);
        // The round is over and the lane still holds something: close it rather than wait on it. Once.
        const over = !row.roundId || !rounds.get(row.roundId) || rounds.get(row.roundId)?.status === "done";
        if (held.positions > 0 && over && !flattened && Date.now() > end - 3_000) {
          flattened = true;
          const closed = await rounds.flatten(this.d.on(this.laneExec(row.lane), row.market), row.market).catch((e) => (console.error(`boost ${id}: lane ${row.lane} not flattened: ${(e as Error).message}`), 0));
          if (closed) console.error(`boost ${id}: lane ${row.lane} still held ${closed} after its round; closed it`);
          end = Date.now() + 10_000;
        }
      }
      if (held.positions > 0) throw Error(`lane ${row.lane} is not flat yet`);
      // The round traded stake plus boost out of the lane's float; what the lane holds past the rest of the float is the round's.
      const rest = row.laneBefore === null ? 0n : row.laneBefore - (row.stake + row.boost);
      const round = row.roundId ? rounds.get(row.roundId) : null;
      const chart = ON_CHART && round ? rounds.chartNet(round) : null;
      const result =
        chart === null
          ? settle(row.stake, row.boost, held.collateral - rest, config.cut, config.lossFee)
          : settleAt(row.stake, row.boost, held.collateral - rest, BigInt(Math.round(chart * 1e6)), config.cut, config.lossFee);
      await store.book(id, result);
      if (row.roundId) {
        rounds.note(row.roundId, {
          boost: this.tag(row, "done", { settlement: { equity: usd(result.equity), back: usd(result.user), fee: usd(result.fee), cut: usd(result.cut), gap: usd(result.gap) } }),
        });
      }
      void this.tend(row.lane).catch((e) => console.error(`boost: lane ${row.lane} not tended: ${(e as Error).message}`));
      console.log(`boost ${id}: settled on ${chart === null ? "the venue" : `the chart (${chart.toFixed(2)})`}, lane ${row.lane}: equity ${usd(result.equity).toFixed(2)}, back to user ${usd(result.user).toFixed(2)}, fee ${usd(result.fee).toFixed(2)}, cut ${usd(result.cut).toFixed(2)}, gap ${usd(result.gap).toFixed(2)}`);
    } catch (e) {
      const problem = `Settling: ${(e as Error).message.slice(0, 140)}`;
      await store.update(id, { problem });
      if (row.roundId) rounds.note(row.roundId, { boost: this.tag(row, "settling", { problem }) });
      throw e;
    }
  }

  /**
   * Pick up anything left half done. A round the engine finished settles; one
   * still running is watched; one that never got going gives its money back.
   */
  async recover() {
    const { store, rounds, treasury } = this.d;
    for (const row of await store.unfinished()) {
      if (this.settling.has(row.id)) continue;
      const round = row.roundId ? rounds.get(row.roundId) : null;
      if (row.status === "settling" || round?.status === "done") {
        await this.settle(row.id).catch(() => undefined);
      } else if (row.status === "running" && round) {
        this.watch(row.id, round.id);
      } else if (row.status === "running" && !round) {
        // The engine has no record of it. Settle once the lane is flat; until then it needs a close.
        const held = await treasury.held(row.lane).catch(() => null);
        if (held && held.positions === 0) await this.settle(row.id).catch(() => undefined);
        else await store.update(row.id, { problem: `Lane ${row.lane} holds a position with no round behind it; close it.` });
      } else if ((row.status === "reserved" || row.status === "funding") && Date.now() - row.createdAt > 60_000) {
        await this.unwind(row.id, row.lane, row.problem ?? "Interrupted before it started.");
      }
    }
    // A free lane holding other than the float (the float was changed, or a tend fell short) comes off the market and is brought to it.
    const float = micro(this.d.config.laneFloat);
    for (const l of await store.lanes()) if (!l.boostId && l.balance !== null && (l.balance < float - micro(1) || l.balance > float + micro(1))) await store.retire(l.lane);
    for (const lane of await store.tendable()) await this.tend(lane).catch((e) => console.error(`boost: lane ${lane} not tended: ${(e as Error).message}`));
    await this.sendHome();
  }

  /**
   * Money nobody is using goes back to its Lighter account by itself, so no
   * one has to know it was ever on skech's side. Less than Lighter's fee
   * cannot be sent; it stays, and is counted in the balance the page shows.
   */
  private async sendHome() {
    for (const { address } of await this.d.store.idle(this.d.config.returnAfter)) {
      await this.withdraw(address, "all").catch((e) => {
        if (!/fee|nothing/i.test((e as Error).message)) console.error(`boost: could not send ${address}'s money home: ${(e as Error).message}`);
      });
    }
  }

  // --- money in and out ------------------------------------------------------------

  async prepareDeposit(address: string, amount: number) {
    const held = await this.d.keys.forAddress(address);
    if (!held) throw Object.assign(Error("Enable trading first: adding money to Boost is signed with your trading key."), { needsKey: true });
    if (!(amount >= 1 && amount <= 10_000)) throw Error("Add between $1 and $10,000.");
    const prep = await this.d.treasury.prepareDeposit({ address, account: held.accountIndex, apiKeyIndex: held.apiKeyIndex, privateKey: held.privateKey, amount: micro(amount) });
    return { id: prep.id, fee: usd(prep.fee), messageToSign: prep.messageToSign };
  }

  async confirmDeposit(address: string, id: string, signature: string) {
    const done = await this.d.treasury.confirmDeposit(id, address, signature);
    try {
      await this.d.store.credit(address, done.amount, `dep:${id}`);
    } catch (e) {
      // The money is in the treasury and not on the books: loud, because only a person can fix it.
      console.error(`BOOST DEPOSIT NOT BOOKED: ${address} ${usd(done.amount)} USDC, tx ${done.hash}: ${(e as Error).message}`);
      throw Error("Your money arrived but could not be recorded yet. It is safe; support can see it.");
    }
    return { balance: usd(await this.d.store.balance(userAccount(address))) };
  }

  /** Out to the wallet's own Lighter account, and only there. Lighter's fee comes off what arrives. */
  async withdraw(address: string, amount: number | "all") {
    const { store, treasury, venue, config } = this.d;
    const to = await venue.accountForAddress(address);
    if (to === null) throw Error("This wallet has no Lighter account to send to.");
    const want = amount === "all" ? await store.balance(userAccount(address)) : micro(amount);
    if (want <= 0n) return { sent: 0, fee: 0, balance: 0 };
    const fee = await treasury.transferFee(config.master, to, treasury.signer(config.master));
    if (want <= fee) throw Error(`Take out more than Lighter's $${usd(fee).toFixed(2)} transfer fee.`);
    const ref = `wd:${crypto.randomUUID()}`;
    if (!(await store.withdraw(address, want, ref))) throw Error("That is more than your Boost balance.");
    try {
      await treasury.payOut(to, want - fee, fee, ref.slice(0, 32));
    } catch (e) {
      await store.unwithdraw(address, want, ref);
      throw e;
    }
    return { sent: usd(want - fee), fee: usd(fee), balance: usd(await store.balance(userAccount(address))) };
  }

  // --- for whoever runs it ------------------------------------------------------------

  /** Stop new boosted rounds, or let them start again. Rounds already open are not touched. */
  pause(killed: boolean, reason: string | null) {
    return this.d.store.setKilled(killed, reason ?? (killed ? "Boost is paused." : null));
  }

  /** The books against the venue. `drift` should be zero, give or take open rounds' unrealised P&L. */
  async reconcile() {
    const { store, treasury, config } = this.d;
    const t = await store.totals();
    let venueHeld = (await treasury.held(config.master)).equity;
    const lanes: { lane: number; equity: number; positions: number }[] = [];
    for (const lane of config.lanes) {
      const h = await treasury.held(lane);
      venueHeld += h.equity;
      lanes.push({ lane, equity: usd(h.equity), positions: h.positions });
    }
    const books = t.users + t.holds + t.treasury + t.fees;
    return {
      books: { users: usd(t.users), holds: usd(t.holds), treasury: usd(t.treasury), fees: usd(t.fees), total: usd(books) },
      venue: { total: usd(venueHeld), lanes },
      drift: usd(venueHeld - books),
      outstanding: usd(await store.outstanding()),
      cap: usd(await this.cap()),
      killed: await store.killed(),
    };
  }
}
